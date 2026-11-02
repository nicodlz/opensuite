import type { PrismaClient } from "./generated/index.js";

export function recordOrganizedResponse(
  db: PrismaClient,
  input: {
    seriesId: string;
    userId: string;
    revision: number;
    sequence: number;
    attendee: string;
    occurrence: string;
    timestamp: number;
    partstat: string;
  },
) {
  return db.$transaction(async (tx) => {
    const locked = await tx.organizedSeries.updateMany({
      where: {
        id: input.seriesId,
        userId: input.userId,
        revision: input.revision,
        sequence: input.sequence,
        pendingId: null,
        cancelled: false,
      },
      data: { revision: { increment: 1 } },
    });
    if (locked.count !== 1) return "retry" as const;
    const key = {
      seriesId: input.seriesId,
      attendee: input.attendee,
      occurrence: input.occurrence,
    };
    const previous = await tx.organizedResponse.findUnique({
      where: { seriesId_attendee_occurrence: key },
    });
    const timestamp = BigInt(input.timestamp);
    if (
      previous &&
      previous.sequence === input.sequence &&
      timestamp <= previous.timestamp
    ) {
      if (timestamp < previous.timestamp) return "stale" as const;
      return previous.partstat === input.partstat
        ? ("duplicate" as const)
        : ("conflict" as const);
    }
    await tx.organizedResponse.upsert({
      where: { seriesId_attendee_occurrence: key },
      create: {
        ...key,
        sequence: input.sequence,
        timestamp,
        partstat: input.partstat,
      },
      update: {
        sequence: input.sequence,
        timestamp,
        partstat: input.partstat,
      },
    });
    return "applied" as const;
  });
}
