import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import { BILLING_INTEGRATION } from "./stripe.ts";

export function startCustomerMetadataJob(
  db: PrismaClient,
  stripe: Stripe,
  onError: () => void,
) {
  let running: Promise<void> | undefined;
  const work = async () => {
    const pending = await db.billingCustomer.findMany({
      where: { metadataSyncedAt: null },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { userId: true, stripeCustomerId: true },
    });
    // Limit concurrent Stripe reads/writes and never update an unowned customer.
    /* oxlint-disable eslint/no-await-in-loop */
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(
        pending.slice(i, i + 4).map(async (item) => {
          try {
            const customer = await stripe.customers.retrieve(
              item.stripeCustomerId,
            );
            if (customer.deleted || customer.metadata["esuno"] !== "1")
              throw new Error("customer not owned");
            await stripe.customers.update(item.stripeCustomerId, {
              metadata: {
                esuno: "1",
                integration: BILLING_INTEGRATION,
                userId: item.userId,
              },
            });
            await db.billingCustomer.update({
              where: { userId: item.userId },
              data: { metadataSyncedAt: new Date() },
            });
          } catch {
            onError();
          }
        }),
      );
    }
    /* oxlint-enable eslint/no-await-in-loop */
  };
  const tick = () => {
    if (running !== undefined) return;
    running = work()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 300_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
