import type { Result } from "neverthrow";
import { ResultAsync } from "neverthrow";
import { z } from "zod";
import { recipientKey } from "../ingest/service.ts";
import type {
  Ledger,
  LedgerRecipient,
  RecipientState,
} from "../ingest/contracts.ts";
import type { createDatabase } from "@opensuite/db";

const state = z.enum([
  "received",
  "importing",
  "imported",
  "quarantined",
  "failed",
  "rejected",
  "uncertain",
]);
type Client =
  ReturnType<typeof createDatabase> extends Result<infer T, infer _E>
    ? T
    : never;
const failure = (cause: unknown) => ({
  message: cause instanceof Error ? cause.message : String(cause),
});
export function databaseLedger(db: Client): Ledger {
  return {
    prepare(notification, recipients) {
      return ResultAsync.fromPromise(
        (async () => {
          const n = notification;
          const stored = await db.inboundMessage.upsert({
            where: { id: n.mail.messageId },
            create: {
              id: n.mail.messageId,
              bucket: n.receipt.action.bucketName,
              objectKey: n.receipt.action.objectKey,
              notification: JSON.stringify(n),
              receivedAt: new Date(n.mail.timestamp),
            },
            update: {},
          });
          if (
            stored.bucket !== n.receipt.action.bucketName ||
            stored.objectKey !== n.receipt.action.objectKey
          )
            throw new Error("Conflicting message identity and object locator");
          await Promise.all(
            recipients.map(async (recipient) => {
              const key = recipientKey(
                n.mail.messageId,
                recipient.destination,
                recipient.known,
              );
              await db.inboundRecipient.upsert({
                where: { idempotencyKey: key },
                create: {
                  idempotencyKey: key,
                  messageId: n.mail.messageId,
                  destination: recipient.destination,
                  addresses: recipient.addresses,
                },
                update: {},
              });
            }),
          );
          const rows = await db.inboundRecipient.findMany({
            where: { messageId: n.mail.messageId },
          });
          return rows.map((row): LedgerRecipient => ({
            key: row.idempotencyKey,
            state: state.parse(row.state),
            attempts: row.attempts,
          }));
        })(),
        failure,
      );
    },
    claim(key) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              idempotencyKey: key,
              state: { in: ["received", "failed"] },
            },
            data: {
              state: "importing",
              attempts: { increment: 1 },
              error: null,
            },
          })
          .then((result) => result.count === 1),
        failure,
      );
    },
    finish(
      key: string,
      status: RecipientState,
      remoteId?: string,
      error?: string,
    ) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .update({
            where: { idempotencyKey: key },
            data: {
              state: status,
              remoteId: remoteId ?? null,
              error: error ?? null,
            },
          })
          .then(() => undefined),
        failure,
      );
    },
    resetFailures() {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({ where: { state: "failed" }, data: { attempts: 0 } })
          .then(() => undefined),
        failure,
      );
    },
    messageState(id, status) {
      return ResultAsync.fromPromise(
        db.inboundMessage
          .update({ where: { id }, data: { state: status } })
          .then(() => undefined),
        failure,
      );
    },
  };
}
