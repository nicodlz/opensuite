import { createReadinessService } from "@opensuite/core";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../api/src/server.ts";
import { httpSessionVerifier } from "../src/adapters/session.ts";

let api: Awaited<ReturnType<typeof buildServer>> | undefined;
afterEach(async () => {
  await api?.close();
});

it("uses the API's actual internal auth route and forwards only the cookie", async () => {
  let received: Request | undefined;
  api = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: () => 0,
    }),
    monotonicMs: () => 0,
    identity: {
      publicOrigin: "http://public.example",
      // The API answers get-session only for a linked, enabled account.
      actor: () =>
        Promise.resolve({
          id: "user",
          email: "user@example.test",
          role: "user",
        }),
      handler: (request) => {
        received = request;
        return Promise.resolve(
          Response.json({
            user: { id: "user" },
            session: {
              userId: "user",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        );
      },
    },
  });
  const address = await api.listen({ host: "127.0.0.1", port: 0 });
  const result = await httpSessionVerifier(address).verify("session=abc");
  expect(result.isOk() && result.value).toBe("user");
  expect(received?.method).toBe("GET");
  expect(received?.url).toBe(
    "http://public.example/api/auth/get-session?disableCookieCache=true",
  );
  expect(received?.headers.get("cookie")).toBe("session=abc");
  expect(received?.headers.get("authorization")).toBeNull();
});

it("checks sessions on the API's internal route with the service token", async () => {
  const token = "s".repeat(32);
  const cookies: (string | null)[] = [];
  let handled = 0;
  api = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: () => 0,
    }),
    monotonicMs: () => 0,
    internalToken: token,
    identity: {
      publicOrigin: "http://public.example",
      actor: (headers) => {
        cookies.push(headers.get("cookie"));
        return Promise.resolve(
          headers.get("cookie") === "session=abc"
            ? { id: "user", email: "user@example.test", role: "user" }
            : null,
        );
      },
      handler: () => {
        handled++;
        return Promise.resolve(new Response(null, { status: 429 }));
      },
    },
  });
  const address = await api.listen({ host: "127.0.0.1", port: 0 });
  const verifier = httpSessionVerifier(address, token);
  const results = await Promise.all(
    Array.from({ length: 150 }, (_, index) =>
      verifier.verify(index % 2 ? "session=abc" : "session=old"),
    ),
  );
  expect(
    results.map((result) => (result.isOk() ? result.value : "unavailable")),
  ).toEqual(results.map((_, index) => (index % 2 ? "user" : null)));
  expect(cookies).toHaveLength(150);
  expect(handled).toBe(0);
  const duplicate = await verifier.verify(
    "__Host-opensuite.session_token=a; __Host-opensuite.session_token=b",
  );
  expect(duplicate.isOk() && duplicate.value).toBeNull();
  // A token the API does not hold falls back to the public route, here at
  // its limit.
  const wrong = await httpSessionVerifier(address, "t".repeat(32)).verify(
    "session=abc",
  );
  expect(wrong.isErr()).toBe(true);
  expect(handled).toBe(1);
});

it("falls back to the public route on an API without the internal route", async () => {
  api = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: () => 0,
    }),
    monotonicMs: () => 0,
    identity: {
      publicOrigin: "http://public.example",
      actor: () =>
        Promise.resolve({
          id: "user",
          email: "user@example.test",
          role: "user",
        }),
      handler: () =>
        Promise.resolve(
          Response.json({
            user: { id: "user" },
            session: {
              userId: "user",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        ),
    },
  });
  const address = await api.listen({ host: "127.0.0.1", port: 0 });
  const result = await httpSessionVerifier(address, "s".repeat(32)).verify(
    "session=abc",
  );
  expect(result.isOk() && result.value).toBe("user");
});
