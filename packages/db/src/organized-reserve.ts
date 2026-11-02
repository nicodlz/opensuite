import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/index.js";

export type SeriesInput = {
  id: string;
  userId: string;
  accountId: string;
  uid: string;
  organizer: string;
  calendarId: string;
};
export type OperationInput = {
  id: string;
  fingerprint: string;
  calendar: string;
  baseSnapshot: string | null;
  sequence: number;
  cancelled: boolean;
  deliveries: { recipient: string; method: string; calendar: string }[];
};
const full = { series: true, deliveries: true } as const;

export function reserveOrganized(
  db: PrismaClient,
  series: SeriesInput,
  input: OperationInput,
  revision: number | null,
) {
  return db.$transaction(async (tx) => {
    const existing = await tx.organizedOperation.findUnique({
      where: { id: input.id },
      include: full,
    });
    if (existing)
      return existing.series.userId === series.userId &&
        existing.fingerprint === input.fingerprint
        ? existing
        : null;
    if (revision === null)
      await tx.organizedSeries.createMany({
        data: [series],
        skipDuplicates: true,
      });
    const locked = await tx.organizedSeries.updateMany({
      where: {
        ...series,
        pendingId: null,
        revision: revision ?? 0,
        cancelled: false,
      },
      data: { pendingId: input.id, revision: { increment: 1 } },
    });
    if (locked.count !== 1) return null;
    return tx.organizedOperation.create({
      data: {
        id: input.id,
        seriesId: series.id,
        fingerprint: input.fingerprint,
        phase: "reserved",
        calendar: input.calendar,
        baseSnapshot: input.baseSnapshot,
        sequence: input.sequence,
        cancelled: input.cancelled,
        deliveries: {
          create: input.deliveries.map((item) => ({
            ...item,
            id: randomUUID(),
            phase: "reserved",
          })),
        },
      },
      include: full,
    });
  });
}
