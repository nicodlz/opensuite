import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { createReadinessService, httpProbe } from "@opensuite/core";
import { createMailService } from "@opensuite/core/services/mail";
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
function totp(secret: string) {
  const bits = secret
    .toUpperCase()
    .replaceAll("=", "")
    .split("")
    .map((character) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(character)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  return String(
    (digest.readUInt32BE((digest.at(-1) ?? 0) & 15) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
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
// The runtime administers Stalwart as management@opensuite.internal, never as
// the recovery administrator. Create that account exactly as
// deploy/stalwart/bootstrap.sh does, with a password distinct from recovery.
const managementPassword = "integration-management-password-0123456789";
const stalwartAdmin = async (
  user: string,
  password: string,
  calls: unknown[],
) => {
  const response = await fetch(`${mailUrl}/jmap/`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: calls,
    }),
  });
  if (!response.ok)
    throw new Error(`Stalwart administration ${response.status}`);
  return JSON.stringify(await response.json());
};
const createManagementAccount = async () => {
  const domain = await stalwartAdmin("admin", "integration-password", [
    [
      "x:Domain/set",
      {
        create: {
          domain: {
            name: "opensuite.internal",
            dkimManagement: { "@type": "Manual" },
          },
        },
      },
      "d",
    ],
  ]);
  const id = /"created":\{"domain":\{"id":"([a-zA-Z0-9]+)"/.exec(domain)?.[1];
  if (id === undefined) throw new Error("management domain not created");
  const account = await stalwartAdmin("admin", "integration-password", [
    [
      "x:Account/set",
      {
        create: {
          account: {
            "@type": "User",
            name: "management",
            domainId: id,
            roles: { "@type": "Admin" },
            credentials: {
              "0": { "@type": "Password", secret: managementPassword },
            },
          },
        },
      },
      "a",
    ],
  ]);
  if (!account.includes('"created":{"account":{"id":'))
    throw new Error("management account not created");
  const check = await stalwartAdmin(
    "management@opensuite.internal",
    managementPassword,
    [["x:Domain/query", {}, "q"]],
  );
  if (!check.includes('"x:Domain/query"'))
    throw new Error("management account not usable");
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
    await createManagementAccount();
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
      const headers = new Headers(init?.headers);
      headers.set(
        "Authorization",
        `Basic ${Buffer.from("admin:integration-password").toString("base64")}`,
      );
      return fetch(input, { ...init, headers });
    };
    const runtime = createAuthRuntime(
      db.value,
      {
        publicOrigin: origin,
        mailDomain: "example.test",
        stalwartOrigin: mailUrl,
        secret: "test-secret-at-least-32-characters-long",
        mailboxKey: "ab".repeat(32),
        adminPassword: managementPassword,
      },
      fetcher,
    );
    reconcile = runtime.reconcile;
    bootstrap = runtime.bootstrap;
    const store = createMailboxStore(db.value, "ab".repeat(32));
    if (store.isErr()) throw new Error("mail store unavailable");
    const mailboxStore = store.value;
    const mailService = createMailService({
      origin: mailUrl,
      store: {
        getForOwner: async (userId, accountId) =>
          mailboxStore.getForOwner(userId, accountId),
      },
    });
    app = await buildServer({
      config: { logLevel: "silent" },
      readiness: createReadinessService({
        probes: [httpProbe("mail-server", `${mailUrl}/healthz/ready`)],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs,
      }),
      monotonicMs,
      identity: runtime.identity,
      accounts: runtime.accounts,
      mail: mailService,
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

const rawPost = (path: string, body: object, cookie?: string) =>
  new Promise<number>((resolve, reject) => {
    const target = new URL(base);
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          origin,
          ...(cookie === undefined ? {} : { cookie }),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });

it("provisions, repairs, authenticates and suspends real local mailboxes", async () => {
  const admin = {
    name: "Admin",
    email: "admin@example.test",
    password: "long-test-password-123",
  };
  const traversalPaths = [
    "/api/auth/x/../sign-up/email",
    "/auth/./sign-in/email",
    "/api/auth/%2e%2e/auth/sign-up/email",
    "/api/auth/x/%2e%2e/sign-up/email",
    "/auth/x/../sign-in/email",
  ];
  const traversal = await Promise.all(
    traversalPaths.map((path) => rawPost(path, admin)),
  );
  expect(traversal).toEqual(traversalPaths.map(() => 400));
  const before = createDatabase(databaseUrl);
  if (before.isErr()) throw new Error("database unavailable");
  try {
    expect(await before.value.user.count()).toBe(0);
    expect(await before.value.mailboxLink.count()).toBe(0);
  } finally {
    await before.value.$disconnect();
  }
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
  expect((await fetch(`${base}/ready`)).status).toBe(200);
  const boxes = await post(
    "/mail/mailboxes",
    { accountId: "default" },
    userCookie,
  );
  expect(boxes.status).toBe(200);
  expect(await boxes.text()).toContain("mailboxes");
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
  try {
    await run("docker", ["pause", mail]);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  } finally {
    await run("docker", ["unpause", mail]);
  }
  const enrollment = await post(
    "/api/auth/two-factor/enable",
    { password: admin.password },
    adminCookie,
  );
  expect(enrollment.status).toBe(200);
  const data: unknown = await enrollment.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("totpURI" in data) ||
    typeof data.totpURI !== "string"
  )
    throw new Error("Missing authenticator URI");
  const secret = new URL(data.totpURI).searchParams.get("secret");
  if (!secret) throw new Error("Missing authenticator secret");
  const activated = await post(
    "/api/auth/two-factor/verify-totp",
    { code: totp(secret) },
    adminCookie,
  );
  expect(activated.status).toBe(200);
  await post("/api/auth/sign-out", {}, cookieOf(activated));
  const challenged = await post("/api/auth/sign-in/email", admin);
  expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
  expect(
    await (
      await fetch(`${base}/api/auth/get-session`, {
        headers: { cookie: cookieOf(challenged) },
      })
    ).json(),
  ).toBeNull();
}, 120_000);
