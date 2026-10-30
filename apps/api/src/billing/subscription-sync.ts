import { plans } from "@opensuite/contracts";
import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import { classifyPrice } from "./prices.ts";
import { BILLING_INTEGRATION } from "./stripe.ts";

const date = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000);

/** Slowly reconcile owned rows after missed webhooks, with bounded Stripe concurrency. */
export function startSubscriptionSync(
  db: PrismaClient,
  stripe: Stripe,
  refresh: (userId: string) => Promise<void>,
  onError: () => void,
) {
  let running: Promise<void> | undefined;
  const sync = async (row: {
    id: string;
    userId: string | null;
    stripeCustomerId: string;
  }) => {
    if (row.userId === null) return;
    const userId = row.userId;
    try {
      const observed = new Date();
      const current = await stripe.subscriptions.retrieve(row.id, {
        expand: ["latest_invoice"],
      });
      const customerId =
        typeof current.customer === "string"
          ? current.customer
          : current.customer.id;
      const customer = await stripe.customers.retrieve(row.stripeCustomerId);
      const item = current.items.data[0];
      const price =
        item && current.items.data.length === 1 && item.quantity === 1
          ? classifyPrice(item.price)
          : null;
      const owned =
        current.metadata["esuno"] === "1" &&
        current.metadata["integration"] === BILLING_INTEGRATION &&
        customerId === row.stripeCustomerId &&
        !customer.deleted &&
        customer.metadata["esuno"] === "1" &&
        customer.metadata["userId"] === userId &&
        price !== null;
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${row.id}, 71032))`;
        const local = await tx.subscription.findUnique({
          where: { id: row.id },
        });
        if (
          local === null ||
          local.userId !== userId ||
          local.stripeCustomerId !== row.stripeCustomerId ||
          local.stripeObservedAt > observed
        )
          return;
        if (!owned || item === undefined) {
          await tx.subscription.update({
            where: { id: row.id },
            data: { status: "unowned", stripeObservedAt: observed },
          });
          onError();
          return;
        }
        await tx.subscription.update({
          where: { id: row.id },
          data: {
            status: current.status,
            plan: price.plan,
            interval: price.interval,
            priceId: item.price.id,
            storageQuotaBytes: BigInt(plans[price.plan].storageBytes),
            currentPeriodStart: date(item.current_period_start),
            currentPeriodEnd: date(item.current_period_end),
            cancelAtPeriodEnd: current.cancel_at_period_end,
            canceledAt: date(current.canceled_at),
            endedAt: date(current.ended_at),
            latestInvoiceStatus:
              typeof current.latest_invoice === "object" &&
              current.latest_invoice !== null
                ? current.latest_invoice.status
                : null,
            stripeCreatedAt: current.created
              ? new Date(current.created * 1000)
              : null,
            stripeObservedAt: observed,
          },
        });
      });
      await refresh(userId);
    } catch {
      onError();
    }
  };
  const work = async () => {
    let cursor: string | undefined;
    /* oxlint-disable eslint/no-await-in-loop */
    do {
      const page = await db.subscription.findMany({
        where: { userId: { not: null } },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, userId: true, stripeCustomerId: true },
      });
      for (let i = 0; i < page.length; i += 4)
        await Promise.all(page.slice(i, i + 4).map(sync));
      cursor = page.length === 100 ? page.at(-1)?.id : undefined;
    } while (cursor !== undefined);
    /* oxlint-enable eslint/no-await-in-loop */
  };
  const tick = () => {
    if (running) return;
    running = work()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 6 * 60 * 60 * 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
