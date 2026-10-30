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
  "held",
  "rerouted",
]);
type Client =
  ReturnType<typeof createDatabase> extends Result<infer T, infer _E>
    ? T
    : never;
const addressesOf = (row: { addresses: unknown }) =>
  z.array(z.string()).parse(row.addresses);
const isMailbox = (row: {
  idempotencyKey: string;
  messageId: string;
  destination: string;
}) => row.idempotencyKey === recipientKey(row.messageId, row.destination, true);
const failure = (cause: unknown) => ({
  message: cause instanceof Error ? cause.message : String(cause),
});
export function databaseLedger(db: Client): Ledger {
  return {
    prepare(notification, recipients, options) {
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
          // Addresses held as unknown may now be known: move them to the
          // mailbox recipient within this locked transaction.
          // Decided under the message lock, so a run that started inside the
          // hold window cannot route after it ends.
          const held =
            options?.rerouteUntil !== undefined &&
            Date.now() >= options.rerouteUntil
              ? []
              : existing.filter(
                  (row) => row.state === "held" && !isMailbox(row),
                );
          const recorded = new Set(
            existing
              .filter((row) => !held.includes(row))
              .flatMap((row) => addressesOf(row)),
          );
          const heldAddresses = new Set(
            held.flatMap((row) => addressesOf(row)),
          );
          const moved = new Set<string>();
          // Sequential: two recipients may update the same held row.
          await recipients.reduce<Promise<void>>(
            async (previousStep, recipient) => {
              await previousStep;
              const addresses = recipient.addresses.filter(
                (address) =>
                  !recorded.has(address) &&
                  (recipient.known || !heldAddresses.has(address)),
              );
              if (addresses.length === 0) return;
              for (const address of addresses) recorded.add(address);
              if (recipient.known)
                for (const address of addresses)
                  if (heldAddresses.has(address)) moved.add(address);
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
                      ...(previous === undefined ? [] : addressesOf(previous)),
                      ...addresses,
                    ]),
                  ],
                },
              });
            },
            Promise.resolve(),
          );
          await held.reduce<Promise<void>>(async (previousStep, row) => {
            await previousStep;
            const remaining = addressesOf(row).filter(
              (address) => !moved.has(address),
            );
            if (remaining.length === addressesOf(row).length) return;
            // Conditional: an operator rejection that won the race keeps
            // its decision; the conflict rolls this transaction back.
            const updated = await tx.inboundRecipient.updateMany({
              where: { idempotencyKey: row.idempotencyKey, state: "held" },
              data:
                remaining.length === 0
                  ? {
                      addresses: remaining,
                      state: "rerouted",
                      error: "Address became known and was routed",
                    }
                  : { addresses: remaining },
            });
            if (updated.count !== 1)
              throw new Error("Held recipient changed during routing");
          }, Promise.resolve());
          const rows = await tx.inboundRecipient.findMany({
            where: { messageId: n.mail.messageId },
          });
          return rows.map((row): LedgerRecipient => ({
            key: row.idempotencyKey,
            state: state.parse(row.state),
            attempts: row.attempts,
            destination: row.destination,
            permanent: row.permanent,
            legacy: row.legacy,
            importStartedAt: row.importStartedAt,
            known:
              row.idempotencyKey ===
              recipientKey(row.messageId, row.destination, true),
          }));
        }),
        failure,
      );
    },
    expireHeld(key, reason) {
      return ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          const row = await tx.inboundRecipient.findUnique({
            where: { idempotencyKey: key },
          });
          if (row?.state !== "held") return false;
          // Same lock as prepare and the operator command.
          await tx.$queryRaw`SELECT "id" FROM "InboundMessage" WHERE "id" = ${row.messageId} FOR UPDATE`;
          const updated = await tx.inboundRecipient.updateMany({
            where: { idempotencyKey: key, state: "held" },
            data: { state: "rejected", error: reason },
          });
          if (updated.count !== 1) return false;
          await tx.inboundResolutionAudit.create({
            data: {
              recipientKey: key,
              operator: "system:expiry",
              reason,
              action: "expire",
              previousState: "held",
              remoteId: null,
            },
          });
          return true;
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
              permanent: false,
            },
            data: {
              state: "importing",
              claimedAt: new Date(),
              claimOwner: owner,
              error: null,
              importStartedAt: null,
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
    startImport(key, owner) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              idempotencyKey: key,
              state: "importing",
              claimOwner: owner,
            },
            data: { importStartedAt: new Date() },
          })
          .then((result) => result.count === 1),
        failure,
      );
    },
    expireClaims() {
      return ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          const stale = {
            state: "importing",
            OR: [
              { claimedAt: null },
              { claimedAt: { lt: new Date(Date.now() - 600_000) } },
            ],
          };
          await tx.inboundRecipient.updateMany({
            where: { ...stale, importStartedAt: null, legacy: false },
            data: {
              state: "failed",
              claimOwner: null,
              claimedAt: null,
              error: "Import lease expired before import",
            },
          });
          await tx.inboundRecipient.updateMany({
            where: {
              ...stale,
            },
            data: {
              state: "uncertain",
              claimOwner: null,
              claimedAt: null,
              error: "Import lease expired",
            },
          });
        }),
        failure,
      );
    },
    retryUncertain(key, before) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .updateMany({
            where: {
              idempotencyKey: key,
              state: "uncertain",
              legacy: false,
              importStartedAt: { lte: before },
            },
            data: {
              state: "failed",
              error: "No keyword match after grace period",
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
              permanent: chargeAttempt,
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
          .updateMany({
            where: { state: "failed", permanent: false },
            data: { attempts: 0 },
          })
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
    recordedAddresses(messageId) {
      return ResultAsync.fromPromise(
        db.inboundRecipient
          .findMany({ where: { messageId }, select: { addresses: true } })
          .then((rows) => rows.flatMap((row) => addressesOf(row))),
        failure,
      );
    },
    importedMessages(ids) {
      return ResultAsync.fromPromise(
        db.inboundMessage
          .findMany({
            where: { id: { in: ids }, state: "imported" },
            select: { id: true },
          })
          .then((rows) => rows.map((row) => row.id)),
        failure,
      );
    },
  };
}
