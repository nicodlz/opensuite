import type { Prisma, PrismaClient } from "./generated/index.js";

type Tx = Prisma.TransactionClient;
async function claim(
  tx: Tx,
  userId: string,
  id: string,
  from: string,
  to: string,
) {
  const op = await tx.organizedOperation.findFirst({
    where: { id, phase: from, series: { userId, pendingId: id } },
  });
  if (!op) return null;
  const updated = await tx.organizedOperation.updateMany({
    where: { id, phase: from },
    data: { phase: to },
  });
  return updated.count === 1 ? op : null;
}
async function release(tx: Tx, seriesId: string, userId: string, id: string) {
  const series = await tx.organizedSeries.updateMany({
    where: { id: seriesId, userId, pendingId: id },
    data: { pendingId: null, revision: { increment: 1 } },
  });
  if (series.count !== 1) throw new Error("Organized event changed");
}
export function transitionOrganized(
  db: PrismaClient,
  userId: string,
  id: string,
  from: string,
  to: string,
) {
  return db.organizedOperation
    .updateMany({
      where: { id, phase: from, series: { userId, pendingId: id } },
      data: { phase: to },
    })
    .then((result) => result.count === 1);
}
export function rejectOrganized(
  db: PrismaClient,
  userId: string,
  id: string,
  from: string,
) {
  return db.$transaction(async (tx) => {
    const op = await claim(tx, userId, id, from, "failed");
    if (!op) return false;
    await release(tx, op.seriesId, userId, id);
    return true;
  });
}
export function organizedCalendarWritten(
  db: PrismaClient,
  userId: string,
  id: string,
  from: string,
  eventId: string,
  snapshot: string,
  attendees: string[],
) {
  return db.$transaction(async (tx) => {
    const op = await claim(tx, userId, id, from, "calendarApplied");
    if (!op) return false;
    const updated = await tx.organizedSeries.updateMany({
      where: { id: op.seriesId, userId, pendingId: id },
      data: {
        eventId,
        snapshot,
        calendar: op.calendar,
        sequence: op.sequence,
        cancelled: op.cancelled,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("Organized event changed");
    await tx.organizedResponse.deleteMany({
      where: { seriesId: op.seriesId, attendee: { notIn: attendees } },
    });
    return true;
  });
}
export function transitionDelivery(
  db: PrismaClient,
  userId: string,
  operationId: string,
  id: string,
  from: string,
  to: string,
  changes: { draftId?: string; identityId?: string } = {},
) {
  return db.organizedDelivery
    .updateMany({
      where: {
        id,
        operationId,
        phase: from,
        operation: { series: { userId, pendingId: operationId } },
      },
      data: { phase: to, ...changes },
    })
    .then((result) => result.count === 1);
}
export function finishOrganized(db: PrismaClient, userId: string, id: string) {
  return db.$transaction(async (tx) => {
    const current = await tx.organizedOperation.findFirst({
      where: {
        id,
        phase: "calendarApplied",
        series: { userId, pendingId: id },
      },
      include: { deliveries: true },
    });
    if (
      !current ||
      current.deliveries.some(
        (item) =>
          item.phase !== "sent" &&
          item.phase !== "rejected" &&
          item.phase !== "rejected:sender",
      )
    )
      return false;
    const phase = current.deliveries.some((item) =>
      item.phase.startsWith("rejected"),
    )
      ? "failed"
      : "sent";
    const op = await claim(tx, userId, id, "calendarApplied", phase);
    if (!op) return false;
    await release(tx, op.seriesId, userId, id);
    return true;
  });
}
