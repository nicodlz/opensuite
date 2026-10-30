// Database writes in each snapshot must occur in order within one transaction.
/* oxlint-disable eslint/no-await-in-loop */
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/index.js";

export interface PlannedCalendarReminder {
  calendarId: string;
  eventId: string;
  uid: string;
  occurrenceId: string;
  recurrenceKey: string;
  alarmId: string;
  occurrenceStart: Date;
  triggerAt: Date;
  title: string;
  location: string;
  timeZone: string;
  allDay: boolean;
}

export function createCalendarReminderStore(
  db: PrismaClient,
  publicKey?: string,
) {
  const fingerprint =
    publicKey === undefined
      ? null
      : createHash("sha256").update(publicKey).digest("hex");
  return {
    users() {
      return db.user.findMany({
        where: {
          disabled: false,
          mailbox: { is: { status: "active" } },
          pushSubscriptions: {
            some: {
              product: "calendar",
              ...(fingerprint === null
                ? {}
                : { vapidFingerprint: fingerprint }),
            },
          },
        },
        select: { id: true, email: true, calendarTimeZone: true },
      });
    },
    async acquire(userId: string, now: Date, until: Date, freshBefore?: Date) {
      const owner = randomUUID();
      await db.calendarReminderSync.createMany({
        data: [{ userId }],
        skipDuplicates: true,
      });
      const result = await db.calendarReminderSync.updateMany({
        where: {
          userId,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
          ...(freshBefore === undefined
            ? {}
            : {
                AND: [
                  {
                    OR: [
                      { lastSyncedAt: null },
                      { lastSyncedAt: { lte: freshBefore } },
                    ],
                  },
                ],
              }),
        },
        data: { owner, leaseUntil: until },
      });
      return result.count ? owner : null;
    },
    async release(userId: string, owner: string) {
      await db.calendarReminderSync.updateMany({
        where: { userId, owner },
        data: { owner: null, leaseUntil: null },
      });
    },
    async replace(
      userId: string,
      owner: string,
      now: Date,
      graceBefore: Date,
      planned: PlannedCalendarReminder[],
      expectedTimeZone?: string,
    ) {
      return db.$transaction(
        async (tx) => {
          const lock = await tx.$queryRaw<
            { owner: string | null; leaseUntil: Date | null }[]
          >`SELECT "owner", "leaseUntil" FROM "CalendarReminderSync" WHERE "userId" = ${userId} FOR UPDATE`;
          if (
            lock[0]?.owner !== owner ||
            !lock[0].leaseUntil ||
            lock[0].leaseUntil <= now
          )
            return false;
          if (expectedTimeZone !== undefined) {
            const user = await tx.user.findUnique({
              where: { id: userId },
              select: { calendarTimeZone: true },
            });
            if (user?.calendarTimeZone !== expectedTimeZone) return false;
          }
          await tx.calendarReminder.updateMany({
            where: { userId, state: "pending", claimUntil: { lte: now } },
            data: { claimOwner: null, claimUntil: null },
          });
          await tx.calendarReminder.updateMany({
            where: {
              userId,
              state: "pending",
              triggerAt: { lt: graceBefore },
              OR: [{ claimUntil: null }, { claimUntil: { lte: now } }],
            },
            data: { state: "skipped", claimOwner: null, claimUntil: null },
          });
          const existing = await tx.calendarReminder.findMany({
            where: {
              userId,
              state: "pending",
              OR: [{ claimUntil: null }, { claimUntil: { lte: now } }],
            },
            select: {
              id: true,
              uid: true,
              recurrenceKey: true,
              alarmId: true,
              occurrenceStart: true,
            },
          });
          const keys = new Set(
            planned.map((p) =>
              JSON.stringify([
                p.uid,
                p.recurrenceKey,
                p.alarmId,
                p.occurrenceStart.toISOString(),
              ]),
            ),
          );
          const removed = existing
            .filter(
              (p) =>
                !keys.has(
                  JSON.stringify([
                    p.uid,
                    p.recurrenceKey,
                    p.alarmId,
                    p.occurrenceStart.toISOString(),
                  ]),
                ),
            )
            .map((p) => p.id);
          if (removed.length)
            await tx.calendarReminder.deleteMany({
              where: {
                id: { in: removed },
                state: "pending",
                OR: [{ claimUntil: null }, { claimUntil: { lte: now } }],
              },
            });
          for (const item of planned) {
            const key = {
              userId,
              uid: item.uid,
              recurrenceKey: item.recurrenceKey,
              alarmId: item.alarmId,
              occurrenceStart: item.occurrenceStart,
            };
            await tx.calendarReminder.createMany({
              data: [{ ...item, userId }],
              skipDuplicates: true,
            });
            await tx.calendarReminder.updateMany({
              where: { ...key, state: "pending", claimOwner: null },
              data: item,
            });
          }
          await tx.calendarReminderSync.update({
            where: { userId },
            data: { lastSyncedAt: now },
          });
          return true;
        },
        { timeout: 60_000 },
      );
    },
    async claim(now: Date, until: Date, graceBefore: Date) {
      const owner = randomUUID();
      const rows = await db.$queryRaw<
        (PlannedCalendarReminder & { id: string; userId: string })[]
      >`
        UPDATE "CalendarReminder" AS r SET "claimOwner" = ${owner}, "claimUntil" = ${until}
        WHERE r."id" IN (
          SELECT c."id" FROM "CalendarReminder" c
          JOIN "User" u ON u."id" = c."userId"
          WHERE c."state" = 'pending' AND c."triggerAt" <= ${now} AND c."triggerAt" >= ${graceBefore}
            AND (c."claimUntil" IS NULL OR c."claimUntil" <= ${now})
            AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${now})
            AND NOT u."disabled"
            AND EXISTS (SELECT 1 FROM "MailboxLink" m WHERE m."userId" = c."userId" AND m."status" = 'active')
            AND EXISTS (SELECT 1 FROM "PushSubscription" s WHERE s."userId" = c."userId" AND s."product" = 'calendar' AND (${fingerprint}::text IS NULL OR s."vapidFingerprint" = ${fingerprint}))
            AND EXISTS (SELECT 1 FROM "CalendarReminderSync" x WHERE x."userId" = c."userId" AND x."lastSyncedAt" >= ${new Date(now.getTime() - 15 * 60_000)})
          ORDER BY c."triggerAt" FOR UPDATE OF c SKIP LOCKED LIMIT 1
        ) RETURNING r.*`;
      const row = rows[0];
      return row === undefined ? null : { ...row, owner };
    },
    async finish(
      id: string,
      owner: string,
      state: "sent" | "skipped" | "retry",
      next: Date,
    ) {
      await db.calendarReminder.updateMany({
        where: { id, state: "pending", claimOwner: owner },
        data: {
          state: state === "retry" ? "pending" : state,
          claimOwner: null,
          claimUntil: null,
          nextAttemptAt: state === "retry" ? next : null,
        },
      });
    },
    async skipExpired(before: Date) {
      await db.calendarReminder.updateMany({
        where: {
          state: "pending",
          triggerAt: { lt: before },
          OR: [{ claimUntil: null }, { claimUntil: { lte: before } }],
        },
        data: { state: "skipped", claimOwner: null, claimUntil: null },
      });
    },
    async purgeFinished(before: Date) {
      await db.calendarReminder.deleteMany({
        where: {
          state: { in: ["sent", "skipped"] },
          updatedAt: { lt: before },
        },
      });
    },
    showDetails(userId: string) {
      return db.user
        .findUniqueOrThrow({
          where: { id: userId },
          select: { pushShowDetails: true },
        })
        .then((user) => user.pushShowDetails);
    },
  };
}
