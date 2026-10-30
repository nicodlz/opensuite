import { parseNotification, verdictPolicy } from "@opensuite/core";
import { z } from "zod";
import type { Delivery, Ledger, Storage } from "@opensuite/core";
import type { createDatabase } from "@opensuite/db";
import type { Result } from "neverthrow";

type Client =
  ReturnType<typeof createDatabase> extends Result<infer T, infer _E>
    ? T
    : never;
type Dependencies = {
  db: Client;
  ledger: Ledger;
  delivery: Delivery;
  storage: Storage;
};
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
// `system:` identities are reserved for automatic actions such as expiry.
const identitySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.toLowerCase().startsWith("system:"));
const reasonSchema = z.string().trim().min(8).max(1000);

export async function operatorCommand(
  deps: Dependencies,
  args: string[],
): Promise<unknown> {
  const expired = await deps.ledger.expireClaims();
  if (expired.isErr()) throw new Error("Could not expire claims");
  const [command, rawKey, action, remote, actor, explanation] = args;
  if (command === "list" && args.length <= 3) {
    // `list held [cursor]` shows held recipients; `list [cursor]` the rows
    // that need an operator decision, without the held backlog.
    const onlyHeld = rawKey === "held";
    const cursor = onlyHeld ? action : rawKey;
    if (!onlyHeld && args.length === 3)
      throw new Error("Invalid operator command");
    const after = cursor === undefined ? undefined : keySchema.parse(cursor);
    // Key-ordered paging that stays correct when the cursor row has left
    // the filter (for example a held row expired by replay).
    const page = after === undefined ? {} : { idempotencyKey: { gt: after } };
    const rows = await deps.db.inboundRecipient.findMany({
      where: onlyHeld
        ? { state: "held", ...page }
        : {
            ...page,
            OR: [
              { state: "uncertain" },
              { state: "importing" },
              { state: "failed", permanent: true },
            ],
          },
      select: {
        idempotencyKey: true,
        messageId: true,
        destination: true,
        state: true,
        claimedAt: true,
        importStartedAt: true,
        legacy: true,
        permanent: true,
        error: true,
      },
      orderBy: { idempotencyKey: "asc" },
      take: 200,
    });
    return {
      rows,
      nextCursor: rows.length === 200 ? rows.at(-1)?.idempotencyKey : null,
    };
  }
  const key = keySchema.parse(rawKey);
  // An unknown recipient is held with its message until its address is
  // provisioned (a replay then routes it) or an operator rejects it here.
  // Rejecting lets the next replay delete the stored message object.
  if (command === "reject") {
    if (args.length !== 4) throw new Error("Invalid operator command");
    const operator = identitySchema.parse(action);
    const reason = reasonSchema.parse(remote);
    return deps.db.$transaction(async (tx) => {
      const found = await tx.inboundRecipient.findUnique({
        where: { idempotencyKey: key },
      });
      if (found === null)
        throw new Error("Only a held recipient can be rejected");
      // Take the message lock that routing holds, then read the row again.
      await tx.$queryRaw`SELECT "id" FROM "InboundMessage" WHERE "id" = ${found.messageId} FOR UPDATE`;
      const row = await tx.inboundRecipient.findUnique({
        where: { idempotencyKey: key },
      });
      if (row === null || row.state !== "held")
        throw new Error("Only a held recipient can be rejected");
      const updated = await tx.inboundRecipient.updateMany({
        where: { idempotencyKey: key, state: "held", updatedAt: row.updatedAt },
        data: { state: "rejected", error: "Rejected by operator" },
      });
      if (updated.count !== 1)
        throw new Error("Recipient changed; inspect it again");
      await tx.inboundResolutionAudit.create({
        data: {
          recipientKey: key,
          operator,
          reason,
          action: "reject",
          previousState: "held",
          remoteId: null,
        },
      });
      return { key, action: "reject" };
    });
  }
  if (
    (command !== "inspect" || args.length !== 2) &&
    (command !== "resolve" || args.length !== 6)
  )
    throw new Error("Invalid operator command");
  const row = await deps.db.inboundRecipient.findUnique({
    where: { idempotencyKey: key },
    include: { message: true },
  });
  if (
    row === null ||
    !(row.state === "uncertain" || (row.state === "failed" && row.permanent))
  )
    throw new Error(
      "Recipient is not resolvable; live claims cannot be changed",
    );
  const notification = parseNotification(
    JSON.stringify(row.message.notification),
  );
  if (notification.isErr()) throw new Error("Stored notification is invalid");
  const n = notification.value;
  const bytes = await deps.storage.readBuffer(
    row.message.bucket,
    row.message.objectKey,
  );
  if (bytes.isErr()) throw new Error("Cannot read original message");
  const quarantine = verdictPolicy(n) === "quarantine";
  // Legacy rows may have been imported without the keyword or expected timestamp.
  const matches = await deps.delivery.reconcile(
    row.destination,
    bytes.value,
    quarantine,
    n.mail.timestamp,
    key,
    row.legacy,
  );
  if (matches.isErr())
    throw new Error(`Mailbox search failed: ${matches.error.message}`);
  if (command === "inspect")
    return { key, legacy: row.legacy, matches: matches.value };
  const operator = identitySchema.parse(actor);
  const reason = reasonSchema.parse(explanation);
  if (action !== "imported" && action !== "retry")
    throw new Error("Action must be imported or retry");
  if (
    action === "imported" &&
    (remote === undefined || !matches.value.includes(remote))
  )
    throw new Error("Remote ID must be a verified candidate");
  if (action === "retry" && (remote !== "-" || matches.value.length !== 0))
    throw new Error("Retry requires '-' and no verified matches");
  const remoteId = action === "imported" ? remote : undefined;
  await deps.db.$transaction(async (tx) => {
    const updated = await tx.inboundRecipient.updateMany({
      where: {
        idempotencyKey: key,
        state: row.state,
        updatedAt: row.updatedAt,
      },
      data: {
        state:
          action === "retry"
            ? "failed"
            : quarantine
              ? "quarantined"
              : "imported",
        remoteId: remoteId ?? null,
        error: null,
        permanent: false,
        legacy: false,
        attempts: 0,
        claimOwner: null,
        claimedAt: null,
      },
    });
    if (updated.count !== 1)
      throw new Error("Recipient changed; inspect it again");
    await tx.inboundResolutionAudit.create({
      data: {
        recipientKey: key,
        operator,
        reason,
        action,
        previousState: row.state,
        remoteId: remoteId ?? null,
      },
    });
  });
  return {
    key,
    action,
    remoteId: remoteId ?? null,
    matches: matches.value.length,
  };
}
