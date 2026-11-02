import { createReadinessService } from "@opensuite/core";
import { afterEach, expect, it } from "vitest";
import { buildServer, type ServerDependencies } from "../src/server.ts";

const token = "x".repeat(32);
type Directory = NonNullable<
  NonNullable<ServerDependencies["identity"]>["accountDirectory"]
>;
type Api = Awaited<ReturnType<typeof buildServer>>;
let app: Api | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(accountDirectory?: Directory) {
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
      ...(accountDirectory === undefined ? {} : { accountDirectory }),
    },
    internalToken: token,
  });
  return app;
}
const resolveUrl = (address: string) =>
  `/internal/accounts/resolve?${new URLSearchParams({ address }).toString()}`;
const addressesUrl = (userIds: unknown) =>
  `/internal/accounts/addresses?${new URLSearchParams({ userIds: JSON.stringify(userIds) }).toString()}`;
const authorized = { authorization: `Bearer ${token}` };
const statuses = (
  api: Api,
  requests: { url: string; headers?: Record<string, string> }[],
) =>
  Promise.all(
    requests.map(async (request) => (await api.inject(request)).statusCode),
  );

it("resolves enabled accounts by address only with the service token", async () => {
  const asked: string[] = [];
  const api = await server({
    resolve: (email) => {
      asked.push(email);
      return Promise.resolve(email === "bob@example.test" ? "bob" : null);
    },
    addresses: () => Promise.resolve([]),
  });
  expect(
    await statuses(
      api,
      [
        {},
        { authorization: `Bearer ${"y".repeat(32)}` },
        { authorization: token },
      ].map((headers) => ({ url: resolveUrl("bob@example.test"), headers })),
    ),
  ).toEqual([401, 401, 401]);
  expect(asked).toEqual([]);
  const found = await api.inject({
    url: resolveUrl("bob@example.test"),
    headers: authorized,
  });
  expect(found.statusCode).toBe(200);
  expect(found.headers["cache-control"]).toBe("no-store");
  expect(found.json()).toEqual({ userId: "bob" });
  const missing = await api.inject({
    url: resolveUrl("nobody@example.test"),
    headers: authorized,
  });
  expect(missing.json()).toEqual({ userId: null });
  expect(
    await statuses(
      api,
      [
        resolveUrl("not an address"),
        resolveUrl(`${"a".repeat(250)}@example.test`),
        "/internal/accounts/resolve",
      ].map((url) => ({ url, headers: authorized })),
    ),
  ).toEqual([400, 400, 400]);
  expect(asked).toEqual(["bob@example.test", "nobody@example.test"]);
});

it("lists addresses for at most 50 user IDs", async () => {
  const asked: (readonly string[])[] = [];
  const api = await server({
    resolve: () => Promise.resolve(null),
    addresses: (userIds) => {
      asked.push(userIds);
      return Promise.resolve(
        userIds
          .filter((userId) => userId !== "disabled")
          .map((userId) => ({ userId, address: `${userId}@example.test` })),
      );
    },
  });
  expect((await api.inject({ url: addressesUrl(["bob"]) })).statusCode).toBe(
    401,
  );
  const listed = await api.inject({
    url: addressesUrl(["bob", "disabled"]),
    headers: authorized,
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.headers["cache-control"]).toBe("no-store");
  expect(listed.json()).toEqual({
    accounts: [{ userId: "bob", address: "bob@example.test" }],
  });
  expect(
    await statuses(
      api,
      [
        addressesUrl([]),
        addressesUrl(Array.from({ length: 51 }, (_, index) => `user-${index}`)),
        addressesUrl([""]),
        addressesUrl("bob"),
        "/internal/accounts/addresses?userIds=%5B",
        "/internal/accounts/addresses",
      ].map((url) => ({ url, headers: authorized })),
    ),
  ).toEqual([400, 400, 400, 400, 400, 400]);
  expect(asked).toEqual([["bob", "disabled"]]);
});

it("fails closed when the directory is missing or fails", async () => {
  const unwired = await server();
  const both = [resolveUrl("bob@example.test"), addressesUrl(["bob"])].map(
    (url) => ({ url, headers: authorized }),
  );
  expect(await statuses(unwired, both)).toEqual([503, 503]);
  await unwired.close();
  const failing = await server({
    resolve: () => Promise.reject(new Error("database down")),
    addresses: () => Promise.reject(new Error("database down")),
  });
  const responses = await Promise.all(
    both.map((request) => failing.inject(request)),
  );
  expect(
    responses.map((response) => [response.statusCode, response.body]),
  ).toEqual([
    [503, '{"code":"SERVICE_UNAVAILABLE"}'],
    [503, '{"code":"SERVICE_UNAVAILABLE"}'],
  ]);
});

it("refuses every caller when no service token is configured", async () => {
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
      accountDirectory: {
        resolve: () => Promise.resolve("bob"),
        addresses: () => Promise.resolve([]),
      },
    },
  });
  expect(
    await statuses(
      app,
      [{}, { authorization: "Bearer " }].map((headers) => ({
        url: resolveUrl("bob@example.test"),
        headers,
      })),
    ),
  ).toEqual([401, 401]);
});
