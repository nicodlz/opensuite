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
