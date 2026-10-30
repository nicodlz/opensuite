import {
  parseNotification,
  recoverFirehose,
  recoverObjects,
  verdictPolicy,
} from "@opensuite/core";
import { z } from "zod";
import type {
  Delivery,
  Ledger,
  RecoveryScope,
  RecoveryStore,
  Storage,
} from "@opensuite/core";
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
  recovery?: { store: RecoveryStore; scope: RecoveryScope };
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

const unconfigured = "Destination is not configured";
const notRejectable =
  "Only a held recipient, one whose destination is not configured or a permanent failure can be rejected";
export async function operatorCommand(
  deps: Dependencies,
  args: string[],
): Promise<unknown> {
  const expired = await deps.ledger.expireClaims();
  if (expired.isErr()) throw new Error("Could not expire claims");
  const [command, rawKey, action, remote, actor, explanation] = args;
  if (command === "recover") return recover(deps, args.slice(1));
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
  // So can a recipient whose mailbox was disabled after routing, which
  // otherwise fails without end. Rejecting lets the next replay delete the
  // stored message object.
  if (command === "reject") {
    if (args.length !== 4) throw new Error("Invalid operator command");
    const operator = identitySchema.parse(action);
    const reason = reasonSchema.parse(remote);
    return deps.db.$transaction(async (tx) => {
      const found = await tx.inboundRecipient.findUnique({
        where: { idempotencyKey: key },
      });
      if (found === null) throw new Error(notRejectable);
      // Take the message lock that routing holds, then read the row again.
      await tx.$queryRaw`SELECT "id" FROM "InboundMessage" WHERE "id" = ${found.messageId} FOR UPDATE`;
      const row = await tx.inboundRecipient.findUnique({
        where: { idempotencyKey: key },
      });
      if (
        row === null ||
        !(
          row.state === "held" ||
          (row.state === "failed" &&
            (row.error === unconfigured || row.permanent))
        )
      )
        throw new Error(notRejectable);
      // A mailbox that is usable again (re-enabled, or linked delivery off)
      // would receive this mail on the next replay: never discard it. A
      // permanent failure (a copy elsewhere in the mailbox, an original that
      // is gone) is the operator's decision to close.
      if (
        row.state === "failed" &&
        !row.permanent &&
        (await tx.mailboxLink.count({
          where: {
            accountId: row.destination,
            status: "active",
            user: { disabled: false },
          },
        })) > 0
      )
        throw new Error("Mailbox is active; run replay instead");
      const updated = await tx.inboundRecipient.updateMany({
        where: {
          idempotencyKey: key,
          state: row.state,
          updatedAt: row.updatedAt,
        },
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
          previousState: row.state,
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

const isoDate = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));
/**
 * `recover firehose OPERATOR PREFIX [SINCE] [UNTIL] [--apply]` copies
 * notifications from the Firehose archive into the replay archive;
 * `recover objects OPERATOR [--apply]` restores the stored versions of the
 * MIME objects unfinished messages need. Both only report unless `--apply`
 * is given; applied runs are recorded in the audit log.
 */
async function recover(deps: Dependencies, args: string[]) {
  if (deps.recovery === undefined)
    throw new Error("Recovery is not configured");
  const apply = args.at(-1) === "--apply";
  const [kind, rawOperator, ...rest] = apply ? args.slice(0, -1) : args;
  const operator = identitySchema.parse(rawOperator);
  const { store, scope } = deps.recovery;
  let result;
  let detail: Record<string, unknown>;
  if (kind === "firehose" && rest.length >= 1 && rest.length <= 3) {
    const [prefix, since, until] = rest;
    const options = {
      prefix: z.string().min(1).parse(prefix),
      apply,
      ...(since === undefined ? {} : { since: isoDate.parse(since) }),
      ...(until === undefined ? {} : { until: isoDate.parse(until) }),
    };
    result = await recoverFirehose(store, scope, options);
    detail = { prefix, since, until };
  } else if (kind === "objects" && rest.length === 0) {
    result = await recoverObjects(store, deps.storage, deps.ledger, scope, {
      apply,
    });
    detail = {};
  } else throw new Error("Invalid operator command");
  if (apply && result.isErr())
    // A run that stopped early is recorded too.
    await deps.db.auditEvent.create({
      data: {
        userId: null,
        action: `ingest.recover.${kind}`,
        detail: { operator, ...detail, error: result.error.message },
      },
    });
  if (result.isErr())
    throw new Error(`Recovery failed: ${result.error.message}`);
  if (apply) {
    // Counts only: message IDs and addresses stay in the operator's output.
    const counts = Object.fromEntries(
      Object.entries(result.value).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.length : value,
      ]),
    );
    await deps.db.auditEvent.create({
      data: {
        userId: null,
        action: `ingest.recover.${kind}`,
        detail: { operator, ...detail, ...counts },
      },
    });
  }
  return result.value;
}

/**
 * Whether a recovery report leaves work undone: the command then exits with
 * a failure so that a scripted run cannot mistake it for success.
 */
export const recoveryIncomplete = (report: unknown) => {
  const parsed = z
    .object({
      failed: z.number(),
      unreadable: z.number().optional(),
      unrecoverable: z.array(z.unknown()).optional(),
      // Messages replay skips: object recovery lists their IDs, Firehose
      // recovery every variant group with whether it can be merged.
      divergent: z
        .array(z.union([z.string(), z.object({ mergeable: z.boolean() })]))
        .optional(),
    })
    .safeParse(report);
  return (
    parsed.success &&
    (parsed.data.failed > 0 ||
      (parsed.data.unreadable ?? 0) > 0 ||
      (parsed.data.unrecoverable ?? []).length > 0 ||
      (parsed.data.divergent ?? []).some(
        (item) => typeof item === "string" || !item.mergeable,
      ))
  );
};
