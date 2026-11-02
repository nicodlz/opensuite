import type {
  ScheduledFailure,
  ScheduledRecord,
  PrismaClient,
} from "@opensuite/db";
import type { Result } from "neverthrow";

export type ReleaseAuthorization = (
  row: ScheduledRecord,
) => Promise<ScheduledFailure | null>;
type SenderLookup = {
  canSendAs(
    userId: string,
    address: string,
  ): PromiseLike<Result<string | null, { kind: string }>>;
};
type ReleaseDependencies = {
  db: PrismaClient;
  aliases: SenderLookup;
  addresses: SenderLookup;
  entitlements: {
    get(
      userId: string,
    ): Promise<{ uploadsAllowed: boolean; quotaBytes: number | null }>;
  };
  storageMeter: {
    measure(userId: string): Promise<{ usedBytes: number; measured: boolean }>;
  };
  domains: readonly string[];
};

async function activeMailbox(db: PrismaClient, row: ScheduledRecord) {
  const user = await db.user.findUnique({
    where: { id: row.userId },
    select: {
      disabled: true,
      mailbox: { select: { accountId: true, address: true, status: true } },
    },
  });
  return user &&
    !user.disabled &&
    user.mailbox?.status === "active" &&
    user.mailbox.accountId === row.accountId
    ? user.mailbox
    : null;
}

async function quota(
  deps: ReleaseDependencies,
  row: ScheduledRecord,
): Promise<ScheduledFailure | null> {
  const entitlement = await deps.entitlements.get(row.userId);
  if (!entitlement.uploadsAllowed || entitlement.quotaBytes === 0)
    return "entitlement_required";
  let used: number | undefined;
  if (entitlement.quotaBytes !== null) {
    const usage = await deps.storageMeter.measure(row.userId);
    if (!usage.measured) throw new Error("storage usage unavailable");
    used = usage.usedBytes;
  }
  // Billing can change while the storage sources are being measured.
  const current = await deps.entitlements.get(row.userId);
  if (!current.uploadsAllowed || current.quotaBytes === 0)
    return "entitlement_required";
  if (current.quotaBytes !== null) {
    if (used === undefined)
      throw new Error("storage quota changed during measurement");
    if (used >= current.quotaBytes) return "quota_exceeded";
  }
  return null;
}

export function createReleaseAuthorization(
  deps: ReleaseDependencies,
): ReleaseAuthorization {
  return async (row) => {
    if (!(await activeMailbox(deps.db, row))) return "account_inactive";
    const quotaFailure = await quota(deps, row);
    if (quotaFailure) return quotaFailure;
    // Re-read account and sender after potentially slow storage I/O.
    const mailbox = await activeMailbox(deps.db, row);
    if (!mailbox) return "account_inactive";
    const domainName = row.senderAddress.split("@")[1];
    if (!domainName) return "sender_unavailable";
    const domain = await deps.db.domain.findUnique({
      where: { name: domainName },
      select: { status: true, removalPending: true, stalwartId: true },
    });
    if (
      !domain ||
      domain.removalPending ||
      !domain.stalwartId ||
      !(deps.domains.includes(domainName) || domain.status === "verified")
    )
      return "domain_unavailable";
    if (mailbox.address.toLowerCase() !== row.senderAddress) {
      const alias = await deps.aliases.canSendAs(row.userId, row.senderAddress);
      if (alias.isErr()) throw new Error("sender authorization unavailable");
      if (!alias.value) {
        const address = await deps.addresses.canSendAs(
          row.userId,
          row.senderAddress,
        );
        if (address.isErr())
          throw new Error("sender authorization unavailable");
        if (!address.value) return "sender_unavailable";
      }
    }
    return null;
  };
}
