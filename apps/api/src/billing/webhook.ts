import { plans, type PlanId, type BillingInterval } from "@opensuite/contracts";
import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import { z } from "zod";
import { BILLING_INTEGRATION } from "./stripe.ts";
import { classifyPrice } from "./prices.ts";

export const BILLING_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
] as const;
export const CLAIM_WINDOW_MS = 30 * 86_400_000;
const objectId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
const date = (value: number | null | undefined) =>
  value === null || value === undefined ? null : new Date(value * 1000);
const owned = z.object({
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});
const subscriptionEvent = owned.extend({
  id: z.string().min(1),
  items: z.object({
    data: z.array(
      z.object({
        price: z.object({
          lookup_key: z.string().nullable(),
          metadata: z.record(z.string(), z.string()).optional(),
        }),
      }),
    ),
  }),
});
const invoiceEvent = z.object({
  parent: z
    .object({
      subscription_details: z
        .object({
          metadata: z.record(z.string(), z.string()).nullable(),
          subscription: z.union([z.string(), z.object({ id: z.string() })]),
        })
        .nullable(),
    })
    .nullable(),
  lines: z.object({
    has_more: z.boolean(),
    data: z.array(
      z.object({
        pricing: z
          .object({
            price_details: z
              .object({
                price: z.union([z.string(), z.object({ id: z.string() })]),
              })
              .optional(),
          })
          .nullable(),
      }),
    ),
  }),
});
const keys = new Set([
  "esuno_plus_month",
  "esuno_plus_year",
  "esuno_pro_month",
  "esuno_pro_year",
]);

