import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import { requireSession } from "./session.ts";

const billing = implement(contract.billing).$context<ApiContext>();
const disabled = () => {
  throw new ORPCError("BILLING_DISABLED", { defined: true, status: 404 });
};

// Cloud activation remains disabled until payment and mail quota enforcement
// are both available. Never instantiate Stripe in self-hosted mode.
export const billingRouter = billing.router({
  plans: billing.plans.handler(() => ({
    mode: "self-hosted" as const,
    checkout: false,
    pricesIncludeTax: true,
  })),
  overview: billing.overview.use(requireSession).handler(() => ({
    mode: "self-hosted" as const,
    plan: "free" as const,
    exempt: false,
    subscription: null,
    uploadsAllowed: true,
    storage: {
      quotaBytes: null,
      usedBytes: 0,
      driveBytes: 0,
      mailBytes: 0,
      measured: false,
    },
  })),
  checkout: billing.checkout.handler(disabled),
  change: billing.change.handler(disabled),
  portal: billing.portal.handler(disabled),
  checkoutStatus: billing.checkoutStatus.handler(disabled),
  claim: billing.claim.handler(disabled),
});
