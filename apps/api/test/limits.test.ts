import { describe, expect, it } from "vitest";
import { createAuthLimiter } from "../src/auth/limits.ts";

describe("account-wide authentication limits", () => {
  it("limits distributed login attempts, resets with the window, and retains the IP limit", () => {
    let time = 0;
    const limiter = createAuthLimiter(() => time);
    for (let i = 0; i < 5; i++)
      expect(
        limiter.check(
          "/auth/sign-in/email",
          `ip${i}`,
          { email: "VICTIM@example.test" },
          undefined,
        ),
      ).toBeUndefined();
    expect(
      limiter.check(
        "/auth/sign-in/email",
        "another",
        { email: "victim@example.test" },
        undefined,
      ),
    ).toMatchObject({ first: true });
    expect(
      limiter.check(
        "/auth/sign-in/email",
        "another",
        { email: "else@example.test" },
        undefined,
      ),
    ).toBeUndefined();
    time += 60_001;
    expect(
      limiter.check(
        "/auth/sign-in/email",
        "another",
        { email: "victim@example.test" },
        undefined,
      ),
    ).toBeUndefined();
    for (let i = 0; i < 50; i++)
      limiter.check(
        "/auth/sign-in/email",
        "attacker",
        { email: `user${i}@example.test` },
        undefined,
      );
    expect(
      limiter.check(
        "/auth/sign-in/email",
        "attacker",
        { email: "new@example.test" },
        undefined,
      ),
    ).toBeDefined();
  });
  it("limits MFA attempts across IPs for the account associated with a challenge", () => {
    const limiter = createAuthLimiter(() => 0);
    const cookie = "__Host-opensuite.two_factor=challenge";
    limiter.remember({ email: "victim@example.test" }, [`${cookie}; Secure`]);
    for (let i = 0; i < 5; i++)
      expect(
        limiter.check("/auth/two-factor/verify-totp", `ip${i}`, {}, cookie),
      ).toBeUndefined();
    expect(
      limiter.check(
        "/auth/two-factor/verify-backup-code",
        "other",
        { email: "decoy@example.test" },
        cookie,
      ),
    ).toMatchObject({ first: true });
  });
});
