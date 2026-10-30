import { execFile } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  createECDH,
  createPublicKey,
  verify,
} from "node:crypto";
import { Agent, createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebPushTransport } from "@opensuite/core/adapters/web-push";
import { createNotificationDispatcher } from "@opensuite/core/services/notifications";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import {
  createAliasService,
  type AliasService,
} from "@opensuite/core/services/aliases";
import {
  createDatabase,
  createAliasStore,
  createAddressStore,
  createPushStore,
  createDomainStore,
  type PrismaClient,
} from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";
import { createAddressService } from "@opensuite/core/services/addresses";
import { createAliasSendGuard } from "../src/adapters/alias-mail.ts";

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
const mailOperations: { accountId: string; enabled: boolean }[] = [];
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
      createAliasStore(db),
      {
        set: async (
          accountId,
          _localPart,
          _domainId,
          _address,
          _userId,
          enabled,
        ) => {
          mailCalls++;
          mailOperations.push({ accountId, enabled });
          await pauseMail?.();
          return failMail ? err({ kind: "unavailable" }) : ok(undefined);
        },
      },
      2,
    );
    const pushStore = createPushStore(db);
    const key = createECDH("prime256v1");
    key.generateKeys();
    const dispatcher = createNotificationDispatcher(pushStore, {
      send: async () => {},
    });
    app = await buildServer({
      push: {
        publicKey: key.getPublicKey().toString("base64url"),
        store: pushStore,
        dispatcher,
      },
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
                  sessionId: `session-${user}`,
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
    const ownMatch = await app.inject({
      method: "POST",
      url: "/aliases/match",
      headers: headers("alice"),
      payload: { addresses: [`Alice <${a.address}>`, "broken address"] },
    });
    expect(ownMatch.json<{ id: string }[]>().map((row) => row.id)).toEqual([
      a.id,
    ]);
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
      headers: {
        authentication: `${key.secret.slice(0, -1)}${key.secret.endsWith("A") ? "B" : "A"}`,
      },
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
    const poisoned = await Promise.all(
      [
        '{"__proto__":{"polluted":true}}',
        '{"constructor":{"prototype":{"polluted":true}}}',
      ].map((payload) =>
        app.inject({
          method: "POST",
          url: "/alias/random/new",
          headers: {
            authentication: key.secret,
            "content-type": "application/json",
          },
          payload,
        }),
      ),
    );
    expect(poisoned.map((response) => response.statusCode)).toEqual([400, 400]);
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
  it("keeps aliases attached across transient and two confirmed adoption failures", async () => {
    const store = createDomainStore(db);
    const before = await db.emailAlias.findMany({
      where: { domainId, enabled: true, deletedAt: null },
      orderBy: { id: "asc" },
    });
    expect(before.length).toBeGreaterThan(0);
    const outcomes = [
      "confirmed",
      "unavailable",
      "confirmed",
      "confirmed",
    ] as const;
    await outcomes.reduce<Promise<void>>(async (previous, outcome) => {
      await previous;
      expect(
        (
          await store.recordAdoptionCheck(
            "alice",
            domainId,
            outcome,
            [],
            "manual",
          )
        ).isOk(),
      ).toBe(true);
    }, Promise.resolve());
    expect(
      (await db.domain.findUniqueOrThrow({ where: { id: domainId } })).status,
    ).toBe("verified");
    expect((await aliases.reconcile()).isOk()).toBe(true);
    const unchanged = await db.emailAlias.findMany({
      where: { domainId, enabled: true, deletedAt: null },
      orderBy: { id: "asc" },
    });
    expect(
      unchanged.map((row) => ({
        id: row.id,
        revision: row.revision,
        ready: row.ready,
        detached: row.detachedByDomain,
      })),
    ).toEqual(
      before.map((row) => ({
        id: row.id,
        revision: row.revision,
        ready: row.ready,
        detached: row.detachedByDomain,
      })),
    );
    const failure = await store.recordAdoptionCheck(
      "alice",
      domainId,
      "confirmed",
      [],
      "manual",
    );
    expect(failure.isOk() && failure.value.status).toBe("failing");
    expect((await aliases.reconcile()).isOk()).toBe(true);
    const detached = await db.emailAlias.findMany({
      where: { domainId, enabled: true, deletedAt: null },
    });
    expect(detached.every((row) => row.detachedByDomain)).toBe(true);
    const recovery = await store.recordAdoptionCheck(
      "alice",
      domainId,
      "verified",
      [],
      "manual",
    );
    expect(recovery.isOk() && recovery.value.status).toBe("verified");
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
    const guard = createAliasSendGuard(aliases);
    const results = await Promise.all(
      Array.from({ length: 31 }, () => guard("bob", row.id)),
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
  it("suspends an alias while its owner is disabled and restores it afterwards", async () => {
    const row = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob", enabled: true, deletedAt: null },
    });
    await db.user.update({ where: { id: "bob" }, data: { disabled: true } });
    await aliases.reconcile();
    const suspended = await db.emailAlias.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(suspended.ready && suspended.suspended).toBe(true);
    const calls = mailCalls;
    await aliases.reconcile();
    expect(mailCalls).toBe(calls);
    await db.user.update({ where: { id: "bob" }, data: { disabled: false } });
    await aliases.reconcile();
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: row.id } })).ready,
    ).toBe(true);
  });
  it("returns a reserved alias when the sync lease is busy", async () => {
    const rows = await db.emailAlias.findMany({
      where: { userId: "bob", deletedAt: null },
    });
    const first = rows[0];
    if (rows.length >= 2 && first !== undefined)
      await aliases.transition("bob", first.id, "delete");
    const key = (
      await app.inject({
        method: "POST",
        url: "/aliases/keys",
        headers: headers("bob"),
        payload: { name: "busy" },
      })
    ).json<{ secret: string }>();
    await db.user.update({
      where: { id: "bob" },
      data: {
        aliasSyncToken: "occupied",
        aliasSyncUntil: new Date(Date.now() + 60_000),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/alias/random/new?hostname=localhost",
      headers: {
        authentication: key.secret,
        "content-type": "application/json",
      },
      payload: "",
    });
    expect(response.statusCode).toBe(201);
    const row = await db.emailAlias.findUniqueOrThrow({
      where: { address: response.json<{ alias: string }>().alias },
    });
    expect(row.ready).toBe(false);
    expect(row.website).toBeNull();
    await db.user.update({
      where: { id: "bob" },
      data: { aliasSyncToken: null, aliasSyncUntil: null },
    });
    expect((await aliases.reconcile()).isOk()).toBe(true);
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: row.id } })).ready,
    ).toBe(true);
  });
  it("caps active keys and audits alias and key operations", async () => {
    const active = await db.aliasApiKey.count({
      where: { userId: "bob", revokedAt: null },
    });
    const attempts = await Promise.all(
      Array.from({ length: 21 - active }, (_, index) =>
        app.inject({
          method: "POST",
          url: "/aliases/keys",
          headers: headers("bob"),
          payload: { name: `key-${index}` },
        }),
      ),
    );
    expect(
      attempts.filter((response) => response.statusCode === 429),
    ).toHaveLength(1);
    expect(
      attempts
        .find((response) => response.statusCode === 429)
        ?.json<{ code: string }>().code,
    ).toBe("ALIAS_KEY_CAP_REACHED");
    const first = attempts.find((response) => response.statusCode === 200);
    if (!first) throw new Error("No key created");
    const id = first.json<{ id: string }>().id;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/aliases/keys/${id}`,
          headers: headers("bob"),
        })
      ).statusCode,
    ).toBe(200);
    const actions = (
      await db.auditEvent.findMany({
        where: { userId: "bob" },
        select: { action: true },
      })
    ).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "alias.create",
        "alias.enable",
        "alias.disable",
        "alias.delete",
        "alias.key.create",
        "alias.key.revoke",
      ]),
    );
  });
  it("counts tombstones toward the lifetime alias cap", async () => {
    const userId = "lifetime-owner";
    await db.user.create({
      data: {
        id: userId,
        email: "lifetime@example.test",
        name: "Lifetime",
        defaultAliasDomainId: domainId,
      },
    });
    await db.mailboxLink.create({
      data: {
        userId,
        accountId: "lifetime-account",
        address: "lifetime@example.test",
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const localPart = `tombstone-${index}`;
        const address = await db.address.create({
          data: { userId, domainId, localPart, isAlias: true },
        });
        await db.emailAlias.create({
          data: {
            userId,
            domainId,
            addressId: address.id,
            address: `${localPart}@example.test`,
            localPart,
            enabled: false,
            ready: true,
            deletedAt: new Date(),
          },
        });
      }),
    );
    const limited = createAliasService(
      createAliasStore(db),
      { set: () => Promise.resolve(ok(undefined)) },
      1,
    );
    const result = await limited.create(userId, { requestId: "new" });
    expect(result.isErr() && result.error.kind).toBe("limit");
  });
  it("suspends aliases when a mailbox link is deleted and requeues on restoration", async () => {
    const row = await db.emailAlias.findFirstOrThrow({
      where: { userId: "bob", enabled: true, deletedAt: null },
    });
    const mailbox = await db.mailboxLink.findUniqueOrThrow({
      where: { userId: "bob" },
    });
    const operationCount = mailOperations.length;
    await db.mailboxLink.delete({ where: { userId: "bob" } });
    const pending = await db.emailAlias.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(pending.ready).toBe(false);
    expect(pending.lastAccountId).toBe(mailbox.accountId);
    expect((await aliases.reconcile()).isOk()).toBe(true);
    const suspended = await db.emailAlias.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(suspended.ready && suspended.suspended).toBe(true);
    expect(mailOperations.slice(operationCount)).toContainEqual({
      accountId: mailbox.accountId,
      enabled: false,
    });
    const count = mailCalls;
    await aliases.reconcile();
    expect(mailCalls).toBe(count);
    await db.mailboxLink.create({
      data: {
        userId: "bob",
        accountId: mailbox.accountId,
        address: mailbox.address,
        credentialId: mailbox.credentialId,
        secret: mailbox.secret,
        status: mailbox.status,
      },
    });
    expect((await aliases.reconcile()).isOk()).toBe(true);
    const restored = await db.emailAlias.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(restored.ready && !restored.suspended).toBe(true);
    const beforeSwap = mailOperations.length;
    const replacementId = `${mailbox.accountId}-replacement`;
    await db.mailboxLink.update({
      where: { userId: "bob" },
      data: { accountId: replacementId },
    });
    expect((await aliases.reconcile()).isOk()).toBe(true);
    expect(mailOperations.slice(beforeSwap)).toEqual(
      expect.arrayContaining([
        { accountId: mailbox.accountId, enabled: false },
        { accountId: replacementId, enabled: true },
      ]),
    );
    expect(
      (await db.emailAlias.findUniqueOrThrow({ where: { id: row.id } }))
        .lastAccountId,
    ).toBe(replacementId);
  });
  it("marks declared errors as defined and limits alias changes", async () => {
    const missing = await app.inject({
      method: "PATCH",
      url: "/aliases/missing",
      headers: headers("alice"),
      payload: { note: "x" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ code: string; defined: boolean }>()).toMatchObject({
      code: "NOT_FOUND",
      defined: true,
    });
    const attempts = await Promise.all(
      Array.from({ length: 65 }, () =>
        app.inject({
          method: "POST",
          url: "/aliases/missing/disable",
          headers: headers("alice"),
          payload: {},
        }),
      ),
    );
    expect(attempts.some((response) => response.statusCode === 429)).toBe(true);
    expect(
      attempts
        .find((response) => response.statusCode === 429)
        ?.json<{ code: string; defined: boolean }>(),
    ).toMatchObject({ code: "TOO_MANY_REQUESTS", defined: true });
    const limitedMutations = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/aliases/missing",
        headers: headers("alice"),
        payload: { note: "x" },
      }),
      app.inject({
        method: "POST",
        url: "/aliases/keys",
        headers: headers("alice"),
        payload: { name: "test" },
      }),
      app.inject({
        method: "DELETE",
        url: "/aliases/keys/missing",
        headers: headers("alice"),
      }),
    ]);
    expect(limitedMutations.map((response) => response.statusCode)).toEqual([
      429, 429, 429,
    ]);
  });
});

describe("push API", () => {
  const endpoint = "https://fcm.googleapis.com/test-http";
  const body = {
    product: "mail",
    endpoint,
    p256dh: "A".repeat(87),
    auth: "A".repeat(22),
    userAgent: "test",
  };
  it("records valid calendar subscriber zones without accepting another user's update", async () => {
    const calendarEndpoint = "https://fcm.googleapis.com/calendar-zone-test";
    const subscription = {
      ...body,
      product: "calendar",
      endpoint: calendarEndpoint,
      timeZone: "Europe/Paris",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/push/subscribe",
          headers: headers("alice"),
          payload: subscription,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: "alice" } }))
        .calendarTimeZone,
    ).toBe("Europe/Paris");
    const invalid = await app.inject({
      method: "POST",
      url: "/push/status",
      headers: headers("alice"),
      payload: {
        product: "calendar",
        endpoint: calendarEndpoint,
        timeZone: "Invalid/Zone",
      },
    });
    expect(invalid.statusCode).toBe(400);
    const other = await app.inject({
      method: "POST",
      url: "/push/status",
      headers: headers("bob"),
      payload: {
        product: "calendar",
        endpoint: calendarEndpoint,
        timeZone: "America/New_York",
      },
    });
    expect(other.json()).toEqual({ subscribed: false });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: "bob" } }))
        .calendarTimeZone,
    ).toBe("UTC");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/push/status",
          headers: headers("alice"),
          payload: {
            product: "calendar",
            endpoint: calendarEndpoint,
            timeZone: "America/New_York",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: "alice" } }))
        .calendarTimeZone,
    ).toBe("America/New_York");
  });
  it("requires a session for the public key and exposes only the public key", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/push/public-key" })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/push/public-key",
      headers: headers("alice"),
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json())).toEqual(["publicKey"]);
    expect(response.json<{ publicKey: string }>().publicKey).toHaveLength(87);
  });
  it("does not let another user take, inspect, remove or test a subscription", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/push/subscribe",
          headers: headers("alice"),
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/push/subscribe",
          headers: headers("bob"),
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    const status = await app.inject({
      method: "POST",
      url: "/push/status",
      headers: headers("bob"),
      payload: { product: "mail", endpoint },
    });
    expect(status.json()).toEqual({ subscribed: false });
    await app.inject({
      method: "POST",
      url: "/push/unsubscribe",
      headers: headers("bob"),
      payload: { product: "mail", endpoint },
    });
    await app.inject({
      method: "POST",
      url: "/push/test",
      headers: headers("bob"),
      payload: { product: "mail" },
    });
    expect(
      (await db.pushSubscription.findUniqueOrThrow({ where: { endpoint } }))
        .lastSuccessAt,
    ).toBeNull();
  });
  it("accepts Edge and Apple push endpoints but refuses unsafe origins", async () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const send = (candidate: string) =>
      app.inject({
        method: "POST",
        url: "/push/subscribe",
        headers: headers("bob"),
        payload: { ...body, endpoint: candidate },
      });
    const accepted = await Promise.all(
      [
        "https://db5.notify.windows.com/push/test",
        "https://web.push.apple.com/3/device/test",
      ].map(send),
    );
    expect(accepted.map((response) => response.statusCode)).toEqual([200, 200]);
    const rejected = await Promise.all(
      [
        "http://db5.notify.windows.com/push/test",
        "https://db5.notify.windows.com:8443/x",
        "https://db5.notify.windows.com:443/x",
        "https://user@web.push.apple.com/x",
        "https://notify.windows.com.evil.test/x",
      ].map(send),
    );
    expect(rejected.map((response) => response.statusCode)).toEqual([
      400, 400, 400, 400, 400,
    ]);
  });
  it("clears only subscriptions attached to the current authenticated session", async () => {
    const store = createPushStore(db);
    const input = {
      product: "calendar" as const,
      endpoint: "https://fcm.googleapis.com/session-one",
      p256dh: "A".repeat(87),
      auth: "A".repeat(22),
      userAgent: "test",
    };
    await store.subscribe("alice", input, "session-alice");
    await store.subscribe(
      "alice",
      { ...input, endpoint: "https://fcm.googleapis.com/other-device" },
      "session-other",
    );
    const response = await app.inject({
      method: "POST",
      url: "/push/clear-session",
      headers: headers("alice"),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(await store.status("alice", "calendar", input.endpoint)).toBe(false);
    expect(
      await store.status(
        "alice",
        "calendar",
        "https://fcm.googleapis.com/other-device",
      ),
    ).toBe(true);
    expect(
      await store.status(
        "bob",
        "mail",
        "https://db5.notify.windows.com/push/test",
      ),
    ).toBe(true);
  });
  it("cleans session subscriptions when sign-out is called directly", async () => {
    const store = createPushStore(db);
    const directEndpoint = "https://fcm.googleapis.com/direct-logout";
    await store.subscribe(
      "bob",
      {
        product: "drive",
        endpoint: directEndpoint,
        p256dh: "A".repeat(87),
        auth: "A".repeat(22),
        userAgent: "test",
      },
      "session-bob",
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/sign-out",
      headers: headers("bob"),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(await store.status("bob", "drive", directEndpoint)).toBe(false);
  });
  it("sends a signed encrypted push and purges the stored endpoint on 410", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esuno-push-http-"));
    const keyFile = join(directory, "key.pem");
    const certFile = join(directory, "cert.pem");
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ]);
    const [key, cert] = await Promise.all([
      readFile(keyFile),
      readFile(certFile),
    ]);
    const vapid = createECDH("prime256v1");
    vapid.generateKeys();
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    let valid = false;
    let received = false;
    const statuses: (number | null)[] = [];
    const server = createServer({ key, cert }, (request, response) => {
      received = true;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const match = /^vapid t=([^,]+), k=(.+)$/.exec(
          request.headers.authorization ?? "",
        );
        const parts = match?.[1]?.split(".") ?? [];
        const [header, claims, signature] = parts;
        if (
          header &&
          claims &&
          signature &&
          match?.[2] === vapid.getPublicKey().toString("base64url")
        ) {
          const bytes = vapid.getPublicKey();
          const publicKey = createPublicKey({
            key: {
              kty: "EC",
              crv: "P-256",
              x: bytes.subarray(1, 33).toString("base64url"),
              y: bytes.subarray(33, 65).toString("base64url"),
            },
            format: "jwk",
          });
          const encrypted = Buffer.concat(chunks);
          valid =
            request.headers["content-encoding"] === "aes128gcm" &&
            encrypted.length > 86 &&
            !encrypted.includes(Buffer.from("private content")) &&
            verify(
              "sha256",
              Buffer.from(`${header}.${claims}`),
              { key: publicKey, dsaEncoding: "ieee-p1363" },
              Buffer.from(signature, "base64url"),
            );
        }
        response.writeHead(410).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing push test port");
    const localEndpoint = `https://127.0.0.1:${address.port}/push`;
    const publicKey = vapid.getPublicKey().toString("base64url");
    const store = createPushStore(db, publicKey);
    const agent = new Agent({ ca: cert });
    try {
      expect(
        await store.subscribe(
          "alice",
          {
            product: "calendar",
            endpoint: localEndpoint,
            p256dh: receiver.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
            userAgent: "test",
          },
          "session-alice",
        ),
      ).toBe(true);
      const dispatcher = createNotificationDispatcher(
        store,
        createWebPushTransport(
          publicKey,
          vapid.getPrivateKey().toString("base64url"),
          origin,
          agent,
        ),
        () => new Date(),
        (event) => statuses.push(event.status),
      );
      const result = await dispatcher.notifyWithResult("alice", "calendar", {
        title: "private content",
        url: "/calendar",
        tag: `real-${randomUUID()}`,
      });
      expect(result).toMatchObject({
        outcome: "failed",
        delivered: 0,
        failed: 1,
      });
      expect({ received, statuses, valid }).toMatchObject({ valid: true });
      expect(
        await db.pushSubscription.findUnique({
          where: { endpoint: localEndpoint },
        }),
      ).toBeNull();
    } finally {
      agent.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it("limits subscription and test requests per user", async () => {
    const subscribe = await Promise.all(
      Array.from({ length: 11 }, () =>
        app.inject({
          method: "POST",
          url: "/push/subscribe",
          headers: headers("alice"),
          payload: body,
        }),
      ),
    );
    expect(subscribe.some((response) => response.statusCode === 429)).toBe(
      true,
    );
    const tests = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: "POST",
          url: "/push/test",
          headers: headers("alice"),
          payload: { product: "mail" },
        }),
      ),
    );
    expect(tests.some((response) => response.statusCode === 429)).toBe(true);
  });
});

