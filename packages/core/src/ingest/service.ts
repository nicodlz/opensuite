import { createHash, randomUUID } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import {
  parseNotification,
  resolveRecipients,
  quarantineReason,
} from "../domain/notification.ts";
import { archiveKey, belongs, mergeVariants } from "./recovery.ts";
import type {
  Failure,
  IngestDependencies,
  LedgerRecipient,
  Queue,
  QueueMessage,
} from "./contracts.ts";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
// States after which a recipient needs no more work. `held` is not one: an
// unknown recipient keeps the message and its object until it is routed by a
// later replay or rejected by an operator.
const finished = new Set(["imported", "quarantined", "rejected", "rerouted"]);
// Exceeds the ten-minute lease plus the two-minute JMAP deadline.
const uncertainGraceMs = 15 * 60_000;
export const recipientKey = (
  messageId: string,
  destination: string,
  known: boolean,
) =>
  digest(
    JSON.stringify([messageId, known ? "mailbox" : "unknown", destination]),
  );

export class IngestService {
  private readonly deps: IngestDependencies;
  constructor(deps: IngestDependencies) {
    this.deps = deps;
  }

  async process(
    body: string,
    reconcile = false,
  ): Promise<Result<void, Failure>> {
    const parsed = parseNotification(body);
    if (parsed.isErr())
      return err({ message: `Invalid notification: ${parsed.error}` });
    const n = parsed.value;
    const { storage, ledger, delivery, events } = this.deps;
    if (!belongs(n, this.deps))
      return err({ message: "Unexpected bucket or topic" });
    if (!reconcile) {
      const archive = await storage.archive(archiveKey(body), body);
      if (archive.isErr()) return archive;
    }
    const claims = await ledger.expireClaims();
    if (claims.isErr()) return claims;
    const dynamic = await this.deps.resolveRoutes?.(n.receipt.recipients);
    if (dynamic?.isErr()) return err(dynamic.error);
    const routes = [...this.deps.routes];
    for (const route of dynamic?.isOk() === true ? dynamic.value : []) {
      const existing = routes.find(
        (item) => item.address.toLowerCase() === route.address.toLowerCase(),
      );
      if (existing !== undefined && existing.destination !== route.destination)
        return err({ message: "Conflicting recipient routes" });
      if (existing === undefined) routes.push(route);
    }
    const recipients = resolveRecipients(n.receipt.recipients, routes);
    // Past the hold window an unknown address is never routed, so a mailbox
    // created later (possibly for someone else) does not receive old mail.
    // The window is counted from the SES receipt time with this server's
    // clock; the ledger re-checks it under the message lock.
    const holdDays = this.deps.holdDays ?? 14;
    const rerouteUntil = Date.parse(n.mail.timestamp) + holdDays * 86_400_000;
    const prepared = await ledger.prepare(n, recipients, { rerouteUntil });
    if (prepared.isErr()) return err(prepared.error);
    let read: Result<Uint8Array, Failure> | undefined;
    const bytes = async () => {
      read ??= await storage.readBuffer(
        n.receipt.action.bucketName,
        n.receipt.action.objectKey,
      );
      return read;
    };
    let firstFailure: Failure | undefined;
    const uploads = new Map<string, string>();
    // Logged with each import, so operators can see why mail went to Junk.
    const reason = quarantineReason(n);
    const quarantine = reason !== null;
    // Sequential delivery bounds memory and ensures the buffer is read only once.
    const processRecipient = async (record: LedgerRecipient): Promise<void> => {
      if (finished.has(record.state)) return;
      if (record.state === "held") {
        if (Date.now() < rerouteUntil) return;
        const rejected = await ledger.expireHeld(
          record.key,
          `Hold window of ${String(holdDays)} days elapsed`,
        );
        if (rejected.isErr()) firstFailure ??= rejected.error;
        else if (rejected.value)
          events.emit("ingest_held_expired", {
            messageId: n.mail.messageId,
            recipient: record.destination,
            recipientKey: record.key,
          });
        return;
      }
      if (record.permanent) {
        firstFailure ??= { message: "Recipient has a permanent rejection" };
        return;
      }
      if (record.state === "importing") {
        firstFailure ??= { message: "Import is in progress" };
        return;
      }
      if (record.state === "uncertain") {
        if (!record.legacy) {
          const source = await bytes();
          if (source.isErr()) {
            firstFailure ??= source.error;
            return;
          }
          const found = await delivery.reconcile(
            record.destination,
            source.value,
            quarantine,
            n.mail.timestamp,
            record.key,
          );
          if (found.isOk() && found.value.length > 0) {
            const remoteId = found.value[0];
            if (remoteId === undefined) return;
            if (found.value.length > 1)
              events.emit("ingest_duplicate", {
                messageId: n.mail.messageId,
                recipient: record.destination,
                matches: found.value.length,
                recipientKey: record.key,
              });
            const saved = await ledger.finish(
              record.key,
              quarantine ? "quarantined" : "imported",
              remoteId,
            );
            if (saved.isErr()) firstFailure ??= saved.error;
            return;
          }
          if (found.isErr()) firstFailure ??= found.error;
          else if (
            record.importStartedAt !== null &&
            Date.now() - record.importStartedAt.getTime() >= uncertainGraceMs
          ) {
            const retry = await ledger.retryUncertain(
              record.key,
              new Date(Date.now() - uncertainGraceMs),
            );
            if (retry.isErr()) firstFailure ??= retry.error;
            else if (retry.value) {
              await processRecipient({ ...record, state: "failed" });
              return;
            } else
              firstFailure ??= {
                message: "Recipient state changed during reconciliation",
              };
          } else
            firstFailure ??= {
              message: "Import requires reconciliation after grace period",
            };
        } else
          firstFailure ??= {
            message: "Legacy import requires operator reconciliation",
          };
        events.emit("ingest_failure", {
          stage: "uncertain",
          messageId: n.mail.messageId,
          recipient: record.destination,
        });
        return;
      }
      if (!record.known) {
        const held = await ledger.finish(
          record.key,
          "held",
          undefined,
          "Unknown envelope recipient",
        );
        if (held.isErr()) firstFailure ??= held.error;
        else
          events.emit("ingest_held", {
            messageId: n.mail.messageId,
            recipient: record.destination,
            recipientKey: record.key,
          });
        return;
      }
      if (record.attempts >= this.deps.maxAttempts) {
        firstFailure ??= { message: "Recipient exceeded retry limit" };
        return;
      }
      const owner = randomUUID();
      const claimed = await ledger.claim(record.key, owner);
      if (claimed.isErr()) {
        firstFailure ??= claimed.error;
        return;
      }
      if (!claimed.value) {
        firstFailure ??= { message: "Recipient already claimed" };
        return;
      }
      // Replay may run on a ledger restored from a backup older than this
      // import: look for the copy in the mailbox before importing again.
      if (reconcile) {
        const source = await bytes();
        const found = source.isErr()
          ? err(source.error)
          : await delivery.reconcile(
              record.destination,
              source.value,
              quarantine,
              n.mail.timestamp,
              record.key,
            );
        const remoteId = found.isOk() ? found.value[0] : undefined;
        if (found.isErr() || remoteId !== undefined) {
          if (found.isOk() && found.value.length > 1)
            events.emit("ingest_duplicate", {
              messageId: n.mail.messageId,
              recipient: record.destination,
              matches: found.value.length,
              recipientKey: record.key,
            });
          const saved = found.isErr()
            ? await ledger.finish(
                record.key,
                "failed",
                undefined,
                found.error.message,
                owner,
              )
            : await ledger.finish(
                record.key,
                quarantine ? "quarantined" : "imported",
                remoteId,
                undefined,
                owner,
              );
          if (saved.isErr()) firstFailure ??= saved.error;
          else if (found.isErr()) firstFailure ??= found.error;
          return;
        }
      }
      let renewal: Promise<void> = Promise.resolve();
      const timer = setInterval(() => {
        renewal = renewal.then(async () => {
          const result = await ledger.renew(record.key, owner);
          if (result.isErr() || !result.value)
            events.emit("ingest_failure", {
              stage: "lease",
              messageId: n.mail.messageId,
            });
          return undefined;
        });
      }, 60_000);
      try {
        const source = await bytes();
        const imported = source.isErr()
          ? err(source.error)
          : await delivery.import(
              record.destination,
              source.value,
              quarantine,
              n.mail.timestamp,
              record.key,
              uploads,
              async () => {
                const started = await ledger.startImport(record.key, owner);
                return started.isErr()
                  ? err(started.error)
                  : started.value
                    ? ok(undefined)
                    : err({ message: "Recipient claim expired before import" });
              },
            );
        if (imported.isErr()) {
          const status =
            imported.error.ambiguous === true ? "uncertain" : "failed";
          const saved = await ledger.finish(
            record.key,
            status,
            undefined,
            imported.error.message,
            owner,
            imported.error.permanent === true,
          );
          firstFailure ??= saved.isErr() ? saved.error : imported.error;
          events.emit("ingest_failure", {
            stage: status,
            messageId: n.mail.messageId,
            recipient: record.destination,
          });
          return;
        }
        const saved = await ledger.finish(
          record.key,
          quarantine ? "quarantined" : "imported",
          imported.value,
          undefined,
          owner,
        );
        if (saved.isErr()) {
          firstFailure ??= saved.error;
          return;
        }
        events.emit("ingest_imported", {
          messageId: n.mail.messageId,
          recipient: record.destination,
          placement: reason ?? "inbox",
          delaySeconds: Math.max(
            0,
            (Date.now() - Date.parse(n.mail.timestamp)) / 1000,
          ),
        });
      } finally {
        clearInterval(timer);
        await renewal;
      }
    };
    await prepared.value.reduce<Promise<void>>(
      (previous, record) => previous.then(() => processRecipient(record)),
      Promise.resolve(),
    );
    const current = await ledger.prepare(n, recipients, { rerouteUntil });
    if (current.isErr()) return err(current.error);
    const complete = current.value.every((r) => finished.has(r.state));
    // Only unknown recipients remain: nothing to retry until an address is
    // provisioned (replay routes it) or an operator rejects it.
    const waiting =
      !complete &&
      current.value.every((r) => finished.has(r.state) || r.state === "held");
    // Delete the object before recording completion: replay skips completed
    // messages, so a failed deletion must leave the message to be retried.
    const done = complete && firstFailure === undefined;
    if (done) {
      const deleted = await storage.deleteBuffer(
        n.receipt.action.bucketName,
        n.receipt.action.objectKey,
      );
      if (deleted.isErr()) {
        events.emit("ingest_failure", {
          stage: "buffer_delete",
          code: deleted.error.code ?? "unknown",
        });
        await ledger.messageState(n.mail.messageId, "failed");
        return deleted;
      }
    }
    const updated = await ledger.messageState(
      n.mail.messageId,
      done ? "imported" : waiting ? "held" : "failed",
    );
    if (updated.isErr()) return updated;
    return firstFailure !== undefined
      ? err(firstFailure)
      : complete || waiting
        ? ok(undefined)
        : err({ message: "Recipients remain incomplete" });
  }

