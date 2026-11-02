import type { Prisma, PrismaClient } from "./generated/index.js";
import { ALIAS_DOMAIN_LOCK_SEED } from "./alias-locks.ts";
import { withRevocation } from "./scheduled-send-guard.ts";

export function withLockedDomain<T>(
  db: PrismaClient,
  domainId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withRevocation(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
    return work(tx);
  });
}

export async function markDomainSendersDirty(
  tx: Prisma.TransactionClient,
  domainId: string,
) {
  await tx.address.updateMany({
    where: { domainId, mailboxManaged: true },
    data: { ready: false, revision: { increment: 1 } },
  });
  await tx.emailAlias.updateMany({
    where: { domainId, deletedAt: null, enabled: true },
    data: { ready: false, detachedByDomain: false, revision: { increment: 1 } },
  });
}
