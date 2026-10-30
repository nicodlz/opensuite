import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import { createAccountStore, createDatabase } from "../packages/db/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { createIdentity } from "../apps/api/src/auth/identity.ts";
import { buildServer } from "../apps/api/src/server.ts";

// Real production bundle, real API and Better Auth on PostgreSQL, served on
// three *.localhost origins (secure contexts in Chromium) plus plain localhost.
const run = promisify(execFile);
const dist = "apps/web/dist";
const container = `opensuite-split-e2e-${randomUUID().slice(0, 8)}`;
let web: Server | undefined;
let api: FastifyInstance | undefined;
let disconnect = () => Promise.resolve();
let mail = "";
let drive = "";
let calendar = "";
let single = "";
const user = { email: "split@example.test", password: "split-strong-password" };
const mfa = {
  email: "mfa-split@example.test",
  password: "mfa-strong-password",
};
let totpSecret = "";

function totp(secret: string) {
  let bits = "";
  for (const character of secret.toUpperCase().replaceAll("=", ""))
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(character)
      .toString(2)
      .padStart(5, "0");
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
/** Stands in for Caddy: /api goes to the API, everything else to the SPA. */
async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  apiBase: () => string,
) {
  const url = new URL(request.url ?? "/", "http://placeholder");
  if (url.pathname.startsWith("/api/")) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string" && name !== "host" && name !== "connection")
        headers.set(name, value);
    const payload =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await body(request);
    const upstream = await fetch(
      `${apiBase()}${url.pathname.slice(4)}${url.search}`,
      {
        method: request.method ?? "GET",
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        redirect: "manual",
      },
    );
    const outgoing: Record<string, string | string[]> = {};
    upstream.headers.forEach((value, name) => {
      if (name !== "set-cookie" && name !== "content-encoding")
        outgoing[name] = value;
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) outgoing["set-cookie"] = cookies;
    delete outgoing["content-length"];
    response.writeHead(upstream.status, outgoing);
    response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  if (url.pathname.startsWith("/drive/api/")) {
    response.writeHead(503).end();
    return;
  }
  const file = normalize(join(dist, url.pathname));
  const target =
    file.startsWith(dist) && extname(file) && existsSync(file)
      ? file
      : join(dist, "index.html");
  response.writeHead(200, {
    "content-type": types[extname(target)] ?? "application/octet-stream",
    "referrer-policy": "no-referrer",
  });
  response.end(await readFile(target));
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  if (!existsSync(join(dist, "index.html")))
    throw new Error("Run `pnpm build` before the split-origin browser test.");
  let apiBase = "";
  web = createServer((request, response) => {
    serve(request, response, () => apiBase).catch(() => {
      response.writeHead(502).end();
    });
  });
  await new Promise<void>((resolve) => web?.listen(0, "127.0.0.1", resolve));
  const address = web.address();
  if (address === null || typeof address === "string")
    throw new Error("No web port");
  const port = address.port;
  mail = `http://mail.localhost:${port}`;
  drive = `http://drive.localhost:${port}`;
  calendar = `http://calendar.localhost:${port}`;
  single = `http://localhost:${port}`;

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
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
      break;
    } catch {
      if (attempt > 240) throw new Error("PostgreSQL did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const dbPort = /:(\d+)\s*$/.exec(
    (await run("docker", ["port", container, "5432"])).stdout,
  )?.[1];
  const databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${dbPort}/postgres`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run(
        "pnpm",
        ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
        { env: { ...process.env, DATABASE_URL: databaseUrl } },
      );
      break;
    } catch (error) {
      if (attempt > 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const database = createDatabase(databaseUrl);
  if (database.isErr()) throw new Error(database.error.message);
  const db = database.value;
  disconnect = () => db.$disconnect();
  const provisioned = new Set<string>();
  const trusted = [mail, drive, calendar, single];
  const identity = createIdentity({
    database: db,
    publicOrigin: mail,
    trustedOrigins: trusted,
    secret: "split-origin-secret-at-least-32-characters",
    provision: (created) => {
      provisioned.add(created.id);
      return Promise.resolve();
    },
    mayStartSession: (userId) => Promise.resolve(provisioned.has(userId)),
  });
  for (const account of [user, mfa])
    await identity.api.signUpEmail({ body: { ...account, name: "Split" } });
  // Enrol TOTP for the MFA account through the public handler.
  const call = async (path: string, payload: object, cookie = "") =>
    identity.handler(
      new Request(`${mail}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: mail, cookie },
        body: JSON.stringify(payload),
      }),
    );
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
  const mfaCookie = cookieOf(await call("sign-in/email", mfa));
  const enrolment = (await (
    await call("two-factor/enable", { password: mfa.password }, mfaCookie)
  ).json()) as { totpURI: string };
  totpSecret = new URL(enrolment.totpURI).searchParams.get("secret") ?? "";
  expect(
    (
      await call(
        "two-factor/verify-totp",
        { code: totp(totpSecret) },
        mfaCookie,
      )
    ).status,
  ).toBe(200);

  const accounts = createAccountStore(db);
  const monotonicMs = () => performance.now();
  api = await buildServer({
    config: { logLevel: "silent" },
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs,
    }),
    monotonicMs,
    identity: {
      handler: identity.handler,
      publicOrigin: mail,
      trustedOrigins: trusted,
      productOrigins: { mail, drive, calendar },
      actor: async (headers) => {
        const session = await identity.api.getSession({ headers });
        if (session === null) return null;
        const actor = await accounts.actor(session.user.id);
        return actor.isOk() ? actor.value : null;
      },
      audit: () => Promise.resolve(),
    },
  });
  apiBase = await api.listen({ host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => {
    if (web === undefined) resolve();
    else web.close(() => resolve());
  });
  await disconnect();
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
});

