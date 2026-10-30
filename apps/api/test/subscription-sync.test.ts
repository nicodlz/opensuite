/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { afterEach, expect, it, vi } from "vitest";
import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import { startSubscriptionSync } from "../src/billing/subscription-sync.ts";

afterEach(() => vi.useRealTimers());

it("repairs a stale local subscription from owned live state on the slow job", async () => {
  vi.useFakeTimers();
  const row = {
    id: "sub_1",
    userId: "user",
    stripeCustomerId: "cus_1",
    stripeObservedAt: new Date(Date.now() - 60_000),
  };
  const update = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const tx = {
    $executeRaw: () => Promise.resolve(1),
    subscription: { findUnique: () => Promise.resolve(row), update },
  };
  const db = {
    subscription: { findMany: () => Promise.resolve([row]) },
    $transaction: (fn: (value: typeof tx) => Promise<void>) => fn(tx),
  } as unknown as PrismaClient;
  const stripe = {
    subscriptions: {
      retrieve: () =>
        Promise.resolve({
          customer: "cus_1",
          metadata: { esuno: "1", integration: "esuno-cloud-v1" },
          status: "active",
          items: {
            data: [
              {
                quantity: 1,
                current_period_start: 1,
                current_period_end: 2,
                price: {
                  id: "price_pro",
                  active: false,
                  lookup_key: "esuno_pro_month",
                  metadata: { esuno: "1" },
                  currency: "eur",
                  unit_amount: 999,
                  tax_behavior: "inclusive",
                  type: "recurring",
                  recurring: { interval: "month", interval_count: 1 },
                },
              },
            ],
          },
          cancel_at_period_end: false,
          canceled_at: null,
          ended_at: null,
          latest_invoice: null,
        }),
    },
    customers: {
      retrieve: () =>
        Promise.resolve({
          deleted: false,
          metadata: { esuno: "1", userId: "user" },
        }),
    },
  } as unknown as Stripe;
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const errors = vi.fn<() => void>();
  const stop = startSubscriptionSync(db, stripe, refresh, errors);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      // oxlint-disable-next-line typescript/no-unsafe-assignment
      data: expect.objectContaining({
        status: "active",
        plan: "pro",
        priceId: "price_pro",
        storageQuotaBytes: 500_000_000_000n,
      }),
    }),
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  await stop();
});
