import { entitledStatuses, plans, PlanId } from "@opensuite/contracts";
import type { PrismaClient } from "@opensuite/db";
import type { BillingConfig } from "../config.ts";

export const createEntitlements = (
  db: PrismaClient,
  config: BillingConfig,
  aliasCap: number,
  verify?: (subscription: {
    id: string;
    stripeCustomerId: string;
    userId: string | null;
    plan: string;
    interval: string;
    status: string;
    priceId: string;
  }) => Promise<boolean>,
) => {
  const get = async (userId: string) => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        billingGrant: true,
        subscriptions: { orderBy: { updatedAt: "desc" } },
      },
    });
    if (user === null) throw new Error("account unavailable");
    const entitled = user.subscriptions.find(
      (subscription) =>
        entitledStatuses.some((status) => status === subscription.status) &&
        PlanId.safeParse(subscription.plan).success,
    );
    const subscription = entitled ?? user.subscriptions[0] ?? null;
    if (config.mode === "self-hosted")
      return {
        mode: "self-hosted" as const,
        plan: "free" as const,
        quotaBytes: null,
        uploadsAllowed: true,
        exempt: false,
        aliasLimit: aliasCap,
        addressLimit: null,
        customDomains: null,
        subscription: null,
        grant: false,
      };
    const grant = user.billingGrant;
    const activeGrant =
      grant !== null &&
      grant.revokedAt === null &&
      (grant.expiresAt === null || grant.expiresAt > new Date())
        ? grant
        : null;
    if (user.role === "admin")
      return {
        mode: "cloud" as const,
        plan:
          activeGrant === null
            ? ("none" as const)
            : activeGrant.plan === "unlimited"
              ? ("pro" as const)
              : PlanId.parse(activeGrant.plan),
        quotaBytes: null,
        uploadsAllowed: true,
        exempt: true,
        aliasLimit: aliasCap,
        addressLimit: null,
        customDomains: null,
        subscription: activeGrant === null ? subscription : null,
        grant: activeGrant !== null,
      };
    if (activeGrant !== null) {
      if (activeGrant.plan === "unlimited")
        return {
          mode: "cloud" as const,
          plan: "pro" as const,
          quotaBytes: null,
          uploadsAllowed: true,
          exempt: true,
          aliasLimit: aliasCap,
          addressLimit: null,
          customDomains: null,
          subscription: null,
          grant: true,
        };
      const grantedPlan = PlanId.parse(activeGrant.plan);
      return {
        mode: "cloud" as const,
        plan: grantedPlan,
        quotaBytes: plans[grantedPlan].storageBytes,
        uploadsAllowed: true,
        exempt: false,
        aliasLimit: Math.min(
          aliasCap,
          plans[grantedPlan].aliasLimit ?? aliasCap,
        ),
        addressLimit: plans[grantedPlan].addressLimit,
        customDomains: plans[grantedPlan].customDomains,
        subscription: null,
        grant: true,
      };
    }
    if (
      entitled === undefined ||
      (verify !== undefined && !(await verify(entitled)))
    )
      return {
        mode: "cloud" as const,
        plan: "none" as const,
        quotaBytes: 0,
        uploadsAllowed: false,
        exempt: false,
        aliasLimit: 0,
        addressLimit: 0,
        customDomains: 0,
        subscription,
        grant: false,
      };
    const plan = PlanId.parse(entitled.plan);
    const quotaBytes = Number(entitled.storageQuotaBytes);
    if (
      !Number.isSafeInteger(quotaBytes) ||
      quotaBytes !== plans[plan].storageBytes
    )
      throw new Error("invalid subscription quota");
    return {
      mode: "cloud" as const,
      plan,
      quotaBytes,
      uploadsAllowed: true,
      exempt: false,
      aliasLimit: Math.min(aliasCap, plans[plan].aliasLimit ?? aliasCap),
      addressLimit: plans[plan].addressLimit,
      customDomains: plans[plan].customDomains,
      subscription: entitled,
      grant: false,
    };
  };
  return { get };
};
export type Entitlements = ReturnType<typeof createEntitlements>;
