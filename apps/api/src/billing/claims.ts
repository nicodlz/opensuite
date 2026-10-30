import { ORPCError } from "@orpc/server";
import { BillingInterval, PlanId } from "@opensuite/contracts";
import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import { BILLING_INTEGRATION } from "./stripe.ts";
import { CLAIM_WINDOW_MS } from "./webhook.ts";

const bad = () =>
  new ORPCError("BAD_REQUEST", {
    status: 400,
    defined: true,
    message: "Checkout cannot be claimed",
  });
const conflict = () =>
  new ORPCError("CONFLICT", {
    status: 409,
    defined: true,
    message: "Address unavailable or checkout already claimed",
  });
const id = (value: string | { id: string } | null) =>
  typeof value === "string" ? value : value?.id;
type ClaimInput = {
  sessionId: string;
  name: string;
  localPart: string;
  password: string;
};

export function createClaimService(
  db: PrismaClient,
  stripe: Stripe,
  domain: string,
  signUp: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<string>,
  refresh?: (userId: string) => Promise<void>,
) {
  const examine = async (sessionId: string) => {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.metadata?.["integration"] !== BILLING_INTEGRATION ||
      session.metadata["esuno"] !== "1" ||
      session.mode !== "subscription" ||
      session.client_reference_id !== null
    )
      throw bad();
    const plan = PlanId.safeParse(session.metadata["plan"]);
    const interval = BillingInterval.safeParse(session.metadata["interval"]);
    if (!plan.success || !interval.success) throw bad();
    return {
      session,
      plan: plan.data,
      interval: interval.data,
      expired: Date.now() >= session.created * 1000 + CLAIM_WINDOW_MS,
    };
  };
  const status = async (sessionId: string) => {
    const checked = await examine(sessionId);
    const existing = await db.checkoutClaim.findUnique({
      where: { sessionId },
    });
    const state = existing?.claimedAt
      ? "claimed"
      : checked.expired
        ? "expired"
        : checked.session.status === "complete" &&
            checked.session.payment_status === "paid" &&
            existing !== null
          ? "claimable"
          : "pending";
    return {
      state,
      plan: checked.plan,
      interval: checked.interval,
      domain,
    } as const;
  };
  const claim = async (input: ClaimInput) => {
    const email = `${input.localPart}@${domain}`;
    const checked = await examine(input.sessionId);
    if (
      checked.expired ||
      checked.session.status !== "complete" ||
      checked.session.payment_status !== "paid"
    )
      throw bad();
    const customer = id(checked.session.customer);
    const subscription = id(checked.session.subscription);
    if (customer === undefined || subscription === undefined) throw bad();
    return db
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 71033))`;
          const record = await tx.checkoutClaim.findUnique({
            where: { sessionId: input.sessionId },
          });
          if (record === null)
            throw new ORPCError("SERVICE_UNAVAILABLE", {
              status: 503,
              defined: true,
            });
          if (
            record.claimedAt !== null ||
            record.stripeCustomerId !== customer ||
            record.subscriptionId !== subscription ||
            record.expiresAt <= new Date()
          )
            throw conflict();
          const [existingUser, address, subscriptionRow] = await Promise.all([
            tx.user.findFirst({
              where: { email: { equals: email, mode: "insensitive" } },
              select: { id: true },
            }),
            tx.address.findFirst({
              where: {
                localPart: { equals: input.localPart, mode: "insensitive" },
                domain: { name: domain },
              },
              select: { id: true },
            }),
            tx.subscription.findUnique({ where: { id: subscription } }),
          ]);
          if (existingUser !== null || address !== null) throw conflict();
          if (
            subscriptionRow === null ||
            subscriptionRow.userId !== null ||
            subscriptionRow.stripeCustomerId !== customer
          )
            throw bad();
          let userId: string;
          try {
            userId = await signUp({
              name: input.name,
              email,
              password: input.password,
            });
          } catch {
            throw conflict();
          }
          await tx.billingCustomer.create({
            data: { userId, stripeCustomerId: customer },
          });
          await tx.subscription.update({
            where: { id: subscription },
            data: { userId },
          });
          await tx.checkoutClaim.update({
            where: { sessionId: input.sessionId },
            data: { claimedByUserId: userId, claimedAt: new Date() },
          });
          await tx.auditEvent.create({
            data: { userId, action: "billing.claim.success", detail: {} },
          });
          return { email, userId };
        },
        { timeout: 45_000 },
      )
      .then(async ({ email: claimedEmail, userId }) => {
        try {
          await stripe.customers.update(customer, {
            metadata: { userId, integration: BILLING_INTEGRATION, esuno: "1" },
          });
          await db.billingCustomer.update({
            where: { userId },
            data: { metadataSyncedAt: new Date() },
          });
        } catch {
          // The linked account is already committed. The periodic job retries
          // metadata reconciliation; do not report a completed claim as failed.
        }
        void refresh?.(userId).catch(() => {});
        return { email: claimedEmail };
      });
  };
  return { status, claim };
}
export type ClaimService = ReturnType<typeof createClaimService>;
