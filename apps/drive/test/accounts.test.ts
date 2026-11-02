import { createReadinessService } from "@opensuite/core";
import { afterEach, expect, it } from "vitest";
import { buildServer } from "../../api/src/server.ts";
import { httpAccountDirectory } from "../src/adapters/accounts.ts";

const token = "s".repeat(32);
let api: Awaited<ReturnType<typeof buildServer>> | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

// The API's actual internal routes, over a directory of enabled accounts.
async function apiWith(accounts: ReadonlyMap<string, string>, failing = false) {
  const batches: number[] = [];
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
      handler: () => Promise.resolve(new Response(null, { status: 404 })),
      accountDirectory: {
        resolve: (email) =>
          failing
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(
                [...accounts].find(([, address]) => address === email)?.[0] ??
                  null,
              ),
        addresses: (userIds) => {
          batches.push(userIds.length);
          if (failing) return Promise.reject(new Error("offline"));
          return Promise.resolve([
            ...userIds.flatMap((userId) => {
              const address = accounts.get(userId);
              return address === undefined ? [] : [{ userId, address }];
            }),
            // Never trusted: an answer for an account that was not asked for.
            ...(userIds.length < 50
              ? [{ userId: "intruder", address: "intruder@example.test" }]
              : []),
          ]);
        },
      },
    },
  });
  return { origin: await api.listen({ host: "127.0.0.1", port: 0 }), batches };
}

it("resolves addresses on the API's internal route with the service token", async () => {
  const { origin } = await apiWith(new Map([["bob", "bob@example.test"]]));
  const directory = httpAccountDirectory(origin, token);
  const found = await directory.resolve("bob@example.test");
  const missing = await directory.resolve("nobody@example.test");
  expect(found.isOk() && found.value).toBe("bob");
  expect(missing.isOk() && missing.value).toBeNull();
  const wrongToken = await httpAccountDirectory(origin, "t".repeat(32)).resolve(
    "bob@example.test",
  );
  expect(wrongToken.isErr() && wrongToken.error).toBe("unavailable");
});

it("looks addresses up in batches and keeps only the accounts asked for", async () => {
  const accounts = new Map(
    Array.from({ length: 120 }, (_, index) => [
      `user-${index}`,
      `user-${index}@example.test`,
    ]),
  );
  const { origin, batches } = await apiWith(accounts);
  const result = await httpAccountDirectory(origin, token).addresses([
    ...accounts.keys(),
    "gone",
    "user-0",
  ]);
  if (result.isErr()) throw new Error("lookup failed");
  expect(result.value.size).toBe(120);
  expect(result.value.get("user-119")).toBe("user-119@example.test");
  expect(result.value.has("gone")).toBe(false);
  expect(result.value.has("intruder")).toBe(false);
  expect(batches.toSorted((a, b) => b - a)).toEqual([50, 50, 21]);
  const none = await httpAccountDirectory(origin, token).addresses([]);
  expect(none.isOk() && none.value.size).toBe(0);
  expect(batches).toHaveLength(3);
});

it("reports API failures and an unreachable API instead of no account", async () => {
  const { origin } = await apiWith(new Map(), true);
  const directory = httpAccountDirectory(origin, token);
  const resolved = await directory.resolve("bob@example.test");
  const listed = await directory.addresses(["bob"]);
  expect(resolved.isErr() && resolved.error).toBe("unavailable");
  expect(listed.isErr() && listed.error).toBe("unavailable");
  await api?.close();
  api = undefined;
  const closed = await directory.resolve("bob@example.test");
  expect(closed.isErr()).toBe(true);
});
