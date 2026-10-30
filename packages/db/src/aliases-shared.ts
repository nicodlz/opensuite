import { ResultAsync, type Result } from "neverthrow";
import type { Prisma, PrismaClient } from "./generated/index.js";
import { ALIAS_USER_LOCK_SEED } from "./alias-locks.ts";

type Kind =
  "invalid" | "not_found" | "conflict" | "limit" | "key_limit" | "unavailable";
export type AliasStoreFailure = { kind: Kind };
export const unavailable = (): AliasStoreFailure => ({ kind: "unavailable" });
export const wrap = <T>(promise: Promise<Result<T, AliasStoreFailure>>) =>
  ResultAsync.fromPromise(promise, unavailable).andThen((result) => result);
export const validDomain = (tx: Prisma.TransactionClient, id: string) =>
  tx.domain.findFirst({
    where: {
      id,
      status: "verified",
      removalPending: false,
      stalwartId: { not: null },
    },
  });
export const createLocked =
  (db: PrismaClient) =>
  <T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${ALIAS_USER_LOCK_SEED}))`;
        return work(tx);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
export type Locked = ReturnType<typeof createLocked>;
export async function aliasCapReached(
  tx: Prisma.TransactionClient,
  userId: string,
  cap: number,
) {
  return (
    (await tx.emailAlias.count({ where: { userId, deletedAt: null } })) >=
      cap || (await tx.emailAlias.count({ where: { userId } })) >= cap * 10
  );
}

export function aliasMetadata(input: {
  website?: string | null | undefined;
  note?: string | null | undefined;
  requestId?: string | undefined;
}) {
  return {
    website: input.website?.toLowerCase() ?? null,
    note: input.note ?? null,
    requestId: input.requestId ?? null,
  };
}
