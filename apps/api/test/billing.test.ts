import { createReadinessService } from "@opensuite/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.ts";

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

it("serves self-hosted billing without calling Stripe", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  app = await buildServer({
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
      actor: () =>
        Promise.resolve({
          id: "user",
          email: "user@example.test",
          role: "user",
        }),
    },
  });
  const plans = await app.inject("/billing/plans");
  expect(plans.statusCode).toBe(200);
  expect(plans.json()).toMatchObject({ mode: "self-hosted", checkout: false });
  const overview = await app.inject("/billing");
  expect(overview.statusCode).toBe(200);
  expect(overview.json()).toMatchObject({
    mode: "self-hosted",
    plan: "free",
    uploadsAllowed: true,
    storage: { quotaBytes: null, measured: false },
  });
  const headers = { origin: "https://mail.example.test" };
  const server = app;
  const disabledResponses = await Promise.all(
    (
      [
        ["/billing/checkout", { plan: "plus", interval: "month" }],
        ["/billing/change", { plan: "pro", interval: "year" }],
        ["/billing/portal", {}],
        [
          "/billing/claim",
          {
            sessionId: "cs_test_a",
            name: "A",
            localPart: "alice",
            password: "long-enough-password",
          },
        ],
      ] as const
    ).map(([url, payload]) =>
      server.inject({
        method: "POST",
        url,
        headers,
        payload,
      }),
    ),
  );
  for (const response of disabledResponses) {
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "BILLING_DISABLED" });
  }
  const status = await app.inject("/billing/checkout/cs_test_a");
  expect(status.statusCode).toBe(404);
  expect(status.json()).toMatchObject({ code: "BILLING_DISABLED" });
  expect(network).not.toHaveBeenCalled();
});
