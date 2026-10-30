import { isReservedMailLocalPart } from "@opensuite/core";
import { ORPCError } from "@orpc/server";
import { BillingInterval, ClaimLocalPart, PlanId } from "@opensuite/contracts";
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
    const parsedLocalPart = ClaimLocalPart.safeParse(input.localPart);
    if (!parsedLocalPart.success) throw bad();
    input = { ...input, localPart: parsedLocalPart.data };
    if (isReservedMailLocalPart(input.localPart))
      throw new ORPCError("BAD_REQUEST", {
        status: 400,
        defined: true,
        message: "This address is reserved",
      });
    if (!input.name.trim() || input.password.length > 128) throw bad();
    const email = `${input.localPart}@${domain}`;
    const localClaim = await db.checkoutClaim.findUnique({
      where: { sessionId: input.sessionId },
    });
    if (localClaim === null || localClaim.expiresAt <= new Date()) throw bad();
    if (localClaim.claimedAt !== null) throw conflict();
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
    // Reserve the address before the independent Better Auth transaction. A retry
    // can recover an account created just before a process crash.
    const reservation = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 71033))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscription}, 71032))`;
      const record = await tx.checkoutClaim.findUniqueOrThrow({
        where: { sessionId: input.sessionId },
      });
      if (
        record.claimedAt !== null ||
        record.stripeCustomerId !== customer ||
        record.subscriptionId !== subscription ||
        record.expiresAt <= new Date()
      )
        throw conflict();
      if (record.pendingEmail !== null && record.pendingEmail !== email)
        throw conflict();
      const subscriptionRow = await tx.subscription.findUnique({
        where: { id: subscription },
      });
      if (
        subscriptionRow === null ||
        subscriptionRow.stripeCustomerId !== customer ||
        (subscriptionRow.userId !== null &&
          subscriptionRow.userId !== record.claimedByUserId)
      )
        throw bad();
      if (record.pendingEmail === null) {
        const [existingUser, address] = await Promise.all([
          tx.user.findFirst({
            where: { email: email },
            select: { id: true },
          }),
          tx.address.findFirst({
            where: {
              localPart: input.localPart,
              domain: { name: domain },
            },
            select: { id: true },
          }),
        ]);
        if (existingUser !== null || address !== null) throw conflict();
        await tx.checkoutClaim.update({
          where: { sessionId: input.sessionId },
          data: { pendingEmail: email },
        });
      }
      return record;
    });
    const reservedUserId = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 71033))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscription}, 71032))`;
        const record = await tx.checkoutClaim.findUniqueOrThrow({
          where: { sessionId: input.sessionId },
        });
        if (record.claimedAt !== null || record.pendingEmail !== email)
          throw conflict();
        let userId = record.claimedByUserId;
        if (userId === null) {
          const existing =
            reservation.pendingEmail === null
              ? null
              : await tx.user.findFirst({
                  where: { email: email },
                  select: { id: true },
                });
          if (existing !== null) userId = existing.id;
          else {
            try {
              userId = await signUp({
                name: input.name,
                email,
                password: input.password,
              });
            } catch {
              throw conflict();
            }
          }
          await tx.checkoutClaim.update({
            where: { sessionId: input.sessionId },
            data: { claimedByUserId: userId },
          });
        }
        return userId;
      },
      { timeout: 45_000 },
    );
    return db
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 71033))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscription}, 71032))`;
          const record = await tx.checkoutClaim.findUniqueOrThrow({
            where: { sessionId: input.sessionId },
          });
          if (
            record.claimedAt !== null ||
            record.pendingEmail !== email ||
            record.claimedByUserId !== reservedUserId
          )
            throw conflict();
          const userId = reservedUserId;
          const row = await tx.subscription.findUniqueOrThrow({
            where: { id: subscription },
          });
          if (
            row.stripeCustomerId !== customer ||
            (row.userId !== null && row.userId !== userId)
          )
            throw bad();
          await tx.billingCustomer.create({
            data: { userId, stripeCustomerId: customer },
          });
          await tx.subscription.update({
            where: { id: subscription },
            data: { userId },
          });
          await tx.checkoutClaim.update({
            where: { sessionId: input.sessionId },
            data: { claimedAt: new Date() },
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
