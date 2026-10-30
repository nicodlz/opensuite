import { describe, expect, it } from "vitest";
import { verifiedType } from "../src/domain/content.ts";
import { httpSessionVerifier } from "../src/adapters/session.ts";
import { createServer } from "node:http";

it("only permits identified safe preview formats", () => {
  expect(
    verifiedType("image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  ).toBe("image/png");
  expect(verifiedType("image/svg+xml", Buffer.from("<svg>"))).toBe(
    "application/octet-stream",
  );
  expect(verifiedType("image/png", Buffer.from("<html>"))).toBe(
    "application/octet-stream",
  );
  expect(verifiedType("text/html", Buffer.from("<html>"))).toBe(
    "application/octet-stream",
  );
});

describe("Better Auth session adapter", () => {
  it("forwards the cookie, verifies identity and fails closed", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/auth/get-session?disableCookieCache=true");
      expect(request.headers.cookie).toBe("session=valid");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          user: { id: "one" },
          session: {
            userId: "one",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("server address missing");
    try {
      const verifier = httpSessionVerifier(
        `http://127.0.0.1:${String(address.port)}`,
      );
      const result = await verifier.verify("session=valid");
      expect(result.isOk() && result.value).toBe("one");
      const anonymous = await verifier.verify(undefined);
      expect(anonymous.isOk() && anonymous.value).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(
      (
        await httpSessionVerifier(
          `http://127.0.0.1:${String(address.port)}`,
        ).verify("session=valid")
      ).isErr(),
    ).toBe(true);
  });
});
