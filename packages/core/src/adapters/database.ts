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
        db.$transaction(async (tx) => {
          const n = notification;
          const stored = await tx.inboundMessage.upsert({
            where: { id: n.mail.messageId },
            create: {
              id: n.mail.messageId,
              bucket: n.receipt.action.bucketName,
              objectKey: n.receipt.action.objectKey,
              notification: z.record(z.string(), z.json()).parse(n),
              receivedAt: new Date(n.mail.timestamp),
            },
            update: {},
          });
          if (
            stored.bucket !== n.receipt.action.bucketName ||
            stored.objectKey !== n.receipt.action.objectKey
          )
            throw new Error("Conflicting message identity and object locator");
          await tx.$queryRaw`SELECT "id" FROM "InboundMessage" WHERE "id" = ${n.mail.messageId} FOR UPDATE`;
          const existing = await tx.inboundRecipient.findMany({
            where: { messageId: n.mail.messageId },
          });
          const recorded = new Set(
            existing.flatMap((row) => z.array(z.string()).parse(row.addresses)),
          );
          await Promise.all(
            recipients.map(async (recipient) => {
              const addresses = recipient.addresses.filter(
                (address) => !recorded.has(address),
              );
              if (addresses.length === 0) return;
              const key = recipientKey(
                n.mail.messageId,
                recipient.destination,
                recipient.known,
              );
              const previous = existing.find(
                (row) => row.idempotencyKey === key,
              );
              await tx.inboundRecipient.upsert({
                where: { idempotencyKey: key },
                create: {
                  idempotencyKey: key,
                  messageId: n.mail.messageId,
                  destination: recipient.destination,
                  addresses,
                },
                update: {
                  addresses: [
                    ...new Set([
                      ...(previous === undefined
                        ? []
                        : z.array(z.string()).parse(previous.addresses)),
                      ...addresses,
                    ]),
                  ],
                },
              });
            }),
          );
          const rows = await tx.inboundRecipient.findMany({
            where: { messageId: n.mail.messageId },
          });
          return rows.map((row): LedgerRecipient => ({
            key: row.idempotencyKey,
            state: state.parse(row.state),
            attempts: row.attempts,
            destination: row.destination,
            known:
              row.idempotencyKey ===
              recipientKey(row.messageId, row.destination, true),
          }));
        }),
        failure,
      );
    },
    claim(key, owner) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              idempotencyKey: key,
              state: { in: ["received", "failed"] },
            },
            data: {
              state: "importing",
              claimedAt: new Date(),
              claimOwner: owner,
              error: null,
            },
          })
          .then((result) => result.count === 1),
        failure,
      );
    },
    renew(key, owner) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              idempotencyKey: key,
              state: "importing",
              claimOwner: owner,
            },
            data: { claimedAt: new Date() },
          })
          .then((result) => result.count === 1),
        failure,
      );
    },
    expireClaims() {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              state: "importing",
              OR: [
                { claimedAt: null },
                { claimedAt: { lt: new Date(Date.now() - 600_000) } },
              ],
            },
            data: {
              state: "uncertain",
              claimOwner: null,
              claimedAt: null,
              error: "Import lease expired",
            },
          })
          .then(() => undefined),
        failure,
      );
    },
    finish(
      key: string,
      status: RecipientState,
      remoteId?: string,
      error?: string,
      owner?: string,
      chargeAttempt = false,
    ) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              idempotencyKey: key,
              ...(owner === undefined
                ? { state: { in: ["received", "uncertain"] } }
                : { state: "importing", claimOwner: owner }),
            },
            data: {
              state: status,
              remoteId: remoteId ?? null,
              error: error ?? null,
              claimedAt: null,
              claimOwner: null,
              ...(chargeAttempt ? { attempts: { increment: 1 } } : {}),
            },
          })
          .then((result) => {
            if (result.count !== 1)
              throw new Error("Recipient state or claim changed");
            return undefined;
          }),
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
