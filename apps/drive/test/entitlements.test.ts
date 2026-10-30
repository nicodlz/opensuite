import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { httpEntitlements } from "../src/adapters/entitlements.ts";

it("validates the owner's entitlement response and fails closed on errors", async () => {
  const requests: {
    path: string | undefined;
    authorization: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("bad"))
      response.end(
        JSON.stringify({ quotaBytes: -1, mailBytes: 0, uploadsAllowed: true }),
      );
    else if (request.url?.includes("offline")) {
      response.statusCode = 503;
      response.end("{}");
    } else
      response.end(
        JSON.stringify({
          quotaBytes: 100,
          mailBytes: 20,
          uploadsAllowed: true,
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No listener");
    const get = httpEntitlements(
      `http://127.0.0.1:${address.port}`,
      "test-token",
    );
    expect(await get("owner-a")).toEqual({
      quotaBytes: 100,
      mailBytes: 20,
      uploadsAllowed: true,
    });
    await expect(get("bad")).rejects.toBeDefined();
    await expect(get("offline")).rejects.toBeDefined();
    expect(requests[0]).toEqual({
      path: "/internal/storage/owner-a",
      authorization: "Bearer test-token",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
