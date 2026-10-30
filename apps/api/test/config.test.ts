import { ok } from "neverthrow";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseProductOrigins,
  loadAuthConfig,
  loadConfig,
} from "../src/config.ts";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    expect(loadConfig({})).toEqual(
      ok({
        host: "127.0.0.1",
        port: 3000,
        logLevel: "info",
        readinessTimeoutMs: 2000,
        aliasPerUserCap: 1000,
      }),
    );
  });

  it("parses explicit values", () => {
    const config = loadConfig({
      API_HOST: "0.0.0.0",
      API_PORT: "8080",
      LOG_LEVEL: "debug",
      READINESS_TIMEOUT_MS: "500",
      ALIAS_PER_USER_CAP: "42",
    });
    expect(config).toEqual(
      ok({
        host: "0.0.0.0",
        port: 8080,
        logLevel: "debug",
        readinessTimeoutMs: 500,
        aliasPerUserCap: 42,
      }),
    );
  });

  it("rejects invalid values without echoing them", () => {
    const config = loadConfig({ API_PORT: "hunter2", LOG_LEVEL: "loud" });
    expect(config.isErr()).toBe(true);
    const issues = config.isErr() ? config.error.issues : [];
    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("API_PORT");
    expect(issues.join("\n")).not.toContain("hunter2");
  });
});

it("requires valid mail configuration and derives readiness from the internal origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensuite-auth-"));
  try {
    const authFile = join(directory, "auth");
    const keyFile = join(directory, "key");
    const adminFile = join(directory, "admin");
    await Promise.all([
      writeFile(authFile, "a".repeat(32)),
      writeFile(keyFile, "ab".repeat(32)),
      writeFile(adminFile, "p".repeat(32)),
    ]);
    const env = {
      TRUSTED_PROXY_IP: "127.0.0.1",
      AUTH_PUBLIC_ORIGIN: "https://suite.example.test",
      MAIL_DOMAIN: "example.test",
      AUTH_SECRET_FILE: authFile,
      MAILBOX_KEY_FILE: keyFile,
      STALWART_MANAGEMENT_PASSWORD_FILE: adminFile,
    };
    expect((await loadAuthConfig(env)).isErr()).toBe(true);
    expect(
      (
        await loadAuthConfig({
          ...env,
          STALWART_INTERNAL_ORIGIN: "https://mail.internal/path",
        })
      ).isErr(),
    ).toBe(true);
    const config = await loadAuthConfig({
      ...env,
      STALWART_INTERNAL_ORIGIN: "http://mail.internal:8080",
      AUTH_PRODUCT_ORIGINS:
        "drive=https://drive.example.test,pass=https://pass.example.test",
      PASS_PUBLIC_HOST: "pass.example.test",
    });
    expect(config.isOk() && config.value).toMatchObject({
      passOrigin: "https://pass.example.test",
      productOrigins: {
        mail: "https://suite.example.test",
        drive: "https://drive.example.test",
      },
      stalwartOrigin: "http://mail.internal:8080",
      mailReadyUrl: "http://mail.internal:8080/healthz/ready",
      mailboxKey: "ab".repeat(32),
    });
    expect(
      (
        await loadAuthConfig({
          ...env,
          STALWART_INTERNAL_ORIGIN: "http://mail.internal:8080",
          AUTH_PRODUCT_ORIGINS: "pass=https://other.example.test",
          PASS_PUBLIC_HOST: "pass.example.test",
        })
      ).isErr(),
    ).toBe(true);
    await writeFile(keyFile, "invalid");
    expect(
      (
        await loadAuthConfig({
          ...env,
          STALWART_INTERNAL_ORIGIN: "http://mail.internal:8080",
        })
      ).isErr(),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("application origins", () => {
  const hub = "https://mail.example.test";
  it("accepts exact HTTPS origins for drive and calendar", () => {
    expect(
      parseProductOrigins(
        hub,
        "drive=https://drive.example.test, calendar=https://calendar.example.test",
      ),
    ).toEqual({
      mail: hub,
      drive: "https://drive.example.test",
      calendar: "https://calendar.example.test",
    });
    expect(parseProductOrigins(hub, undefined)).toEqual({ mail: hub });
  });
  it.each([
    "pass=http://pass.example.test",
    "pass=https://mail.example.test",
    "drive=http://drive.example.test",
    "drive=https://drive.example.test/",
    "drive=https://*.example.test",
    "drive=https://drive.example.test/app",
    "mail=https://other.example.test",
    "contacts=https://contacts.example.test",
    "drive=https://drive.example.test,drive=https://d2.example.test",
    "calendar=https://mail.example.test",
    "drive",
  ])("refuses %s", (value) => {
    expect(parseProductOrigins(hub, value)).toBeNull();
  });
});
