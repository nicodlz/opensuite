import { execFile } from "node:child_process";
import { createECDH, createHmac, randomUUID } from "node:crypto";
import { createNotificationDispatcher } from "@opensuite/core/services/notifications";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import {
  createAccountStore,
  createPushStore,
  type PrismaClient,
  createDatabase,
} from "../packages/db/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { createIdentity } from "../apps/api/src/auth/identity.ts";
import { buildServer } from "../apps/api/src/server.ts";

// Real production bundle, real API and Better Auth on PostgreSQL, served on
// three *.localhost origins (secure contexts in Chromium) plus plain localhost.
const run = promisify(execFile);
const dist = "apps/web/dist";
const container = `opensuite-split-e2e-${randomUUID().slice(0, 8)}`;
let web: Server | undefined;
let api: Awaited<ReturnType<typeof buildServer>> | undefined;
let disconnect = () => Promise.resolve();
let pushDb: PrismaClient;
let mail = "";
let drive = "";
let calendar = "";
let single = "";
const user = { email: "split@example.test", password: "split-strong-password" };
const mfa = {
  email: "mfa-split@example.test",
  password: "mfa-strong-password",
};
const keyUser = {
  email: "key-split@example.test",
  password: "key-strong-password",
};
const totpUser = {
  email: "totp-ui@example.test",
  password: "totp-ui-strong-password",
};
let totpSecret = "";
let pushSession = "";
let issuePushSession = () => Promise.resolve("");

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
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
async function body(request: IncomingMessage) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request)
    if (chunk instanceof Uint8Array) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
/** Retries an asynchronous step until it succeeds or attempts run out. */
async function retry<T>(
  attempts: number,
  ms: number,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (attempts <= 1) throw error;
    await pause(ms);
    return retry(attempts - 1, ms, step);
  }
}
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
const monotonicMs = () => performance.now();
/** Stands in for Caddy: /api goes to the API, everything else to the SPA. */
async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  apiBase: () => string,
) {
  const url = new URL(request.url ?? "/", "http://placeholder");
  if (url.pathname.startsWith("/api/")) {
    // node:http without an agent: no idle keep-alive connection can hold
    // the API open at teardown.
    const target = new URL(`${url.pathname.slice(4)}${url.search}`, apiBase());
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => name !== "host" && name !== "connection",
      ),
    );
    const payload =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await body(request);
    await new Promise<void>((resolve, reject) => {
      const upstream = httpRequest(
        target,
        { method: request.method ?? "GET", headers, agent: false },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
          reply.on("end", resolve);
          reply.on("error", reject);
        },
      );
      upstream.on("error", reject);
      upstream.end(payload);
    });
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
    "content-security-policy":
      "default-src 'self'; connect-src 'self' https: http:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
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
  await retry(240, 500, () =>
    run("docker", ["exec", container, "pg_isready", "-U", "postgres"]),
  );
  const dbPort = /:(\d+)\s*$/.exec(
    (await run("docker", ["port", container, "5432"])).stdout,
  )?.[1];
  const databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${dbPort}/postgres`;
  await retry(10, 1000, () =>
    run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: databaseUrl } },
    ),
  );
  const database = createDatabase(databaseUrl);
  if (database.isErr()) throw new Error(database.error.message);
  const db = database.value;
  pushDb = db;
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
  await Promise.all(
    [user, mfa, keyUser, totpUser].map((account) =>
      identity.api.signUpEmail({ body: { ...account, name: "Split" } }),
    ),
  );
  // Enrol TOTP for the MFA account through the public handler.
  const call = async (path: string, payload: object, cookie = "") =>
    identity.handler(
      new Request(`${mail}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: mail, cookie },
        body: JSON.stringify(payload),
      }),
    );
  issuePushSession = async () => {
    const login = await call("sign-in/email", user);
    const cookie = login.headers
      .getSetCookie()
      .find((item) => item.startsWith("__Host-opensuite.session_token="));
    if (!cookie) throw new Error("Missing test session");
    return (
      cookie.slice("__Host-opensuite.session_token=".length).split(";")[0] ?? ""
    );
  };
  pushSession = await issuePushSession();
  const mfaCookie = cookieOf(await call("sign-in/email", mfa));
  const enrolment = z
    .object({ totpURI: z.string() })
    .parse(
      await (
        await call("two-factor/enable", { password: mfa.password }, mfaCookie)
      ).json(),
    );
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
  const pushStore = createPushStore(db);
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  api = await buildServer({
    push: {
      publicKey: vapid.getPublicKey().toString("base64url"),
      store: pushStore,
      dispatcher: createNotificationDispatcher(pushStore, {
        send: async () => {},
      }),
    },
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
        return actor.isOk() && actor.value !== null
          ? { ...actor.value, sessionId: session.session.id }
          : null;
      },
      audit: () => Promise.resolve(),
    },
  });
  apiBase = await api.listen({ host: "127.0.0.1", port: 0 });
});
const timed = async (label: string, step: () => Promise<unknown>) => {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    step().then(() => "done"),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timed out"), 15_000);
    }),
  ]);
  clearTimeout(timer);
  process.stderr.write(
    `split-origins teardown ${label}: ${outcome} after ${Math.round(performance.now() - started)} ms\n`,
  );
};
test.afterAll(async () => {
  // Close the browser-facing server first so the API sees no new requests.
  await timed("web", async () => {
    await new Promise<void>((resolve) => {
      if (web === undefined) resolve();
      else {
        // Browsers keep connections alive; close() alone waits for them.
        web.close(() => resolve());
        web.closeAllConnections();
      }
    });
  });
  await timed("api", async () => api?.close());
  await timed("database", disconnect);
  await timed("container", () =>
    run("docker", ["rm", "-f", container]).catch(() => undefined),
  );
});

