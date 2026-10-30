import { describe, expect, it } from "vitest";
import {
  createAuthLimiter,
  hasDuplicateAuthCookie,
  hasPendingFactor,
  hasTrustDevice,
  withoutSessionCookie,
} from "../src/auth/limits.ts";

describe("account-wide authentication limits", () => {
  it("parses cookie names like Better Auth, including whitespace and duplicates", () => {
    expect(hasTrustDevice("__Host-opensuite.trust_device \t=value")).toBe(true);
    expect(hasPendingFactor("__Host-opensuite.two_factor \t=value")).toBe(true);
    expect(
      hasDuplicateAuthCookie(
        "__Host-opensuite.session_token=a; __Host-opensuite.session_token \t=b",
      ),
    ).toBe(true);
    expect(
      withoutSessionCookie(
        "__Host-opensuite.session_token \t=a; other=b",
      ).trim(),
    ).toBe("other=b");
  });
  it("sees authentication cookies whose names carry Unicode whitespace", () => {
    const nbsp = "\u00a0";
    expect(hasTrustDevice(`${nbsp}__Host-opensuite.trust_device=value`)).toBe(
      true,
    );
    expect(
      hasTrustDevice(`__Host-opensuite.trust_device${nbsp}=value${nbsp}`),
    ).toBe(true);
    expect(hasPendingFactor(`${nbsp}__Host-opensuite.two_factor=value`)).toBe(
      true,
    );
    expect(
      hasDuplicateAuthCookie(
        `${nbsp}__Host-opensuite.session_token=attacker; __Host-opensuite.session_token=victim`,
      ),
    ).toBe(true);
    expect(
      withoutSessionCookie(
        `${nbsp}__Host-opensuite.session_token=a; other=b`,
      ).trim(),
    ).toBe("other=b");
  });
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
    ).toMatchObject({ first: true, bucket: "account" });
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
    ).toMatchObject({ bucket: "ip" });
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
  it("shares the MFA account limit with security-key verification", () => {
    const limiter = createAuthLimiter(() => 0);
    const cookie = "__Host-opensuite.two_factor=challenge";
    limiter.remember({ email: "user@example.test" }, [`${cookie}; Secure`]);
    for (let i = 0; i < 5; i++)
      expect(
        limiter.check(
          i % 2 === 0
            ? "/auth/two-factor/verify-totp"
            : "/auth/two-factor/verify-security-key",
          `ip${i}`,
          {},
          cookie,
        ),
      ).toBeUndefined();
    expect(
      limiter.check(
        "/auth/two-factor/verify-security-key",
        "other",
        {},
        cookie,
      ),
    ).toMatchObject({ first: true });
  });
  it("limits every password re-check per authenticated user", () => {
    const limiter = createAuthLimiter(() => 0);
    for (const path of [
      "/auth/two-factor/enable",
      "/auth/two-factor/disable",
      "/auth/two-factor/get-totp-uri",
      "/auth/two-factor/generate-backup-codes",
      "/auth/change-password",
    ])
      for (let i = 0; i < 2; i++)
        expect(limiter.reauthenticate(path, "user-a")).toBeUndefined();
    expect(
      limiter.reauthenticate("/auth/security-keys/remove", "user-a"),
    ).toMatchObject({ first: true });
    expect(
      limiter.reauthenticate("/auth/get-session", "user-a"),
    ).toBeUndefined();
  });
  it("limits key password checks per authenticated user across both actions", () => {
    const limiter = createAuthLimiter(() => 0);
    for (let i = 0; i < 10; i++)
      expect(
        limiter.reauthenticate(
          i % 2
            ? "/auth/security-keys/remove"
            : "/auth/security-keys/register-options",
          "user-a",
        ),
      ).toBeUndefined();
    expect(
      limiter.reauthenticate("/auth/security-keys/remove", "user-a"),
    ).toMatchObject({ first: true });
    expect(
      limiter.reauthenticate("/auth/security-keys/remove", "user-b"),
    ).toBeUndefined();
  });
});
