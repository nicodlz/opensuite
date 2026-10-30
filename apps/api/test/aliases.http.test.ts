import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import {
  createAliasService,
  type AliasService,
} from "@opensuite/core/services/aliases";
import {
  createDatabase,
  createDomainStore,
  type PrismaClient,
} from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";
import { createAliasSendGuard } from "../src/routes/alias-mail.ts";

const run = promisify(execFile);
const container = `opensuite-alias-test-${randomUUID().slice(0, 8)}`;
const origin = "https://suite.example.test";
let db: PrismaClient;
let app: FastifyInstance;
let disconnect = async () => {};
let closeApp = async () => {};
let domainId: string;
let pendingId: string;
let disabledId: string;
let failMail = false;
let aliases: AliasService;
let mailCalls = 0;
let pauseMail: (() => Promise<void>) | undefined;
const clock = () => performance.now();
const noop = () => {};
const headers = (user: string) => ({ origin, cookie: `test-user=${user}` });
const wait = async (attempt: number): Promise<void> => {
  try {
    await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
  } catch {
    if (!attempt) throw new Error("database unavailable");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await wait(attempt - 1);
  }
};
beforeAll(async () => {
  try {
    await run("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=test-password",
      "-e",
      "POSTGRES_INITDB_ARGS=--no-sync",
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ]);
    await wait(239);
    const port = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", container, "5432"])).stdout,
    )?.[1];
    if (!port) throw new Error("missing database port");
    const url = `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, maxBuffer: 4_000_000 },
    );
    const database = createDatabase(url);
    if (database.isErr()) throw new Error("database configuration");
    db = database.value;
    disconnect = () => db.$disconnect();
    await db.user.createMany({
      data: [
        { id: "alice", email: "alice@example.test", name: "Alice" },
        { id: "bob", email: "bob@example.test", name: "Bob" },
      ],
    });
    await db.mailboxLink.createMany({
      data: ["alice", "bob"].map((userId) => ({
        userId,
        accountId: `${userId}-account`,
        address: `${userId}@example.test`,
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      })),
    });
    domainId = (
      await db.domain.create({
        data: {
          userId: "alice",
          name: "example.test",
          status: "verified",
          stalwartId: "domain",
        },
      })
    ).id;
    pendingId = (
      await db.domain.create({
        data: {
          userId: "alice",
          name: "pending.test",
          status: "pending",
          stalwartId: "domain2",
        },
      })
    ).id;
    disabledId = (
      await db.domain.create({
        data: {
          userId: "alice",
          name: "disabled.test",
          status: "failing",
          stalwartId: "domain3",
        },
      })
    ).id;
    await db.user.updateMany({ data: { defaultAliasDomainId: domainId } });
    aliases = createAliasService(
      db,
      {
        set: async () => {
          mailCalls++;
          await pauseMail?.();
          return failMail ? err({ kind: "unavailable" }) : ok(undefined);
        },
      },
      2,
    );
    app = await buildServer({
      config: { logLevel: "silent" },
      monotonicMs: clock,
      readiness: createReadinessService({
        probes: [],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs: clock,
      }),
      aliases,
      identity: {
        publicOrigin: origin,
        handler: () => Promise.resolve(new Response()),
        actor: (h) => {
          const user = /test-user=(alice|bob)/.exec(h.get("cookie") ?? "")?.[1];
          return Promise.resolve(
            user
              ? {
                  id: user,
                  email: `${user}@example.test`,
                  role: "user" as const,
                }
              : null,
          );
        },
      },
    });
    closeApp = () => app.close();
  } catch (error) {
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
    throw error;
  }
}, 120_000);
afterAll(async () => {
  await closeApp();
  await disconnect();
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
}, 60_000);

describe("alias API", () => {
  it("isolates users in both directions, including updates and key revocation", async () => {
    const alice = await app.inject({
      method: "POST",
      url: "/aliases",
      headers: headers("alice"),
      payload: { requestId: "alice-1" },
    });
    const bob = await app.inject({
      method: "POST",
      url: "/aliases",
      headers: headers("bob"),
      payload: { requestId: "bob-1" },
    });
    expect(alice.statusCode).toBe(200);
    expect(bob.statusCode).toBe(200);
    const a = alice.json<{ id: string; address: string }>();
    const b = bob.json<{ id: string; address: string }>();
    const cases: { user: string; target: string; address: string }[] = [
      { user: "alice", target: b.id, address: b.address },
      { user: "bob", target: a.id, address: a.address },
    ];
    await Promise.all(
      cases.map(async ({ user, target, address }) => {
        expect(
          (
            await app.inject({
              method: "PATCH",
              url: `/aliases/${target}`,
              headers: headers(user),
              payload: { note: "stolen" },
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/aliases/${target}/enable`,
              headers: headers(user),
              payload: {},
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: "DELETE",
              url: `/aliases/${target}`,
              headers: headers(user),
            })
          ).statusCode,
        ).toBe(404);
        const matched = await app.inject({
          method: "POST",
          url: "/aliases/match",
          headers: headers(user),
          payload: { addresses: [address] },
        });
        expect(matched.json<unknown[]>()).toEqual([]);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/aliases/${target}/disable`,
              headers: headers(user),
              payload: {},
            })
          ).statusCode,
        ).toBe(404);
        const list = (
          await app.inject({
            method: "GET",
            url: "/aliases",
            headers: headers(user),
          })
        ).json<{ id: string }[]>();
        expect(list.map((row: { id: string }) => row.id)).not.toContain(target);
      }),
    );
    const retry = await app.inject({
      method: "POST",
      url: "/aliases",
      headers: headers("alice"),
      payload: { requestId: "alice-1" },
    });
    expect(retry.json<{ id: string }>().id).toBe(a.id);
    const key = (
      await app.inject({
        method: "POST",
        url: "/aliases/keys",
        headers: headers("alice"),
        payload: { name: "test" },
      })
    ).json<{ id: string; secret: string }>();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/aliases/keys/${key.id}`,
          headers: headers("bob"),
        })
      ).statusCode,
    ).toBe(404);
    const bobKey = (
      await app.inject({
        method: "POST",
        url: "/aliases/keys",
        headers: headers("bob"),
        payload: { name: "Bob" },
      })
    ).json<{ secret: string }>();
    const created = await app.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: { authentication: bobKey.secret },
      payload: { note: "Bob" },
    });
    expect(created.statusCode).toBe(201);
    const createdRow = await db.emailAlias.findFirstOrThrow({
      where: { address: created.json<{ alias: string }>().alias },
    });
    expect(createdRow.userId).toBe("bob");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/aliases/${createdRow.id}`,
          headers: headers("bob"),
        })
      ).statusCode,
    ).toBe(200);
  });
  it("rejects unavailable domains and enforces the per-user cap", async () => {
    const domains = await app.inject({
      method: "GET",
      url: "/aliases/domains",
      headers: headers("bob"),
    });
    expect(domains.json<{ id: string }[]>().map((row) => row.id)).toEqual([
      domainId,
    ]);
    const selected = await app.inject({
      method: "PUT",
      url: "/aliases/default-domain",
      headers: headers("bob"),
      payload: { domainId },
    });
    expect(selected.statusCode).toBe(200);
    await Promise.all(
      [pendingId, disabledId].map(async (id) => {
        const response = await app.inject({
          method: "POST",
          url: "/aliases",
          headers: headers("bob"),
          payload: { domainId: id, requestId: `invalid-${id}` },
        });
        expect(response.statusCode).toBe(400);
      }),
    );
    const attempts = await Promise.all(
      ["cap-1", "cap-2"].map((requestId) =>
        app.inject({
          method: "POST",
          url: "/aliases",
          headers: headers("bob"),
          payload: { requestId },
        }),
      ),
    );
    expect(
      attempts.map((response) => response.statusCode).toSorted((a, b) => a - b),
    ).toEqual([200, 429]);
    expect(
      attempts
        .find((response) => response.statusCode === 429)
        ?.json<{ code: string }>().code,
    ).toBe("ALIAS_CAP_REACHED");
  });
  it("supports the Bitwarden contract, scoped CORS, and key-only authentication", async () => {
    const key = (
      await app.inject({
        method: "POST",
        url: "/aliases/keys",
        headers: headers("alice"),
        payload: { name: "Bitwarden" },
      })
    ).json<{ id: string; secret: string }>();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/alias/random/new",
      headers: {
        origin: "https://vault.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authentication,content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(
      preflight.headers["access-control-allow-credentials"],
    ).toBeUndefined();
    const cookie = await app.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: headers("alice"),
      payload: { note: "fixture" },
    });
    expect(cookie.statusCode).toBe(401);
    const wrong = await app.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: { authentication: `${key.secret}wrong` },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    const malformed = await app.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: {
        authentication: key.secret,
        "content-type": "application/json",
        origin: "https://vault.example",
      },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: string }>().error).toBe("Invalid request");
    const created = await app.inject({
      method: "POST",
      url: "/alias/random/new?hostname=example.org",
      headers: { authentication: key.secret, origin: "https://vault.example" },
      payload: { note: "Generated by Bitwarden" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ alias: string }>().alias).toMatch(/@example\.test$/);
    expect(created.headers["access-control-allow-origin"]).toBe("*");
    const row = await db.emailAlias.findFirstOrThrow({
      where: { address: created.json<{ alias: string }>().alias },
    });
    expect(row.website).toBe("example.org");
    expect(row.note).toBe("Generated by Bitwarden");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/aliases",
          headers: headers("alice"),
          payload: { requestId: `rate-${i}` },
        }),
      ),
    );
    const retry = await app.inject({
      method: "POST",
      url: "/aliases",
      headers: headers("alice"),
      payload: { requestId: "alice-1" },
    });
    expect(retry.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/aliases/keys/${key.id}`,
          headers: headers("alice"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/alias/random/new",
          headers: { authentication: key.secret },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const stored = await db.aliasApiKey.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(stored.secretHash).not.toContain(key.secret);
  });
  it("reconciles a failed Stalwart operation and keeps the same reservation", async () => {
    const bobAlias = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob" },
    });
    await db.emailAlias.update({
      where: { id: bobAlias.id },
      data: { deletedAt: new Date(), enabled: false, ready: true },
    });
    failMail = true;
    const failed = await app.inject({
      method: "POST",
      url: "/aliases",
      headers: headers("bob"),
      payload: { requestId: "retry" },
    });
    expect(failed.statusCode).toBe(503);
    const pending = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob", requestId: "retry" },
    });
    expect(pending.ready).toBe(false);
    failMail = false;
    const reconciled = await aliases.reconcile();
    expect(reconciled.isOk() && reconciled.value).toBe(0);
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: pending.id } }))
        .ready,
    ).toBe(true);
    const retried = await app.inject({
      method: "POST",
      url: "/aliases",
      headers: headers("bob"),
      payload: { requestId: "retry" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ id: string }>().id).toBe(pending.id);
  });
  it("disables, re-enables and tombstones the caller's alias", async () => {
    const row = await db.emailAlias.findFirstOrThrow({
      where: { userId: "alice", deletedAt: null },
    });
    const disable = await app.inject({
      method: "POST",
      url: `/aliases/${row.id}/disable`,
      headers: headers("alice"),
      payload: {},
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json<{ enabled: boolean }>().enabled).toBe(false);
    const enable = await app.inject({
      method: "POST",
      url: `/aliases/${row.id}/enable`,
      headers: headers("alice"),
      payload: {},
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json<{ enabled: boolean }>().enabled).toBe(true);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/aliases/${row.id}`,
          headers: headers("alice"),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: row.id } }))
        .deletedAt,
    ).not.toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/aliases/${row.id}/enable`,
          headers: headers("alice"),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it("detaches once when domain verification fails and reattaches when restored", async () => {
    const store = createDomainStore(db);
    expect(
      (
        await store.save(
          "alice",
          domainId,
          { status: "failing", records: [] },
          "test.domain",
        )
      ).isOk(),
    ).toBe(true);
    const first = await aliases.reconcile();
    expect(first.isOk() && first.value).toBe(0);
    const detached = await db.emailAlias.findMany({
      where: { domainId, enabled: true, deletedAt: null },
    });
    expect(detached.length).toBeGreaterThan(0);
    expect(detached.every((row) => row.ready && row.detachedByDomain)).toBe(
      true,
    );
    const calls = mailCalls;
    expect((await aliases.reconcile()).isOk()).toBe(true);
    expect(mailCalls).toBe(calls);
    expect(
      (
        await store.save(
          "alice",
          domainId,
          { status: "verified", records: [] },
          "test.domain",
        )
      ).isOk(),
    ).toBe(true);
    expect((await aliases.reconcile()).isOk()).toBe(true);
    const restored = await db.emailAlias.findMany({
      where: { domainId, enabled: true, deletedAt: null },
    });
    expect(restored.every((row) => row.ready && !row.detachedByDomain)).toBe(
      true,
    );
  });
  it("does not let an old network result confirm a newer state", async () => {
    const row = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob", deletedAt: null, enabled: true },
    });
    let entered = noop;
    let release = noop;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    pauseMail = async () => {
      entered();
      await waiting;
    };
    const disabling = aliases.transition("bob", row.id, "disable");
    await started;
    const enabling = await aliases.transition("bob", row.id, "enable");
    expect(enabling.isErr()).toBe(true);
    expect(await db.user.count()).toBeGreaterThan(0);
    pauseMail = undefined;
    release();
    expect((await disabling).isErr()).toBe(true);
    expect((await aliases.reconcile()).isOk()).toBe(true);
    const latest = await db.emailAlias.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(latest.enabled && latest.ready).toBe(true);
  });
  it("audits alias submission attempts and enforces the per-user send limit", async () => {
    const row = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob", enabled: true, ready: true, deletedAt: null },
    });
    const guard = createAliasSendGuard(db);
    const results = await Promise.all(
      Array.from({ length: 31 }, () => guard("bob", row.address)),
    );
    expect(results.filter(Boolean)).toHaveLength(30);
    const events = await db.auditEvent.findMany({
      where: { userId: "bob", action: "alias.submission.attempt" },
    });
    expect(events).toHaveLength(30);
    expect(
      events.every(
        (event) =>
          JSON.stringify(event.detail) === JSON.stringify({ aliasId: row.id }),
      ),
    ).toBe(true);
  });
  it("keeps an alias pending while its owner is disabled and restores it afterwards", async () => {
    const row = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob", enabled: true, deletedAt: null },
    });
    await db.user.update({ where: { id: "bob" }, data: { disabled: true } });
    await db.emailAlias.update({
      where: { id: row.id },
      data: { ready: false },
    });
    await aliases.reconcile();
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: row.id } })).ready,
    ).toBe(false);
    await db.user.update({ where: { id: "bob" }, data: { disabled: false } });
    await aliases.reconcile();
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: row.id } })).ready,
    ).toBe(true);
  });
});
