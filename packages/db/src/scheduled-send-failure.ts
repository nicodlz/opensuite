import type { Prisma } from "./generated/index.js";
import type { ScheduledFailure, ScheduledRecord } from "./scheduled-send.ts";

export async function clearScheduledGuard(
  tx: Prisma.TransactionClient,
  row: ScheduledRecord,
) {
  await tx.mailDraftGuard.deleteMany({
    where: {
      userId: row.userId,
      accountId: row.accountId,
      draftId: row.draftId,
      token: row.id,
    },
  });
}
export async function failScheduled(
  tx: Prisma.TransactionClient,
  row: ScheduledRecord,
  reason: ScheduledFailure,
  token?: string,
) {
  const result = await tx.scheduledSend.updateMany({
    where: token
      ? { id: row.id, state: "preparing", leaseToken: token }
      : { id: row.id, state: { in: ["creating", "unknown"] } },
    data: {
      state: "failed",
      failureReason: reason,
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (result.count !== 1) return false;
  await clearScheduledGuard(tx, row);
  await tx.auditEvent.create({
    data: {
      userId: row.userId,
      action: "mail.scheduled.failed",
      detail: { scheduledId: row.id, reason },
    },
  });
  return true;
}
