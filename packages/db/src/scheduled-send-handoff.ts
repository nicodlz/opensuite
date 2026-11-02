import type { Prisma, PrismaClient } from "./generated/index.js";
import { createLocked } from "./aliases-shared.ts";
import {
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
  const user = await tx.user.findUnique({
    where: { id: row.userId },
    select: {
      disabled: true,
      mailbox: { select: { accountId: true, address: true, status: true } },
    },
  });
  if (
    !user ||
    user.disabled ||
    !user.mailbox ||
    user.mailbox.status !== "active" ||
    user.mailbox.accountId !== row.accountId
  )
    return "account_inactive";
  const domainName = row.senderAddress.split("@")[1];
  if (!domainName) return "sender_unavailable";
  const domain = await tx.domain.findUnique({
    where: { name: domainName },
    select: { status: true, removalPending: true, stalwartId: true },
  });
  if (
    !domain ||
    domain.removalPending ||
    !domain.stalwartId ||
    !(configured.includes(domainName) || domain.status === "verified")
  )
    return "domain_unavailable";
  if (user.mailbox.address.toLowerCase() === row.senderAddress) return null;
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
  configured: readonly string[],
) {
  return createLocked(db)(row.userId, async (tx) => {
    const failure = await senderFailure(tx, row, configured);
    if (failure) {
      await failScheduled(tx, row, failure, token);
      return false;
    }
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
        leaseToken: null,
        leaseUntil: null,
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
      data: { state: "releasing", submissionId },
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
