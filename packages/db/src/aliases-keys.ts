import { err, ok, ResultAsync } from "neverthrow";
import type { PrismaClient } from "./generated/index.js";
import { unavailable, wrap, type Locked } from "./aliases-shared.ts";

export const createKeys = (db: PrismaClient, locked: Locked) => ({
  createKey: (
    userId: string,
    name: string,
    prefix: string,
    secretHash: string,
  ) =>
    wrap(
      locked(userId, async (tx) => {
        if (
          (await tx.aliasApiKey.count({
            where: { userId, revokedAt: null },
          })) >= 20 ||
          (await tx.aliasApiKey.count({ where: { userId } })) >= 200
        )
          return err({ kind: "key_limit" });
        const row = await tx.aliasApiKey.create({
          data: { userId, name, prefix, secretHash },
        });
        await tx.auditEvent.create({
          data: {
            userId,
            action: "alias.key.create",
            detail: { keyId: row.id },
          },
        });
        return ok(row);
      }),
    ),
  listKeys: (userId: string) =>
    ResultAsync.fromPromise(
      db.aliasApiKey.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      unavailable,
    ),
  revokeKey: (userId: string, id: string) =>
    wrap(
      db.$transaction(async (tx) => {
        const result = await tx.aliasApiKey.updateMany({
          where: { id, userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (!result.count) return err({ kind: "not_found" });
        await tx.auditEvent.create({
          data: { userId, action: "alias.key.revoke", detail: { keyId: id } },
        });
        return ok({ revoked: true as const });
      }),
    ),
  keyForPrefix: (prefix: string) =>
    ResultAsync.fromPromise(
      db.aliasApiKey.findUnique({
        where: { prefix },
        include: { user: true },
      }),
      unavailable,
    ),
  useKey: (id: string) =>
    ResultAsync.fromPromise(
      db.aliasApiKey
        .updateMany({
          where: { id, revokedAt: null, user: { disabled: false } },
          data: { lastUsedAt: new Date() },
        })
        .then((result) => result.count === 1),
      unavailable,
    ),
});
