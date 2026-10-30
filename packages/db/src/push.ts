import { createHash } from "node:crypto";
import type { PrismaClient } from "./generated/index.js";

type Product = "mail" | "calendar" | "drive";
type Subscription = {
  product: Product;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
  timeZone?: string | undefined;
};
export function createPushStore(db: PrismaClient, publicKey?: string) {
  const fingerprint =
    publicKey === undefined
      ? null
      : createHash("sha256").update(publicKey).digest("hex");
  return {
    async subscribe(
      userId: string,
      input: Subscription,
      sessionId?: string,
    ): Promise<boolean> {
      return db.$transaction(async (tx) => {
        // Serialize subscriptions for each user, including the limit check.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        if (fingerprint !== null)
          await tx.pushSubscription.deleteMany({
            where: {
              userId,
              OR: [
                { vapidFingerprint: null },
                { vapidFingerprint: { not: fingerprint } },
              ],
            },
          });
        const { timeZone, ...subscription } = input;
        const updateTimeZone = async () => {
          if (input.product !== "calendar" || timeZone === undefined) return;
          const changed = await tx.user.updateMany({
            where: { id: userId, calendarTimeZone: { not: timeZone } },
            data: { calendarTimeZone: timeZone },
          });
          if (changed.count)
            await tx.calendarReminderSync.updateMany({
              where: { userId },
              data: { lastSyncedAt: null },
            });
        };
        const where = {
          endpoint: input.endpoint,
          userId,
          product: input.product,
        };
        const data = {
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent,
          failureCount: 0,
          nextAttemptAt: null,
          vapidFingerprint: fingerprint,
          sessionId: sessionId ?? null,
        };
        if ((await tx.pushSubscription.updateMany({ where, data })).count) {
          await updateTimeZone();
          return true;
        }
        if ((await tx.pushSubscription.count({ where: { userId } })) >= 20)
          return false;
        const created = await tx.pushSubscription.createMany({
          data: [
            {
              ...subscription,
              userId,
              vapidFingerprint: fingerprint,
              sessionId: sessionId ?? null,
            },
          ],
          skipDuplicates: true,
        });
        const success =
          created.count === 1 ||
          (await tx.pushSubscription.updateMany({ where, data })).count > 0;
        if (success) await updateTimeZone();
        return success;
      });
    },
    async status(userId: string, product: Product, endpoint: string) {
      const where = { userId, product, endpoint };
      if (fingerprint !== null)
        await db.pushSubscription.deleteMany({
          where: {
            ...where,
            OR: [
              { vapidFingerprint: null },
              { vapidFingerprint: { not: fingerprint } },
            ],
          },
        });
      return (
        (await db.pushSubscription.count({
          where: {
            ...where,
            ...(fingerprint === null ? {} : { vapidFingerprint: fingerprint }),
          },
        })) > 0
      );
    },
    async setCalendarTimeZone(userId: string, timeZone: string) {
      await db.$transaction(async (tx) => {
        const changed = await tx.user.updateMany({
          where: { id: userId, calendarTimeZone: { not: timeZone } },
          data: { calendarTimeZone: timeZone },
        });
        if (changed.count)
          await tx.calendarReminderSync.updateMany({
            where: { userId },
            data: { lastSyncedAt: null },
          });
      });
    },
    async unsubscribe(userId: string, product: Product, endpoint: string) {
      await db.pushSubscription.deleteMany({
        where: { userId, product, endpoint },
      });
    },
    async unsubscribeSession(userId: string, sessionId: string) {
      await db.pushSubscription.deleteMany({ where: { userId, sessionId } });
    },
    async privacy(userId: string) {
      const user = await db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { pushShowDetails: true },
      });
      return user.pushShowDetails;
    },
    async setPrivacy(userId: string, showDetails: boolean) {
      await db.user.update({
        where: { id: userId },
        data: { pushShowDetails: showDetails },
      });
    },
    async claim(
      userId: string,
      product: Product,
      tag: string,
      now: Date,
      expiresAt: Date,
    ) {
      await db.pushTag.deleteMany({ where: { expiresAt: { lte: now } } });
      const result = await db.pushTag.createMany({
        data: [{ userId, product, tag, expiresAt }],
        skipDuplicates: true,
      });
      return result.count === 1;
    },
    async release(
      userId: string,
      product: Product,
      tag: string,
      expiresAt: Date,
    ) {
      await db.pushTag.deleteMany({
        where: { userId, product, tag, expiresAt },
      });
    },
    showDetails(userId: string) {
      return this.privacy(userId);
    },
    eligible(userId: string, product: Product, now: Date) {
      return db.pushSubscription.findMany({
        where: {
          userId,
          product,
          ...(fingerprint === null ? {} : { vapidFingerprint: fingerprint }),
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
      });
    },
    async success(id: string, now: Date) {
      await db.pushSubscription.updateMany({
        where: { id },
        data: { lastSuccessAt: now, failureCount: 0, nextAttemptAt: null },
      });
    },
    async purge(id: string) {
      await db.pushSubscription.deleteMany({ where: { id } });
    },
    async failure(id: string, _now: Date, next: Date) {
      await db.pushSubscription.updateMany({
        where: { id },
        data: { failureCount: { increment: 1 }, nextAttemptAt: next },
      });
    },
  };
}
