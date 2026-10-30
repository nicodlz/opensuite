import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Stripe } from "stripe";
import { expect, it } from "vitest";

const run = promisify(execFile);
const image =
  "stripe/stripe-mock@sha256:818639c8a513394ec2abda3b42482c0ff32e24f3cb25aca09f91596d7fca2a4e";
it("accepts the Stripe-hosted subscription Checkout request shape", async () => {
  const name = `esuno-stripe-mock-${randomUUID().slice(0, 8)}`;
  try {
    await run("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      "127.0.0.1::12111",
      image,
    ]);
    const port = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", name, "12111"])).stdout,
    )?.[1];
    if (!port) throw new Error("stripe-mock port unavailable");
    const ready = async (remaining: number): Promise<void> => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/charges?limit=1`,
          { headers: { authorization: "Bearer sk_test_fixture" } },
        );
        if (response.ok) return;
      } catch {
        /* container starting */
      }
      if (remaining === 0) throw new Error("stripe-mock did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await ready(remaining - 1);
    };
    await ready(80);
    const stripe = new Stripe("sk_test_fixture", {
      apiVersion: "2026-09-30.endive",
      host: "127.0.0.1",
      port: Number(port),
      protocol: "http",
      maxNetworkRetries: 2,
    });
    const product = await stripe.products.create({
      id: "esuno_plus",
      name: "Esuno Plus",
      statement_descriptor: "ESUNO.NET",
      tax_code: "txcd_10000000",
      metadata: { esuno: "1" },
    });
    expect(product.object).toBe("product");
    const price = await stripe.prices.create({
      product: "prod_123",
      currency: "eur",
      unit_amount: 349,
      recurring: { interval: "month" },
      tax_behavior: "inclusive",
      lookup_key: "esuno_plus_month",
      metadata: { esuno: "1" },
    });
    expect(price.object).toBe("price");
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        allowed_payment_method_types: ["card"],
        line_items: [{ price: "price_123", quantity: 1 }],
        success_url:
          "https://mail.example.test/settings/billing?billing=updated",
        cancel_url:
          "https://mail.example.test/settings/billing?billing=canceled",
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        metadata: { integration: "esuno-cloud-v1", esuno: "1" },
        subscription_data: {
          metadata: { integration: "esuno-cloud-v1", esuno: "1" },
          description: "Esuno Plus",
        },
      },
      { idempotencyKey: "esuno_mock_checkout_1" },
    );
    expect(session.object).toBe("checkout.session");
  } finally {
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
  }
}, 60_000);
