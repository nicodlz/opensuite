import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Actor } from "@opensuite/core/services/accounts";
import {
  entitledStatuses,
  type BillingInterval,
  type PlanId,
} from "@opensuite/contracts";
import type { PrismaClient } from "@opensuite/db";
import { Stripe } from "stripe";
import type { BillingConfig } from "../config.ts";
import type { Entitlements } from "./entitlements.ts";
import { classifyPrice, createPriceResolver } from "./prices.ts";

export const STRIPE_API_VERSION = "2026-09-30.endive" as const;
export const BILLING_INTEGRATION = "esuno-cloud-v1";
type CloudConfig = Extract<BillingConfig, { mode: "cloud" }>;
export type PlanChoice = { plan: PlanId; interval: BillingInterval };

export function createStripeBilling(
  db: PrismaClient,
  config: CloudConfig,
  origin: string,
  entitlements: Entitlements,
  client = new Stripe(config.stripeSecretKey, {
    apiVersion: STRIPE_API_VERSION,
    timeout: 5_000,
    maxNetworkRetries: 1,
  }),
) {
  const resolvePrice = createPriceResolver(client);
  const updatedUrl = `${origin}/settings/billing?billing=updated`;
  const canceledUrl = `${origin}/settings/billing?billing=canceled`;
  const verifyCustomer = async (id: string, userId: string) => {
    const customer = await client.customers.retrieve(id);
    if (
      customer.deleted ||
      customer.metadata["esuno"] !== "1" ||
      customer.metadata["userId"] !== userId
    )
      throw new Error("billing customer unavailable");
  };
  const customerFor = async (actor: Actor) => {
    const existing = await db.billingCustomer.findUnique({
      where: { userId: actor.id },
    });
    if (existing !== null) {
      await verifyCustomer(existing.stripeCustomerId, actor.id);
      return existing.stripeCustomerId;
    }
    const customer = await client.customers.create(
      {
        email: actor.email,
        metadata: {
          userId: actor.id,
          integration: BILLING_INTEGRATION,
          esuno: "1",
        },
      },
      { idempotencyKey: `esuno_customer_${actor.id}` },
    );
    const row = await db.billingCustomer.upsert({
      where: { userId: actor.id },
      create: {
        userId: actor.id,
        stripeCustomerId: customer.id,
        metadataSyncedAt: new Date(),
      },
      update: {},
    });
    if (row.stripeCustomerId !== customer.id)
      throw new Error("billing customer mismatch");
    return row.stripeCustomerId;
  };
  const checkoutUnlocked = async (actor: Actor | null, choice: PlanChoice) => {
    if (actor !== null) {
      const entitlement = await entitlements.get(actor.id);
      if (entitlement.grant)
        throw new ORPCError("CONFLICT", {
          status: 409,
          defined: true,
          message: "An active grant already provides access",
        });
      if (
        entitlement.subscription !== null &&
        entitledStatuses.some(
          (status) => status === entitlement.subscription?.status,
        )
      )
        throw new ORPCError("CONFLICT", {
          status: 409,
          defined: true,
          message: "Use the billing portal to change your plan",
        });
    }
    const price = await resolvePrice(choice.plan, choice.interval);
    const customer = actor === null ? undefined : await customerFor(actor);
    if (customer !== undefined) {
      const subscriptions = await client.subscriptions
        .list({ customer, status: "all", limit: 100 })
        .autoPagingToArray({ limit: 10_000 });
      if (
        subscriptions.some(
          (sub) =>
            sub.status !== "canceled" && sub.status !== "incomplete_expired",
        )
      )
        throw new ORPCError("CONFLICT", {
          status: 409,
          defined: true,
          message:
            "An existing subscription must be managed in billing settings",
        });
      const sessions = await client.checkout.sessions
        .list({ customer, status: "open", limit: 100 })
        .autoPagingToArray({ limit: 10_000 });
      /* oxlint-disable eslint/no-await-in-loop */
      for (const open of sessions) {
        if (
          open.metadata?.["esuno"] === "1" &&
          open.metadata["integration"] === BILLING_INTEGRATION
        )
          await client.checkout.sessions.expire(open.id);
      }
      /* oxlint-enable eslint/no-await-in-loop */
    }
    const session = await client.checkout.sessions.create(
      {
        mode: "subscription",
        allowed_payment_method_types: ["card"],
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: {
          integration: BILLING_INTEGRATION,
          esuno: "1",
          plan: choice.plan,
          interval: choice.interval,
          ...(actor === null ? {} : { userId: actor.id }),
        },
        subscription_data: {
          description: `Esuno ${choice.plan === "plus" ? "Plus" : "Pro"}`,
          metadata: {
            integration: BILLING_INTEGRATION,
            esuno: "1",
            ...(actor === null ? {} : { userId: actor.id }),
          },
        },
        ...(customer === undefined ? {} : { customer }),
        ...(actor === null ? {} : { client_reference_id: actor.id }),
        success_url:
          actor === null
            ? `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`
            : updatedUrl,
        cancel_url:
          actor === null
            ? (config.cancelUrl ?? "https://esuno.net")
            : canceledUrl,
        ...(config.automaticTax
          ? {
              automatic_tax: { enabled: true },
              billing_address_collection: "required" as const,
              tax_id_collection: { enabled: true },
              ...(customer === undefined
                ? {}
                : {
                    customer_update: {
                      address: "auto" as const,
                      name: "auto" as const,
                    },
                  }),
            }
          : {}),
      },
      { idempotencyKey: `esuno_checkout_${randomUUID()}` },
    );
    if (session.url === null) throw new Error("checkout URL unavailable");
    return { url: session.url };
  };
  const busy = new Set<string>();
  const serialize = async <T>(
    userId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (busy.has(userId))
      throw new ORPCError("CONFLICT", {
        status: 409,
        defined: true,
        message: "A billing request is already in progress",
      });
    busy.add(userId);
    try {
      return await work();
    } finally {
      busy.delete(userId);
    }
  };
  const checkout = async (actor: Actor | null, choice: PlanChoice) =>
    actor === null
      ? checkoutUnlocked(null, choice)
      : serialize(actor.id, () => checkoutUnlocked(actor, choice));
  const portalUnlocked = async (actor: Actor, choice?: PlanChoice) => {
    const customer = await db.billingCustomer.findUnique({
      where: { userId: actor.id },
    });
    if (customer === null)
      throw new ORPCError("CONFLICT", { status: 409, defined: true });
    await verifyCustomer(customer.stripeCustomerId, actor.id);
    let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
    if (choice !== undefined) {
      const entitlement = await entitlements.get(actor.id);
      const sub = entitlement.subscription;
      if (
        entitlement.grant ||
        entitlement.plan === "none" ||
        sub === null ||
        !entitledStatuses.some((status) => status === sub.status)
      )
        throw new ORPCError("CONFLICT", { status: 409, defined: true });
      const [price, current] = await Promise.all([
        resolvePrice(choice.plan, choice.interval),
        client.subscriptions.retrieve(sub.id),
      ]);
      const item = current.items.data[0];
      if (
        item === undefined ||
        current.items.data.length !== 1 ||
        item.quantity !== 1 ||
        current.metadata["esuno"] !== "1" ||
        classifyPrice(item.price) === null ||
        (typeof current.customer === "string"
          ? current.customer
          : current.customer.id) !== customer.stripeCustomerId
      )
        throw new Error("subscription unavailable");
      flow = {
        type: "subscription_update_confirm",
        subscription_update_confirm: {
          subscription: sub.id,
          items: [{ id: item.id, price: price.id, quantity: 1 }],
        },
        after_completion: {
          type: "redirect",
          redirect: { return_url: updatedUrl },
        },
      };
    }
    const configurations = await client.billingPortal.configurations
      .list({ active: true, limit: 100 })
      .autoPagingToArray({ limit: 10_000 });
    const managed = configurations.filter(
      (item) => !item.is_default && item.metadata?.["esuno"] === "1",
    );
    if (managed.length !== 1 || managed[0] === undefined)
      throw new Error("billing portal unavailable");
    const session = await client.billingPortal.sessions.create(
      {
        customer: customer.stripeCustomerId,
        configuration: managed[0].id,
        return_url: updatedUrl,
        ...(flow === undefined ? {} : { flow_data: flow }),
      },
      { idempotencyKey: `esuno_portal_${randomUUID()}` },
    );
    return { url: session.url };
  };
  const portal = (actor: Actor, choice?: PlanChoice) =>
    serialize(actor.id, () => portalUnlocked(actor, choice));
  return {
    client,
    checkout,
    portal,
    resolvePrice,
    updatedUrl,
  };
}
export type StripeBilling = ReturnType<typeof createStripeBilling>;
