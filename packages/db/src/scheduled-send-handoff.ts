import type { Prisma, PrismaClient } from "./generated/index.js";
import { HANDOFF_TIMEOUT_MS, tryLockHandoff } from "./scheduled-send-guard.ts";
import {
  activeSenderMailbox,
  usableSendDomain,
  findAllowedAddress,
  findAllowedAlias,
  usableAddressDomain,
} from "./sender-authorization.ts";
import { failScheduled } from "./scheduled-send-failure.ts";
import type { ScheduledFailure, ScheduledRecord } from "./scheduled-send.ts";

async function senderFailure(
  tx: Prisma.TransactionClient,
  row: ScheduledRecord,
  configured: readonly string[],
): Promise<ScheduledFailure | null> {
  const mailbox = await activeSenderMailbox(tx, row.userId, row.accountId);
  if (!mailbox) return "account_inactive";
  const domainName = row.senderAddress.split("@")[1];
  if (!domainName) return "sender_unavailable";
  if (!(await usableSendDomain(tx, domainName, configured)))
    return "domain_unavailable";
  if (mailbox.address.toLowerCase() === row.senderAddress) return null;
  if (await findAllowedAlias(tx, row.userId, row.senderAddress)) return null;
  return (await findAllowedAddress(
    tx,
    row.userId,
    row.senderAddress,
    usableAddressDomain(configured),
  ))
    ? null
    : "sender_unavailable";
}

export function beginScheduledHandoff(
  db: PrismaClient,
  row: ScheduledRecord,
  token: string,
  now: () => number,
  previousIds: string[],
) {
  return db.$transaction(async (tx) => {
    const result = await tx.scheduledSend.updateMany({
      where: {
        id: row.id,
        state: "preparing",
        leaseToken: token,
        leaseUntil: { gt: new Date(now()) },
      },
      data: {
        state: "creating",
        previousIds,
      },
    });
    if (result.count !== 1) return false;
    await tx.auditEvent.create({
      data: {
        userId: row.userId,
        action: "mail.scheduled.handoff_started",
        detail: { scheduledId: row.id },
      },
    });
    return true;
  });
}

type HandoffResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "unknown" | "refused" | "stale" | "deferred" };
type DbClient = PrismaClient | Prisma.TransactionClient;

async function deferUnissued(
  db: DbClient,
  row: ScheduledRecord,
  token: string,
) {
  await db.scheduledSend.updateMany({
    where: {
      id: row.id,
      state: { in: ["creating", "unknown"] },
      leaseToken: token,
    },
    data: { state: "pending", leaseToken: null, leaseUntil: null },
  });
}

async function issueWithDeadline<T>(
  tx: Prisma.TransactionClient,
  row: ScheduledRecord,
  token: string,
  remaining: number,
  controller: AbortController,
  submit: (signal: AbortSignal) => Promise<T>,
): Promise<HandoffResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HandoffResult<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "unknown" });
    }, remaining);
  });
  let result: HandoffResult<T>;
  try {
    result = await Promise.race([
      submit(controller.signal).then(
        (value): HandoffResult<T> => ({ kind: "completed", value }),
        (): HandoffResult<T> => ({ kind: "unknown" }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  await tx.scheduledSend.updateMany({
    where: {
      id: row.id,
      state: { in: ["creating", "unknown"] },
      leaseToken: token,
    },
    data: {
      ...(result.kind === "unknown" ? { state: "unknown" } : {}),
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return result;
}

export async function guardedScheduledHandoff<T>(
  db: PrismaClient,
  row: ScheduledRecord,
  token: string,
  configured: readonly string[],
  submit: (signal: AbortSignal) => Promise<T>,
): Promise<HandoffResult<T>> {
  const started = performance.now();
  let active = true;
  let issued = false;
  let controller: AbortController | undefined;
  const canIssue = () => active;
  const requestIssued = () => issued;
  try {
    return await db.$transaction(
      async (tx) => {
        // PostgreSQL enforces the deadline even if a database statement blocks.
        await tx.$executeRaw`SELECT set_config('transaction_timeout', ${`${String(HANDOFF_TIMEOUT_MS)}ms`}, true)`;
        if (!(await tryLockHandoff(tx))) {
          await deferUnissued(tx, row, token);
          return { kind: "deferred" };
        }
        if (!canIssue()) return { kind: "stale" };
        const current = await tx.scheduledSend.findUnique({
          where: { id: row.id },
          select: { state: true, leaseToken: true },
        });
        if (
          !current ||
          current.leaseToken !== token ||
          !["creating", "unknown"].includes(current.state)
        )
          return { kind: "stale" };
        const failure = await senderFailure(tx, row, configured);
        if (!canIssue()) return { kind: "stale" };
        if (failure) {
          await failScheduled(tx, row, failure);
          return { kind: "refused" };
        }
        const remaining =
          HANDOFF_TIMEOUT_MS - (performance.now() - started) - 250;
        if (remaining <= 0) {
          await deferUnissued(tx, row, token);
          return { kind: "deferred" };
        }
        controller = new AbortController();
        return issueWithDeadline(
          tx,
          row,
          token,
          remaining,
          controller,
          (signal) => {
            if (
              !canIssue() ||
              performance.now() - started >= HANDOFF_TIMEOUT_MS
            )
              throw new Error("handoff transaction expired");
            issued = true;
            return submit(signal);
          },
        );
      },
      { timeout: HANDOFF_TIMEOUT_MS, maxWait: 5_000 },
    );
  } catch (error) {
    active = false;
    controller?.abort();
    if (requestIssued()) throw error;
    await deferUnissued(db, row, token);
    return { kind: "deferred" };
  } finally {
    active = false;
    controller?.abort();
  }
}

export async function acceptScheduledHandoff(
  db: PrismaClient,
  row: ScheduledRecord,
  submissionId: string,
) {
  return db.$transaction(async (tx) => {
    const result = await tx.scheduledSend.updateMany({
      where: {
        id: row.id,
        state: { in: ["creating", "unknown", "canceling"] },
      },
      data: {
        state: "releasing",
        submissionId,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    if (result.count !== 1) return false;
    await tx.auditEvent.create({
      data: {
        userId: row.userId,
        action: "mail.scheduled.handoff_accepted",
        detail: { scheduledId: row.id, submissionId },
      },
    });
    return true;
  });
}