async function signIn(
  page: Page,
  account: { email: string; password: string },
) {
  await expect(page).toHaveURL(`${mail}/login`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const visited = (page: Page) => {
  const urls: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });
  return urls;
};

test("sign in once on mail, then reach calendar and drive at their root", async ({
  page,
  context,
}) => {
  const urls = visited(page);
  await page.goto(`${calendar}/?view=week#today`);
  await signIn(page, user);
  await expect(page).toHaveURL(`${calendar}/?view=week`);
  await expect(page.getByRole("link", { name: "Mail" })).toHaveAttribute(
    "href",
    `${mail}/`,
  );
  // The token travelled in a fragment and never reached the address bar now.
  expect(page.url()).not.toContain("token");
  expect(urls.some((url) => url.includes("/auth/callback#token="))).toBe(true);
  expect(urls.every((url) => !/[?&]token=/.test(url))).toBe(true);
  const cookies = await context.cookies();
  const sessions = cookies.filter(
    (cookie) => cookie.name === "__Host-opensuite.session_token",
  );
  expect(sessions.map((cookie) => cookie.domain).toSorted()).toEqual([
    "calendar.localhost",
    "mail.localhost",
  ]);
  expect(cookies.every((cookie) => !cookie.domain.startsWith("."))).toBe(true);
  expect(sessions.every((cookie) => cookie.secure && cookie.httpOnly)).toBe(
    true,
  );

  // Moving to Drive needs no new sign-in.
  await page.getByRole("link", { name: "Drive" }).first().click();
  await expect(page).toHaveURL(`${drive}/`);
  await expect(
    page.getByRole("link", { name: "Calendar" }).first(),
  ).toBeVisible();

  // A reopened tab uses the existing session without visiting mail.
  const again = await context.newPage();
  const againUrls = visited(again);
  await again.goto(`${calendar}/`);
  await expect(
    again.getByRole("link", { name: "Drive" }).first(),
  ).toBeVisible();
  expect(againUrls.every((url) => url.startsWith(calendar))).toBe(true);

  // Old single-origin URLs keep their query on the new origin.
  await again.goto(`${mail}/drive?folder=abc#files`);
  await expect(again).toHaveURL(`${drive}/?folder=abc#files`);
  await again.goto(`${calendar}/setup?step=2`);
  await expect(again).toHaveURL(`${mail}/setup?step=2`);

  // Sign out on one origin ends the session on all three.
  await page.goto(`${calendar}/`);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${mail}/login`);
  await again.goto(`${drive}/`);
  await expect(again).toHaveURL(`${mail}/login`);
  const response = await page.request.get(`${drive}/api/auth/get-session`);
  expect(await response.json()).toBeNull();
});

test("the second factor is required before any sibling origin gets a session", async ({
  page,
}) => {
  await page.goto(`${drive}/?folder=projects`);
  await signIn(page, mfa);
  await expect(
    page.getByRole("heading", { name: "Verify your identity" }),
  ).toBeVisible();
  expect(page.url().startsWith(mail)).toBe(true);
  await page.getByLabel("Authenticator code").fill(totp(totpSecret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(`${drive}/?folder=projects`);
});

test("forged or replayed callbacks are refused", async ({ page }) => {
  await page.goto(
    `${calendar}/auth/callback#token=${"a".repeat(32)}&state=${"b".repeat(43)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Sign-in link expired" }),
  ).toBeVisible();
  expect(page.url()).toBe(`${calendar}/auth/callback`);
  await page.goto(
    `${mail}/auth/handoff?to=${encodeURIComponent("https://evil.example.test")}&state=${"c".repeat(43)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Could not continue" }),
  ).toBeVisible();
});

test("a single origin keeps path routing", async ({ page }) => {
  await page.goto(`${single}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${single}/mail`);
  await page.getByRole("link", { name: "Calendar" }).first().click();
  await expect(page).toHaveURL(`${single}/calendar`);
  await page.goto(`${single}/drive?folder=abc`);
  await expect(page).toHaveURL(`${single}/drive?folder=abc`);
});
