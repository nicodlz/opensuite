import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, createDomainStore } from "@opensuite/db";
import { err, ok, okAsync } from "neverthrow";
import { createSesDomainProvider } from "@opensuite/core/adapters/domain-ses";
import { configureDomains } from "../src/routes/domain-setup.ts";
import { startDomainJob } from "../src/routes/domain-job.ts";

vi.mock("@opensuite/core/adapters/domain-ses", () => ({
  createSesDomainProvider: vi.fn<typeof createSesDomainProvider>(() => ({
    ensure: () =>
      Promise.resolve(
        ok({ verificationToken: "token", dkimTokens: ["token"] }),
      ),
    receipt: () => Promise.resolve(ok(undefined)),
    verified: () => Promise.resolve(ok(true)),
  })),
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const database = createDatabase("postgresql://localhost/domain-test");
if (database.isErr()) throw new Error("invalid test database configuration");
const store = createDomainStore(database.value);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "domain-setup-test-"));
  directories.push(directory);
  const password = join(directory, "password");
  const credentials = join(directory, "ses.json");
  await writeFile(password, "management-password");
  const env = {
    DOMAINS_SES_ENABLED: "true",
    DOMAINS_SES_RULE: "inbound",
    DOMAINS_SES_RULE_SET: "active",
    DOMAINS_SES_MODE: "adopt",
    DOMAINS_ADOPT_DOMAINS: "example.test",
    DOMAINS_STALWART_ORIGIN: "http://localhost:8080",
    DOMAINS_STALWART_USER: "manager",
    DOMAINS_STALWART_PASSWORD_FILE: password,
    DOMAINS_SES_ENDPOINT: "",
    DOMAINS_SES_CREDENTIALS_FILE: credentials,
  };
  return { credentials, env };
}

describe("domain API configuration", () => {
  it("passes file-backed SES credentials to the provider and accepts an empty endpoint", async () => {
    const { credentials, env } = await fixture();
    await writeFile(
      credentials,
      JSON.stringify({
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
        sessionToken: "test-token",
      }),
    );
    expect(await configureDomains(env, store)).toBeDefined();
    expect(createSesDomainProvider).toHaveBeenCalledWith({
      enabled: true,
      ruleName: "inbound",
      ruleSetName: "active",
      approvedDomains: ["example.test"],
      credentials: {
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
        sessionToken: "test-token",
      },
    });
  });

  it("does not read credentials when disabled and permits the default credential chain", async () => {
    expect(
      await configureDomains({ DOMAINS_SES_ENABLED: "" }, store),
    ).toBeUndefined();
    expect(createSesDomainProvider).not.toHaveBeenCalled();
    const { env } = await fixture();
    expect(
      await configureDomains(
        { ...env, DOMAINS_SES_CREDENTIALS_FILE: "" },
        store,
      ),
    ).toBeDefined();
    expect(createSesDomainProvider).toHaveBeenCalledWith({
      enabled: true,
      ruleName: "inbound",
      ruleSetName: "active",
      approvedDomains: ["example.test"],
    });
  });

  it("uses the default verification interval when Compose supplies an empty value", async () => {
    const { env } = await fixture();
    const service = await configureDomains(
      { ...env, DOMAINS_SES_CREDENTIALS_FILE: "" },
      store,
    );
    if (service === undefined) throw new Error("domain service disabled");
    const stop = startDomainJob(store, service, "", () => undefined);
    expect(stop).toBeTypeOf("function");
    await stop();
  });

  it("backs off scheduled retries when the provider is unavailable", async () => {
    const { env } = await fixture();
    const service = await configureDomains(
      { ...env, DOMAINS_SES_CREDENTIALS_FILE: "" },
      store,
    );
    if (service === undefined) throw new Error("domain service disabled");
    vi.spyOn(store, "verificationTargets").mockReturnValue(
      okAsync([
        { id: "domain", user: { id: "admin", email: "admin@example.test" } },
      ]),
    );
    const recheck = vi
      .spyOn(service, "recheck")
      .mockResolvedValue(
        err({ kind: "unavailable", message: "temporarily unavailable" }),
      );
    vi.useFakeTimers();
    const stop = startDomainJob(store, service, 60, () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recheck).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("requires explicit adoption mode, rule set, and exact approved domains", async () => {
    const { env } = await fixture();
    await Promise.all(
      [
        { DOMAINS_SES_MODE: "" },
        { DOMAINS_SES_RULE_SET: "" },
        { DOMAINS_ADOPT_DOMAINS: "" },
        { DOMAINS_ADOPT_DOMAINS: "*.example.test" },
      ].map(async (missing) =>
        expect(
          configureDomains({ ...env, ...missing }, store),
        ).rejects.toBeDefined(),
      ),
    );
    expect(createSesDomainProvider).not.toHaveBeenCalled();
  });

  it("rejects malformed credentials without including their contents in the error", async () => {
    const { credentials, env } = await fixture();
    await writeFile(credentials, "sensitive-invalid-json");
    await expect(configureDomains(env, store)).rejects.toThrow(
      "invalid SES credential file",
    );
    expect(createSesDomainProvider).not.toHaveBeenCalled();
  });
});
