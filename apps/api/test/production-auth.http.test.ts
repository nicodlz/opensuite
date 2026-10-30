import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import {
  configureApplicationRole,
  createDatabase,
  createMailboxStore,
} from "@opensuite/db";
import { JmapClient } from "@opensuite/jmap";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuthRuntime } from "../src/auth/runtime.ts";
import { buildServer } from "../src/server.ts";

const run = promisify(execFile);
const fixtureId = randomUUID().slice(0, 8);
const pg = `opensuite-auth-prod-db-${fixtureId}`;
const mail = `opensuite-auth-prod-mail-${fixtureId}`;
const origin = "https://suite.example.test";
const monotonicMs = () => performance.now();
let app: FastifyInstance | undefined;
let base = "";
let databaseUrl = "";
let mailUrl = "";
let closeDb = () => Promise.resolve();
let reconcile = () => Promise.resolve(0);
let bootstrap = (_email: string, _password: string, _name: string) =>
  Promise.resolve();
let failIssue = false;
let failSuspend = false;
const wait = async (
  probe: () => Promise<boolean>,
  attempts = 120,
): Promise<void> => {
  if (await probe().catch(() => false)) return;
  if (attempts === 0) throw new Error("fixture unavailable");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });
  return wait(probe, attempts - 1);
};
const port = async (container: string, target: string) => {
  const match = /:(\d+)\s*$/.exec(
    (await run("docker", ["port", container, target])).stdout,
  );
  if (match?.[1] === undefined) throw new Error("port missing");
  return match[1];
};
const cleanup = async () => {
  await app?.close();
  await closeDb();
  await Promise.all(
    [pg, mail].map((name) =>
      run("docker", ["rm", "-f", name]).catch(() => undefined),
    ),
  );
};
beforeAll(async () => {
  try {
    await Promise.all([
      run("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        pg,
        "-e",
        "POSTGRES_PASSWORD=test-password",
        "-e",
        "POSTGRES_INITDB_ARGS=--no-sync",
        "-p",
        "127.0.0.1::5432",
        "postgres:18.6",
      ]),
      run("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        mail,
        "-e",
        "STALWART_RECOVERY_ADMIN=admin:integration-password",
        "-p",
        "127.0.0.1::8080",
        "-v",
        `${process.cwd()}/deploy/stalwart/config.json:/etc/stalwart/config.json:ro`,
        "stalwartlabs/stalwart:v1.0.1",
        "--config",
        "/etc/stalwart/config.json",
      ]),
    ]);
    await wait(async () => {
      await run("docker", ["exec", pg, "pg_isready", "-U", "postgres"]);
      return true;
    });
    databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${await port(pg, "5432")}/postgres`;
    mailUrl = `http://127.0.0.1:${await port(mail, "8080")}`;
    await wait(async () => (await fetch(`${mailUrl}/healthz/ready`)).ok);
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        maxBuffer: 4_000_000,
      },
    );
    const owner = createDatabase(databaseUrl);
    if (owner.isErr()) throw new Error("database unavailable");
    const password = "application-test-password-32-characters-long";
    await configureApplicationRole(owner.value, password);
    await owner.value.$disconnect();
    const url = new URL(databaseUrl);
    url.username = "opensuite_app";
    url.password = password;
    const db = createDatabase(url.toString());
    if (db.isErr()) throw new Error("database unavailable");
    closeDb = () => db.value.$disconnect();
    const fetcher: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (
        (failIssue &&
          body.includes("x:AppPassword/set") &&
          body.includes('"create"')) ||
        (failSuspend && body.includes("disabledPermissions"))
      )
        return new Response("unavailable", { status: 503 });
      return fetch(input, init);
    };
    const runtime = createAuthRuntime(
      db.value,
      {
        publicOrigin: origin,
        mailDomain: "example.test",
        stalwartOrigin: mailUrl,
        secret: "test-secret-at-least-32-characters-long",
        mailboxKey: "ab".repeat(32),
        adminPassword: "integration-password",
      },
      fetcher,
    );
    reconcile = runtime.reconcile;
    bootstrap = runtime.bootstrap;
    app = await buildServer({
      config: { logLevel: "silent" },
      readiness: createReadinessService({
        probes: [],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs,
      }),
      monotonicMs,
      identity: runtime.identity,
      accounts: runtime.accounts,
    });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
  } catch (error) {
    await cleanup();
    throw error;
  }
}, 240_000);
afterAll(cleanup, 240_000);
const post = (path: string, body: object, cookie?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
const userId = async (email: string) => {
  const result = createDatabase(databaseUrl);
  if (result.isErr()) throw new Error("database unavailable");
  try {
    return (await result.value.user.findUniqueOrThrow({ where: { email } })).id;
  } finally {
    await result.value.$disconnect();
  }
};

it("provisions, repairs, authenticates and suspends real local mailboxes", async () => {
  const admin = {
    name: "Admin",
    email: "admin@example.test",
    password: "long-test-password-123",
  };
  expect((await post("/api/auth/sign-up/email", admin)).status).toBe(403);
  await bootstrap(admin.email, admin.password, admin.name);
  const adminLogin = await post("/api/auth/sign-in/email", admin);
  expect(adminLogin.status).toBe(200);
  const adminCookie = cookieOf(adminLogin);
  const adminId = await userId(admin.email);
  expect(
    (await post(`/admin/accounts/${adminId}/disable`, {}, adminCookie)).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/admin/accounts`, {
        headers: { cookie: adminCookie },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/api/auth/sign-up/email",
        {
          ...admin,
          email: "wrong@other.test",
        },
        adminCookie,
      )
    ).status,
  ).toBe(400);

  failIssue = true;
  const user = {
    name: "User",
    email: "user@example.test",
    password: "long-test-password-456",
  };
  expect((await post("/api/auth/sign-up/email", user, adminCookie)).ok).toBe(
    false,
  );
  const id = await userId(user.email);
  expect((await post("/api/auth/sign-in/email", user)).ok).toBe(false);
  failIssue = false;
  expect(await reconcile()).toBe(0);
  expect(await reconcile()).toBe(0);
  const login = await post("/api/auth/sign-in/email", user);
  expect(login.status).toBe(200);
  const userCookie = cookieOf(login);
  expect(
    (
      await fetch(`${base}/api/auth/get-session?disableCookieCache=true`, {
        headers: { cookie: userCookie },
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await fetch(`${base}/api/auth/get-session?disableCookieCache=true`, {
        headers: { cookie: userCookie },
      })
    ).json(),
  ).toMatchObject({ user: { id } });
  const owner = createDatabase(databaseUrl);
  if (owner.isErr()) throw new Error("database unavailable");
  try {
    const link = await owner.value.mailboxLink.findUniqueOrThrow({
      where: { userId: id },
    });
    expect(link.secret).not.toContain("private");
    const store = createMailboxStore(owner.value, "ab".repeat(32));
    if (store.isErr()) throw new Error("store unavailable");
    const credential = await store.value.getForOwner(id, link.accountId);
    if (credential.isErr()) throw new Error("credential unavailable");
    const client = new JmapClient(mailUrl, {
      authorization: `Basic ${Buffer.from(`${user.email}:${credential.value.secret}`).toString("base64")}`,
    });
    expect((await client.discover()).isOk()).toBe(true);
    failSuspend = true;
    expect(
      (await post(`/admin/accounts/${id}/disable`, {}, adminCookie)).status,
    ).toBe(500);
    expect(
      await (
        await fetch(`${base}/api/auth/get-session?disableCookieCache=true`, {
          headers: { cookie: userCookie },
        })
      ).json(),
    ).toBeNull();
    failSuspend = false;
    expect(await reconcile()).toBe(0);
    expect((await client.discover()).isErr()).toBe(true);
    await expect(
      bootstrap(user.email, user.password, user.name),
    ).rejects.toThrow("mailbox provisioning failed");
    expect(
      (
        await owner.value.mailboxLink.findUniqueOrThrow({
          where: { userId: id },
        })
      ).status,
    ).toBe("disabled");
    const events = await owner.value.auditEvent.findMany({
      select: { action: true },
    });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "sign_up.failure",
        "sign_in.success",
        "app_password.issue.success",
        "app_password.issue.failure",
        "app_password.revoke.success",
        "admin.account.disable",
      ]),
    );
  } finally {
    await owner.value.$disconnect();
  }
}, 120_000);
