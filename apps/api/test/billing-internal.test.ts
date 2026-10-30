/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { createReadinessService } from "@opensuite/core";
import { expect, it } from "vitest";
import type { Entitlements } from "../src/billing/entitlements.ts";
import type { StorageMeter } from "../src/billing/storage.ts";
import { buildServer } from "../src/server.ts";

it("protects storage usage and refresh with the service token", async () => {
  const calls: string[] = [];
  const entitlements = {
    get: () => Promise.resolve({ quotaBytes: 100, uploadsAllowed: true }),
  } as unknown as Entitlements;
  const storageMeter = {
    mailBytes: () => Promise.resolve(20),
    refresh: (userId: string) => {
      calls.push(userId);
      return Promise.resolve();
    },
  } as unknown as StorageMeter;
  const token = "x".repeat(32);
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
    entitlements,
    storageMeter,
    internalToken: token,
  });
  try {
    expect((await app.inject("/internal/storage/owner")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/internal/storage/owner",
          headers: { authorization: `Bearer ${"y".repeat(32)}` },
        })
      ).statusCode,
    ).toBe(401);
    const response = await app.inject({
      url: "/internal/storage/owner",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json()).toEqual({
      quotaBytes: 100,
      mailBytes: 20,
      uploadsAllowed: true,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/storage/owner/refresh",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(calls).toEqual(["owner"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/storage/owner/refresh/extra",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});

it("limits signed-out Checkout creation by client IP", async () => {
  let calls = 0;
  const service = {
    checkout: () => {
      calls++;
      return Promise.resolve({ url: "https://checkout.stripe.test/session" });
    },
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]["billing"]>;
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
    billing: service,
  });
  try {
    const requests = await Promise.all(
      Array.from({ length: 11 }, () =>
        app.inject({
          method: "POST",
          url: "/billing/checkout",
          headers: { origin: "https://mail.example.test" },
          payload: { plan: "plus", interval: "month" },
        }),
      ),
    );
    expect(
      requests.filter((response) => response.statusCode === 200),
    ).toHaveLength(10);
    expect(
      requests.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
    expect(calls).toBe(10);
  } finally {
    await app.close();
  }
});

it("reports automatic-tax Checkout failures as unavailable", async () => {
  const error = Object.assign(new Error("private Stripe detail"), {
    code: "tax_settings_incomplete",
  });
  const service = {
    checkout: () => Promise.reject(error),
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]["billing"]>;
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
    billing: service,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { origin: "https://mail.example.test" },
      payload: { plan: "plus", interval: "month" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private Stripe detail");
  } finally {
    await app.close();
  }
});

it("limits status and claim calls per client and maps missing Stripe sessions", async () => {
  let statuses = 0;
  let claims = 0;
  const service = {} as NonNullable<
    Parameters<typeof buildServer>[0]["billing"]
  >;
  const claimService = {
    status: () => {
      statuses++;
      return Promise.resolve({
        state: "pending",
        plan: null,
        interval: null,
        domain: "example.test",
      });
    },
    claim: () => {
      claims++;
      return Promise.reject(
        Object.assign(new Error("missing"), { code: "resource_missing" }),
      );
    },
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]["claims"]>;
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
    billing: service,
    claims: claimService,
  });
  try {
    const statusResponses = await Promise.all(
      Array.from({ length: 61 }, () =>
        app.inject("/billing/checkout/cs_test_a"),
      ),
    );
    expect(
      statusResponses.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
    expect(statuses).toBe(60);
    const claimResponses = await Promise.all(
      Array.from({ length: 11 }, () =>
        app.inject({
          method: "POST",
          url: "/billing/claim",
          headers: { origin: "https://mail.example.test" },
          payload: {
            sessionId: "cs_test_a",
            name: "User",
            localPart: "member",
            password: "a-long-password",
          },
        }),
      ),
    );
    expect(
      claimResponses.filter((response) => response.statusCode === 400),
    ).toHaveLength(10);
    expect(
      claimResponses.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
    expect(claims).toBe(10);
  } finally {
    await app.close();
  }
});

it("shares a per-user limit across checkout, change and portal", async () => {
  const service = {
    checkout: () =>
      Promise.resolve({ url: "https://checkout.stripe.test/session" }),
    portal: () =>
      Promise.resolve({ url: "https://billing.stripe.test/session" }),
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]["billing"]>;
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
      actor: () =>
        Promise.resolve({
          id: "same-user",
          email: "user@example.test",
          role: "user",
        }),
    },
    billing: service,
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        app.inject({
          method: "POST",
          url: i % 2 ? "/billing/portal" : "/billing/checkout",
          headers: { origin: "https://mail.example.test" },
          payload: i % 2 ? {} : { plan: "plus", interval: "month" },
        }),
      ),
    );
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(
      1,
    );
  } finally {
    await app.close();
  }
});

it("caps checkout status globally across client addresses", async () => {
  let calls = 0;
  const claims = {
    status: () => {
      calls++;
      return Promise.resolve({
        state: "pending",
        plan: null,
        interval: null,
        domain: "example.test",
      });
    },
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]["claims"]>;
  const service = {} as NonNullable<
    Parameters<typeof buildServer>[0]["billing"]
  >;
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
    billing: service,
    claims,
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 601 }, (_, index) =>
        app.inject({
          method: "GET",
          url: "/billing/checkout/cs_test_a",
          remoteAddress: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`,
        }),
      ),
    );
    expect(
      results.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
    expect(calls).toBe(600);
  } finally {
    await app.close();
  }
});