/* oxlint-disable eslint/no-await-in-loop */
it("restricts subscriber choices and creation while preserving existing mail and admin access", async () => {
  const adminId = "policy-admin";
  const subscriberId = "policy-subscriber";
  const newSubscriberId = "policy-new-subscriber";
  const allowed = ["esuno.net", "esn.pm"];
  const technical = "technical.example";
  const foreign = "other.example";
  await db.user.createMany({
    data: [
      {
        id: adminId,
        email: `admin@${technical}`,
        name: "Admin",
        role: "admin",
      },
      { id: subscriberId, email: `existing@${technical}`, name: "Subscriber" },
      { id: newSubscriberId, email: "new@esuno.net", name: "New subscriber" },
    ],
  });
  await db.mailboxLink.createMany({
    data: [adminId, subscriberId, newSubscriberId].map((userId) => ({
      userId,
      accountId: `${userId}-mail`,
      address:
        userId === adminId
          ? `admin@${technical}`
          : userId === subscriberId
            ? `existing@${technical}`
            : "new@esuno.net",
      credentialId: "fixture",
      secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
    })),
  });
  const ids = new Map<string, string>();
  for (const name of [technical, foreign, ...allowed]) {
    const row = await db.domain.create({
      data: {
        name,
        userId: adminId,
        status: "verified",
        stalwartId: `remote-${name}`,
      },
    });
    ids.set(name, row.id);
  }
  const technicalId = ids.get(technical);
  const foreignId = ids.get(foreign);
  if (!technicalId || !foreignId) throw new Error("fixture domains");
  const mail = { set: () => Promise.resolve(ok(undefined)) };
  const unrestricted = createAliasService(createAliasStore(db), mail, 100);
  const oldAlias = await unrestricted.create(subscriberId, {
    domainId: technicalId,
    requestId: "old-policy-request",
  });
  expect(oldAlias.isOk()).toBe(true);
  if (oldAlias.isErr()) throw new Error("fixture alias");
  await db.user.update({
    where: { id: subscriberId },
    data: { defaultAliasDomainId: technicalId },
  });
  const oldAddressStore = createAddressStore(db, [technical, ...allowed]);
  const oldAddress = (
    await oldAddressStore.reserve(
      subscriberId,
      technicalId,
      "existing-extra",
      100,
    )
  ).match(
    (value) => value,
    () => {
      throw new Error("fixture result");
    },
  );
  await db.address.update({
    where: { id: oldAddress.id },
    data: { ready: true, active: true },
  });
  const addressStore = createAddressStore(db, [technical, ...allowed], allowed);
  const policyAliases = createAliasService(
    createAliasStore(db, allowed),
    mail,
    100,
  );
  const policyAddresses = createAddressService(
    addressStore,
    mail,
    () => Promise.resolve(100),
    () => Promise.resolve(ok(undefined)),
    [technical, ...allowed],
  );
  const actor = (id: string) => ({
    id,
    email: id === adminId ? `admin@${technical}` : `existing@${technical}`,
    role: id === adminId ? ("admin" as const) : ("user" as const),
  });
  const policyApp = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: clock,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: clock,
    }),
    aliases: policyAliases,
    addresses: policyAddresses,
    identity: {
      publicOrigin: origin,
      handler: () => Promise.resolve(new Response()),
      actor: (h) => {
        const id = /test-user=(policy-admin|policy-subscriber)/.exec(
          h.get("cookie") ?? "",
        )?.[1];
        return Promise.resolve(id ? actor(id) : null);
      },
    },
  });
  try {
    const names = async (path: string, userId: string) =>
      (
        await policyApp.inject({
          method: "GET",
          url: path,
          headers: headers(userId),
        })
      )
        .json<{ name: string }[]>()
        .map((row) => row.name);
    expect(await names("/addresses/domains", subscriberId)).toEqual([
      "esn.pm",
      "esuno.net",
    ]);
    expect(await names("/aliases/domains", subscriberId)).toEqual([
      "esn.pm",
      "esuno.net",
    ]);
    expect(await names("/addresses/domains", adminId)).toContain(technical);
    expect(await names("/aliases/domains", adminId)).toContain(technical);
    for (const blockedDomainId of [technicalId, foreignId]) {
      expect(
        (
          await policyAddresses.create(actor(subscriberId), {
            localPart: "blocked",
            domainId: blockedDomainId,
          })
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await policyAliases.create(subscriberId, {
            domainId: blockedDomainId,
          })
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await policyApp.inject({
            method: "POST",
            url: "/addresses",
            headers: headers(subscriberId),
            payload: { localPart: "blocked", domainId: blockedDomainId },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await policyApp.inject({
            method: "POST",
            url: "/aliases",
            headers: headers(subscriberId),
            payload: {
              domainId: blockedDomainId,
              requestId: `blocked-${blockedDomainId}`,
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await policyApp.inject({
            method: "PUT",
            url: "/aliases/default-domain",
            headers: headers(subscriberId),
            payload: { domainId: blockedDomainId },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await policyApp.inject({
          method: "PATCH",
          url: `/aliases/${oldAlias.value.id}`,
          headers: headers(subscriberId),
          payload: { domainId: technicalId },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await policyAliases.getDefault(subscriberId)).match(
        (value) => value,
        () => {
          throw new Error("fixture result");
        },
      ),
    ).toEqual({ domainId: null });
    const key = (
      await policyAliases.createKey(subscriberId, "Generator")
    ).match(
      (value) => value,
      () => {
        throw new Error("fixture result");
      },
    );
    const compat = await policyApp.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: { authentication: key.secret },
      payload: {},
    });
    expect(compat.statusCode).toBe(201);
    expect(compat.json<{ alias: string }>().alias).toMatch(/@esuno\.net$/);
    const newKeyResult = await policyAliases.createKey(
      newSubscriberId,
      "New generator",
    );
    if (newKeyResult.isErr()) throw new Error("fixture key");
    const newCompat = await policyApp.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: { authentication: newKeyResult.value.secret },
      payload: {},
    });
    expect(newCompat.statusCode).toBe(201);
    expect(newCompat.json<{ alias: string }>().alias).toMatch(/@esuno\.net$/);
    await db.domain.update({
      where: { name: "esuno.net" },
      data: { status: "failing" },
    });
    const nextCompat = await policyApp.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: { authentication: newKeyResult.value.secret },
      payload: {},
    });
    expect(nextCompat.statusCode).toBe(201);
    expect(nextCompat.json<{ alias: string }>().alias).toMatch(/@esn\.pm$/);
    expect(
      (
        await policyAliases.create(subscriberId, {
          domainId: technicalId,
          requestId: "old-policy-request",
        })
      ).isErr(),
    ).toBe(true);
    await db.domain.updateMany({
      where: { name: { in: allowed } },
      data: { status: "failing" },
    });
    const unavailable = await policyApp.inject({
      method: "POST",
      url: "/alias/random/new",
      headers: { authentication: key.secret },
      payload: {},
    });
    expect(unavailable.statusCode).toBe(400);
    await db.domain.updateMany({
      where: { name: { in: allowed } },
      data: { status: "verified" },
    });
    const allowedId = ids.get("esuno.net");
    if (!allowedId) throw new Error("fixture domain");
    expect(
      (await policyAliases.setDefault(subscriberId, allowedId)).isOk(),
    ).toBe(true);
    expect(
      (
        await policyAliases.create(subscriberId, { domainId: allowedId })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await policyAddresses.create(actor(subscriberId), {
          localPart: "allowed",
          domainId: allowedId,
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await policyAddresses.create(actor(adminId), {
          localPart: "admin-extra",
          domainId: technicalId,
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (await policyAliases.create(adminId, { domainId: technicalId })).isOk(),
    ).toBe(true);
    expect((await policyAliases.setDefault(adminId, technicalId)).isOk()).toBe(
      true,
    );
    expect(
      (await addressStore.resolveLogin(`existing-extra@${technical}`))?.id,
    ).toBe(subscriberId);
    expect(
      (
        await addressStore.canSendAs(
          subscriberId,
          `existing-extra@${technical}`,
        )
      ).match(
        (value) => value,
        () => {
          throw new Error("fixture result");
        },
      )?.id,
    ).toBe(oldAddress.id);
    const provisioned: string[] = [];
    const configuredStore = createAddressStore(
      db,
      ["excluded.example", "included.example"],
      ["included.example"],
    );
    expect(
      (
        await configuredStore.ensureConfigured((name) => {
          provisioned.push(name);
          return Promise.resolve(`remote-${name}`);
        })
      ).isOk(),
    ).toBe(true);
    expect(provisioned).toEqual(["excluded.example", "included.example"]);
    const excluded = await db.domain.findUnique({
      where: { name: "excluded.example" },
    });
    expect(excluded).toMatchObject({
      stalwartId: "remote-excluded.example",
      status: "pending",
    });
    const adminChoices = await configuredStore.domains(adminId);
    const subscriberChoices = await configuredStore.domains(subscriberId);
    expect(
      adminChoices.isOk() && adminChoices.value.map((row) => row.name),
    ).toContain("excluded.example");
    expect(
      subscriberChoices.isOk() &&
        subscriberChoices.value.map((row) => row.name),
    ).not.toContain("excluded.example");
    expect(
      (await policyAliases.list(subscriberId))
        .match(
          (value) => value,
          () => {
            throw new Error("fixture result");
          },
        )
        .some((row) => row.id === oldAlias.value.id),
    ).toBe(true);
    expect(
      (
        await policyAliases.canSendAs(subscriberId, oldAlias.value.address)
      ).match(
        (value) => value,
        () => {
          throw new Error("fixture result");
        },
      ),
    ).toBe(oldAlias.value.id);
    const routes = (
      await createDomainStore(db).routes([
        `existing@${technical}`,
        oldAlias.value.address,
      ])
    ).match(
      (value) => value,
      () => {
        throw new Error("fixture result");
      },
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        {
          address: `existing@${technical}`,
          destination: `${subscriberId}-mail`,
        },
        {
          address: oldAlias.value.address,
          destination: `${subscriberId}-mail`,
        },
      ]),
    );
  } finally {
    await policyApp.close();
  }
});

/* oxlint-enable eslint/no-await-in-loop */
