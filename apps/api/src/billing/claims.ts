import { randomUUID } from "node:crypto";
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
    userId: string;
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
      reservedLocalPart:
        state === "claimable" && existing?.pendingEmail?.endsWith(`@${domain}`)
          ? existing.pendingEmail.slice(0, -(domain.length + 1))
          : null,
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
    // Serialize reservation changes with address and primary-account creation.
    let reservedUserId: string;
    const signupLeaseToken = randomUUID();
    try {
      reservedUserId = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domain}, 9876))`;
        const domainRow = await tx.domain.findUnique({
          where: { name: domain },
          select: { id: true },
        });
        if (domainRow)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainRow.id}, 9876))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 71033))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscription}, 71032))`;
        const record = await tx.checkoutClaim.findUniqueOrThrow({
          where: { sessionId: input.sessionId },
        });
        if (
          record.claimedAt ||
          record.stripeCustomerId !== customer ||
          record.subscriptionId !== subscription ||
          record.expiresAt <= new Date()
        )
          throw conflict();
        if (record.signupLeaseUntil && record.signupLeaseUntil > new Date())
          throw conflict();
        const row = await tx.subscription.findUnique({
          where: { id: subscription },
        });
        if (
          !row ||
          row.stripeCustomerId !== customer ||
          (row.userId !== null && row.userId !== record.claimedByUserId)
        )
          throw bad();
        const existingExpected = record.pendingUserId
          ? await tx.user.findUnique({
              where: { id: record.pendingUserId },
              select: { id: true, email: true },
            })
          : null;
        if (
          record.pendingEmail !== null &&
          record.pendingEmail !== email &&
          (record.claimedByUserId !== null ||
            existingExpected !== null ||
            (
              await tx.$queryRaw<
                { id: string }[]
              >`SELECT "id" FROM "User" WHERE lower("email") = ${record.pendingEmail} LIMIT 1`
            ).length > 0)
        )
          throw conflict();
        const expectedUserId =
          record.pendingEmail === email
            ? (record.claimedByUserId ?? record.pendingUserId ?? randomUUID())
            : randomUUID();
        const existing = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "User" WHERE lower("email") = ${email} LIMIT 1`;
        if (existing[0] && existing[0].id !== expectedUserId) throw conflict();
        if (
          domainRow &&
          (
            await tx.$queryRaw<
              { id: string }[]
            >`SELECT "id" FROM "Address" WHERE "domainId" = ${domainRow.id} AND lower("localPart") = ${input.localPart} LIMIT 1`
          ).length
        )
          throw conflict();
        await tx.checkoutClaim.updateMany({
          where: {
            pendingEmail: email,
            expiresAt: { lte: new Date() },
            claimedAt: null,
            OR: [
              { signupLeaseUntil: null },
              { signupLeaseUntil: { lte: new Date() } },
            ],
            sessionId: { not: input.sessionId },
          },
          data: { pendingEmail: null },
        });
        await tx.checkoutClaim.update({
          where: { sessionId: input.sessionId },
          data: {
            pendingEmail: email,
            pendingUserId: expectedUserId,
            signupLeaseUntil: new Date(Date.now() + 120_000),
            signupLeaseToken,
          },
        });
        return expectedUserId;
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      )
        throw conflict();
      throw error;
    }
    const heartbeat = setInterval(() => {
      void db.checkoutClaim
        .updateMany({
          where: {
            sessionId: input.sessionId,
            signupLeaseToken,
            claimedAt: null,
          },
          data: { signupLeaseUntil: new Date(Date.now() + 120_000) },
        })
        .catch(() => {});
    }, 30_000);
    heartbeat.unref();
    try {
      const existing = await db.user.findUnique({
        where: { id: reservedUserId },
        select: { email: true },
      });
      if (existing !== null) {
        if (existing.email !== email) throw conflict();
      } else {
        const createdId = await signUp({
          name: input.name,
          email,
          password: input.password,
          userId: reservedUserId,
        });
        if (createdId !== reservedUserId) throw conflict();
        const created = await db.user.findUnique({
          where: { id: reservedUserId },
          select: { email: true },
        });
        if (created === null || created.email !== email) throw conflict();
      }
      const linked = await db.checkoutClaim.updateMany({
        where: {
          sessionId: input.sessionId,
          pendingEmail: email,
          pendingUserId: reservedUserId,
          claimedAt: null,
          signupLeaseUntil: { gt: new Date() },
          signupLeaseToken,
        },
        data: {
          claimedByUserId: reservedUserId,
          signupLeaseUntil: null,
          signupLeaseToken: null,
        },
      });
      if (linked.count !== 1) throw conflict();
    } catch (error) {
      await db.checkoutClaim.updateMany({
        where: {
          sessionId: input.sessionId,
          pendingUserId: reservedUserId,
          claimedAt: null,
          signupLeaseToken,
        },
        data: { signupLeaseUntil: null, signupLeaseToken: null },
      });
      if (error instanceof ORPCError) throw error;
      throw conflict();
    } finally {
      clearInterval(heartbeat);
    }
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
  const release = async (sessionId: string) => {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domain}, 9876))`;
      const domainRow = await tx.domain.findUnique({
        where: { name: domain },
        select: { id: true },
      });
      if (domainRow)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainRow.id}, 9876))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 71033))`;
      const record = await tx.checkoutClaim.findUnique({
        where: { sessionId },
      });
      if (!record || record.claimedAt || record.expiresAt <= new Date())
        throw bad();
      if (
        record.claimedByUserId ||
        (record.signupLeaseUntil && record.signupLeaseUntil > new Date())
      )
        throw conflict();
      if (
        record.pendingEmail &&
        (
          await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "User" WHERE lower("email") = ${record.pendingEmail} LIMIT 1`
        ).length
      )
        throw conflict();
      if (
        record.pendingUserId &&
        (await tx.user.count({ where: { id: record.pendingUserId } }))
      )
        throw conflict();
      await tx.checkoutClaim.update({
        where: { sessionId },
        data: {
          pendingEmail: null,
          pendingUserId: null,
          signupLeaseUntil: null,
          signupLeaseToken: null,
        },
      });
    });
    return { released: true as const };
  };
  return { status, claim, release };
}
export type ClaimService = ReturnType<typeof createClaimService>;
