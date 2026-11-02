import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { httpAccountDirectory } from "../src/adapters/accounts.ts";

type Seen = {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  body: unknown;
};

async function directoryServer(
  answer: (path: string | undefined, body: unknown) => [number, unknown],
) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    void (async () => {
      const body: unknown = JSON.parse(await text(request));
      seen.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      const [status, payload] = answer(request.url, body);
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No listener");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

it("resolves an address in the request body with the service token", async () => {
  const api = await directoryServer((_path, body) => [
    200,
    {
      userId:
        JSON.stringify(body) === '{"address":"bob@example.test"}'
          ? "bob"
          : null,
    },
  ]);
  try {
    const directory = httpAccountDirectory(api.origin, "t".repeat(32));
    const found = await directory.resolve("bob@example.test");
    const missing = await directory.resolve("nobody@example.test");
    expect(found.isOk() && found.value).toBe("bob");
    expect(missing.isOk() && missing.value).toBeNull();
    expect(api.seen[0]).toEqual({
      method: "POST",
      path: "/internal/accounts/resolve",
      authorization: `Bearer ${"t".repeat(32)}`,
      body: { address: "bob@example.test" },
    });
  } finally {
    await api.close();
  }
});

it("reports failures and malformed answers instead of no account", async () => {
  const api = await directoryServer((path) =>
    path === "/internal/accounts/resolve"
      ? [503, { code: "SERVICE_UNAVAILABLE" }]
      : [200, { accounts: [{ userId: "bob", address: "not an address" }] }],
  );
  try {
    const directory = httpAccountDirectory(api.origin, "t".repeat(32));
    const resolved = await directory.resolve("bob@example.test");
    const listed = await directory.addresses(["bob"]);
    expect(resolved.isErr() && resolved.error).toBe("unavailable");
    expect(listed.isErr() && listed.error).toBe("unavailable");
  } finally {
    await api.close();
  }
  const closed = await httpAccountDirectory(api.origin, "t".repeat(32)).resolve(
    "bob@example.test",
  );
  expect(closed.isErr()).toBe(true);
});

it("looks addresses up in batches and keeps only the accounts asked for", async () => {
  const api = await directoryServer((_path, body) => {
    const userIds =
      typeof body === "object" &&
      body !== null &&
      "userIds" in body &&
      Array.isArray(body.userIds)
        ? body.userIds.map(String)
        : [];
    return [
      200,
      {
        accounts: [
          ...userIds
            .filter((userId) => userId !== "gone")
            .map((userId) => ({ userId, address: `${userId}@example.test` })),
          { userId: "intruder", address: "intruder@example.test" },
        ].slice(0, 100),
      },
    ];
  });
  try {
    const userIds = [
      ...Array.from({ length: 150 }, (_, index) => `user-${index}`),
      "gone",
      "user-0",
    ];
    const result = await httpAccountDirectory(
      api.origin,
      "t".repeat(32),
    ).addresses(userIds);
    if (result.isErr()) throw new Error("lookup failed");
    expect(result.value.size).toBe(150);
    expect(result.value.get("user-149")).toBe("user-149@example.test");
    expect(result.value.has("gone")).toBe(false);
    expect(result.value.has("intruder")).toBe(false);
    expect(
      api.seen
        .map((request) =>
          typeof request.body === "object" &&
          request.body !== null &&
          "userIds" in request.body &&
          Array.isArray(request.body.userIds)
            ? request.body.userIds.length
            : 0,
        )
        .toSorted((a, b) => b - a),
    ).toEqual([100, 51]);
    const none = await httpAccountDirectory(
      api.origin,
      "t".repeat(32),
    ).addresses([]);
    expect(none.isOk() && none.value.size).toBe(0);
    expect(api.seen).toHaveLength(2);
  } finally {
    await api.close();
  }
});
