/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { createReadinessService } from "@opensuite/core";
import { Stripe } from "stripe";
import { expect, it, vi } from "vitest";
import type { StripeBilling } from "../src/billing/stripe.ts";
import { buildServer } from "../src/server.ts";

it("verifies the exact webhook bytes, secret and timestamp", async () => {
  const stripe = new Stripe("sk_test_12345678901234567890", {
    apiVersion: "2026-09-30.endive",
  });
  const secret = "whsec_abcdefghijklmnopqrstuvwxyz123456";
  const processEvent = vi
    .fn<(event: Stripe.Event) => Promise<void>>()
    .mockResolvedValue(undefined);
  const app = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: () => 0,
    }),
    monotonicMs: () => 0,
    identity: {
      handler: () => Promise.resolve(new Response()),
      publicOrigin: "https://mail.example.test",
    },
    billing: { client: stripe } as StripeBilling,
    webhook: {
      secret,
      processor: { process: processEvent },
    },
  });
  try {
    const payload = JSON.stringify({
      id: "evt_test_123",
      type: "customer.subscription.updated",
      created: 1,
      data: { object: { id: "sub_123" } },
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    const send = (body: string, signature: string) =>
      app.inject({
        method: "POST",
        url: "/billing/webhook",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
        payload: body,
      });
    expect((await send(payload, header)).statusCode).toBe(200);
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect((await send(`${payload} `, header)).statusCode).toBe(400);
    expect(
      (
        await send(
          payload,
          stripe.webhooks.generateTestHeaderString({
            payload,
            secret: "whsec_wrongwrongwrongwrongwrong",
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(
          payload,
          stripe.webhooks.generateTestHeaderString({
            payload,
            secret,
            timestamp: Math.floor(Date.now() / 1000) - 301,
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(processEvent).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
