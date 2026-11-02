import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

const CandidateSchema = z.array(
  z.object({
    userId: z.string(),
    accountId: z.string(),
    address: z.email(),
    messageId: z.string(),
  }),
);
export function createOrganizedReplyScanStore(db: PrismaClient) {
  return {
    candidates: async () =>
      CandidateSchema.parse(
        await db.$queryRaw`
      WITH eligible AS (
        SELECT m."userId", m."accountId", m."address", r."remoteId" AS "messageId",
               COALESCE(scan."nextAttemptAt", r."updatedAt") AS due, r."idempotencyKey" AS key
        FROM "InboundRecipient" r
        JOIN "MailboxLink" m ON m."accountId" = r."destination" AND m."status" = 'active'
        JOIN "User" u ON u."id" = m."userId" AND NOT u."disabled"
        LEFT JOIN "OrganizedReplyScan" scan ON scan."userId" = m."userId" AND scan."accountId" = m."accountId" AND scan."messageId" = r."remoteId"
        WHERE r."state" = 'imported' AND r."remoteId" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "OrganizedSeries" series WHERE series."userId" = m."userId" AND series."accountId" = m."accountId"
            AND series."createdAt" <= r."updatedAt" + INTERVAL '5 minutes')
          AND (scan."userId" IS NULL OR (NOT scan."finished" AND scan."nextAttemptAt" <= CURRENT_TIMESTAMP)
            OR (scan."outcome" = 'pending' AND EXISTS (SELECT 1 FROM "OrganizedSeries" series
              WHERE series."userId" = m."userId" AND series."accountId" = m."accountId" AND series."uid" = scan."uid" AND series."pendingId" IS NULL)))
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY due, key) AS position FROM eligible
      )
      SELECT "userId", "accountId", "address", "messageId" FROM ranked ORDER BY position, due, key LIMIT 50
    `,
      ),
    record: async (input: {
      userId: string;
      accountId: string;
      messageId: string;
      outcome: string;
      uid: string | null;
      finished: boolean;
      nextAttemptAt: Date | null;
    }) => {
      const { userId, accountId, messageId, ...data } = input;
      await db.organizedReplyScan.createMany({
        data: [{ userId, accountId, messageId, ...data }],
        skipDuplicates: true,
      });
      await db.organizedReplyScan.updateMany({
        where: {
          userId,
          accountId,
          messageId,
          OR: [{ finished: false }, { outcome: "pending" }],
        },
        data,
      });
    },
    unverified: (userId: string, accountId: string, after?: string) =>
      db.organizedReplyScan.findMany({
        where: {
          userId,
          accountId,
          outcome: "unverified",
          ...(after ? { messageId: { gt: after } } : {}),
        },
        orderBy: { messageId: "asc" },
        take: 101,
        select: { messageId: true },
      }),
  };
}
export type OrganizedReplyScanStore = ReturnType<
  typeof createOrganizedReplyScanStore
>;
