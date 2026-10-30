#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { plans, priceLookupKey } from "@opensuite/contracts";
import { Stripe } from "stripe";
import { z } from "zod";
import { checkTaxReadiness } from "./tax-preflight.ts";
import { BILLING_EVENTS } from "./webhook.ts";
import { STRIPE_API_VERSION } from "./stripe.ts";

const args = new Set(process.argv.slice(2));
if (
  [...args].some(
    (arg) =>
      !["--live", "--dry-run", "--allow-no-tax-registration"].includes(arg),
  )
)
  throw new Error(
    "Usage: node scripts/stripe-setup.mjs [--live] [--dry-run] [--allow-no-tax-registration]",
  );
const file = process.env["STRIPE_SECRET_KEY_FILE"];
if (!file) throw new Error("STRIPE_SECRET_KEY_FILE is required");
const key = (await readFile(file, "utf8")).trim();
if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key))
  throw new Error("Invalid Stripe key");
if (/^(sk|rk)_live_/.test(key) && !args.has("--live"))
  throw new Error("Live key requires --live");
if (/^(sk|rk)_test_/.test(key) && args.has("--live"))
  throw new Error("--live requires a live key");
const endpoint = process.env["STRIPE_WEBHOOK_URL"];
const publicOrigin = process.env["AUTH_PUBLIC_ORIGIN"];
if (
  !publicOrigin ||
  new URL(publicOrigin).protocol !== "https:" ||
  new URL(publicOrigin).origin !== publicOrigin
)
  throw new Error("AUTH_PUBLIC_ORIGIN must be an HTTPS origin");
if (
  !endpoint ||
  new URL(endpoint).protocol !== "https:" ||
  new URL(endpoint).pathname !== "/api/billing/webhook" ||
  new URL(endpoint).search !== "" ||
  new URL(endpoint).hash !== "" ||
  new URL(endpoint).username !== "" ||
  new URL(endpoint).password !== ""
)
  throw new Error(
    "STRIPE_WEBHOOK_URL must be an HTTPS /api/billing/webhook URL",
  );
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
const dry = args.has("--dry-run");
const say = (action: string) =>
  process.stdout.write(`${dry ? "would " : ""}${action}\n`);
const events: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  ...BILLING_EVENTS,
];
let preflightFailed = false;
const automaticTax = z
  .enum(["true", "false"])
  .parse(process.env["STRIPE_AUTOMATIC_TAX"] || "true");
if (automaticTax === "true") {
  try {
    await checkTaxReadiness(
      stripe,
      args.has("--allow-no-tax-registration"),
      (message) => process.stderr.write(`${message}\n`),
    );
  } catch (error) {
    if (!dry) throw error;
    preflightFailed = true;
    process.stderr.write("Stripe Tax preflight failed; setup is blocked\n");
  }
}
if (preflightFailed) process.exitCode = 1;
const groups: { product: string; prices: string[] }[] = [];
// Prices depend on their product and are deliberately processed in order.
/* oxlint-disable eslint/no-await-in-loop */
for (const plan of ["plus", "pro"] as const) {
  const productId = `esuno_${plan}`;
  let product;
  try {
    product = await stripe.products.retrieve(productId);
  } catch (error) {
    if (
      !(error instanceof Stripe.errors.StripeError) ||
      error.code !== "resource_missing"
    )
      throw error;
  }
  if (
    product &&
    (product.name !== `Esuno ${plans[plan].name}` ||
      (product.unit_label !== null && product.unit_label !== undefined) ||
      product.statement_descriptor !== "ESUNO.NET" ||
      (typeof product.tax_code === "string"
        ? product.tax_code
        : product.tax_code?.id) !== "txcd_10000000" ||
      product.metadata["esuno"] !== "1")
  )
    throw new Error(`Product ${productId} does not match`);
  if (!product) {
    say(`create product ${productId}`);
    if (!dry)
      product = await stripe.products.create(
        {
          id: productId,
          name: `Esuno ${plans[plan].name}`,
          statement_descriptor: "ESUNO.NET",
          tax_code: "txcd_10000000",
          metadata: { integration: "esuno-cloud-v1", esuno: "1", plan },
        },
        { idempotencyKey: `esuno_setup_product_${plan}` },
      );
  }
  const prices: string[] = [];
  for (const interval of ["month", "year"] as const) {
    const lookup = priceLookupKey(plan, interval);
    const found = await stripe.prices.list({
      lookup_keys: [lookup],
      active: true,
      limit: 2,
    });
    if (found.data.length > 1) throw new Error(`Duplicate price ${lookup}`);
    let price = found.data[0];
    if (
      price &&
      (price.metadata["esuno"] !== "1" ||
        price.currency !== "eur" ||
        price.unit_amount !== plans[plan].prices[interval].amount ||
        price.tax_behavior !== "inclusive" ||
        price.recurring?.interval !== interval ||
        price.recurring.interval_count !== 1 ||
        (typeof price.product === "string"
          ? price.product
          : price.product.id) !== productId)
    )
      throw new Error(`Price ${lookup} does not match catalogue`);
    if (!price) {
      say(`create price ${lookup}`);
      if (!dry)
        price = await stripe.prices.create(
          {
            product: productId,
            currency: "eur",
            unit_amount: plans[plan].prices[interval].amount,
            recurring: { interval },
            tax_behavior: "inclusive",
            lookup_key: lookup,
            metadata: { esuno: "1", integration: "esuno-cloud-v1" },
          },
          { idempotencyKey: `esuno_setup_${lookup}` },
        );
    }
    if (price) prices.push(price.id);
  }
  groups.push({ product: productId, prices });
}
/* oxlint-enable eslint/no-await-in-loop */
const configurations = await stripe.billingPortal.configurations
  .list({ active: true, limit: 100 })
  .autoPagingToArray({ limit: 10_000 });
