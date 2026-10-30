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
const identitySchema = z.string().trim().min(1).max(200);
const reasonSchema = z.string().trim().min(8).max(1000);

export async function operatorCommand(
  deps: Dependencies,
  args: string[],
): Promise<unknown> {
  const expired = await deps.ledger.expireClaims();
  if (expired.isErr()) throw new Error("Could not expire claims");
  const [command, rawKey, action, remote, actor, explanation] = args;
  if (command === "list" && args.length <= 2) {
    const after = rawKey === undefined ? undefined : keySchema.parse(rawKey);
    const rows = await deps.db.inboundRecipient.findMany({
      where: {
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
      ...(after === undefined
        ? {}
        : { cursor: { idempotencyKey: after }, skip: 1 }),
      take: 200,
    });
    return {
      rows,
      nextCursor: rows.length === 200 ? rows.at(-1)?.idempotencyKey : null,
    };
  }
  const key = keySchema.parse(rawKey);
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
