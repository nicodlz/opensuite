import {
  plans,
  priceLookupKey,
  type BillingInterval,
  type PlanId,
} from "@opensuite/contracts";
import type Stripe from "stripe";

export function matchesPrice(
  price: Stripe.Price,
  plan: PlanId,
  interval: BillingInterval,
) {
  return (
    price.active &&
    price.metadata["esuno"] === "1" &&
    price.lookup_key === priceLookupKey(plan, interval) &&
    price.currency === "eur" &&
    price.unit_amount === plans[plan].prices[interval].amount &&
    price.tax_behavior === "inclusive" &&
    price.type === "recurring" &&
    price.recurring?.interval === interval &&
    price.recurring.interval_count === 1
  );
}

export function createPriceResolver(
  stripe: Stripe,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { price: Stripe.Price; expires: number }>();
  return async (plan: PlanId, interval: BillingInterval) => {
    const key = priceLookupKey(plan, interval);
    const cached = cache.get(key);
    if (cached !== undefined && cached.expires > now()) return cached.price;
    const result = await stripe.prices.list({
      active: true,
      lookup_keys: [key],
      limit: 2,
    });
    if (
      result.data.length !== 1 ||
      result.data[0] === undefined ||
      !matchesPrice(result.data[0], plan, interval)
    )
      throw new Error("Stripe price mismatch");
    cache.set(key, { price: result.data[0], expires: now() + 300_000 });
    return result.data[0];
  };
}

export function classifyPrice(price: Stripe.Price) {
  for (const plan of ["plus", "pro"] as const)
    for (const interval of ["month", "year"] as const)
      if (matchesPrice(price, plan, interval)) return { plan, interval };
  return null;
}