const matches = configurations.filter(
  (configuration) =>
    !configuration.is_default && configuration.metadata?.["esuno"] === "1",
);
if (!configurations.some((configuration) => configuration.is_default))
  throw new Error(
    "An existing default portal configuration is required; setup will not create or change it",
  );
if (matches.length > 1) throw new Error("Multiple Esuno portal configurations");
const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: {
    enabled: true,
    mode: "at_period_end",
    proration_behavior: "none",
  },
  subscription_update: {
    enabled: true,
    default_allowed_updates: ["price"],
    proration_behavior: "create_prorations",
    products: groups,
  },
};
if (dry && groups.some((group) => group.prices.length !== 2))
  say("configure portal after creating prices");
else if (matches[0]) {
  const current = matches[0].features;
  const actualProducts = (current.subscription_update.products ?? [])
    .map((group) => ({
      product: group.product,
      prices: [...group.prices].toSorted(),
    }))
    .toSorted((a, b) => a.product.localeCompare(b.product));
  const expectedProducts = groups
    .map((group) => ({
      product: group.product,
      prices: [...group.prices].toSorted(),
    }))
    .toSorted((a, b) => a.product.localeCompare(b.product));
  if (
    !current.invoice_history.enabled ||
    !current.payment_method_update.enabled ||
    !current.subscription_cancel.enabled ||
    current.subscription_cancel.mode !== "at_period_end" ||
    current.subscription_cancel.proration_behavior !== "none" ||
    !current.subscription_update.enabled ||
    current.subscription_update.proration_behavior !== "create_prorations" ||
    JSON.stringify(
      current.subscription_update.default_allowed_updates.toSorted(),
    ) !== JSON.stringify(["price"]) ||
    JSON.stringify(actualProducts) !== JSON.stringify(expectedProducts)
  )
    throw new Error(
      "Esuno portal configuration does not match; repair it explicitly in Stripe",
    );
  say(`verified dedicated portal ${matches[0].id}`);
} else {
  say("create portal configuration");
  if (!dry)
    await stripe.billingPortal.configurations.create(
      {
        features,
        metadata: { integration: "esuno-cloud-v1", esuno: "1" },
        default_return_url: publicOrigin,
      },
      { idempotencyKey: "esuno_setup_portal_v1" },
    );
}
const endpoints = await stripe.webhookEndpoints
  .list({ limit: 100 })
  .autoPagingToArray({ limit: 10_000 });
const webhook = endpoints.filter((item) => item.url === endpoint);
if (webhook.length > 1) throw new Error("Multiple webhooks use this URL");
if (webhook[0]) {
  const existing = webhook[0];
  if (
    existing.metadata["esuno"] !== "1" ||
    existing.api_version !== STRIPE_API_VERSION ||
    existing.status !== "enabled" ||
    JSON.stringify([...existing.enabled_events].toSorted()) !==
      JSON.stringify([...events].toSorted())
  )
    throw new Error(
      "Webhook URL is owned by another integration or does not match",
    );
  say(`verified webhook ${existing.id}`);
} else {
  say("create webhook endpoint");
  if (!dry) {
    const created = await stripe.webhookEndpoints.create(
      {
        url: endpoint,
        enabled_events: events,
        api_version: STRIPE_API_VERSION,
        metadata: { integration: "esuno-cloud-v1", esuno: "1" },
      },
      { idempotencyKey: "esuno_setup_webhook_v1" },
    );
    if (!created.secret)
      throw new Error("Stripe did not return a webhook secret");
    process.stdout.write(
      `Store this signing secret immediately in STRIPE_WEBHOOK_SECRET_FILE (shown only once): ${created.secret}\n`,
    );
  }
}
