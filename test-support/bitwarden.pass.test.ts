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
import { createPassFixture } from "./pass-fixture.js";

const run = promisify(execFile);
const id = randomBytes(5).toString("hex");
const {
  env,
  args: composeArgs,
  compose,
  chooseSubnets,
} = createPassFixture("bw");
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
let privateDir = "";
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
  // Concurrent Docker network changes or a slow host can interrupt initial
  // asset loading. Retry only before submitting any registration data.
  for (let attempt = 0; ; attempt++) {
    errors.length = 0;
    try {
      if (attempt === 0) await page.goto(`${origin}/#/register`);
      else await page.reload();
      await page.getByLabel("Email address").waitFor({ timeout: 30_000 });
      break;
    } catch (error) {
      if (attempt < 3) continue;
      throw new Error(
        `Registration ${index} page failed to load: ${errors.join("; ")}`,
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
      await chooseSubnets();
      temp = await mkdtemp(join(tmpdir(), "opensuite-pass-"));
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
  }, 480_000);
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
    for (const service of ["pass", "caddy"])
      expect(await compose("logs", "--no-color", service)).not.toContain(
        marker,
      );
  }

  test("plaintext marker is absent from database, Pass volume and logs", async () => {
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
