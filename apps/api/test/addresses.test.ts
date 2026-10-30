/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { createReadinessService } from "@opensuite/core";
import { createAddressService } from "@opensuite/core/services/addresses";
import type { AddressStore } from "@opensuite/db";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

it("maps entitlement failures to 503 and plan limits to 403", async () => {
  let failing = true;
  const store = {
    reserve: () => Promise.resolve(err({ kind: "limit" })),
    audit: () => Promise.resolve(ok(undefined)),
  } as unknown as AddressStore;
  const addresses = createAddressService(
    store,
    { set: () => Promise.resolve(ok(undefined)) },
    () =>
      failing
        ? Promise.reject(new Error("entitlements unavailable"))
        : Promise.resolve(1),
    () => Promise.resolve(ok(undefined)),
    [],
  );
  const app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: () => performance.now(),
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: () => performance.now(),
    }),
    addresses,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: () =>
        Promise.resolve({
          id: "owner",
          email: "owner@example.test",
          role: "user",
        }),
    },
  });
  try {
    const headers = { origin: "https://suite.example.test" };
    expect(
      (await app.inject({ method: "GET", url: "/addresses", headers }))
        .statusCode,
    ).toBe(503);
    const create = () =>
      app.inject({
        method: "POST",
        url: "/addresses",
        headers,
        payload: { localPart: "extra", domainId: "domain" },
      });
    expect((await create()).statusCode).toBe(503);
    failing = false;
    expect((await create()).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});

it("lists available domains without calling the provisioning callback", async () => {
  let calls = 0;
  const store = {
    domains: () => Promise.resolve(ok([{ id: "good", name: "good.test" }])),
  } as unknown as AddressStore;
  const addresses = createAddressService(
    store,
    { set: () => Promise.resolve(ok(undefined)) },
    () => Promise.resolve(5),
    () => {
      calls++;
      return Promise.resolve(ok(undefined));
    },
    [],
  );
  const domains = await addresses.domains();
  expect(domains.isOk() && domains.value).toEqual([
    { id: "good", name: "good.test" },
  ]);
  expect(calls).toBe(0);
});