export function createWebhookProcessor(
  db: PrismaClient,
  stripe: Stripe,
  refresh: (userId: string) => Promise<void>,
  logUnknown: (eventId: string, type: string) => void,
) {
  const process = async (event: Stripe.Event) => {
    await db.stripeEvent.createMany({
      data: [
        {
          id: event.id,
          type: event.type,
          createdAt: new Date(event.created * 1000),
        },
      ],
      skipDuplicates: true,
    });
    if (!BILLING_EVENTS.some((type) => type === event.type)) {
      await db.stripeEvent.updateMany({
        where: { id: event.id },
        data: {
          processedAt: new Date(),
          ignoredAt: new Date(),
        },
      });
      return;
    }
    await db.stripeEvent.updateMany({
      where: { id: event.id, processedAt: null },
      data: { attempts: { increment: 1 } },
    });
    const touched = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.id}, 71031))`;
        const recorded = await tx.stripeEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        if (recorded.processedAt !== null)
          return { duplicate: true, userId: null };
        const ignore = async () => {
          await tx.stripeEvent.update({
            where: { id: event.id },
            data: { ignoredAt: new Date(), processedAt: new Date() },
          });
          return { duplicate: true, userId: null };
        };
        let subscriptionId: string | undefined;
        let session: Stripe.Checkout.Session | undefined;
        if (event.type === "checkout.session.completed") {
          const original = owned.safeParse(event.data.object);
          if (!original.success || original.data.metadata?.["esuno"] !== "1")
            return ignore();
          const sessionId = z
            .object({ id: z.string().min(1) })
            .parse(event.data.object).id;
          session = await stripe.checkout.sessions.retrieve(sessionId);
          if (
            session.metadata?.["integration"] !== BILLING_INTEGRATION ||
            session.metadata["esuno"] !== "1" ||
            session.mode !== "subscription"
          )
            return ignore();
          subscriptionId = objectId(session.subscription);
        } else if (event.type.startsWith("customer.subscription.")) {
          const original = subscriptionEvent.safeParse(event.data.object);
          if (!original.success) return ignore();
          subscriptionId = original.data.id;
          const price = original.data.items.data[0]?.price;
          if (
            original.data.metadata?.["esuno"] !== "1" ||
            original.data.items.data.length !== 1 ||
            price === undefined ||
            price.lookup_key === null ||
            !keys.has(price.lookup_key) ||
            price.metadata?.["esuno"] !== "1"
          ) {
            // Unknown objects are ignored unless this ID is already ours, in
            // which case inspect live state so an old active row cannot linger.
            const known = await tx.subscription.findUnique({
              where: { id: subscriptionId },
              select: { id: true },
            });
            if (known === null) return ignore();
          }
        } else {
          const original = invoiceEvent.safeParse(event.data.object);
          const details = original.success
            ? original.data.parent?.subscription_details
            : null;
          if (details?.metadata?.["esuno"] !== "1") return ignore();
          if (
            !original.success ||
            original.data.lines.has_more ||
            original.data.lines.data.length === 0
          )
            return ignore();
          const priceIds = original.data.lines.data.map((line) =>
            objectId(line.pricing?.price_details?.price),
          );
          if (priceIds.some((priceId) => priceId === undefined))
            return ignore();
          let invoicePrices: Stripe.Price[];
          try {
            invoicePrices = await Promise.all(
              priceIds.map(async (priceId) => {
                if (priceId === undefined)
                  throw new Error("invoice price unavailable");
                return stripe.prices.retrieve(priceId);
              }),
            );
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "resource_missing"
            )
              return ignore();
            throw error;
          }
          if (invoicePrices.some((price) => classifyPrice(price) === null)) {
            logUnknown(event.id, event.type);
            return ignore();
          }
          subscriptionId = objectId(details.subscription);
        }
        if (subscriptionId === undefined)
          throw new Error("subscription unavailable");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscriptionId}, 71032))`;
        const current = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["latest_invoice"],
        });
        const customerId = objectId(current.customer);
        if (customerId === undefined) throw new Error("customer unavailable");
        const existing = await tx.subscription.findUnique({
          where: { id: subscriptionId },
        });
        const rejectExisting = async () => {
          if (existing === null) return ignore();
          await tx.subscription.update({
            where: { id: subscriptionId },
            data: { status: "unowned", stripeObservedAt: new Date() },
          });
          await tx.stripeEvent.update({
            where: { id: event.id },
            data: { ignoredAt: new Date(), processedAt: new Date() },
          });
          logUnknown(event.id, event.type);
          return { duplicate: false, userId: existing.userId };
        };
        const currentItem = current.items.data[0];
        if (
          current.metadata["esuno"] !== "1" ||
          current.metadata["integration"] !== BILLING_INTEGRATION ||
          (existing !== null && existing.stripeCustomerId !== customerId)
        )
          return rejectExisting();
        if (
          current.items.data.length !== 1 ||
          currentItem === undefined ||
          currentItem.quantity !== 1 ||
          classifyPrice(currentItem.price) === null
        ) {
          return rejectExisting();
        }
        let customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return rejectExisting();
        if (
          customer.metadata["esuno"] !== "1" &&
          session !== undefined &&
          session.client_reference_id === null &&
          session.status === "complete" &&
          session.payment_status === "paid" &&
          objectId(session.customer) === customerId &&
          objectId(session.subscription) === subscriptionId
        ) {
          customer = await stripe.customers.update(customerId, {
            metadata: { esuno: "1", integration: BILLING_INTEGRATION },
          });
        }
        if (customer.metadata["esuno"] !== "1") return rejectExisting();
        const owner = await tx.billingCustomer.findUnique({
          where: { stripeCustomerId: customerId },
        });
        if (existing?.userId && owner && existing.userId !== owner.userId)
          return ignore();
        const userId = existing?.userId ?? owner?.userId ?? null;
        if (userId !== null)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 71035))`;
        const item = currentItem;
        const classification: {
          plan: PlanId;
          interval: BillingInterval;
        } | null = classifyPrice(item.price);
        const observations = z
          .array(z.object({ at: z.date() }))
          .parse(await tx.$queryRaw`SELECT clock_timestamp() AS at`);
        const observed = observations[0]?.at;
        if (observed === undefined) throw new Error("observation unavailable");
        if (classification === null) {
          logUnknown(event.id, event.type);
          return ignore();
        } else if (existing === null || existing.stripeObservedAt <= observed) {
          const invoice =
            typeof current.latest_invoice === "object" &&
            current.latest_invoice !== null
              ? current.latest_invoice.status
              : null;
          const data = {
            userId,
            stripeCustomerId: customerId,
            plan: classification.plan,
            interval: classification.interval,
            status: current.status,
            priceId: item.price.id,
            storageQuotaBytes: BigInt(plans[classification.plan].storageBytes),
            currentPeriodStart: date(item.current_period_start),
            currentPeriodEnd: date(item.current_period_end),
            cancelAtPeriodEnd: current.cancel_at_period_end,
            canceledAt: date(current.canceled_at),
            endedAt: date(current.ended_at),
            latestInvoiceStatus: invoice,
            stripeCreatedAt: date(current.created),
            stripeObservedAt: observed,
          };
          await tx.subscription.upsert({
            where: { id: subscriptionId },
            create: { id: subscriptionId, ...data },
            update: data,
          });
          if (
            userId !== null &&
            ["active", "trialing", "past_due"].includes(current.status)
          ) {
            const duplicate = await tx.subscription.findFirst({
              where: {
                userId,
                id: { not: subscriptionId },
                status: { in: ["active", "trialing", "past_due"] },
              },
              select: { id: true },
            });
            if (duplicate !== null)
              logUnknown(
                event.id,
                "duplicate entitled subscription: operator refund required",
              );
          }
          if (
            session !== undefined &&
            session.status === "complete" &&
            session.payment_status === "paid" &&
            session.client_reference_id === null &&
            objectId(session.customer) === customerId
          ) {
            await tx.checkoutClaim.upsert({
              where: { sessionId: session.id },
              create: {
                sessionId: session.id,
                stripeCustomerId: customerId,
                subscriptionId,
                expiresAt: new Date(session.created * 1000 + CLAIM_WINDOW_MS),
              },
              update: {},
            });
          }
        }
        await tx.stripeEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return { duplicate: false, userId };
      },
      { timeout: 30_000 },
    );
    if (touched.duplicate) return;
    if (touched.userId !== null) {
      try {
        await refresh(touched.userId);
      } catch {
        logUnknown(event.id, "mail quota refresh failed");
      }
    }
  };
  return { process };
}
