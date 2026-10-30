import { createHash, randomUUID } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import {
  parseNotification,
  resolveRecipients,
  verdictPolicy,
} from "../domain/notification.ts";
import type {
  Failure,
  IngestDependencies,
  LedgerRecipient,
  Queue,
  QueueMessage,
} from "./contracts.ts";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
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
    if (
      n.receipt.action.bucketName !== this.deps.bucket ||
      n.receipt.action.topicArn !== this.deps.topic ||
      !n.receipt.action.objectKey.startsWith(this.deps.bufferPrefix)
    )
      return err({ message: "Unexpected bucket or topic" });
    const archive = await storage.archive(`${digest(body)}.json`, body);
    if (archive.isErr()) return archive;
    const expired = await ledger.expireClaims();
    if (expired.isErr()) return expired;
    const recipients = resolveRecipients(
      n.receipt.recipients,
      this.deps.routes,
    );
    const prepared = await ledger.prepare(n, recipients);
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
    const quarantine = verdictPolicy(n) === "quarantine";
    // Sequential delivery bounds memory and ensures the buffer is read only once.
    const processRecipient = async (record: LedgerRecipient): Promise<void> => {
      if (["imported", "quarantined", "rejected"].includes(record.state))
        return;
      if (record.state === "importing") {
        firstFailure ??= { message: "Import is in progress" };
        return;
      }
      if (record.state === "uncertain") {
        if (reconcile) {
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
          if (found.isOk()) {
            const saved = await ledger.finish(
              record.key,
              quarantine ? "quarantined" : "imported",
              found.value,
            );
            if (saved.isErr()) firstFailure ??= saved.error;
            return;
          }
          firstFailure ??= found.error;
        } else firstFailure ??= { message: "Import requires reconciliation" };
        events.emit("ingest_failure", {
          stage: "uncertain",
          messageId: n.mail.messageId,
          recipient: record.destination,
        });
        return;
      }
      if (!record.known) {
        const rejected = await ledger.finish(
          record.key,
          "rejected",
          undefined,
          "Unknown envelope recipient",
        );
        if (rejected.isErr()) firstFailure ??= rejected.error;
        else
          events.emit("ingest_rejected", {
            messageId: n.mail.messageId,
            recipient: record.destination,
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
    const current = await ledger.prepare(n, recipients);
    if (current.isErr()) return err(current.error);
    const complete = current.value.every((r) =>
      ["imported", "quarantined", "rejected"].includes(r.state),
    );
    const updated = await ledger.messageState(
      n.mail.messageId,
      complete ? "imported" : "failed",
    );
    if (updated.isErr()) return updated;
    if (complete && firstFailure === undefined) {
      const deleted = await storage.deleteBuffer(
        n.receipt.action.bucketName,
        n.receipt.action.objectKey,
      );
      if (deleted.isErr()) return deleted;
    }
    return firstFailure !== undefined
      ? err(firstFailure)
      : complete
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
    const referenced = new Set<string>();
    let failures = keys.isErr() ? 1 : 0;
    const replay = async (key: string): Promise<void> => {
      const body = await this.deps.storage.readArchive(key);
      if (body.isErr()) {
        failures++;
        return;
      }
      const n = parseNotification(body.value);
      if (n.isErr()) {
        failures++;
        return;
      }
      referenced.add(n.value.receipt.action.objectKey);
      if (
        keys.isOk() &&
        Date.now() - Date.parse(n.value.mail.timestamp) >
          maxAgeSeconds * 1000 &&
        keys.value.includes(n.value.receipt.action.objectKey)
      )
        this.deps.events.emit("ingest_notification_old", {
          messageId: n.value.mail.messageId,
        });
      if ((await this.process(body.value, true)).isErr()) failures++;
    };
    await list.value.reduce<Promise<void>>(
      (previous, key) => previous.then(() => replay(key)),
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