const isSignIn = (response: {
  url(): string;
  request(): { method(): string };
}) =>
  response.url().endsWith("/api/auth/sign-in/email") &&
  response.request().method() === "POST";

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

for (const [product, label, startUrl] of [
  ["mail", "Mail", "/mail"],
  ["drive", "Drive", "/"],
  ["calendar", "Calendar", "/"],
] as const) {
  test(`${label} origin supplies its installable app metadata`, async ({
    page,
  }) => {
    const origin = { mail, drive, calendar }[product];
    const violations: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text().includes("Content Security Policy")
      )
        violations.push(message.text());
    });
    // This public route stays on the product origin without a session.
    await page.goto(`${origin}/auth/callback`);
    const links = [
      [
        'link[rel="icon"][type="image/svg+xml"]',
        `/icons/${product}-favicon.svg`,
        "image/svg+xml",
      ],
      [
        'link[rel="icon"][type="image/png"]',
        `/icons/${product}-32.png`,
        "image/png",
      ],
      [
        'link[rel="apple-touch-icon"]',
        `/icons/${product}-180.png`,
        "image/png",
      ],
    ] as const;
    await Promise.all(
      links.map(async ([selector, href, contentType]) => {
        await expect(page.locator(selector)).toHaveAttribute("href", href);
        const response = await page.request.get(`${origin}${href}`);
        expect(response.status()).toBe(200);
        expect(response.headers()["content-type"]).toContain(contentType);
      }),
    );
    const manifestPath = `/manifest-${product}.webmanifest`;
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      manifestPath,
    );
    const response = await page.request.get(`${origin}${manifestPath}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(
      "application/manifest+json",
    );
    const manifest = z
      .object({
        icons: z.array(
          z.object({
            src: z.string(),
            sizes: z.string(),
            type: z.string(),
            purpose: z.string(),
          }),
        ),
      })
      .passthrough()
      .parse(await response.json());
    expect(manifest).toMatchObject({
      name: `Esuno ${label}`,
      short_name: label,
      start_url: startUrl,
      scope: "/",
      display: "standalone",
      theme_color: "#1c1427",
      background_color: "#1c1427",
      icons: [
        {
          src: `/icons/${product}-192.png`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `/icons/${product}-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `/icons/${product}-maskable-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    });
    await Promise.all(
      manifest.icons.map(async (icon) => {
        const image = await page.request.get(`${origin}${icon.src}`);
        expect(image.status()).toBe(200);
        expect(image.headers()["content-type"]).toContain("image/png");
        const png = await image.body();
        expect(png.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        const size = Number(icon.sizes.split("x")[0]);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
          size,
          size,
        ]);
      }),
    );
    await expect(
      page.getByRole("heading", { name: "Sign-in link expired" }),
    ).toBeVisible();
    expect(violations).toEqual([]);
  });
}

test("single-origin and unavailable origin maps default to Mail metadata", async ({
  page,
}) => {
  await page.goto(`${single}/auth/callback`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest-mail.webmanifest",
  );
  await page.route("**/api/origins", (route) => route.abort());
  await page.goto(`${drive}/auth/callback`);
  await expect(
    page.getByRole("heading", { name: "Sign-in link expired" }),
  ).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest-mail.webmanifest",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/mail-180.png",
  );
});

test("sign in once on mail, then reach calendar and drive at their root", async ({
  page,
  context,
}) => {
  const urls = visited(page);
  await page.goto(`${calendar}/?view=week#today`);
  await signIn(page, user);
  await expect(page).toHaveURL(`${calendar}/?view=week`);
  await expect(
    page
      .getByRole("navigation", { name: "Products" })
      .getByRole("link", { name: "Mail" }),
  ).toHaveAttribute("href", `${mail}/`);
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
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Drive" })
    .click();
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

test("a security key is registered and used as a second factor against the real API", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: false,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await page.goto(`${mail}/login`);
  await signIn(page, keyUser);
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  await page.getByLabel("Current password").fill(keyUser.password);
  await page.getByLabel("Security key name").fill("USB key");
  await page.getByRole("button", { name: "Add security key" }).click();
  await expect(
    page.getByText("Save these new backup codes somewhere safe.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/USB key — Added/)).toBeVisible();
  await page.getByLabel("Current password").fill(keyUser.password);
  await page.getByLabel("Security key name").fill("Duplicate");
  await page.getByRole("button", { name: "Add security key" }).click();
  await expect(page.getByRole("alert")).toContainText("already registered");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await signIn(page, keyUser);
  await expect(
    page.getByRole("heading", { name: "Verify your identity" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use security key" }).click();
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await cdp.send("WebAuthn.disable");
});

test("security-key enrollment from Drive opens the sign-in origin security panel", async ({
  page,
}) => {
  await page.goto(`${drive}/`);
  await signIn(page, user);
  await expect(page).toHaveURL(`${drive}/`);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  const link = page.getByRole("link", {
    name: "Add security key on the sign-in address",
  });
  await expect(link).toHaveAttribute("href", `${mail}/mail?security=1`);
  await link.click();
  await expect(
    page.getByRole("dialog", { name: "Account security" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add security key" }),
  ).toBeVisible();
});

test("closing account security discards a late enrollment response", async ({
  page,
}) => {
  await page.goto(`${mail}/login`);
  await signIn(page, user);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  await page.getByLabel("Current password").fill(user.password);
  const gate = Promise.withResolvers<void>();
  await page.route("**/api/auth/two-factor/enable", async (route) => {
    await gate.promise;
    await route.fulfill({
      json: {
        totpURI:
          "otpauth://totp/Esuno:test@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Esuno",
        backupCodes: ["late-secret"],
      },
    });
  });
  const requested = page.waitForRequest("**/api/auth/two-factor/enable");
  await page
    .getByRole("button", { name: "Set up two-factor authentication" })
    .click();
  await requested;
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  const response = page.waitForResponse("**/api/auth/two-factor/enable");
  gate.resolve();
  await response;
  await expect(page.getByText("late-secret")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set up two-factor authentication" }),
  ).toBeVisible();
});

test("a failed challenge-method lookup offers a retry before showing choices", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/auth/two-factor/methods", async (route) => {
    requests++;
    if (requests === 1)
      await route.fulfill({ status: 503, json: { message: "unavailable" } });
    else await route.continue();
  });
  await page.goto(`${mail}/login`);
  await signIn(page, mfa);
  await expect(
    page.getByRole("button", { name: "Retry loading verification methods" }),
  ).toBeVisible();
  await expect(page.getByLabel("Authenticator code")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry loading verification methods" })
    .click();
  await expect(page.getByLabel("Authenticator code")).toBeVisible();
});

test("the real API enrols an authenticator from the displayed QR secret", async ({
  page,
}) => {
  await page.goto(`${mail}/login`);
  await signIn(page, totpUser);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  await page.getByLabel("Current password").fill(totpUser.password);
  await page
    .getByRole("button", { name: "Set up two-factor authentication" })
    .click();
  await expect(
    page.locator('svg[aria-label="Authenticator setup QR code"]'),
  ).toBeVisible();
  const qr = page.getByRole("img", { name: "Authenticator setup QR code" });
  await expect(qr.locator("path").first()).toHaveAttribute("fill", "#FFFFFF");
  await expect(qr.locator("path").nth(1)).toHaveAttribute("d", /^M4[ ,]4/);
  const secret = await page.locator("code.auth-secret").first().textContent();
  if (!secret) throw new Error("Missing authenticator secret");
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Confirm setup" }).click();
  await expect(page.getByRole("status")).toContainText("enabled");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await signIn(page, totpUser);
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
});

test("an MFA account signs out on calendar and signs in again with its password", async ({
  page,
}) => {
  await page.goto(`${calendar}/`);
  const first = page.waitForResponse(isSignIn);
  await signIn(page, mfa);
  expect((await first).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Verify your identity" }),
  ).toBeVisible();
  await page.getByLabel("Authenticator code").fill(totp(totpSecret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(`${calendar}/`);

  // Answer the move to mail with 204 so the browser stays on calendar's
  // /login document: it must show no form there.
  await page.route(`${mail}/login`, (route) => route.fulfill({ status: 204 }));
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("Redirecting to sign-in…");
  await expect(page.getByLabel("Email")).toHaveCount(0);
  expect(page.url()).toBe(`${calendar}/login`);
  await page.unrouteAll({ behavior: "wait" });
  await page.goto(`${mail}/login`);

  // Same browser, same password: the second factor is asked again.
  const second = page.waitForResponse(isSignIn);
  await signIn(page, mfa);
  const response = await second;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
  await expect(
    page.getByRole("heading", { name: "Verify your identity" }),
  ).toBeVisible();
});

test("a lazy page chunk that fails once is reloaded on the production build", async ({
  page,
}) => {
  await page.goto(`${single}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${single}/mail`);
  let aborted = 0;
  await page.route("**/assets/drive-page-*.js", async (route) => {
    if (aborted === 0) {
      aborted += 1;
      await route.abort("internetdisconnected");
    } else await route.continue();
  });
  await page.goto(`${single}/drive`);
  await expect(
    page.getByRole("navigation", { name: "Products" }).getByRole("link", {
      name: "Calendar",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^New$/ })).toBeVisible();
  expect(aborted).toBe(1);
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

/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, typescript/no-non-null-assertion, typescript/require-await, eslint/no-await-in-loop, unicorn/consistent-function-scoping */
// Chromium has no push service credentials in this test environment. The browser
// subscription API is stubbed; the API, database, worker and notification UI are real.
for (const product of ["mail", "calendar", "drive"] as const) {
  test(`${product} notification opt-in and worker delivery`, async ({
    page,
    context,
  }) => {
    const origin = { mail, calendar, drive }[product];
    await context.grantPermissions(["notifications"], { origin });
    await page.addInitScript(() => {
      let current: PushSubscription | null = null;
      PushManager.prototype.getSubscription = async () => current;
      PushManager.prototype.subscribe = async () => {
        const endpoint = `https://fcm.googleapis.com/e2e-${location.hostname}-${crypto.randomUUID()}`;
        current = {
          endpoint,
          expirationTime: null,
          options: {} as PushSubscriptionOptions,
          getKey: () => null,
          toJSON: () => ({
            endpoint,
            keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
          }),
          unsubscribe: async () => {
            current = null;
            return true;
          },
        };
        return current;
      };
    });
    await context.addCookies([
      {
        name: "__Host-opensuite.session_token",
        value: pushSession,
        url: origin.replace("http:", "https:"),
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto(`${origin}/`);
    await expect(page).toHaveURL(`${origin}/`);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await expect(page.getByText("Status: on")).toBeVisible();
    const saved = await pushDb.pushSubscription.findFirst({
      where: { product, user: { email: user.email } },
    });
    expect(saved?.endpoint).toContain(`e2e-${product}.localhost`);

    const cdp = await context.newCDPSession(page);
    const registrations: { registrationId: string; scopeURL: string }[] = [];
    cdp.on(
      "ServiceWorker.workerRegistrationUpdated",
      (event: {
        registrations: { registrationId: string; scopeURL: string }[];
      }) => registrations.push(...event.registrations),
    );
    await cdp.send("ServiceWorker.enable");
    await expect
      .poll(
        () =>
          registrations.find((entry) => entry.scopeURL === `${origin}/`)
            ?.registrationId,
      )
      .toBeTruthy();
    const id = registrations.find(
      (entry) => entry.scopeURL === `${origin}/`,
    )!.registrationId;
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId: id,
      data: JSON.stringify({
        title: "Push test",
        body: "Delivered",
        url: product === "drive" ? "//evil.example/" : "/?from=push",
        tag: `e2e-${product}`,
      }),
    });
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await (await navigator.serviceWorker.ready).getNotifications()).map(
            (item) => ({
              title: item.title,
              body: item.body,
              tag: item.tag,
              icon: item.icon,
            }),
          ),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Push test",
            body: "Delivered",
            tag: `e2e-${product}`,
            icon: `${origin}/icons/${product}-192.png`,
          }),
        ]),
      );
    // Dispatch a click to the actual worker, using its real notification object.
    await expect
      .poll(() =>
        context
          .serviceWorkers()
          .find((worker) => worker.url().startsWith(`${origin}/push-sw-v1.js`)),
      )
      .toBeTruthy();
    const worker = context
      .serviceWorkers()
      .find((item) => item.url().startsWith(`${origin}/push-sw-v1.js`))!;
    await worker.evaluate(async () => {
      const sw = globalThis as unknown as {
        registration: ServiceWorkerRegistration;
        dispatchEvent(event: Event): boolean;
      };
      const notification = (await sw.registration.getNotifications())[0]!;
      const pending: Promise<unknown>[] = [];
      const event = new Event("notificationclick");
      Object.defineProperties(event, {
        notification: { value: notification },
        waitUntil: {
          value: (promise: Promise<unknown>) => pending.push(promise),
        },
      });
      sw.dispatchEvent(event);
      // A synthetic click has no browser user activation, so Chromium rejects
      // focus after navigation; a real notification click has activation.
      await Promise.all(pending).catch((error: unknown) => {
        if (
          !(error instanceof DOMException) ||
          error.name !== "InvalidAccessError"
        )
          throw error;
      });
    });
    await expect(page).toHaveURL(
      product === "drive" ? `${origin}/` : `${origin}/?from=push`,
    );
    await cdp.detach();
  });
}

test("sign-out removes the current session's subscriptions across origins", async ({
  page,
  context,
}) => {
  for (const origin of [mail, calendar])
    await context.grantPermissions(["notifications"], { origin });
  await page.addInitScript(() => {
    function make(endpoint: string): PushSubscription {
      return {
        endpoint,
        expirationTime: null,
        options: {} as PushSubscriptionOptions,
        getKey: () => null,
        toJSON: () => ({
          endpoint,
          keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
        }),
        unsubscribe: async () => {
          localStorage.removeItem("mock-push-endpoint");
          return true;
        },
      };
    }
    PushManager.prototype.getSubscription = async () => {
      const endpoint = localStorage.getItem("mock-push-endpoint");
      return endpoint ? make(endpoint) : null;
    };
    PushManager.prototype.subscribe = async () => {
      const endpoint = `https://fcm.googleapis.com/logout-${location.hostname}-${crypto.randomUUID()}`;
      localStorage.setItem("mock-push-endpoint", endpoint);
      return make(endpoint);
    };
  });
  const session = await issuePushSession();
  await context.addCookies(
    [mail, calendar].map((origin) => ({
      name: "__Host-opensuite.session_token",
      value: session,
      url: origin.replace("http:", "https:"),
      secure: true,
      httpOnly: true,
      sameSite: "Lax" as const,
    })),
  );
  const endpoints: string[] = [];
  for (const origin of [calendar, mail]) {
    await page.goto(`${origin}/`);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Notification settings" }).click();
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await expect(page.getByText("Status: on")).toBeVisible();
    const endpoint = await page.evaluate(() =>
      localStorage.getItem("mock-push-endpoint"),
    );
    if (!endpoint) throw new Error("missing endpoint");
    endpoints.push(endpoint);
    await page.getByRole("button", { name: "Close dialog" }).click();
  }
  expect(
    await pushDb.pushSubscription.count({
      where: { endpoint: { in: endpoints } },
    }),
  ).toBe(2);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${mail}/login`);
  expect(
    await pushDb.pushSubscription.count({
      where: { endpoint: { in: endpoints } },
    }),
  ).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("mock-push-endpoint")),
  ).toBeNull();
});
