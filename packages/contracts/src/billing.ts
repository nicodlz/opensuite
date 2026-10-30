import { oc } from "@orpc/contract";
import { z } from "zod";

export const DeploymentMode = z.enum(["self-hosted", "cloud"]);
export type DeploymentMode = z.infer<typeof DeploymentMode>;
export const PlanId = z.enum(["plus", "pro"]);
export type PlanId = z.infer<typeof PlanId>;
export const BillingInterval = z.enum(["month", "year"]);
export type BillingInterval = z.infer<typeof BillingInterval>;

const GB = 1_000_000_000;
/**
 * The managed Cloud catalogue. Amounts are EUR cents, VAT included. The
 * Stripe prices carry the lookup key `esuno_<plan>_<interval>`; the server
 * checks that each Stripe price matches the amount listed here before use.
 */
export const plans = {
  plus: {
    name: "Plus",
    storageBytes: 50 * GB,
    customDomains: 1,
    addressLimit: 5,
    // A fixed number of aliases; Pro relies on the anti-abuse cap only.
    aliasLimit: 50,
    prices: {
      month: { amount: 349, monthly: 349 },
      year: { amount: 3588, monthly: 299 },
    },
  },
  pro: {
    name: "Pro",
    storageBytes: 500 * GB,
    customDomains: 5,
    addressLimit: 15,
    aliasLimit: null,
    prices: {
      month: { amount: 999, monthly: 999 },
      year: { amount: 9588, monthly: 799 },
    },
  },
} as const satisfies Record<
  PlanId,
  {
    name: string;
    storageBytes: number;
    customDomains: number;
    addressLimit: number;
    aliasLimit: number | null;
    prices: Record<BillingInterval, { amount: number; monthly: number }>;
  }
>;
export const priceLookupKey = (plan: PlanId, interval: BillingInterval) =>
  `esuno_${plan}_${interval}`;

/** Stripe subscription statuses that grant the plan's entitlements. */
export const entitledStatuses = ["active", "trialing", "past_due"] as const;

const Storage = z.object({
  /** Null when no storage limit applies (self-hosted, operator accounts). */
  quotaBytes: z.number().int().nonnegative().nullable(),
  usedBytes: z.number().int().nonnegative(),
  driveBytes: z.number().int().nonnegative(),
  mailBytes: z.number().int().nonnegative(),
  /** False when a storage backend could not be measured right now. */
  measured: z.boolean(),
});
export const BillingOverview = z.object({
  mode: DeploymentMode,
  /** `free` is self-hosted; `none` is a Cloud account without a plan. */
  plan: z.enum(["free", "none", "plus", "pro"]),
  /** Operator accounts in Cloud mode are not limited by a plan. */
  exempt: z.boolean(),
  subscription: z
    .object({
      status: z.string(),
      interval: BillingInterval,
      amount: z.number().int(),
      currency: z.literal("eur"),
      currentPeriodEnd: z.string().nullable(),
      cancelAtPeriodEnd: z.boolean(),
      canceledAt: z.string().nullable(),
      endedAt: z.string().nullable(),
    })
    .nullable(),
  /** New uploads and mail are accepted only while this is true. */
  uploadsAllowed: z.boolean(),
  storage: Storage,
});
export type BillingOverview = z.infer<typeof BillingOverview>;

const PlanInput = z
  .object({ plan: PlanId, interval: BillingInterval })
  .strict();
const CheckoutSessionId = z
  .string()
  .regex(/^cs_(test|live)_[A-Za-z0-9]{1,200}$/);
const RedirectUrl = z.object({ url: z.url() });
const procedure = oc.errors({
  BILLING_DISABLED: { status: 404, message: "Billing is not enabled" },
  BAD_REQUEST: { status: 400, message: "Invalid billing request" },
  CONFLICT: { status: 409, message: "Billing request conflicts" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests" },
  SERVICE_UNAVAILABLE: { status: 503, message: "Billing unavailable" },
});

export const billingContract = {
  plans: procedure
    .route({ method: "GET", path: "/billing/plans", summary: "Plans" })
    .input(z.object({}).strict())
    .output(
      z.object({
        mode: DeploymentMode,
        checkout: z.boolean(),
        pricesIncludeTax: z.boolean(),
      }),
    ),
  overview: procedure
    .route({ method: "GET", path: "/billing", summary: "Billing overview" })
    .input(z.object({}).strict())
    .output(BillingOverview),
  /** Signed in: bills the account. Signed out: the account is claimed after payment. */
  checkout: procedure
    .route({ method: "POST", path: "/billing/checkout" })
    .input(PlanInput)
    .output(RedirectUrl),
  /** Opens a Stripe confirmation page for a plan or interval change. */
  change: procedure
    .route({ method: "POST", path: "/billing/change" })
    .input(PlanInput)
    .output(RedirectUrl),
  portal: procedure
    .route({ method: "POST", path: "/billing/portal" })
    .input(z.object({}).strict())
    .output(RedirectUrl),
  checkoutStatus: procedure
    .route({ method: "GET", path: "/billing/checkout/{sessionId}" })
    .input(z.object({ sessionId: CheckoutSessionId }).strict())
    .output(
      z.object({
        state: z.enum(["pending", "claimable", "claimed", "expired"]),
        plan: PlanId.nullable(),
        interval: BillingInterval.nullable(),
        domain: z.string(),
      }),
    ),
  claim: procedure
    .route({ method: "POST", path: "/billing/claim" })
    .input(
      z
        .object({
          sessionId: CheckoutSessionId,
          name: z.string().trim().min(1).max(100),
          localPart: z
            .string()
            .trim()
            .toLowerCase()
            .min(3)
            .max(40)
            .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
          password: z.string().min(12).max(256),
        })
        .strict(),
    )
    .output(z.object({ email: z.email() })),
};
