import { randomUUID } from "node:crypto";
import { ResultAsync } from "neverthrow";
import type { PrismaClient } from "./generated/index.js";

export const ALIAS_DOMAIN_LOCK_SEED = 9876;
export const ALIAS_USER_LOCK_SEED = 427391;
export function withUserLease<T>(
  db: PrismaClient,
  userId: string,
  work: (token: string) => Promise<T>,
) {
  let busy = false;
  return ResultAsync.fromPromise(
    (async () => {
      const token = randomUUID();
      const now = new Date();
      const claimed = await db.user.updateMany({
        where: {
          id: userId,
          OR: [{ aliasSyncUntil: null }, { aliasSyncUntil: { lt: now } }],
        },
        data: {
          aliasSyncToken: token,
          aliasSyncUntil: new Date(now.getTime() + 120_000),
        },
      });
      if (!claimed.count) {
        busy = true;
        throw new Error("address operation busy");
      }
      try {
        return await work(token);
      } finally {
        await db.user.updateMany({
          where: { id: userId, aliasSyncToken: token },
          data: { aliasSyncToken: null, aliasSyncUntil: null },
        });
      }
    })(),
    () => ({ kind: busy ? ("busy" as const) : ("unavailable" as const) }),
  );
}
