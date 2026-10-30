import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/index.js";

/** Persistent cursor and short fenced lease shared by API instances. */
export function createMailPushStore(db: PrismaClient, publicKey?: string) {
  const subscription = {
    product: "mail",
    ...(publicKey === undefined
      ? {}
      : {
          vapidFingerprint: createHash("sha256")
            .update(publicKey)
            .digest("hex"),
        }),
  };
  return {
    async users() {
      const links = await db.mailboxLink.findMany({
        where: {
          status: "active",
          user: {
            disabled: false,
            pushSubscriptions: { some: subscription },
          },
        },
        select: { userId: true, accountId: true },
        orderBy: { userId: "asc" },
      });
      return links;
    },
    async claim(userId: string, accountId: string) {
      const token = randomUUID();
      const now = new Date();
      // Lock the subscription transition, so a newly inserted cursor cannot
      // survive an unsubscribe/resubscribe cycle.
      return db.$transaction(async (tx) => {
        // Match subscription creation's row-lock ordering before taking its
        // advisory lock; the cursor insert also references this user.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 78127))`;
        const eligible = await tx.mailboxLink.findFirst({
          where: {
            userId,
            accountId,
            status: "active",
            user: {
              disabled: false,
              pushSubscriptions: { some: subscription },
            },
          },
          select: { userId: true },
        });
        if (!eligible) return null;
        const existing = await tx.mailPushState.findUnique({
          where: { userId },
        });
        if (existing && existing.accountId !== accountId)
          await tx.mailPushState.delete({ where: { userId } });
        await tx.mailPushState.upsert({
          where: { userId },
          create: { userId, accountId, generation: randomUUID() },
          update: {},
        });
        const acquired = await tx.mailPushState.updateMany({
          where: {
            userId,
            accountId,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
          data: {
            leaseToken: token,
            leaseUntil: new Date(now.getTime() + 300_000),
          },
        });
        if (!acquired.count) return null;
        const row = await tx.mailPushState.findUniqueOrThrow({
          where: { userId },
        });
        return { token, generation: row.generation, state: row.state };
      });
    },
    async current(userId: string, generation: string, token: string) {
      return (
        (await db.mailPushState.count({
          where: {
            userId,
            generation,
            leaseToken: token,
            leaseUntil: { gt: new Date() },
            user: {
              disabled: false,
              pushSubscriptions: { some: subscription },
              mailbox: { status: "active" },
            },
          },
        })) > 0
      );
    },
    async save(
      userId: string,
      generation: string,
      token: string,
      state: string,
    ) {
      const result = await db.mailPushState.updateMany({
        where: {
          userId,
          generation,
          leaseToken: token,
          leaseUntil: { gt: new Date() },
        },
        data: { state },
      });
      return result.count === 1;
    },
    async release(userId: string, generation: string, token: string) {
      await db.mailPushState.updateMany({
        where: { userId, generation, leaseToken: token },
        data: { leaseToken: null, leaseUntil: null },
      });
    },
  };
}
