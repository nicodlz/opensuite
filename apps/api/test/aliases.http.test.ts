import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import { createAliasService } from "@opensuite/core/services/aliases";
import { createDatabase, type PrismaClient } from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

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
const clock = () => performance.now();
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
          status: "verified",
          enabled: false,
          stalwartId: "domain3",
        },
      })
    ).id;
    await db.user.updateMany({ data: { defaultAliasDomainId: domainId } });
    const aliases = createAliasService(
      db,
      {
        set: () =>
          Promise.resolve(
            failMail ? err({ kind: "unavailable" }) : ok(undefined),
          ),
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
    const a = alice.json<{ id: string }>();
    const b = bob.json<{ id: string }>();
    const cases: { user: string; target: string }[] = [
      { user: "alice", target: b.id },
      { user: "bob", target: a.id },
    ];
    await Promise.all(
      cases.map(async ({ user, target }) => {
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
});
