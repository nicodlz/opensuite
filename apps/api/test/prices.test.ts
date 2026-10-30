/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  classifyPrice,
  createPriceResolver,
  matchesPrice,
} from "../src/billing/prices.ts";

it("checks Stripe prices against the catalogue and caches only valid results", async () => {
  const price = {
    id: "price_plus",
    metadata: { esuno: "1" },
    active: true,
    lookup_key: "esuno_plus_month",
    currency: "eur",
    unit_amount: 349,
    tax_behavior: "inclusive",
    type: "recurring",
    recurring: { interval: "month", interval_count: 1 },
  } as unknown as Stripe.Price;
  expect(matchesPrice(price, "plus", "month")).toBe(true);
  for (const patch of [
    { unit_amount: 350 },
    { currency: "usd" },
    { metadata: { esuno: "0" } },
    { tax_behavior: "exclusive" },
    { recurring: { interval: "year", interval_count: 1 } },
  ])
    expect(
      matchesPrice({ ...price, ...patch } as Stripe.Price, "plus", "month"),
    ).toBe(false);
  expect(classifyPrice({ ...price, active: false })).toEqual({
    plan: "plus",
    interval: "month",
  });
  const list = vi
    .fn<() => Promise<{ data: Stripe.Price[] }>>()
    .mockResolvedValue({ data: [price] });
  const stripe = { prices: { list } } as unknown as Stripe;
  let time = 0;
  const resolve = createPriceResolver(stripe, () => time);
  expect((await resolve("plus", "month")).id).toBe(price.id);
  await resolve("plus", "month");
  expect(list).toHaveBeenCalledTimes(1);
  time = 300_001;
  list.mockResolvedValue({ data: [{ ...price, active: false }] });
  await expect(resolve("plus", "month")).rejects.toThrow(
    "Stripe price mismatch",
  );
  list.mockResolvedValue({ data: [{ ...price, unit_amount: 1 }] });
  await expect(resolve("plus", "month")).rejects.toThrow(
    "Stripe price mismatch",
  );
});
