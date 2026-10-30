import { createECDH } from "node:crypto";
import { ok } from "neverthrow";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseProductOrigins,
  loadAuthConfig,
  loadConfig,
  loadVapidConfig,
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
        addressPerUserCap: 50,
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
      ADDRESS_PER_USER_CAP: "7",
    });
    expect(config).toEqual(
      ok({
        host: "0.0.0.0",
        port: 8080,
        logLevel: "debug",
        readinessTimeoutMs: 500,
        aliasPerUserCap: 42,
        addressPerUserCap: 7,
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
        "drive=https://drive.example.test,vault=https://vault.example.test",
      VAULT_PUBLIC_HOST: "vault.example.test",
    });
    expect(config.isOk() && config.value).toMatchObject({
      vaultOrigin: "https://vault.example.test",
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
          AUTH_PRODUCT_ORIGINS: "vault=https://other.example.test",
          VAULT_PUBLIC_HOST: "vault.example.test",
        })
      ).isErr(),
    ).toBe(true);
    const domains = await loadAuthConfig({
      ...env,
      STALWART_INTERNAL_ORIGIN: "http://mail.internal:8080",
      MAIL_DOMAINS: " Second.TEST, example.test ,",
    });
    expect(domains.isOk() && domains.value.mailDomains).toEqual([
      "example.test",
      "second.test",
    ]);
    expect(
      (
        await loadAuthConfig({
          ...env,
          STALWART_INTERNAL_ORIGIN: "http://mail.internal:8080",
        })
      ).map((value) => value.mailDomains),
    ).toEqual(ok(["example.test"]));
    expect(
      (
        await loadAuthConfig({
          ...env,
          STALWART_INTERNAL_ORIGIN: "http://mail.internal:8080",
          MAIL_DOMAINS: "second.test,Not a domain",
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
    "pass=https://vault.example.test",
    "vault=http://vault.example.test",
    "vault=https://mail.example.test",
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

it("reads a matching VAPID key pair from files without revealing failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensuite-vapid-"));
  try {
    const key = createECDH("prime256v1");
    key.generateKeys();
    const publicFile = join(directory, "public");
    const privateFile = join(directory, "private");
    await writeFile(publicFile, key.getPublicKey().toString("base64url"));
    await writeFile(privateFile, key.getPrivateKey().toString("base64url"));
    const env = {
      VAPID_PUBLIC_KEY_FILE: publicFile,
      VAPID_PRIVATE_KEY_FILE: privateFile,
    };
    expect((await loadVapidConfig(env)).isOk()).toBe(true);
    const other = createECDH("prime256v1");
    other.generateKeys();
    await writeFile(privateFile, other.getPrivateKey().toString("base64url"));
    const invalid = await loadVapidConfig(env);
    expect(invalid.isErr()).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain(
      other.getPrivateKey().toString("base64url"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds mail notification settings and permits polling-only operation", async () => {
  const { loadMailPushConfig } = await import("../src/config.ts");
  const defaults = loadMailPushConfig({});
  expect(defaults.isOk() && defaults.value).toEqual({
    pollMs: 30000,
    refreshMs: 10000,
    freshnessMs: 900000,
    burstMs: 3000,
    burstThreshold: 3,
    pushConnections: 50,
  });
  const polling = loadMailPushConfig({
    MAIL_PUSH_CONNECTIONS: "0",
    MAIL_PUSH_POLL_SECONDS: "5",
  });
  expect(polling.isOk() && polling.value.pushConnections).toBe(0);
  expect(
    loadMailPushConfig({
      MAIL_PUSH_POLL_SECONDS: "1",
      MAIL_PUSH_CONNECTIONS: "1001",
    }).isErr(),
  ).toBe(true);
});

it("defaults to self-hosted billing and rejects incomplete Cloud configuration", async () => {
  const { loadBillingConfig } = await import("../src/config.ts");
  const selfHosted = await loadBillingConfig({
    BILLING_CANCEL_URL: "",
    STRIPE_SECRET_KEY_FILE: "",
  });
  expect(selfHosted.isOk() && selfHosted.value).toEqual({
    mode: "self-hosted",
  });
  const cloud = await loadBillingConfig({ ESUNO_DEPLOYMENT_MODE: "cloud" });
  expect(cloud.isErr()).toBe(true);
  expect(
    (await loadBillingConfig({ ESUNO_DEPLOYMENT_MODE: "invalid" })).isErr(),
  ).toBe(true);
});

it("reads the Cloud account domain and rejects an invalid one", async () => {
  const { loadBillingConfig } = await import("../src/config.ts");
  const directory = await mkdtemp(join(tmpdir(), "billing-config-"));
  const files = {
    STRIPE_SECRET_KEY_FILE: join(directory, "key"),
    STRIPE_WEBHOOK_SECRET_FILE: join(directory, "webhook"),
    BILLING_INTERNAL_TOKEN_FILE: join(directory, "token"),
  };
  await writeFile(files.STRIPE_SECRET_KEY_FILE, "sk_test_abcdefghijklmnop");
  await writeFile(files.STRIPE_WEBHOOK_SECRET_FILE, "whsec_abcdefghijklmnop");
  await writeFile(files.BILLING_INTERNAL_TOKEN_FILE, "t".repeat(40));
  const cloud = { ESUNO_DEPLOYMENT_MODE: "cloud", ...files };
  const withDomain = await loadBillingConfig({
    ...cloud,
    BILLING_ACCOUNT_DOMAIN: "esuno.net",
  });
  expect(withDomain.isOk() && withDomain.value).toMatchObject({
    mode: "cloud",
    accountDomain: "esuno.net",
  });
  const fallback = await loadBillingConfig({
    ...cloud,
    BILLING_ACCOUNT_DOMAIN: "",
  });
  expect(fallback.isOk() && "accountDomain" in fallback.value).toBe(false);
  expect(
    (
      await loadBillingConfig({
        ...cloud,
        BILLING_ACCOUNT_DOMAIN: "Esuno.NET.",
      })
    ).isErr(),
  ).toBe(true);
});
