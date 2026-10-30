import { createHash } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import {
  parseNotification,
  resolveRecipients,
  verdictPolicy,
} from "../domain/notification.ts";
import type {
  Failure,
  IngestDependencies,
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
  async process(body: string): Promise<Result<void, Failure>> {
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
    const prepared = await ledger.prepare(n, recipients);
    if (prepared.isErr()) return err(prepared.error);
    const outcomes = await Promise.all(
      recipients.map(async (recipient): Promise<Result<void, Failure>> => {
        const key = recipientKey(
          n.mail.messageId,
          recipient.destination,
          recipient.known,
        );
        const record = prepared.value.find((item) => item.key === key);
        if (record === undefined)
          return err({ message: "Ledger omitted recipient" });
        if (record.state === "importing") {
          events.emit("ingest_failure", {
            stage: "importing_requires_reconciliation",
            messageId: n.mail.messageId,
          });
          return err({
            message: "Import is already in progress or requires reconciliation",
          });
        }
        if (
          ["imported", "quarantined", "rejected", "uncertain"].includes(
            record.state,
          )
        )
          return ok(undefined);
        if (!recipient.known) {
          const rejected = await ledger.finish(
            key,
            "rejected",
            undefined,
            "Unknown envelope recipient",
          );
          if (rejected.isErr()) return rejected;
          events.emit("ingest_rejected", {
            messageId: n.mail.messageId,
            recipient: recipient.destination,
          });
          return ok(undefined);
        }
        if (record.attempts >= this.deps.maxAttempts) {
          return err({ message: "Recipient exceeded retry limit" });
        }
        const read = await storage.readBuffer(
          n.receipt.action.bucketName,
          n.receipt.action.objectKey,
        );
        if (read.isErr()) {
          events.emit("ingest_failure", {
            stage: "buffer",
            messageId: n.mail.messageId,
          });
          return err(read.error);
        }
        const bytes = read.value;
        const claimed = await ledger.claim(key);
        if (claimed.isErr()) return err(claimed.error);
        if (!claimed.value) {
          return err({ message: "Recipient already claimed" });
        }
        const quarantine = verdictPolicy(n) === "quarantine";
        const imported = await delivery.import(
          recipient.destination,
          bytes,
          quarantine,
        );
        if (imported.isErr()) {
          const state =
            imported.error.ambiguous === true ? "uncertain" : "failed";
          const saved = await ledger.finish(
            key,
            state,
            undefined,
            imported.error.message,
          );
          if (saved.isErr()) return saved;
          events.emit("ingest_failure", {
            stage: state,
            messageId: n.mail.messageId,
            recipient: recipient.destination,
          });
          return state === "failed" ? err(imported.error) : ok(undefined);
        }
        const saved = await ledger.finish(
          key,
          quarantine ? "quarantined" : "imported",
          imported.value,
        );
        if (saved.isErr()) return saved;
        events.emit("ingest_imported", {
          messageId: n.mail.messageId,
          recipient: recipient.destination,
          delaySeconds: Math.max(
            0,
            (Date.now() - Date.parse(n.mail.timestamp)) / 1000,
          ),
        });
        return ok(undefined);
      }),
    );
    const firstFailure = outcomes.find((outcome) => outcome.isErr());
    // Re-read states, including concurrent claims, before considering source deletion.
    const current = await ledger.prepare(n, recipients);
    if (current.isErr()) return err(current.error);
    const allImported = current.value.every(
      (r) => r.state === "imported" || r.state === "quarantined",
    );
    const state = allImported ? "imported" : "failed";
    const updated = await ledger.messageState(n.mail.messageId, state);
    if (updated.isErr()) return updated;
    if (allImported) {
      const deleted = await storage.deleteBuffer(
        n.receipt.action.bucketName,
        n.receipt.action.objectKey,
      );
      if (deleted.isErr()) return deleted;
    }
    return firstFailure?.isErr() === true
      ? err(firstFailure.error)
      : ok(undefined);
  }
  async handle(
    queue: Queue,
    item: QueueMessage,
  ): Promise<Result<void, Failure>> {
    const result = await this.process(item.body);
    if (result.isErr()) {
      this.deps.events.emit("ingest_failure", {
        stage: "processing",
        attempts: item.attempts,
      });
      const delay = Math.min(900, 2 ** Math.min(item.attempts, 9));
      const deferred = await queue.defer(item.receipt, delay);
      return deferred.isErr() ? deferred : result;
    }
    return queue.delete(item.receipt);
  }
  async reconcile(maxAgeSeconds: number): Promise<Result<void, Failure>> {
    const list = await this.deps.storage.archives();
    if (list.isErr()) return err(list.error);
    const keys = await this.deps.storage.bufferKeys();
    if (keys.isErr()) return err(keys.error);
    const referenced = new Set<string>();
    const replay = async (index: number): Promise<number> => {
      const key = list.value[index];
      if (key === undefined) return 0;
      const body = await this.deps.storage.readArchive(key);
      let success = false;
      if (body.isOk()) {
        const n = parseNotification(body.value);
        if (n.isOk()) {
          referenced.add(n.value.receipt.action.objectKey);
          if (
            Date.now() - Date.parse(n.value.mail.timestamp) >
              maxAgeSeconds * 1000 &&
            keys.value.includes(n.value.receipt.action.objectKey)
          )
            this.deps.events.emit("ingest_notification_old", {
              messageId: n.value.mail.messageId,
            });
          success = (await this.process(body.value)).isOk();
        }
      }
      return (success ? 0 : 1) + (await replay(index + 1));
    };
    const failures = await replay(0);
    for (const key of keys.value)
      if (!referenced.has(key))
        this.deps.events.emit("ingest_buffer_without_notification", { key });
    return failures > 0
      ? err({ message: `${String(failures)} archived notifications failed` })
      : ok(undefined);
  }
}
