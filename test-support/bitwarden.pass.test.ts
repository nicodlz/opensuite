// Sequential requests are intentional for client state and rate-limit assertions.
/* oxlint-disable eslint/no-await-in-loop */
import { execFile } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
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

const run = promisify(execFile);
const id = randomBytes(5).toString("hex");
const project = `opensuite-bw-${id}`;
const octet = (randomBytes(1).readUInt8() % 200) + 20;
const env = {
  ...process.env,
  COMPOSE_PROFILES: "",
  HTTPS_PORT: "443",
  DRIVE_S3_ENDPOINT: "http://fixture.invalid",
  DRIVE_S3_PUBLIC_ENDPOINT: "http://fixture.invalid",
  DRIVE_S3_BUCKET: "fixture",
  DRIVE_S3_REGION: "fixture",
  DRIVE_S3_ACCESS_KEY: "fixture",
  DRIVE_S3_SECRET_FILE: "/dev/null",
  PASS_PUBLIC_HOST: "pass.localhost",
  PASS_ALLOW_SAVED_SIGNUPS: "false",
  PASS_TEST_API_SUBNET: `10.237.${octet}.0/24`,
  PASS_TEST_API_IP: `10.237.${octet}.2`,
  PASS_TEST_SUBNET: `10.238.${octet}.0/24`,
  PASS_TEST_DYNAMIC_RANGE: `10.238.${octet}.128/25`,
  PASS_TEST_PROXY_IP: `10.238.${octet}.2`,
  PASS_CADDY_IP: `10.238.${octet}.2`,
  PASS_TEST_DOMAIN: "https://pass.localhost",
  PASS_SIGNUPS_ALLOWED: "false",
  PASS_INVITATIONS_ALLOWED: "true",
  PASS_SMTP_HOST: "",
};
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--profile",
  "pass",
  "--env-file",
  "deploy/env.example",
  "-f",
  "compose.yaml",
  "-f",
  "compose.test.yaml",
  "-f",
  "test-support/pass-compose.yaml",
];
const compose = async (...args: string[]) =>
  (
    await run("docker", [...composeArgs, ...args], {
      env,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
const secret = () => randomBytes(24).toString("base64url");
const b64 = (b: Uint8Array) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "");
const adminPassword = secret();
const masterPassword = secret();
const emails = [`a-${id}@example.invalid`, `b-${id}@example.invalid`];
const marker = `pass-marker-${secret()}`;
const seed = randomBytes(20);
const seedBase32 =
  [...seed]
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("")
    .match(/.{5}/g)
    ?.map((bits) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(bits, 2)])
    .join("") ?? "";
let temp = "";
let origin = "";
let caPath = "";
let ca = "";
let direct = "";
let context: BrowserContext | undefined;
const sessions = ["", ""];
const homes = ["", ""];
let itemId = "";
let attachmentId = "";
let folderId = "";
let file = "";

async function bw(
  user: number,
  args: string[],
  session = sessions[user] ?? "",
) {
  try {
    const result = await run(
      resolve("node_modules/.bin/bw"),
      [...args, "--nointeraction"],
      {
        env: {
          ...process.env,
          BITWARDENCLI_APPDATA_DIR: homes[user],
          NODE_EXTRA_CA_CERTS: caPath,
          TEST_MASTER_PASSWORD: masterPassword,
          BW_SESSION: session,
          TMPDIR: temp,
        },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 90_000,
      },
    );
    return result.stdout.trim();
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.split("\n").slice(1).join("\n")
        : "unknown error";
    // Do not attach the original error: its command line can contain fixture plaintext.
    // oxlint-disable-next-line eslint/preserve-caught-error
    throw new Error(`bw ${args[0] ?? "command"} failed: ${detail}`);
  }
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
        servername: "pass.localhost",
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
async function cleanup() {
  try {
    await context?.close();
  } finally {
    context = undefined;
    try {
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
    } finally {
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
  context = await chromium.launchPersistentContext(
    join(temp, `browser-${index}`),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--ignore-certificate-errors-spki-list=${pin}`,
        "--host-resolver-rules=MAP pass.localhost 127.0.0.1",
      ],
      env: { ...process.env, TMPDIR: temp },
    },
  );
  context.setDefaultTimeout(90_000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (req) =>
    errors.push(
      `${new URL(req.url()).pathname}: ${req.failure()?.errorText ?? "request failed"}`,
    ),
  );
  // Concurrent Docker network creation can interrupt Chromium's initial asset
  // requests with ERR_NETWORK_CHANGED. Reload only that failed bootstrap,
  // before submitting any registration data.
  for (let attempt = 0; ; attempt++) {
    errors.length = 0;
    const initial = await page.goto(`${origin}/#/register`);
    try {
      await page.getByLabel("Email address").waitFor({ timeout: 15_000 });
      break;
    } catch (error) {
      if (
        attempt < 3 &&
        errors.some((message) => message.includes("ERR_NETWORK_CHANGED"))
      )
        continue;
      throw new Error(
        `Registration ${index} page ${initial?.status()}: ${errors.join("; ")}`,
        { cause: error },
      );
    }
  }
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator('input[type="password"]').nth(0).fill(masterPassword);
  await page.locator('input[type="password"]').nth(1).fill(masterPassword);
  await page.locator('input[type="checkbox"]').uncheck();
  await page.getByText("Strong", { exact: true }).waitFor({ timeout: 60_000 });
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
  await context.close();
  context = undefined;
}

describe("Bitwarden CLI against Pass", () => {
  beforeAll(async () => {
    try {
      temp = await mkdtemp(join(tmpdir(), "opensuite-pass-"));
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
      Object.assign(env, { PASS_ADMIN_TOKEN_FILE: adminFile });
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
      origin = `https://pass.localhost:${port}`;
      env.PASS_TEST_DOMAIN = origin;
      await compose("up", "-d", "--wait", "--wait-timeout", "180", "pass");
      direct = await getPort("pass", "8080");
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
            servername: "pass.localhost",
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
      file = join(temp, "attachment.bin");
      await writeFile(
        file,
        Buffer.concat([Buffer.from(marker), randomBytes(128)]),
        { mode: 0o600 },
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 480_000);
  afterAll(cleanup, 90_000);

  test("invited accounts log in and sync with signups closed", async () => {
    expect(
      (
        await request("/identity/accounts/register/send-verification-email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `uninvited-${id}@example.invalid` }),
        })
      ).status,
    ).toBe(400);
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

  test("login, TOTP, secure note, card, folder and favorite round trip", async () => {
    const folder = object(
      await bw(0, ["create", "folder", encoded({ name: `folder-${id}` })]),
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
    itemId = object(await bw(0, ["create", "item", encoded(login)])).id ?? "";
    await bw(0, [
      "create",
      "item",
      encoded({
        ...template,
        type: 2,
        name: `note-${id}`,
        notes: marker,
        secureNote: { type: 0 },
      }),
    ]);
    await bw(0, [
      "create",
      "item",
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
    ]);
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
    const output = join(temp, "download.bin");
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
    await compose("restart", "pass");
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "180",
      "pass",
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
    const output = join(temp, "restart-download.bin");
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
    const beforeFile = join(temp, "isolation-before.bin");
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
        join(temp, "denied"),
      ]),
    ).rejects.toThrow("failed");
    const data = z
      .record(z.string(), z.unknown())
      .parse(
        parseJson(await readFile(join(homes[1] ?? "", "data.json"), "utf8")),
      );
    const tokenEntry = Object.entries(data).find(
      ([key, value]) =>
        key.toLowerCase().includes("accesstoken") && typeof value === "string",
    );
    if (!tokenEntry || typeof tokenEntry[1] !== "string")
      throw new Error("CLI access token not found in test state");
    const headers = { authorization: `Bearer ${tokenEntry[1]}` };
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
    await bw(0, ["sync"]);
    expect(object(await bw(0, ["get", "item", itemId]))).toEqual(ownerBefore);
    const afterFile = join(temp, "isolation-after.bin");
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
  }, 120_000);

  test("plaintext marker is absent from database, Pass volume and logs", async () => {
    const dump = await compose(
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "opensuite",
      "-d",
      "opensuite_pass",
    );
    expect(dump).toContain(itemId);
    expect(dump).not.toContain(marker);
    const archive = await run(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "pass",
        "tar",
        "-C",
        "/data",
        "-cf",
        "-",
        ".",
      ],
      { env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(archive.stdout.includes(Buffer.from(marker))).toBe(false);
    for (const service of ["pass", "caddy"])
      expect(await compose("logs", "--no-color", service)).not.toContain(
        marker,
      );
  }, 120_000);

  test("edit, trash, restore, permanent delete and attachment deletion", async () => {
    const item = object(await bw(0, ["get", "item", itemId]));
    item.name = `edited-${id}`;
    await bw(0, ["edit", "item", itemId, encoded(item)]);
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

  test("file Send creation and receipt", async () => {
    const send = z
      .object({ accessUrl: z.string().url() })
      .parse(parseJson(await bw(0, ["send", "--file", file, "--raw"])));
    const link = send.accessUrl;
    const output = join(temp, "send-download.bin");
    await bw(1, ["receive", link, "--output", output]);
    expect(await readFile(output)).toEqual(await readFile(file));
  }, 120_000);

  test("login rate limit resists forged client IP headers", async () => {
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: "cli",
      password: secret(),
      scope: "api offline_access",
      username: emails[0] ?? "",
      device_identifier: id,
      device_name: "test",
      device_type: "8",
    }).toString();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const response = await request("/identity/connect/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-real-ip": `198.51.100.${i + 1}`,
          "x-forwarded-for": `203.0.113.${i + 1}`,
        },
        body,
      });
      statuses.push(response.status);
    }
    expect(statuses[0]).toBe(400);
    expect(statuses).toContain(429);
    expect(statuses.at(-1)).toBe(429);
  }, 120_000);
});
