/* oxlint-disable eslint/no-await-in-loop, typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  configureApplicationRole,
  createAliasStore,
  createDatabase,
  type PrismaClient,
} from "@opensuite/db";
import { createAliasService } from "@opensuite/core/services/aliases";
import { ok } from "neverthrow";
import type Stripe from "stripe";
import { createWebhookProcessor } from "../src/billing/webhook.ts";
import { createEntitlements } from "../src/billing/entitlements.ts";
import { createClaimService } from "../src/billing/claims.ts";
import { createStripeBilling } from "../src/billing/stripe.ts";
import { createGrantStore } from "../src/billing/grants.ts";
import type { BillingConfig } from "../src/config.ts";

const run = promisify(execFile);
const container = `esuno-billing-db-${randomUUID().slice(0, 8)}`;
let db: PrismaClient;
let databaseUrl = "";
beforeAll(async () => {
  try {
    await run("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=test-password",
      "-e",
      "POSTGRES_INITDB_ARGS=--no-sync",
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ]);
    for (let i = 0; ; i++) {
      try {
        await run("docker", [
          "exec",
          container,
          "pg_isready",
          "-U",
          "postgres",
        ]);
        break;
      } catch (error) {
        if (i >= 120) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const port = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", container, "5432"])).stdout,
    )?.[1];
    if (!port) throw new Error("missing PostgreSQL port");
    const url = `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`;
    databaseUrl = url;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, maxBuffer: 4_000_000 },
    );
    const client = createDatabase(url);
    if (client.isErr()) throw new Error("database unavailable");
    db = client.value;
  } catch (error) {
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
    throw error;
  }
}, 180_000);
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  await db?.$disconnect();
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
}, 60_000);

it("uses current Stripe state for duplicate and out-of-order subscription events", async () => {
  const userId = `billing-${randomUUID()}`;
  await db.user.create({
    data: { id: userId, name: "Billing", email: `${userId}@example.test` },
  });
  await db.billingCustomer.create({
    data: { userId, stripeCustomerId: "cus_test_fixture" },
  });
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
  };
  let current = {
    id: "sub_test_fixture",
    customer: "cus_test_fixture",
    metadata: { integration: "esuno-cloud-v1", esuno: "1" },
    status: "active",
    items: {
      data: [
        {
          id: "si_test",
          quantity: 1,
          price,
          current_period_start: 1_700_000_000,
          current_period_end: 1_800_000_000,
        },
      ],
    },
    latest_invoice: { status: "paid" },
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
  };
  let fetches = 0;
  let customerOwned = true;
  let fetchFails = false;
  let invoiceOwned = false;
  const stripe = {
    subscriptions: {
      retrieve: () => {
        fetches++;
        return fetchFails
          ? Promise.reject(new Error("fixture outage"))
          : Promise.resolve(current);
      },
    },
    prices: {
      retrieve: () =>
        Promise.resolve(
          invoiceOwned
            ? price
            : { ...price, lookup_key: "foreign_plan", metadata: {} },
        ),
    },
    customers: {
      retrieve: () =>
        Promise.resolve({
          id: "cus_test_fixture",
          metadata: customerOwned ? { esuno: "1" } : {},
        }),
    },
  } as unknown as Stripe;
  const config: BillingConfig = {
    mode: "cloud",
    stripeSecretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    internalToken: "x".repeat(32),
    automaticTax: false,
  };
  const entitlements = createEntitlements(db, config, 1000);
  let refreshes = 0;
  const webhook = createWebhookProcessor(
    db,
    stripe,
    () => {
      refreshes++;
      return Promise.resolve();
    },
    () => {},
  );
  const event = (id: string, created: number) =>
    ({
      id,
      type: "customer.subscription.updated",
      created,
      data: { object: current },
    }) as unknown as Stripe.Event;
  const first = event("evt_fixture_1", 200);
  const foreignCheckout = {
    id: "evt_foreign_checkout",
    type: "checkout.session.completed",
    created: 9,
    data: { object: { id: "cs_other", metadata: {} } },
  } as unknown as Stripe.Event;
  await webhook.process(foreignCheckout);
  expect(
    (
      await db.stripeEvent.findUniqueOrThrow({
        where: { id: foreignCheckout.id },
      })
    ).ignoredAt,
  ).not.toBeNull();
  const foreign = {
    ...event("evt_foreign", 10),
    data: { object: { ...current, metadata: {} } },
  } as unknown as Stripe.Event;
  await webhook.process(foreign);
  expect(fetches).toBe(0);
  expect(
    (await db.stripeEvent.findUniqueOrThrow({ where: { id: foreign.id } }))
      .ignoredAt,
  ).not.toBeNull();
  const foreignPrice = {
    ...event("evt_foreign_price", 12),
    data: {
      object: {
        ...current,
        items: {
          data: [
            {
              ...current.items.data[0],
              price: { ...price, lookup_key: "other_business_month" },
            },
          ],
        },
      },
    },
  } as unknown as Stripe.Event;
  await webhook.process(foreignPrice);
  expect(fetches).toBe(0);
  expect(
    (await db.stripeEvent.findUniqueOrThrow({ where: { id: foreignPrice.id } }))
      .ignoredAt,
  ).not.toBeNull();
  const foreignInvoice = {
    id: "evt_foreign_invoice",
    type: "invoice.paid",
    created: 13,
    data: {
      object: {
        parent: {
          subscription_details: {
            metadata: { esuno: "1" },
            subscription: current.id,
          },
        },
        lines: {
          has_more: false,
          data: [{ pricing: { price_details: { price: "price_other" } } }],
        },
      },
    },
  } as unknown as Stripe.Event;
  await webhook.process(foreignInvoice);
  expect(fetches).toBe(0);
  expect(
    (
      await db.stripeEvent.findUniqueOrThrow({
        where: { id: foreignInvoice.id },
      })
    ).ignoredAt,
  ).not.toBeNull();
  customerOwned = false;
  await webhook.process(event("evt_foreign_customer", 15));
  expect(
    await db.subscription.findUnique({ where: { id: current.id } }),
  ).toBeNull();
  customerOwned = true;
  await Promise.all([webhook.process(first), webhook.process(first)]);
  expect(refreshes).toBe(1);
  fetchFails = true;
  await expect(
    webhook.process(event("evt_fixture_retry", 201)),
  ).rejects.toThrow("fixture outage");
  expect(
    (
      await db.stripeEvent.findUniqueOrThrow({
        where: { id: "evt_fixture_retry" },
      })
    ).processedAt,
  ).toBeNull();
  fetchFails = false;
  await webhook.process(event("evt_fixture_retry", 201));
  expect(
    (
      await db.stripeEvent.findUniqueOrThrow({
        where: { id: "evt_fixture_retry" },
      })
    ).processedAt,
  ).not.toBeNull();
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "plus",
    quotaBytes: 50_000_000_000,
    uploadsAllowed: true,
  });
  current = { ...current, status: "past_due" };
  invoiceOwned = true;
  const invoice = (
    id: string,
    type:
      | "invoice.paid"
      | "invoice.payment_failed"
      | "invoice.payment_action_required",
  ) => ({ ...foreignInvoice, id, type }) as unknown as Stripe.Event;
  await webhook.process(
    invoice("evt_payment_failed", "invoice.payment_failed"),
  );
  await webhook.process(
    invoice("evt_payment_action", "invoice.payment_action_required"),
  );
  expect((await entitlements.get(userId)).subscription?.status).toBe(
    "past_due",
  );
  const olderEvent = event("evt_fixture_old", 100);
  current = { ...current, status: "unpaid" };
  await webhook.process(olderEvent);
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "none",
    quotaBytes: 0,
    uploadsAllowed: false,
  });
  current = { ...current, status: "active" };
  await webhook.process(invoice("evt_payment_paid", "invoice.paid"));
  expect((await entitlements.get(userId)).uploadsAllowed).toBe(true);
  current = {
    ...current,
    status: "active",
    cancel_at_period_end: true,
    items: {
      data: [
        {
          id: "si_test",
          quantity: 1,
          current_period_start: 1_700_000_000,
          current_period_end: 1_800_000_000,
          price: {
            ...price,
            id: "price_pro_year",
            lookup_key: "esuno_pro_year",
            unit_amount: 9588,
            recurring: { interval: "year", interval_count: 1 },
          },
        },
      ],
    },
  };
  await webhook.process(event("evt_fixture_3", 400));
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "pro",
    quotaBytes: 500_000_000_000,
    subscription: { cancelAtPeriodEnd: true, interval: "year" },
  });
  current = {
    ...current,
    items: {
      data: [
        {
          id: "si_test",
          quantity: 1,
          current_period_start: 1_700_000_000,
          current_period_end: 1_800_000_000,
          price: {
            ...price,
            id: "price_plus_year",
            lookup_key: "esuno_plus_year",
            unit_amount: 3588,
            recurring: { interval: "year", interval_count: 1 },
          },
        },
      ],
    },
  };
  await webhook.process(event("evt_fixture_downgrade", 401));
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "plus",
    subscription: { interval: "year" },
  });
  current = {
    ...current,
    items: {
      data: [
        {
          id: "si_test",
          quantity: 1,
          current_period_start: 1_700_000_000,
          current_period_end: 1_800_000_000,
          price,
        },
      ],
    },
  };
  await webhook.process(event("evt_fixture_interval", 402));
  expect((await entitlements.get(userId)).subscription?.interval).toBe("month");
  current = { ...current, status: "canceled" };
  await webhook.process({
    ...event("evt_fixture_4", 500),
    type: "customer.subscription.deleted",
  } as Stripe.Event);
  expect((await entitlements.get(userId)).uploadsAllowed).toBe(false);
});

it("claims a paid public checkout only once and refuses an unpaid session", async () => {
  const created = Math.floor(Date.now() / 1000);
  const session = {
    id: "cs_test_claim",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    client_reference_id: null,
    created,
    customer: "cus_claim",
    subscription: "sub_claim",
    metadata: {
      integration: "esuno-cloud-v1",
      esuno: "1",
      plan: "plus",
      interval: "month",
    },
  };
  const stripe = {
    checkout: { sessions: { retrieve: () => Promise.resolve(session) } },
    customers: { update: () => Promise.resolve({}) },
  } as unknown as Stripe;
  await db.subscription.create({
    data: {
      id: "sub_claim",
      stripeCustomerId: "cus_claim",
      plan: "plus",
      interval: "month",
      status: "active",
      priceId: "price_claim",
      storageQuotaBytes: 50_000_000_000n,
      stripeObservedAt: new Date(),
    },
  });
  await db.checkoutClaim.create({
    data: {
      sessionId: session.id,
      stripeCustomerId: "cus_claim",
      subscriptionId: "sub_claim",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const claims = createClaimService(
    db,
    stripe,
    "claim.test",
    async ({ name, email }) => {
      const userId = randomUUID();
      await db.user.create({ data: { id: userId, name, email } });
      return userId;
    },
  );
  expect((await claims.status(session.id)).state).toBe("claimable");
  session.created = created - 31 * 86_400;
  expect((await claims.status(session.id)).state).toBe("expired");
  session.created = created;
  session.payment_status = "unpaid";
  await expect(
    claims.claim({
      sessionId: session.id,
      localPart: "alice",
      name: "Alice",
      password: "long-enough-password",
    }),
  ).rejects.toMatchObject({ status: 400 });
  session.payment_status = "paid";
  const input = {
    sessionId: session.id,
    localPart: "alice",
    name: "Alice",
    password: "long-enough-password",
  };
  expect(await claims.claim(input)).toEqual({ email: "alice@claim.test" });
  expect((await claims.status(session.id)).state).toBe("claimed");
  await expect(claims.claim(input)).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.subscription.findUniqueOrThrow({ where: { id: "sub_claim" } }))
      .userId,
  ).not.toBeNull();
});

it("creates signed-in and public Checkout sessions and directs plan changes through the portal", async () => {
  const userId = `checkout-${randomUUID()}`;
  const actor = {
    id: userId,
    email: `${userId}@example.test`,
    role: "user" as const,
  };
  await db.user.create({
    data: { id: userId, name: "Checkout", email: actor.email },
  });
  const config: BillingConfig = {
    mode: "cloud",
    stripeSecretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    internalToken: "x".repeat(32),
    automaticTax: true,
    cancelUrl: "https://site.example.test/",
  };
  const entitlements = createEntitlements(db, config, 1000);
  const requests: Record<string, unknown>[] = [];
  const portalRequests: Record<string, unknown>[] = [];
  let ownedPrice = true;
  let quantity = 1;
  const prices = {
    esuno_plus_month: {
      id: "price_plus_month",
      lookup_key: "esuno_plus_month",
      unit_amount: 349,
      recurring: { interval: "month", interval_count: 1 },
    },
    esuno_pro_year: {
      id: "price_pro_year",
      lookup_key: "esuno_pro_year",
      unit_amount: 9588,
      recurring: { interval: "year", interval_count: 1 },
    },
  };
  const stripe = {
    prices: {
      list: ({ lookup_keys }: { lookup_keys: [keyof typeof prices] }) =>
        Promise.resolve({
          data: [
            {
              ...prices[lookup_keys[0]],
              active: true,
              metadata: { esuno: "1" },
              currency: "eur",
              tax_behavior: "inclusive",
              type: "recurring",
            },
          ],
        }),
    },
    customers: {
      create: () => Promise.resolve({ id: "cus_checkout" }),
      retrieve: () =>
        Promise.resolve({
          id: "cus_checkout",
          metadata: { esuno: "1", userId },
        }),
    },
    checkout: {
      sessions: {
        create: (params: Record<string, unknown>) => {
          requests.push(params);
          return Promise.resolve({
            url: "https://checkout.stripe.test/session",
          });
        },
      },
    },
    subscriptions: {
      retrieve: () =>
        Promise.resolve({
          customer: "cus_checkout",
          status: "active",
          metadata: { esuno: "1" },
          items: {
            data: [
              {
                id: "si_checkout",
                quantity,
                price: {
                  ...prices.esuno_plus_month,
                  lookup_key: ownedPrice ? "esuno_plus_month" : "foreign_month",
                  active: true,
                  currency: "eur",
                  tax_behavior: "inclusive",
                  type: "recurring",
                  metadata: { esuno: "1" },
                },
              },
            ],
          },
        }),
    },
    billingPortal: {
      configurations: {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve([
              { id: "bpc_test", is_default: false, metadata: { esuno: "1" } },
              {
                id: "bpc_other_business",
                is_default: true,
                metadata: { esuno: "1" },
              },
              { id: "bpc_foreign", is_default: false, metadata: {} },
            ]),
        }),
      },
      sessions: {
        create: (params: Record<string, unknown>) => {
          portalRequests.push(params);
          return Promise.resolve({
            url: "https://billing.stripe.test/session",
          });
        },
      },
    },
  } as unknown as Stripe;
  const billing = createStripeBilling(
    db,
    config,
    "https://mail.example.test",
    entitlements,
    stripe,
  );
  await billing.checkout(null, { plan: "plus", interval: "month" });
  await billing.checkout(actor, { plan: "plus", interval: "month" });
  expect(requests[0]).toMatchObject({
    mode: "subscription",
    success_url:
      "https://mail.example.test/welcome?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://site.example.test/",
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
  });
  expect(requests[1]).toMatchObject({
    customer: "cus_checkout",
    client_reference_id: userId,
    success_url: "https://mail.example.test/settings/billing?billing=updated",
    cancel_url: "https://mail.example.test/settings/billing?billing=canceled",
  });
  await db.subscription.create({
    data: {
      id: "sub_checkout",
      userId,
      stripeCustomerId: "cus_checkout",
      plan: "plus",
      interval: "month",
      status: "active",
      priceId: "price_plus_month",
      storageQuotaBytes: 50_000_000_000n,
      stripeObservedAt: new Date(),
    },
  });
  await expect(
    billing.checkout(actor, { plan: "plus", interval: "month" }),
  ).rejects.toMatchObject({ status: 409 });
  await billing.portal(actor, { plan: "pro", interval: "year" });
  expect(portalRequests[0]).toMatchObject({
    customer: "cus_checkout",
    configuration: "bpc_test",
    flow_data: {
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: "sub_checkout",
        items: [{ id: "si_checkout", price: "price_pro_year" }],
      },
      after_completion: {
        redirect: {
          return_url:
            "https://mail.example.test/settings/billing?billing=updated",
        },
      },
    },
  });
  const subscription = await db.subscription.findUniqueOrThrow({
    where: { id: "sub_checkout" },
  });
  expect(await billing.verifySubscription(subscription)).toBe(true);
  ownedPrice = false;
  expect(await billing.verifySubscription(subscription)).toBe(false);
  ownedPrice = true;
  quantity = 0;
  expect(await billing.verifySubscription(subscription)).toBe(false);
  quantity = 1;
  prices.esuno_plus_month.unit_amount = 1;
  const mismatched = createStripeBilling(
    db,
    config,
    "https://mail.example.test",
    entitlements,
    stripe,
  );
  await expect(
    mismatched.checkout(null, { plan: "plus", interval: "month" }),
  ).rejects.toThrow("Stripe price mismatch");
  expect(requests).toHaveLength(2);
});

it("enforces managed alias entitlements in the reservation path", async () => {
  const userId = `aliases-${randomUUID()}`;
  const domainId = `domain-${randomUUID()}`;
  await db.user.create({
    data: { id: userId, name: "Alias", email: `${userId}@example.test` },
  });
  await db.domain.create({
    data: {
      id: domainId,
      userId,
      name: `${userId}.test`,
      status: "verified",
      stalwartId: "domain",
    },
  });
  await db.user.update({
    where: { id: userId },
    data: { defaultAliasDomainId: domainId },
  });
  await db.mailboxLink.create({
    data: {
      userId,
      accountId: userId,
      address: `${userId}@example.test`,
      credentialId: "credential",
      secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  const config: BillingConfig = {
    mode: "cloud",
    stripeSecretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    internalToken: "x".repeat(32),
    automaticTax: false,
  };
  const entitlement = createEntitlements(db, config, 1000);
  const aliases = createAliasService(
    createAliasStore(db),
    { set: () => Promise.resolve(ok(undefined)) },
    1000,
    async (owner) => (await entitlement.get(owner)).aliasLimit,
  );
  const blocked = await aliases.create(userId, {});
  expect(blocked.isErr() && blocked.error.kind).toBe("limit");
  await db.subscription.create({
    data: {
      id: `sub-${userId}`,
      userId,
      stripeCustomerId: `cus-${userId}`,
      plan: "plus",
      interval: "month",
      status: "active",
      priceId: "price",
      storageQuotaBytes: 50_000_000_000n,
      stripeObservedAt: new Date(),
    },
  });
  expect((await aliases.create(userId, {})).isOk()).toBe(true);
  const records = Array.from({ length: 49 }, (_, index) => ({
    id: `address-${userId}-${index}`,
    userId,
    domainId,
    localPart: `fixture-${index}`,
    isAlias: true,
  }));
  await db.address.createMany({ data: records });
  await db.emailAlias.createMany({
    data: records.map((record) => ({
      userId,
      domainId,
      addressId: record.id,
      address: `${record.localPart}@${userId}.test`,
      localPart: record.localPart,
    })),
  });
  const limited = await aliases.create(userId, {});
  expect(limited.isErr() && limited.error.kind).toBe("limit");
  await db.subscription.update({
    where: { id: `sub-${userId}` },
    data: { plan: "pro", storageQuotaBytes: 500_000_000_000n },
  });
  expect((await aliases.create(userId, {})).isOk()).toBe(true);
});

it("prioritizes active grants and ignores expired or revoked grants", async () => {
  const userId = `grant-${randomUUID()}`;
  const email = `${userId}@example.test`;
  await db.user.create({ data: { id: userId, name: "Grant", email } });
  await db.subscription.create({
    data: {
      id: `sub-${userId}`,
      userId,
      stripeCustomerId: `cus-${userId}`,
      plan: "plus",
      interval: "month",
      status: "active",
      priceId: "price",
      storageQuotaBytes: 50_000_000_000n,
      stripeObservedAt: new Date(),
    },
  });
  const config: BillingConfig = {
    mode: "cloud",
    stripeSecretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    internalToken: "x".repeat(32),
    automaticTax: false,
  };
  let verifications = 0;
  const entitlements = createEntitlements(db, config, 1000, () => {
    verifications++;
    return Promise.resolve(true);
  });
  const grants = createGrantStore(db);
  await grants.grant({
    email,
    plan: "pro",
    reason: "complimentary",
    expiresAt: null,
  });
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "pro",
    quotaBytes: 500_000_000_000,
    addressLimit: 15,
    subscription: null,
    grant: true,
  });
  expect(verifications).toBe(0);
  await grants.grant({
    email,
    plan: "unlimited",
    reason: "operator",
    expiresAt: null,
  });
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "pro",
    exempt: true,
    quotaBytes: null,
    addressLimit: null,
    subscription: null,
  });
  await db.user.update({ where: { id: userId }, data: { role: "admin" } });
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "pro",
    exempt: true,
    quotaBytes: null,
    subscription: null,
    grant: true,
  });
  await db.user.update({ where: { id: userId }, data: { role: "user" } });
  await db.billingGrant.update({
    where: { userId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "plus",
    addressLimit: 5,
    grant: false,
  });
  expect(verifications).toBe(1);
  await grants.grant({
    email,
    plan: "plus",
    reason: "limited",
    expiresAt: null,
  });
  await grants.revoke(email, "ended");
  expect(await entitlements.get(userId)).toMatchObject({
    plan: "plus",
    grant: false,
  });
  expect(verifications).toBe(2);
  expect(
    await createEntitlements(db, { mode: "self-hosted" }, 1000).get(userId),
  ).toMatchObject({ plan: "free", quotaBytes: null, addressLimit: null });
  const audits = await db.auditEvent.findMany({
    where: { userId, action: { startsWith: "billing.grant." } },
  });
  expect(audits.map((item) => item.action)).toEqual(
    expect.arrayContaining(["billing.grant.create", "billing.grant.revoke"]),
  );
});

it("does not permit the application database role to write grants", async () => {
  const password = "grant-role-fixture-password-01234567890123456789";
  await configureApplicationRole(db, password);
  const url = new URL(databaseUrl);
  url.username = "opensuite_app";
  url.password = password;
  const result = createDatabase(url.toString());
  if (result.isErr()) throw new Error("application role unavailable");
  const userId = `grant-role-${randomUUID()}`;
  await db.user.create({
    data: { id: userId, name: "Grant role", email: `${userId}@example.test` },
  });
  try {
    expect(
      await result.value.billingGrant.findUnique({ where: { userId } }),
    ).toBeNull();
    await expect(
      result.value.billingGrant.create({
        data: { userId, plan: "unlimited", reason: "forbidden" },
      }),
    ).rejects.toBeDefined();
  } finally {
    await result.value.$disconnect();
  }
});

it("manages grants only through the operator CLI and audits each action", async () => {
  const userId = `grant-cli-${randomUUID()}`;
  const email = `${userId}@example.test`;
  await db.user.create({ data: { id: userId, name: "Grant CLI", email } });
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BILLING_INTERNAL_API: "",
    BILLING_INTERNAL_TOKEN_FILE: "",
  };
  const execute = (...args: string[]) =>
    run("node", ["apps/api/src/billing-grant.ts", ...args], {
      env,
      maxBuffer: 1_000_000,
    });
  expect(
    (
      await execute(
        email,
        "--plan",
        "unlimited",
        "--reason",
        "operator fixture",
      )
    ).stdout,
  ).toContain("Granted unlimited");
  expect((await execute("--list")).stdout).toContain(email);
  expect(
    (await execute(email, "--revoke", "--reason", "finished")).stdout,
  ).toContain("Revoked grant");
  const actions = await db.auditEvent.findMany({
    where: { action: { startsWith: "billing.grant." } },
    select: { action: true },
  });
  expect(actions.map((row) => row.action)).toEqual(
    expect.arrayContaining([
      "billing.grant.create",
      "billing.grant.revoke",
      "billing.grant.list",
    ]),
  );
});