  async handle(
    queue: Queue,
    item: QueueMessage,
  ): Promise<Result<void, Failure>> {
    let heartbeat: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(async () => {
        const extended = await queue.defer(item.receipt, 300);
        if (extended.isErr())
          this.deps.events.emit("ingest_failure", {
            stage: "visibility_heartbeat",
            attempts: item.attempts,
          });
        return undefined;
      });
    }, 60_000);
    let result: Result<void, Failure>;
    try {
      result = await this.process(item.body);
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
    if (result.isErr()) {
      this.deps.events.emit("ingest_failure", {
        stage: "processing",
        attempts: item.attempts,
      });
      const delay = Math.min(
        3600,
        60 * 2 ** Math.min(Math.max(item.attempts - 1, 0), 6),
      );
      const deferred = await queue.defer(item.receipt, delay);
      return deferred.isErr() ? deferred : result;
    }
    return queue.delete(item.receipt);
  }

  async reconcile(maxAgeSeconds: number): Promise<Result<void, Failure>> {
    const list = await this.deps.storage.archives();
    if (list.isErr()) return err(list.error);
    const keys = await this.deps.storage.bufferKeys();
    const bufferKeys = new Set(keys.isOk() ? keys.value : []);
    const referenced = new Set<string>();
    let failures = keys.isErr() ? 1 : 0;
    if (keys.isErr())
      this.deps.events.emit("ingest_failure", {
        stage: "buffer_list",
        code: keys.error.code ?? "unknown",
      });
    const archived: { body: string; id: string }[] = [];
    const read = async (key: string): Promise<void> => {
      const body = await this.deps.storage.readArchive(key);
      if (body.isErr()) {
        failures++;
        this.deps.events.emit("ingest_failure", {
          stage: "archive_read",
          code: body.error.code ?? "unknown",
        });
        return;
      }
      const n = parseNotification(body.value);
      if (n.isErr()) {
        failures++;
        this.deps.events.emit("ingest_failure", { stage: "archive_parse" });
        return;
      }
      referenced.add(n.value.receipt.action.objectKey);
      if (
        keys.isOk() &&
        Date.now() - Date.parse(n.value.mail.timestamp) >
          maxAgeSeconds * 1000 &&
        bufferKeys.has(n.value.receipt.action.objectKey)
      )
        this.deps.events.emit("ingest_notification_old", {
          messageId: n.value.mail.messageId,
        });
      archived.push({ body: body.value, id: n.value.mail.messageId });
    };
    await list.value.reduce<Promise<void>>(
      (previous, key) => previous.then(() => read(key)),
      Promise.resolve(),
    );
    const completed = new Set<string>();
    const batches = Array.from(
      { length: Math.ceil(archived.length / 500) },
      (_, i) => archived.slice(i * 500, (i + 1) * 500),
    );
    const lookup = await batches.reduce<Promise<Result<void, Failure>>>(
      (previous, batch) =>
        previous.then(async (prior) => {
          if (prior.isErr()) return prior;
          const result = await this.deps.ledger.importedMessages(
            batch.map((item) => item.id),
          );
          if (result.isErr()) return err(result.error);
          for (const id of result.value) completed.add(id);
          return ok(undefined);
        }),
      Promise.resolve(ok(undefined)),
    );
    if (lookup.isErr()) return lookup;
    // SES can send several notifications for one message with different
    // envelopes. Replaying them one by one would let the first delete the
    // object before the others are delivered, so they are replayed together,
    // even when the message already counts as imported.
    const variants = new Map<string, string[]>();
    for (const item of archived)
      variants.set(item.id, [...(variants.get(item.id) ?? []), item.body]);
    const pending = [...variants].flatMap(([id, bodies]) =>
      bodies.length > 1
        ? [{ id, body: mergeVariants(bodies) }]
        : completed.has(id)
          ? []
          : bodies.map((body) => ({ id, body })),
    );
    await pending.reduce<Promise<void>>(
      (previous, item) =>
        previous.then(async () => {
          if ((await this.process(item.body, true)).isErr()) {
            failures++;
            this.deps.events.emit("ingest_failure", {
              stage: "replay_message",
            });
          }
          return undefined;
        }),
      Promise.resolve(),
    );
    if (keys.isOk())
      for (const key of keys.value)
        if (!referenced.has(key))
          this.deps.events.emit("ingest_buffer_without_notification", { key });
    return failures > 0
      ? err({
          message: `${String(failures)} reconciliation operations failed${keys.isErr() ? `: buffer listing: ${keys.error.message}` : ""}`,
        })
      : ok(undefined);
  }
}
