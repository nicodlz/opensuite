import { describe, expect, it } from "vitest";
import { AuthError, createAuthClient } from "../src/auth/client.ts";

describe("authentication API", () => {
  it("uses same-origin credentials and the Better Auth challenge endpoints", async () => {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ path, init });
      const result = path.endsWith("get-session")
        ? null
        : path.endsWith("sign-in/email")
          ? { twoFactorRedirect: true }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(result), { status: 200 }),
      );
    };
    const client = createAuthClient(fetcher);
    expect(await client.session()).toBeNull();
    expect(await client.signIn("user@example.test", "password")).toEqual({
      twoFactorRedirect: true,
    });
    await client.verify("one-time-code", false);
    await client.verify("backup", true);
    await client.signOut();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/get-session",
      "/api/auth/sign-in/email",
      "/api/auth/two-factor/verify-totp",
      "/api/auth/two-factor/verify-backup-code",
      "/api/auth/sign-out",
    ]);
    expect(
      calls.every((call) => call.init?.credentials === "same-origin"),
    ).toBe(true);
    const body = calls[2]?.init?.body;
    if (typeof body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(body)).toEqual({
      code: "one-time-code",
    });
  });
  it("preserves authentication failure status", async () => {
    const client = createAuthClient(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Denied" }), { status: 401 }),
      ),
    );
    await expect(client.session()).rejects.toMatchObject({
      status: 401,
      message: "Denied",
    });
    await expect(client.session()).rejects.toBeInstanceOf(AuthError);
  });
});
