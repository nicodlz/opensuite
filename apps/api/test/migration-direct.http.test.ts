import { createReadinessService } from "@opensuite/core";
import { createDirectMigrationService } from "@opensuite/core/services/migration-direct";
import { createMailMigrationService } from "@opensuite/core/services/migration-mail";
import { directMigrationTools } from "@opensuite/core/adapters/migration-direct";
import { migrationMailTools } from "@opensuite/core/adapters/migration-mail";
import { createDatabase } from "@opensuite/db";
import { err } from "neverthrow";
import { expect, it } from "vitest";
import { buildServer, configureDirectImport } from "../src/server.ts";

const now = () => performance.now();

it("requires authentication, a trusted origin and ownership before handling direct import credentials", async () => {
  const dbResult = createDatabase(
    "postgresql://unused:unused@127.0.0.1:1/unused",
  );
  if (dbResult.isErr())
    throw new Error("Fixture database configuration failed");
  const db = dbResult.value;
  const store = {
    getForOwner: () => Promise.resolve(err({ kind: "not_found" })),
  };
  expect(() =>
    configureDirectImport(
      db,
      { mailboxKey: "ab".repeat(32), stalwartOrigin: "http://127.0.0.1:1" },
      store,
      { MAIL_MIGRATION_GOOGLE_OAUTH: "yes" },
    ),
  ).toThrow(/Invalid option/);
  const migrationMail = createMailMigrationService({
    db,
    key: "ab".repeat(32),
    store,
    origin: "http://127.0.0.1:1",
    tools: migrationMailTools,
  });
  const migrationDirect = createDirectMigrationService({
    db,
    key: "ab".repeat(32),
    store,
    origin: "http://127.0.0.1:1",
    tools: directMigrationTools,
    connectSource: () =>
      Promise.reject(new Error("unexpected source connection")),
  });
  const app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 100,
      now: () => new Date(),
      monotonicMs: now,
    }),
    migrationMail,
    migrationDirect,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) =>
        Promise.resolve(
          headers.get("cookie") === "session"
            ? { id: "alice", email: "alice@example.test", role: "user" }
            : null,
        ),
    },
  });
  try {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const call = (headers: Record<string, string>) =>
      fetch(`${base}/mail/direct-imports/create`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          accountId: "default",
          mailboxId: "inbox",
          labels: {},
          source: {
            kind: "gmail",
            username: "source@example.test",
            password: "fixture-private-password",
          },
        }),
      });
    expect((await call({ origin: "https://suite.example.test" })).status).toBe(
      401,
    );
    expect(
      (await call({ origin: "https://evil.example.test", cookie: "session" }))
        .status,
    ).toBe(403);
    const denied = await call({
      origin: "https://suite.example.test",
      cookie: "session",
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("fixture-private-password");
    const authorized = {
      origin: "https://suite.example.test",
      cookie: "session",
    };
    const creations = await Promise.all(
      Array.from({ length: 19 }, () => call(authorized)),
    );
    expect(creations.every((response) => response.status === 403)).toBe(true);
    expect((await call(authorized)).status).toBe(429);
    const mutate = () =>
      fetch(`${base}/mail/direct-imports/resume`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authorized },
        body: JSON.stringify({ accountId: "default", jobId: "fixture" }),
      });
    const mutations = await Promise.all(
      Array.from({ length: 60 }, () => mutate()),
    );
    expect(mutations.every((response) => response.status === 403)).toBe(true);
    expect((await mutate()).status).toBe(429);
    const alias = await fetch(`${base}/aliases/fixture`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authorized },
      body: JSON.stringify({ note: "fixture" }),
    });
    expect(alias.status).toBe(503);
  } finally {
    await app.close();
    await db.$disconnect();
  }
});
