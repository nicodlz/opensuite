import type { Prisma, PrismaClient } from "./generated/index.js";

// Shared for a submission, exclusive for changes that revoke its sender.
const HANDOFF_LOCK = 1873943821;
export const HANDOFF_TIMEOUT_MS = 3_000;

export async function tryLockHandoff(tx: Prisma.TransactionClient) {
  const result = await tx.$queryRaw<
    { acquired: boolean }[]
  >`SELECT pg_try_advisory_xact_lock_shared(${HANDOFF_LOCK}::bigint) AS acquired`;
  return result[0]?.acquired === true;
}
export async function lockRevocation(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HANDOFF_LOCK}::bigint)`;
}

export function withRevocation<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(
    async (tx) => {
      await lockRevocation(tx);
      return work(tx);
    },
    { timeout: 10_000, maxWait: 5_000 },
  );
}
