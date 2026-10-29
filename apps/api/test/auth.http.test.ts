import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import { createDatabase, createMailboxStore } from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createIdentity } from "../src/auth/identity.ts";
import { buildServer } from "../src/server.ts";

const run = promisify(execFile);
const container = `opensuite-auth-test-${randomUUID().slice(0, 8)}`;
const origin = "https://suite.example.test";
let app: FastifyInstance | undefined;
let base: string;
let databaseUrl: string;
let disconnect = () => Promise.resolve();
const provisioned = new Set<string>();
const monotonicMs = () => performance.now();
const waitForDatabase = async (attempt: number): Promise<void> => {
  try {
    await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
  } catch {
    if (attempt === 0) throw new Error("PostgreSQL did not start");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    await waitForDatabase(attempt - 1);
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
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ]);
    await waitForDatabase(239);
    const port = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", container, "5432"])).stdout,
    )?.[1];
    if (port === undefined) throw new Error("PostgreSQL port unavailable");
    databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        maxBuffer: 4_000_000,
      },
    );
    const dbResult = createDatabase(databaseUrl);
    if (dbResult.isErr()) throw new Error(dbResult.error.message);
    const db = dbResult.value;
    disconnect = () => db.$disconnect();
    const identity = createIdentity({
      database: db,
      publicOrigin: origin,
      secret: "test-secret-at-least-32-characters-long",
      provision: (user) => {
        provisioned.add(user.id);
        return Promise.resolve();
      },
      mayStartSession: (userId) => Promise.resolve(provisioned.has(userId)),
    });
    app = await buildServer({
      config: { logLevel: "silent" },
      readiness: createReadinessService({
        probes: [],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs,
      }),
      monotonicMs,
      identity: { handler: identity.handler, publicOrigin: origin },
    });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
  } catch (error) {
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
    throw error;
  }
}, 240_000);

afterAll(async () => {
  try {
    await app?.close();
    await disconnect();
  } finally {
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
  }
}, 60_000);

const post = (
  path: string,
  body: object,
  cookie?: string,
  requestOrigin = origin,
) =>
  fetch(`${base}/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: requestOrigin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });

describe("identity over HTTP", () => {
  it("stores an encrypted mailbox credential and scopes it to its owner", async () => {
    const dbResult = createDatabase(databaseUrl);
    if (dbResult.isErr()) throw new Error(dbResult.error.message);
    const db = dbResult.value;
    try {
      await db.user.createMany({
        data: [
          { id: "mail-owner", name: "Owner", email: "owner@example.test" },
          { id: "mail-other", name: "Other", email: "other@example.test" },
        ],
      });
      const result = createMailboxStore(db, "ab".repeat(32));
      if (result.isErr()) throw new Error(result.error.message);
      const store = result.value;
      expect(
        (
          await store.create({
            userId: "mail-owner",
            accountId: "mailbox",
            address: "owner@example.test",
            credentialId: "credential",
            secret: "private-mail-secret",
          })
        ).isOk(),
      ).toBe(true);
      const row = await db.mailboxLink.findUniqueOrThrow({
        where: { userId: "mail-owner" },
      });
      expect(row.secret).not.toContain("private-mail-secret");
      expect((await store.getForOwner("mail-other", "mailbox")).isErr()).toBe(
        true,
      );
      const own = await store.getForOwner("mail-owner", "mailbox");
      expect(own.isOk() ? own.value.secret : undefined).toBe(
        "private-mail-secret",
      );
    } finally {
      await db.$disconnect();
    }
  });
  it("refuses a session if the provisioning gate has not passed", async () => {
    const data = {
      email: "unlinked@example.test",
      name: "Unlinked",
      password: "a-strong-test-password",
    };
    const signup = await post("sign-up/email", data);
    expect(signup.status).toBe(200);
    const created: unknown = await signup.json();
    const user = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(created).user;
    provisioned.delete(user.id);
    const login = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    expect(login.ok).toBe(false);
    expect(
      login.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("session_token=")),
    ).toBe(false);
  });
  it("signs up, signs in with a secure cookie, and rejects a foreign origin", async () => {
    const data = {
      email: "alice@example.test",
      name: "Alice",
      password: "a-strong-test-password",
    };
    const signup = await post("sign-up/email", data);
    expect(signup.status).toBe(200);
    expect(provisioned.size).toBe(1);
    const signIn = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    expect(signIn.status).toBe(200);
    const cookies = signIn.headers.getSetCookie().join("; ");
    expect(cookies).toMatch(/HttpOnly/i);
    expect(cookies).toMatch(/Secure/i);
    expect(cookies).toMatch(/SameSite=Lax/i);
    const rejected = await post(
      "sign-out",
      {},
      cookies,
      "https://evil.example.test",
    );
    expect(rejected.status).toBe(403);
    expect((await post("sign-out", {}, cookies)).status).toBe(200);
    const session = await fetch(`${base}/auth/get-session`, {
      headers: { cookie: cookies },
    });
    expect(await session.json()).toBeNull();
  });

  it("enrols TOTP, challenges sign-in, and accepts a backup code", async () => {
    const data = {
      email: "mfa@example.test",
      name: "MFA",
      password: "another-strong-password",
    };
    expect((await post("sign-up/email", data)).status).toBe(200);
    const signIn = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    const sessionCookie = signIn.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const enable = await post(
      "two-factor/enable",
      { password: data.password },
      sessionCookie,
    );
    expect(enable.status).toBe(200);
    const enrollment: unknown = await enable.json();
    const parsed = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()).min(1) })
      .parse(enrollment);
    const secret = new URL(parsed.totpURI).searchParams.get("secret");
    if (secret === null) throw new Error("TOTP secret missing");
    let bits = "";
    for (const character of secret.toUpperCase().replaceAll("=", "")) {
      const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
      if (index < 0) throw new Error("Invalid TOTP secret");
      bits += index.toString(2).padStart(5, "0");
    }
    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8)
      bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const digest = createHmac("sha1", Buffer.from(bytes))
      .update(counter)
      .digest();
    const offset = (digest.at(-1) ?? 0) & 15;
    const code = String(
      (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
    ).padStart(6, "0");
    const verification = await post(
      "two-factor/verify-totp",
      { code },
      sessionCookie,
    );
    expect(verification.status).toBe(200);
    const activeCookie = verification.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    await post("sign-out", {}, activeCookie);
    const challenge = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = challenge.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const backup = parsed.backupCodes[0];
    if (backup === undefined) throw new Error("Backup code missing");
    expect(
      (
        await post(
          "two-factor/verify-backup-code",
          { code: backup },
          challengeCookie,
        )
      ).status,
    ).toBe(200);
  });
});
