// Sequential requests are intentional for client state and rate-limit assertions.
/* oxlint-disable eslint/no-await-in-loop */
import { execFile, spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { argon2id } from "@noble/hashes/argon2";
import { chromium, type BrowserContext } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { createVaultFixture } from "./vault-fixture.js";
import { captureVaultMail } from "./vault-smtp.js";

const run = promisify(execFile);
const id = randomBytes(5).toString("hex");
const {
  env,
  project,
  args: composeArgs,
  compose,
  chooseSubnets,
} = createVaultFixture("bw");
const secret = () => randomBytes(24).toString("base64url");
const b64 = (b: Uint8Array) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "");
const adminPassword = secret();
const masterPassword = secret();
const emails = [`a-${id}@example.invalid`, `b-${id}@example.invalid`];
const marker = `vault-marker-${secret()}`;
const seed = randomBytes(20);
const seedBase32 =
  [...seed]
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("")
    .match(/.{5}/g)
    ?.map((bits) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(bits, 2)])
    .join("") ?? "";
let temp = "";
let privateDir = "";
let origin = "";
let caPath = "";
let ca = "";
let direct = "";
let certificatePin = "";
let context: BrowserContext | undefined;
let smtp: Awaited<ReturnType<typeof captureVaultMail>> | undefined;
const sessions = ["", ""];
const homes = ["", ""];
let itemId = "";
let attachmentId = "";
let folderId = "";
let file = "";

