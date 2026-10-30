import { createReadinessService } from "@opensuite/core";
import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";

let app: FastifyInstance | undefined;
const monotonicMs = () => performance.now();
afterEach(async () => {
  await app?.close();
});
it("trusts only the configured proxy, limits before lookups and bounds audit events", async () => {
  let lookups = 0;
  let audits = 0;
  app = await buildServer({
    config: { logLevel: "silent", trustProxy: "127.0.0.1" },
    monotonicMs,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () =>
        Promise.resolve(
          new Response("{}", {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
      actor: () => {
        lookups += 1;
        return Promise.resolve(null);
      },
      userIdForEmail: () => {
        lookups += 1;
        return Promise.resolve(null);
      },
      audit: (event) => {
        if (event.action === "authentication.rate_limited") audits += 1;
        return Promise.resolve();
      },
    },
  });
  const server = app;
  const request = (ip: string, email: string, remoteAddress = "127.0.0.1") =>
    server.inject({
      method: "POST",
      url: "/auth/sign-in/email",
      remoteAddress,
      headers: { origin: "https://suite.example.test", "x-forwarded-for": ip },
      payload: { email, password: "wrong" },
    });
  const first = await Promise.all(
    Array.from({ length: 5 }, () =>
      request("198.51.100.1", "victim@example.test"),
    ),
  );
  expect(first.map((response) => response.statusCode)).toEqual([
    401, 401, 401, 401, 401,
  ]);
  expect(
    (await request("198.51.100.1", "victim@example.test")).statusCode,
  ).toBe(429);
  const limitedLookups = lookups;
  const blocked = await Promise.all(
    Array.from({ length: 10 }, () =>
      request("198.51.100.1", "victim@example.test"),
    ),
  );
  expect(blocked.every((response) => response.statusCode === 429)).toBe(true);
  expect(lookups).toBe(limitedLookups);
  expect(audits).toBe(1);
  expect(
    (await request("198.51.100.2", "victim@example.test")).statusCode,
  ).toBe(429);
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      request(`203.0.113.${i + 1}`, "spoof@example.test", "192.0.2.9"),
    ),
  );
  expect(
    (await request("203.0.113.99", "spoof@example.test", "192.0.2.9"))
      .statusCode,
  ).toBe(429);
  const ipAttempts = await Promise.all(
    Array.from({ length: 51 }, (_, i) =>
      request("198.51.100.40", `account${i}@example.test`),
    ),
  );
  expect(
    ipAttempts.filter((response) => response.statusCode === 401),
  ).toHaveLength(50);
  expect(
    ipAttempts.filter((response) => response.statusCode === 429),
  ).toHaveLength(1);
  expect(
    (await request("198.51.100.41", "account0@example.test")).statusCode,
  ).toBe(401);
  const signups = await Promise.all(
    Array.from({ length: 11 }, (_, i) =>
      server.inject({
        method: "POST",
        url: "/auth/sign-up/email",
        remoteAddress: "127.0.0.1",
        headers: {
          origin: "https://suite.example.test",
          "x-forwarded-for": "198.51.100.30",
        },
        payload: {
          email: `person${i}@example.test`,
          password: "strong-password",
          name: "Person",
        },
      }),
    ),
  );
  expect(
    signups.filter((response) => response.statusCode === 403),
  ).toHaveLength(10);
  expect(
    signups.filter((response) => response.statusCode === 429),
  ).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/auth/two-factor/verify-totp",
        headers: {
          origin: "https://suite.example.test",
          cookie:
            "__Host-opensuite.two_factor=a; __Host-opensuite.two_factor=b",
        },
        payload: { code: "123456" },
      })
    ).statusCode,
  ).toBe(400);
});

it("associates MFA challenges only with the exact cookie, even with a decoy", async () => {
  app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: (request) =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: request.url.includes("sign-in")
              ? {
                  "set-cookie":
                    "__Host-opensuite.two_factor=real; HttpOnly; Secure",
                }
              : {},
          }),
        ),
    },
  });
  const server = app;
  const signIn = await server.inject({
    method: "POST",
    url: "/auth/sign-in/email",
    headers: { origin: "https://suite.example.test" },
    payload: { email: "victim@example.test", password: "password" },
  });
  expect(signIn.statusCode).toBe(200);
  const verify = () =>
    server.inject({
      method: "POST",
      url: "/auth/two-factor/verify-totp",
      headers: {
        origin: "https://suite.example.test",
        cookie: "decoy.two_factor=fake; __Host-opensuite.two_factor=real",
      },
      payload: { code: "000000" },
    });
  const first = await Promise.all(Array.from({ length: 5 }, verify));
  expect(first.every((response) => response.statusCode === 200)).toBe(true);
  expect((await verify()).statusCode).toBe(429);
});

it("keeps sign-in available after anonymous IP buckets fill", async () => {
  app = await buildServer({
    config: { logLevel: "silent", trustProxy: "127.0.0.1" },
    monotonicMs,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      actor: () => Promise.resolve(null),
    },
  });
  const server = app;
  const fill = async (start: number): Promise<void> => {
    if (start >= 10_100) return;
    await Promise.all(
      Array.from({ length: Math.min(250, 10_100 - start) }, (_, offset) =>
        server.inject({
          method: "GET",
          url: "/auth/get-session",
          remoteAddress: "127.0.0.1",
          headers: {
            "x-forwarded-for": `2001:db8:${(start + offset).toString(16)}::1`,
          },
        }),
      ),
    );
    return fill(start + 250);
  };
  await fill(0);
  const response = await server.inject({
    method: "POST",
    url: "/auth/sign-in/email",
    remoteAddress: "127.0.0.1",
    headers: {
      origin: "https://suite.example.test",
      "x-forwarded-for": "2001:db9:1::1",
    },
    payload: { email: "fresh@example.test", password: "test-password" },
  });
  expect(response.statusCode).toBe(200);
  const sameSubnet = await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      server.inject({
        method: "GET",
        url: "/auth/get-session",
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-for": `2001:db8:fffe:1::${(index + 1).toString(16)}`,
        },
      }),
    ),
  );
  expect(sameSubnet.filter((item) => item.statusCode === 429)).toHaveLength(1);
}, 120_000);
it("labels a refusal by Better Auth's own rate limit as rate limited", async () => {
  const actions: string[] = [];
  app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs,
    }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () =>
        Promise.resolve(
          new Response('{"message":"Too many requests"}', {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
        ),
      actor: () => Promise.resolve(null),
      userIdForEmail: () => Promise.resolve("user-1"),
      audit: (event) => {
        actions.push(event.action);
        return Promise.resolve();
      },
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/auth/sign-in/email",
    headers: { origin: "https://suite.example.test" },
    payload: { email: "user@example.test", password: "right-password" },
  });
  expect(response.statusCode).toBe(429);
  expect(actions).toEqual(["sign_in.rate_limited"]);
});
