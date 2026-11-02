import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

const PendingSchema = z.array(
  z.object({
    userId: z.string(),
    accountId: z.string(),
    address: z.email(),
    operationId: z.string(),
    updatedAt: z.date(),
  }),
);

/** Oldest attempts go first; claiming updates their age so a stuck item cannot starve others. */
export async function pendingOrganized(db: PrismaClient) {
  return PendingSchema.parse(
    await db.$queryRaw`
    SELECT s."userId", s."accountId", m."address", o."id" AS "operationId", o."updatedAt"
    FROM "OrganizedSeries" s
    JOIN "OrganizedOperation" o ON o."id" = s."pendingId" AND o."seriesId" = s."id"
    JOIN "User" u ON u."id" = s."userId" AND NOT u."disabled"
    JOIN "MailboxLink" m ON m."userId" = s."userId" AND m."accountId" = s."accountId" AND m."status" = 'active'
    WHERE o."updatedAt" <= CURRENT_TIMESTAMP - INTERVAL '1 minute'
    ORDER BY o."updatedAt", o."id"
    LIMIT 50
  `,
  );
}

export async function claimOrganizedRecovery(
  db: PrismaClient,
  userId: string,
  operationId: string,
  updatedAt: Date,
) {
  const claimed = await db.organizedOperation.updateMany({
    where: {
      id: operationId,
      updatedAt,
      series: { userId, pendingId: operationId },
    },
    data: { updatedAt: new Date() },
  });
  return claimed.count === 1;
}