async function bw(user: number, args: string[], stdin?: string) {
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      resolve("node_modules/.bin/bw"),
      [...args, "--nointeraction"],
      {
        env: {
          ...process.env,
          BITWARDENCLI_APPDATA_DIR: homes[user],
          NODE_EXTRA_CA_CERTS: caPath,
          TEST_MASTER_PASSWORD: masterPassword,
          BW_SESSION: sessions[user] ?? "",
          TMPDIR: temp,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 90_000,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code === 0)
        resolveResult(Buffer.concat(stdout).toString("utf8").trim());
      else
        reject(
          new Error(
            `bw ${args[0] ?? "command"} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
    child.stdin.end(stdin);
  });
}
const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");
const itemSchema = z
  .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    attachments: z.array(z.object({ id: z.string() }).passthrough()).nullish(),
    deletedDate: z.string().nullish(),
  })
  .passthrough();
const parseJson = (text: string): unknown => JSON.parse(text);
const object = (text: string) => itemSchema.parse(parseJson(text));
const request = (
  path: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  new Promise<{ status: number; body: string }>((resolveRequest, reject) => {
    const target = new URL(origin);
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: target.port,
        servername: "vault.localhost",
        ca,
        path,
        method: options.method ?? "GET",
        headers: { host: target.host, ...options.headers },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolveRequest({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
function codeAt(time: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const hmac = createHmac("sha1", seed).update(counter).digest();
  const offset = (hmac[19] ?? 0) & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
async function accessToken(user: number) {
  const data = z
    .record(z.string(), z.unknown())
    .parse(
      parseJson(await readFile(join(homes[user] ?? "", "data.json"), "utf8")),
    );
  const entry = Object.entries(data).find(
    ([key, value]) =>
      key.toLowerCase().includes("accesstoken") && typeof value === "string",
  );
  if (!entry || typeof entry[1] !== "string")
    throw new Error("CLI access token not found in test state");
  return entry[1];
}
async function cleanup() {
  try {
    await context?.close();
  } finally {
    context = undefined;
    try {
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
    } finally {
      await smtp?.close();
      smtp = undefined;
      if (temp) {
        await rm(temp, { recursive: true, force: true });
        temp = "";
      }
    }
  }
}

async function register(
  email: string,
  pin: string,
  index: number,
  cookie: string,
) {
  const invite = await fetch(`http://127.0.0.1:${direct}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ email }),
  });
  if (invite.status !== 200)
    throw new Error(`Admin invitation failed: ${invite.status}`);
  if (!smtp) throw new Error("SMTP capture is not running");
  // Registration may also have sent a welcome message for the previous user.
  let mail = await smtp.take();
  while (mail.subject !== "Join Esuno Vault") mail = await smtp.take();
  const recipients = Array.isArray(mail.to) ? mail.to : [mail.to];
  expect(recipients.map((recipient) => recipient?.text).join(", ")).toContain(
    email,
  );
  expect(mail.from?.text).toContain("Esuno Vault");
  expect(mail.text).toContain("Esuno Vault");
  expect(mail.html).toContain("Esuno Vault");
  // Preserve the upstream source-code URL; it is not a service-name label.
  const serviceText =
    `${mail.subject} ${mail.text ?? ""} ${mail.html || ""}`.replaceAll(
      "https://github.com/dani-garcia/vaultwarden",
      "",
    );
  expect(/vaultwarden|bitwarden/i.test(serviceText)).toBe(false);
  if (!mail.html || !mail.text)
    throw new Error("Invitation MIME parts missing");
  context = await chromium.launchPersistentContext(
    join(temp, `browser-${index}`),
    {
      channel: "chromium",
      headless: true,
      // The web vault is localized; the selectors below use English labels.
      locale: "en-US",
      args: [
        `--ignore-certificate-errors-spki-list=${pin}`,
        "--host-resolver-rules=MAP vault.localhost 127.0.0.1",
      ],
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
        LANGUAGE: "en",
        TMPDIR: temp,
      },
    },
  );
  context.setDefaultTimeout(90_000);
  const page = await context.newPage();
  await page.setContent(mail.html);
  const inviteUrl = await page.getByTestId("invite").getAttribute("href");
  if (!inviteUrl) throw new Error("Invitation link missing");
  expect(mail.text.includes(inviteUrl)).toBe(true);
  expect(new URL(inviteUrl).origin).toBe(origin);
  const logo = page.getByAltText("Esuno Vault");
  expect(new URL((await logo.getAttribute("src")) ?? "").pathname).toBe(
    "/esuno-vault/images/logo-white@2x.png",
  );
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(
      'img[alt="Esuno Vault"]',
    );
    return img?.complete && img.naturalWidth > 0;
  });
  const screenshots = process.env["VAULT_MAIL_SCREENSHOTS"];
  if (screenshots && index === 0) {
    await mkdir(screenshots, { recursive: true });
    // The rendered screenshot must not retain the disposable invitation token.
    await page.locator("a").evaluateAll((links) => {
      for (const link of links) link.removeAttribute("href");
    });
    await page.screenshot({ path: join(screenshots, "invitation.png") });
  }
  const errors: string[] = [];
  const consoleMessages: string[] = [];
  const bundleResponses: number[] = [];
  page.on("console", (message) =>
    consoleMessages.push(`${message.type()}: ${message.text()}`),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (/\/app\/main\.[^/]+\.js(?:\?|$)/.test(response.url()))
      bundleResponses.push(response.status());
  });
  page.on("requestfailed", (req) =>
    errors.push(
      `${new URL(req.url()).pathname}: ${req.failure()?.errorText ?? "request failed"}`,
    ),
  );
  const capture = async (name: string) => {
    const prefix = join(privateDir, `registration-${index}-${name}`);
    const url = page.url();
    const html = await page.content().catch(() => "<page unavailable>");
    await writeFile(`${prefix}.html`, html, { mode: 0o600 });
    await writeFile(
      `${prefix}.json`,
      JSON.stringify(
        { url, errors, bundleResponses, console: consoleMessages },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await page.screenshot({ path: `${prefix}.png` }).catch(() => undefined);
  };
  // Concurrent Docker network changes or a slow host can interrupt initial
  // asset loading. Retry only before submitting any registration data.
  for (let attempt = 0; ; attempt++) {
    errors.length = 0;
    bundleResponses.length = 0;
    try {
      if (attempt === 0) await page.goto(inviteUrl);
      else await page.reload();
      // The server's index is only a loading shell. Wait for its application
      // bundle before allowing extra time for Angular to render registration.
      await page.waitForFunction(
        () =>
          performance
            .getEntriesByType("resource")
            .some((entry) => /\/app\/main\.[^/]+\.js(?:\?|$)/.test(entry.name)),
        undefined,
        { timeout: 90_000 },
      );
      if (!bundleResponses.some((status) => status === 200 || status === 304))
        throw new Error(
          `Web vault bundle response: ${bundleResponses.join(", ")}`,
        );
      await page
        .locator('input[type="password"]')
        .first()
        .waitFor({ timeout: 120_000 });
      break;
    } catch (error) {
      await capture(String(attempt));
      if (attempt < 1) continue;
      throw new Error(
        `Registration ${index} page failed to load: ${errors.join("; ")}; bundle HTTP: ${bundleResponses.join(", ")}; console: ${consoleMessages.join("; ")}. Diagnostics captured in disposable test directory.`,
        { cause: error },
      );
    }
  }
  try {
    await page.locator('input[type="password"]').nth(0).fill(masterPassword);
    await page.locator('input[type="password"]').nth(1).fill(masterPassword);
    await page.locator('input[type="checkbox"]').uncheck();
    await page
      .getByText("Strong", { exact: true })
      .waitFor({ timeout: 60_000 });
    const registered = page.waitForResponse(
      (r) => r.url().endsWith("/identity/accounts/register/finish"),
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Create account" }).click();
    const response = await registered.catch(async () => {
      throw new Error(
        `Registration ${index} stalled: ${await page.locator("body").innerText()}; errors: ${errors.join("; ")}`,
      );
    });
    if (response.status() !== 200)
      throw new Error(`Registration failed: ${response.status()}`);
  } catch (error) {
    await capture("submit");
    throw error;
  }
  await context.close();
  context = undefined;
}

describe("Bitwarden CLI against Vault", () => {
  beforeAll(async () => {
    try {
      await chooseSubnets();
      temp = await mkdtemp(join(tmpdir(), "opensuite-vault-"));
      privateDir = join(temp, "private");
      await mkdir(privateDir, { mode: 0o700 });
      homes[0] = join(temp, "user-a");
      homes[1] = join(temp, "user-b");
      await Promise.all(homes.map((home) => mkdir(home, { mode: 0o700 })));
      // The container runs as UID 1000, which may differ from the test user.
      // The container reads the generated admin hash from this directory.
      await chmod(temp, 0o711);
      const salt = randomBytes(16);
      const hash = argon2id(adminPassword, salt, {
        t: 2,
        m: 19456,
        p: 1,
        dkLen: 32,
      });
      const adminFile = join(temp, "admin");
      await writeFile(
        adminFile,
        `$argon2id$v=19$m=19456,t=2,p=1$${b64(salt)}$${b64(hash)}`,
        { mode: 0o644 },
      );
      Object.assign(env, { VAULT_ADMIN_TOKEN_FILE: adminFile });
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "postgres",
        "caddy",
      );
      const getPort = async (service: string, port: string) =>
        /:(\d+)\s*$/.exec(await compose("port", service, port))?.[1] ?? "";
      const port = await getPort("caddy", "443");
      origin = `https://vault.localhost:${port}`;
      env.VAULT_TEST_DOMAIN = origin;
      const smtpHost = (
        await run("docker", [
          "network",
          "inspect",
          `${project}_pass-network`,
          "--format",
          "{{(index .IPAM.Config 0).Gateway}}",
        ])
      ).stdout.trim();
      smtp = await captureVaultMail(smtpHost);
      Object.assign(env, {
        VAULT_SMTP_HOST: smtpHost,
        VAULT_SMTP_PORT: String(smtp.port),
        VAULT_SMTP_FROM: "vault@example.invalid",
        VAULT_SMTP_SECURITY: "off",
      });
      await compose("up", "-d", "--wait", "--wait-timeout", "180", "vault");
      direct = await getPort("vault", "8080");
      ca = await compose(
        "exec",
        "-T",
        "caddy",
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      );
      caPath = join(temp, "ca.pem");
      await writeFile(caPath, ca);
      // Pin only the test certificate in Chromium, after validating its chain and hostname.
      const pin = await new Promise<string>((resolvePin, reject) => {
        const socket = connect(
          {
            host: "127.0.0.1",
            port: Number(port),
            servername: "vault.localhost",
            ca,
          },
          () => {
            const cert = new X509Certificate(socket.getPeerCertificate().raw);
            resolvePin(
              createHash("sha256")
                .update(cert.publicKey.export({ type: "spki", format: "der" }))
                .digest("base64"),
            );
            socket.end();
          },
        );
        socket.on("error", reject);
      });
      certificatePin = pin;
      const login = await fetch(`http://127.0.0.1:${direct}/admin/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: adminPassword }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      if (login.status !== 200 || !cookie)
        throw new Error("Admin login failed");
      await register(emails[0] ?? "", pin, 0, cookie);
      await register(emails[1] ?? "", pin, 1, cookie);
      file = join(privateDir, "attachment.bin");
      await writeFile(
        file,
        Buffer.concat([Buffer.from(marker), randomBytes(128)]),
        { mode: 0o600 },
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 960_000);
  afterAll(cleanup, 90_000);

  test("invited accounts log in and sync with signups closed", async () => {
    const registration = await request(
      "/identity/accounts/register/send-verification-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `uninvited-${id}@example.invalid` }),
      },
    );
    expect(registration.status).toBe(400);
    expect(registration.body).toContain("Registration not allowed");
    for (const user of [0, 1]) {
      await bw(user, ["config", "server", origin]);
      sessions[user] = await bw(user, [
        "login",
        emails[user] ?? "",
        "--passwordenv",
        "TEST_MASTER_PASSWORD",
        "--raw",
      ]);
      expect(sessions[user]).toBeTruthy();
      expect(await bw(user, ["sync"])).toContain("Syncing complete");
    }
  }, 180_000);

  test("Esuno web vault branding and login in both themes", async () => {
    const example = object(
      await bw(
        0,
        ["create", "item"],
        encoded({
          ...object(await bw(0, ["get", "template", "item"])),
          type: 1,
          name: "Example account",
          login: { username: "demo@example.invalid", password: "example-only" },
        }),
      ),
    );
    const screenshots = process.env["VAULT_BRAND_SCREENSHOTS"];
    if (screenshots) await mkdir(screenshots, { recursive: true });
    try {
      for (const theme of ["light", "dark"] as const) {
        context = await chromium.launchPersistentContext(
          join(temp, `brand-${theme}`),
          {
            channel: "chromium",
            headless: true,
            locale: "en-US",
            colorScheme: theme,
            viewport: { width: 1440, height: 900 },
            args: [
              `--ignore-certificate-errors-spki-list=${certificatePin}`,
              "--host-resolver-rules=MAP vault.localhost 127.0.0.1",
            ],
            env: {
              ...process.env,
              LANG: "en_US.UTF-8",
              LANGUAGE: "en",
              TMPDIR: temp,
            },
          },
        );
        context.setDefaultTimeout(90_000);
        const external: string[] = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) {
            external.push(url.origin + url.pathname);
            await route.abort();
          } else await route.continue();
        });
        const page = await context.newPage();
        const cssResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/css/vaultwarden.css",
        );
        const response = await page.goto(origin);
        expect(response?.status()).toBe(200);
        expect(response?.headers()["content-security-policy"]).toContain(
          "script-src 'self'",
        );
        const css = await (await cssResponse).text();
        expect(css).toMatch(/--esuno-violet:\s*#5630a8/);
        expect(css).toContain(".vw-sso-login");
        expect(css).toContain(".vw-passkey-login");
        await page.getByLabel("Email address").waitFor();
        expect(
          await page.getByRole("link", { name: "Create account" }).isVisible(),
        ).toBe(false);
        expect(css).toContain(".vw-signup-link");
        expect(await page.locator("html").getAttribute("class")).toContain(
          `theme_${theme}`,
        );
        expect(
          await page
            .locator("html")
            .evaluate((el) =>
              getComputedStyle(el)
                .getPropertyValue("--color-background-alt")
                .trim(),
            ),
        ).toBe(theme === "light" ? "246 244 248" : "10 7 16");
        const logo = theme === "light" ? "logo.svg" : "logo-white.svg";
        const logoPath = `/esuno-vault/images/${logo}?v=1`;
        expect(
          await page
            .locator('bit-landing-header bit-svg[aria-label="Bitwarden logo"]')
            .first()
            .evaluate((el) => getComputedStyle(el).content),
        ).toContain(logoPath);
        const favicon = await page
          .locator('link[rel="icon"][sizes="32x32"]')
          .getAttribute("href");
        expect(favicon).toBe("/esuno-vault/images/favicon-32x32.png?v=2");
        if (!favicon) throw new Error("Favicon link missing");
        for (const [url, fileName] of [
          [logoPath, logo],
          [favicon, "favicon-32x32.png"],
        ] as const) {
          const result = await page.evaluate(async (path) => {
            const fetched = await fetch(path);
            return {
              bytes: Array.from(new Uint8Array(await fetched.arrayBuffer())),
              cache: fetched.headers.get("cache-control"),
            };
          }, url);
          expect(Buffer.from(result.bytes)).toEqual(
            await readFile(
              join("deploy/vaultwarden/brand/esuno-vault/images", fileName),
            ),
          );
          expect(result.cache).toContain("no-cache");
        }
        const manifestHref = await page
          .locator('link[rel="manifest"]')
          .getAttribute("href");
        expect(manifestHref).toBe("/esuno-vault/manifest.json?v=2");
        const manifest = await page.evaluate(
          async (url) => (await fetch(url)).text(),
          manifestHref ?? "",
        );
        const app = z
          .object({
            name: z.string(),
            short_name: z.string(),
            icons: z.array(
              z.object({ sizes: z.string(), purpose: z.string() }),
            ),
          })
          .parse(JSON.parse(manifest));
        expect([app.name, app.short_name]).toEqual(["Esuno Vault", "Vault"]);
        expect(
          app.icons
            .map((entry) => `${entry.purpose} ${entry.sizes}`)
            .toSorted(),
        ).toEqual([
          "any 192x192",
          "any 512x512",
          "maskable 192x192",
          "maskable 512x512",
        ]);
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `login-${theme}.png`),
          });
        await page.getByLabel("Email address").fill(emails[0] ?? "");
        await page.getByRole("button", { name: "Continue" }).click();
        await page.locator('input[type="password"]').fill(masterPassword);
        await page.getByRole("button", { name: "Log in", exact: true }).click();
        const addLater = page.getByText("Add it later", { exact: true });
        const exampleItem = page.getByText("Example account", { exact: true });
        try {
          await addLater.or(exampleItem).first().waitFor({ timeout: 45_000 });
          if (await addLater.isVisible()) {
            await addLater.click();
            await page.getByRole("link", { name: "Skip to web app" }).click();
          }
          await exampleItem.waitFor();
          const skipTour = page.getByRole("button", {
            name: "Skip",
            exact: true,
          });
          if (await skipTour.isVisible()) await skipTour.click();
        } catch (error) {
          if (screenshots)
            await page.screenshot({
              path: join(screenshots, `login-error-${theme}.png`),
            });
          throw new Error(
            `Vault list did not load at ${page.url()}: ${await page.locator("body").innerText()}`,
            { cause: error },
          );
        }
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `vault-${theme}.png`),
          });
        expect(external).toEqual([]);
        await context.close();
        context = undefined;
      }
    } finally {
      await context?.close();
      context = undefined;
      if (example.id)
        await bw(0, ["delete", "item", example.id, "--permanent"]);
    }
  }, 360_000);

  test("login, TOTP, secure note, card, folder and favorite round trip", async () => {
    const folder = object(
      await bw(0, ["create", "folder"], encoded({ name: `folder-${id}` })),
    );
    folderId = folder.id ?? "";
    const template = object(await bw(0, ["get", "template", "item"]));
    const login = {
      ...template,
      type: 1,
      name: marker,
      notes: marker,
      favorite: true,
      folderId,
      login: {
        username: `user-${id}`,
        password: marker,
        uris: [{ match: null, uri: "https://example.invalid/login" }],
        totp: seedBase32,
      },
    };
    itemId = object(await bw(0, ["create", "item"], encoded(login))).id ?? "";
    await bw(
      0,
      ["create", "item"],
      encoded({
        ...template,
        type: 2,
        name: `note-${id}`,
        notes: marker,
        secureNote: { type: 0 },
      }),
    );
    await bw(
      0,
      ["create", "item"],
      encoded({
        ...template,
        type: 3,
        name: `card-${id}`,
        card: {
          cardholderName: "Test User",
          brand: "Visa",
          number: "4111111111111111",
          expMonth: "12",
          expYear: "2030",
          code: "123",
        },
      }),
    );
    await bw(0, ["sync"]);
    const got = object(await bw(0, ["get", "item", itemId]));
    expect(got).toMatchObject({
      name: marker,
      notes: marker,
      favorite: true,
      folderId,
      login: {
        password: marker,
        totp: seedBase32,
        uris: [{ uri: "https://example.invalid/login" }],
      },
    });
    const before = Date.now();
    const totp = await bw(0, ["get", "totp", itemId]);
    const after = Date.now();
    expect([codeAt(before), codeAt(after)]).toContain(totp);
    const items: unknown = JSON.parse(await bw(0, ["list", "items"]));
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 2, name: `note-${id}`, notes: marker }),
        expect.objectContaining({
          type: 3,
          name: `card-${id}`,
        }),
      ]),
    );
    expect(JSON.stringify(items)).toContain("4111111111111111");
    expect(object(await bw(0, ["get", "folder", folderId])).name).toBe(
      `folder-${id}`,
    );
  }, 240_000);

  test("attachment upload and byte-for-byte download", async () => {
    await bw(0, ["create", "attachment", "--file", file, "--itemid", itemId]);
    const item = object(await bw(0, ["get", "item", itemId]));
    attachmentId = item.attachments?.[0]?.id ?? "";
    const output = join(privateDir, "download.bin");
    await bw(0, [
      "get",
      "attachment",
      attachmentId,
      "--itemid",
      itemId,
      "--output",
      output,
    ]);
    expect(await readFile(output)).toEqual(await readFile(file));
  }, 120_000);

  test("encrypted data and attachment persist across restart and re-login", async () => {
    await bw(0, ["logout"]);
    sessions[0] = "";
    await compose("restart", "vault");
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "180",
      "vault",
    );
    sessions[0] = await bw(0, [
      "login",
      emails[0] ?? "",
      "--passwordenv",
      "TEST_MASTER_PASSWORD",
      "--raw",
    ]);
    await bw(0, ["sync"]);
    expect(object(await bw(0, ["get", "item", itemId])).name).toBe(marker);
    const output = join(privateDir, "restart-download.bin");
    await bw(0, [
      "get",
      "attachment",
      attachmentId,
      "--itemid",
      itemId,
      "--output",
      output,
    ]);
    expect(await readFile(output)).toEqual(await readFile(file));
  }, 240_000);

  test("second user cannot list or fetch the first user's item or attachment", async () => {
    const ownerBefore = object(await bw(0, ["get", "item", itemId]));
    const beforeFile = join(privateDir, "isolation-before.bin");
    await bw(0, [
      "get",
      "attachment",
      attachmentId,
      "--itemid",
      itemId,
      "--output",
      beforeFile,
    ]);
    expect(await readFile(beforeFile)).toEqual(await readFile(file));
    await bw(1, ["sync"]);
    expect(JSON.parse(await bw(1, ["list", "items"]))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: itemId })]),
    );
    await expect(bw(1, ["get", "item", itemId])).rejects.toThrow("failed");
    await expect(
      bw(1, [
        "get",
        "attachment",
        attachmentId,
        "--itemid",
        itemId,
        "--output",
        join(privateDir, "denied"),
      ]),
    ).rejects.toThrow("failed");
    const headers = { authorization: `Bearer ${await accessToken(1)}` };
    const ownerToken = await accessToken(0);
    const ownerRaw = await request(`/api/ciphers/${itemId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerRaw.status).toBe(200);
    const ownerId = z
      .object({ sub: z.string().uuid() })
      .parse(
        parseJson(
          Buffer.from(ownerToken.split(".")[1] ?? "", "base64url").toString(
            "utf8",
          ),
        ),
      ).sub;
    // The response omits the required encryptedFor field used in PUT requests.
    const updateBody = JSON.stringify({
      ...z.record(z.string(), z.unknown()).parse(parseJson(ownerRaw.body)),
      encryptedFor: ownerId,
    });
    const list = await request("/api/sync", { headers });
    expect(list.status).toBe(200);
    expect(list.body).not.toContain(itemId);
    const deniedItem = await request(`/api/ciphers/${itemId}`, { headers });
    const deniedAttachment = await request(
      `/api/ciphers/${itemId}/attachment/${attachmentId}`,
      { headers },
    );
    for (const [response, message] of [
      [deniedItem, "Cipher is not owned by user"],
      [deniedAttachment, "Cipher is not accessible"],
    ] as const) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.status).toBe(400);
      // Exact error shape excludes ciphertext, attachment URLs and item fields.
      expect(parseJson(response.body)).toEqual({
        message,
        validationErrors: { "": [message] },
        errorModel: { message, object: "error" },
        error: "",
        error_description: "",
        exceptionMessage: null,
        exceptionStackTrace: null,
        innerExceptionMessage: null,
        object: "error",
      });
    }
    const missing = await request(`/api/ciphers/${randomUUID()}`, { headers });
    expect(missing.status).toBe(400);
    expect(
      z.object({ message: z.string() }).parse(parseJson(missing.body)).message,
    ).toBe("Cipher doesn't exist");
    const forbiddenUpdate = await request(`/api/ciphers/${itemId}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: updateBody,
    });
    expect(forbiddenUpdate.status).toBe(400);
    expect(forbiddenUpdate.body).toContain("Cipher is not write accessible");
    for (const path of [
      `/api/ciphers/${itemId}`,
      `/api/ciphers/${itemId}/attachment/${attachmentId}`,
    ]) {
      for (const method of ["PUT", "DELETE"]) {
        const response = await request(path, {
          method,
          headers: { ...headers, "content-type": "application/json" },
          ...(method === "PUT" ? { body: updateBody } : {}),
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      }
    }
    await bw(0, ["sync"]);
    expect(object(await bw(0, ["get", "item", itemId]))).toEqual(ownerBefore);
    const afterFile = join(privateDir, "isolation-after.bin");
    await bw(0, [
      "get",
      "attachment",
      attachmentId,
      "--itemid",
      itemId,
      "--output",
      afterFile,
    ]);
    expect(await readFile(afterFile)).toEqual(await readFile(beforeFile));
  }, 180_000);

  // This helper groups assertions shared by the two storage checks.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  async function scanStorage(sendPath?: string) {
    const dump = await compose(
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "opensuite",
      "-d",
      "opensuite_vault",
    );
    expect(dump).toContain(itemId);
    expect(dump).not.toContain(marker);
    const archive = await run(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "vault",
        "tar",
        "-C",
        "/data",
        "-cf",
        "-",
        ".",
      ],
      { env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(
      archive.stdout.includes(
        Buffer.from(`attachments/${itemId}/${attachmentId}`),
      ),
    ).toBe(true);
    const paths = sendPath ? [sendPath] : [];
    expect(
      paths.every((path) => archive.stdout.includes(Buffer.from(path))),
    ).toBe(true);
    expect(archive.stdout.includes(Buffer.from(marker))).toBe(false);
    for (const service of ["vault", "caddy"])
      expect(await compose("logs", "--no-color", service)).not.toContain(
        marker,
      );
  }

  test("plaintext marker is absent from database, Vault volume and logs", async () => {
    expect(attachmentId).toBeTruthy();
    await scanStorage();
  }, 120_000);

  test("file Send creation and receipt", async () => {
    const send = z
      .object({
        accessUrl: z.string().url(),
        id: z.string(),
        file: z.object({ id: z.string() }),
      })
      .parse(parseJson(await bw(0, ["send", "--file", file, "--raw"])));
    const link = send.accessUrl;
    const output = join(privateDir, "send-download.bin");
    // bw receive requires a URL positional argument and offers no stdin option.
    // This disposable Send link and its key fragment are therefore visible in argv.
    await bw(1, ["receive", link, "--output", output]);
    expect(await readFile(output)).toEqual(await readFile(file));
    await scanStorage(`sends/${send.id}/${send.file.id}`);
  }, 180_000);

  test("edit, trash, restore, permanent delete and attachment deletion", async () => {
    const item = object(await bw(0, ["get", "item", itemId]));
    item.name = `edited-${id}`;
    await bw(0, ["edit", "item", itemId], encoded(item));
    expect(object(await bw(0, ["get", "item", itemId])).name).toBe(
      `edited-${id}`,
    );
    await bw(0, ["delete", "attachment", attachmentId, "--itemid", itemId]);
    expect(
      object(await bw(0, ["get", "item", itemId])).attachments ?? [],
    ).toHaveLength(0);
    await bw(0, ["delete", "item", itemId]);
    expect(
      object(await bw(0, ["get", "item", itemId])).deletedDate,
    ).toBeTruthy();
    await bw(0, ["restore", "item", itemId]);
    expect(
      object(await bw(0, ["get", "item", itemId])).deletedDate,
    ).toBeFalsy();
    await bw(0, ["delete", "item", itemId, "--permanent"]);
    await expect(bw(0, ["get", "item", itemId])).rejects.toThrow("failed");
  }, 180_000);
});
