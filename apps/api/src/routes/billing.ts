import { contract, plans, PlanId, BillingInterval } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import { requireSession } from "./session.ts";

const billing = implement(contract.billing).$context<ApiContext>();
const disabled = () => {
  throw new ORPCError("BILLING_DISABLED", { defined: true, status: 404 });
};
const logged = async <T>(
  context: ApiContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : null;
    if (code === "resource_missing")
      throw new ORPCError("BAD_REQUEST", {
        status: 400,
        defined: true,
        message: "Checkout cannot be claimed",
      });
    context.log.error({ stripeCode: code }, "billing request failed");
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      status: 503,
      defined: true,
      message: "Billing unavailable",
    });
  }
};
export const billingRouter = billing.router({
  plans: billing.plans.handler(({ context }) => ({
    mode:
      context.billing === undefined
        ? ("self-hosted" as const)
        : ("cloud" as const),
    checkout: context.billing !== undefined,
    pricesIncludeTax: true,
  })),
  overview: billing.overview.use(requireSession).handler(async ({ context }) =>
    logged(context, async () => {
      const entitlement = await context.entitlements?.get(context.actor.id);
      const usage =
        context.storageMeter === undefined
          ? { driveBytes: 0, mailBytes: 0, usedBytes: 0, measured: false }
          : await context.storageMeter.measure(context.actor.id);
      const sub = entitlement?.subscription;
      const plan = PlanId.safeParse(sub?.plan);
      const interval = BillingInterval.safeParse(sub?.interval);
      return {
        mode: entitlement?.mode ?? "self-hosted",
        plan: entitlement?.plan ?? "free",
        exempt: entitlement?.exempt ?? false,
        source:
          entitlement === undefined || entitlement.mode === "self-hosted"
            ? ("self-hosted" as const)
            : entitlement.grant
              ? ("grant" as const)
              : entitlement.exempt
                ? ("operator" as const)
                : entitlement.plan === "none"
                  ? ("none" as const)
                  : ("subscription" as const),
        uploadsAllowed:
          (entitlement?.uploadsAllowed ?? true) &&
          !(
            usage.measured &&
            entitlement?.quotaBytes !== null &&
            entitlement?.quotaBytes !== undefined &&
            usage.usedBytes >= entitlement.quotaBytes
          ),
        storage: {
          quotaBytes: entitlement === undefined ? null : entitlement.quotaBytes,
          ...usage,
        },
        subscription:
          sub !== null && sub !== undefined && plan.success && interval.success
            ? {
                status: sub.status,
                interval: interval.data,
                amount: plans[plan.data].prices[interval.data].amount,
                currency: "eur" as const,
                currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
                cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
                canceledAt: sub.canceledAt?.toISOString() ?? null,
                endedAt: sub.endedAt?.toISOString() ?? null,
              }
            : null,
      };
    }),
  ),
  checkout: billing.checkout.handler(({ context, input }) => {
    const service = context.billing;
    if (service === undefined) return disabled();
    if (context.actor !== null && !context.signedBillingLimit(context.actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    if (context.actor === null && !context.publicCheckoutLimit())
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return logged(context, () => service.checkout(context.actor, input));
  }),
  change: billing.change.handler(({ context, input }) => {
    const service = context.billing;
    if (service === undefined) return disabled();
    const actor = context.actor;
    if (actor === null) throw new ORPCError("UNAUTHORIZED");
    if (!context.signedBillingLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return logged(context, () => service.portal(actor, input));
  }),
  portal: billing.portal.handler(({ context }) => {
    const service = context.billing;
    if (service === undefined) return disabled();
    const actor = context.actor;
    if (actor === null) throw new ORPCError("UNAUTHORIZED");
    if (!context.signedBillingLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return logged(context, () => service.portal(actor));
  }),
  checkoutStatus: billing.checkoutStatus.handler(({ context, input }) => {
    const service = context.claims;
    if (context.billing === undefined || service === undefined)
      return disabled();
    if (!context.claimLimit("status"))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return logged(context, () => service.status(input.sessionId));
  }),
  releaseClaim: billing.releaseClaim.handler(({ context, input }) => {
    const service = context.claims;
    if (context.billing === undefined || service === undefined)
      return disabled();
    if (!context.claimLimit("claim"))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return logged(context, () => service.release(input.sessionId));
  }),
  claim: billing.claim.handler(({ context, input }) => {
    const service = context.claims;
    if (context.billing === undefined || service === undefined)
      return disabled();
    if (!context.claimLimit("claim"))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return logged(context, () => service.claim(input));
  }),
});
