import type { BillingOverview, billingContract } from "@opensuite/contracts";
import type { ContractRouterClient } from "@orpc/contract";

const base: BillingOverview = {
  mode: "cloud",
  source: "subscription",
  plan: "plus",
  exempt: false,
  subscription: {
    status: "active",
    interval: "month",
    amount: 349,
    currency: "eur",
    currentPeriodEnd: "2027-01-15T00:00:00Z",
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
  },
  uploadsAllowed: true,
  storage: {
    quotaBytes: 50_000_000_000,
    usedBytes: 18_000_000_000,
    driveBytes: 12_000_000_000,
    mailBytes: 6_000_000_000,
    measured: true,
  },
};
function overview(): BillingOverview {
  switch (sessionStorage.getItem("billing-fixture")) {
    case "plus":
      return base;
    case "past_due":
      return {
        ...base,
        subscription: {
          ...base.subscription,
          interval: "month",
          amount: 349,
          currency: "eur",
          currentPeriodEnd: "2027-01-15T00:00:00Z",
          cancelAtPeriodEnd: false,
          canceledAt: null,
          endedAt: null,
          status: "past_due",
        },
      };
    case "over_quota":
      return {
        ...base,
        uploadsAllowed: false,
        storage: {
          ...base.storage,
          usedBytes: 52_000_000_000,
          driveBytes: 40_000_000_000,
          mailBytes: 12_000_000_000,
        },
      };
    case "no_plan":
      return {
        ...base,
        plan: "none",
        source: "none",
        subscription: null,
        uploadsAllowed: false,
        storage: { ...base.storage, quotaBytes: null },
      };
    case null:
    default:
      return {
        ...base,
        mode: "self-hosted",
        source: "self-hosted",
        plan: "free",
        subscription: null,
        storage: { ...base.storage, quotaBytes: null },
      };
  }
}
const demoUrl = () =>
  Promise.resolve({
    url: `${window.location.origin}/settings/billing?billing=updated`,
  });
export const fakeBilling: ContractRouterClient<typeof billingContract> = {
  plans: () =>
    Promise.resolve({ mode: "cloud", checkout: true, pricesIncludeTax: true }),
  overview: () => Promise.resolve(overview()),
  checkout: demoUrl,
  change: demoUrl,
  portal: demoUrl,
  checkoutStatus: () =>
    Promise.resolve({
      state: "claimable",
      plan: "plus",
      interval: "month",
      domain: "example.test",
    }),
  releaseClaim: () => Promise.resolve({ released: true }),
  claim: (input) =>
    Promise.resolve({ email: `${input.localPart}@example.test` }),
};
