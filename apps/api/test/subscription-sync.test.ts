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
  let completed = false;
  const db = {
    billingSyncState: {
      upsert: () => Promise.resolve({}),
      updateMany: (args: { data: { lastCompletedAt?: Date } }) => {
        if (args.data.lastCompletedAt) completed = true;
        return Promise.resolve({
          count: completed && !args.data.lastCompletedAt ? 0 : 1,
        });
      },
    },
    subscription: { findMany: () => Promise.resolve([row]) },
    $transaction: (fn: (value: typeof tx) => Promise<void>) => fn(tx),
  } as unknown as PrismaClient;
  const customerUpdate = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const retrieve = vi.fn<() => void>();
  const customerState: { userId?: string } = {};
  const stripe = {
    subscriptions: {
      retrieve: () => {
        retrieve();
        return Promise.resolve({
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
        });
      },
    },
    customers: {
      retrieve: () =>
        Promise.resolve({
          deleted: false,
          metadata: {
            esuno: "1",
            ...(customerState.userId ? { userId: customerState.userId } : {}),
          },
        }),
      update: customerUpdate,
    },
  } as unknown as Stripe;
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const errors = vi.fn<() => void>();
  const stop = startSubscriptionSync(db, stripe, refresh, errors);
  await vi.advanceTimersByTimeAsync(30_000);
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
  expect(customerUpdate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(retrieve).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  await stop();
  const stopAfterRestart = startSubscriptionSync(db, stripe, refresh, errors);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(retrieve).toHaveBeenCalledOnce();
  customerState.userId = "different-user";
  completed = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      // oxlint-disable-next-line typescript/no-unsafe-assignment
      data: expect.objectContaining({ status: "unowned" }),
    }),
  );
  expect(errors).toHaveBeenCalledOnce();
  expect(customerUpdate).toHaveBeenCalledOnce();
  await stopAfterRestart();
});

it("paces batches and excludes subscriptions ended before the grace period", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `sub-${i}`,
    userId: "u",
    stripeCustomerId: "cus",
    stripeObservedAt: new Date(0),
  }));
  const findMany = vi
    .fn<(input: unknown) => Promise<typeof rows>>()
    .mockResolvedValue(rows);
  const retrieve = vi
    .fn<() => Promise<never>>()
    .mockRejectedValue(new Error("fixture outage"));
  const state = {
    upsert: () => Promise.resolve({}),
    updateMany: () => Promise.resolve({ count: 1 }),
  };
  const db = {
    billingSyncState: state,
    subscription: { findMany },
  } as unknown as PrismaClient;
  const stripe = { subscriptions: { retrieve } } as unknown as Stripe;
  const stop = startSubscriptionSync(
    db,
    stripe,
    () => Promise.resolve(),
    () => {},
  );
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(retrieve).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(retrieve).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(retrieve).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(findMany.mock.calls[0]?.[0])).toContain("endedAt");
    expect(JSON.stringify(findMany.mock.calls[0]?.[0])).toContain(
      "incomplete_expired",
    );
  } finally {
    await stop();
    random.mockRestore();
  }
});
