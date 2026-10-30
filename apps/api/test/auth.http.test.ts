import { execFile } from "node:child_process";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import {
  configureApplicationRole,
  createAccountStore,
  createDatabase,
  createMailboxStore,
} from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { err } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createIdentity } from "../src/auth/identity.ts";
import { buildServer } from "../src/server.ts";

const run = promisify(execFile);
const container = `opensuite-auth-test-${randomUUID().slice(0, 8)}`;
const origin = "https://suite.example.test";
const calendarOrigin = "https://calendar.example.test";
let app: FastifyInstance | undefined;
let base: string;
let databaseUrl: string;
let adminCookie = "";
let directSignupStatus = 0;
let directSignupUsers = -1;
let directSignUp: (account: {
  email: string;
  name: string;
  password: string;
}) => Promise<unknown>;
let directHandler: (request: Request) => Promise<Response>;
let disconnect = () => Promise.resolve();
const provisioned = new Set<string>();
const resolved = () => Promise.resolve();
const monotonicMs = () => performance.now();
const waitForDatabase = async (attempt: number): Promise<void> => {
  try {
    await run("docker", [
      "exec",
      "-e",
      "PGPASSWORD=test-password",
      container,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      "SELECT 1",
    ]);
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
      "-e",
      "POSTGRES_INITDB_ARGS=--no-sync",
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
      trustedOrigins: [calendarOrigin],
      secret: "test-secret-at-least-32-characters-long",
      provision: (user) => {
        provisioned.add(user.id);
        return Promise.resolve();
      },
      mayStartSession: (userId) => Promise.resolve(provisioned.has(userId)),
    });
    directSignUp = (account) => identity.api.signUpEmail({ body: account });
    directHandler = identity.handler;
    const direct = await identity.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          name: "Unauthorized",
          email: "unauthorized@example.test",
          password: "long-test-password",
        }),
      }),
    );
    directSignupStatus = direct.status;
    directSignupUsers = await db.user.count();
    const seed = await identity.api.signUpEmail({
      body: {
        name: "Operator",
        email: "operator@example.test",
        password: "operator-test-password",
      },
    });
    await db.user.update({
      where: { id: seed.user.id },
      data: { role: "admin" },
    });
    const accounts = createAccountStore(db);
    app = await buildServer({
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
        publicOrigin: origin,
        trustedOrigins: [origin, calendarOrigin],
        productOrigins: { mail: origin, calendar: calendarOrigin },
        actor: async (headers) => {
          const session = await identity.api.getSession({ headers });
          if (session === null) return null;
          const actor = await accounts.actor(session.user.id);
          return actor.isOk() ? actor.value : null;
        },
        userIdForEmail: async (email) => {
          const result = await accounts.userIdForEmail(email);
          if (result.isErr()) throw new Error("account lookup failed");
          return result.value;
        },
        audit: async (event) => {
          const result = await accounts.audit(event);
          if (result.isErr()) throw new Error("audit failed");
        },
      },
      accounts: {
        mailbox: async (actor, accountId) => accounts.mailbox(actor, accountId),
        list: async (actor) => accounts.list(actor),
        disable: () =>
          Promise.resolve(
            err({ kind: "unavailable", message: "not configured" }),
          ),
      },
    });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await fetch(`${base}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: "operator@example.test",
        password: "operator-test-password",
      }),
    });
    adminCookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
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
}, 240_000);

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
      ...((cookie ?? (path === "sign-up/email" ? adminCookie : undefined)) ===
      undefined
        ? {}
        : { cookie: cookie ?? adminCookie }),
    },
    body: JSON.stringify(body),
  });

const directPost = (path: string, body: object, cookie: string) =>
  directHandler(
    new Request(`${origin}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify(body),
    }),
  );
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
const totp = (uri: string) => {
  const secret = new URL(uri).searchParams.get("secret");
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
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
};

const cborBytes = (value: Buffer) =>
  Buffer.concat([Buffer.from([0x58, value.length]), value]);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest();
const client = (type: string, challenge: string) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
// A minimal software authenticator: P-256, attestation "none", and signed assertions.
function softwareKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Missing public coordinates");
  const id = randomBytes(32);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const cose = Buffer.concat([
    Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21]),
    cborBytes(x),
    Buffer.from([0x22]),
    cborBytes(y),
  ]);
  return {
    id: id.toString("base64url"),
    registration(challenge: string) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        hash(new URL(origin).hostname),
        Buffer.from([0x41, 0, 0, 0, 0]),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      const encodedAuth =
        authData.length < 256
          ? cborBytes(authData)
          : Buffer.concat([
              Buffer.from([0x59, authData.length >> 8, authData.length & 255]),
              authData,
            ]);
      const attestation = Buffer.concat([
        Buffer.from(
          "a363666d74646e6f6e656761747453746d74a0686175746844617461",
          "hex",
        ),
        encodedAuth,
      ]);
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: client("webauthn.create", challenge).toString(
            "base64url",
          ),
          attestationObject: attestation.toString("base64url"),
          transports: ["usb"],
        },
        clientExtensionResults: {},
      };
    },
    assertion(
      challenge: string,
      counter: number,
      options: {
        origin?: string;
        rp?: string;
        type?: string;
        forged?: boolean;
      } = {},
    ) {
      const clientData = Buffer.from(
        JSON.stringify({
          type: options.type ?? "webauthn.get",
          challenge,
          origin: options.origin ?? origin,
          crossOrigin: false,
        }),
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([
        hash(options.rp ?? new URL(origin).hostname),
        Buffer.from([1]),
        count,
      ]);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, hash(clientData)]),
        pair.privateKey,
      );
      if (options.forged)
        signature[signature.length - 1] = (signature.at(-1) ?? 0) ^ 1;
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
  };
}
const sessionOf = async (cookie: string) =>
  (await fetch(`${base}/auth/get-session`, { headers: { cookie } })).json();
const handoff = (
  cookie: string,
  requestOrigin = origin,
  target = calendarOrigin,
) =>
  fetch(`${base}/session/handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: requestOrigin,
      cookie,
    },
    body: JSON.stringify({ target }),
  });

describe("sign-in handoff to sibling application origins", () => {
  it("issues origin-bound single-use tokens and shares sign-out", async () => {
    const data = {
      email: "handoff@example.test",
      name: "Handoff",
      password: "handoff-strong-password",
    };
    expect((await post("sign-up/email", data)).status).toBe(200);
    const hubCookie = cookieOf(
      await post("sign-in/email", {
        email: data.email,
        password: data.password,
      }),
    );
    expect(hubCookie).toContain("session_token");

    // Only the sign-in origin issues, only for a listed sibling, only when signed in.
    expect((await handoff(hubCookie, calendarOrigin)).status).toBe(403);
    expect(
      (await handoff(hubCookie, origin, "https://evil.example.test")).status,
    ).toBe(400);
    expect((await handoff(hubCookie, origin, origin)).status).toBe(400);
    expect((await handoff("", origin)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/auth/one-time-token/generate`, {
          headers: { cookie: hubCookie },
        })
      ).status,
    ).toBe(404);

    const issued = await handoff(hubCookie);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const { token } = z
      .object({ token: z.string() })
      .parse(await issued.json());

    // Redemption from any other origin fails and burns the token.
    const stolen = await post("one-time-token/verify", { token }, "", origin);
    expect(stolen.status).toBe(400);
    expect(
      (await post("one-time-token/verify", { token }, "", calendarOrigin))
        .status,
    ).toBe(400);

    const fresh = z
      .object({ token: z.string() })
      .parse(await (await handoff(hubCookie)).json()).token;
    const redeemed = await post(
      "one-time-token/verify",
      { token: fresh },
      "",
      calendarOrigin,
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ success: true });
    const setCookie = redeemed.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    const calendarCookie = cookieOf(redeemed);
    expect(await sessionOf(calendarCookie)).toMatchObject({
      user: { email: data.email },
    });
    // Replay is refused.
    expect(
      (
        await post(
          "one-time-token/verify",
          { token: fresh },
          "",
          calendarOrigin,
        )
      ).status,
    ).toBe(400);

    // Signing out on one origin revokes the session everywhere.
    expect(
      (await post("sign-out", {}, calendarCookie, calendarOrigin)).status,
    ).toBe(200);
    expect(await sessionOf(hubCookie)).toBeNull();
    expect(await sessionOf(calendarCookie)).toBeNull();
    expect((await handoff(hubCookie)).status).toBe(401);
  });

  it("expires unused tokens", async () => {
    const { createHandoffRegistry } = await import("../src/auth/handoff.ts");
    let clock = 0;
    const registry = createHandoffRegistry(() => clock, 60_000);
    registry.bind("token-a", calendarOrigin);
    clock = 60_001;
    expect(registry.consume("token-a", calendarOrigin)).toBe(false);
    registry.bind("token-b", calendarOrigin);
    expect(registry.consume("token-b", calendarOrigin)).toBe(true);
    expect(registry.consume("token-b", calendarOrigin)).toBe(false);
  });
});

describe("cookie isolation from sibling subdomains", () => {
  it("uses __Host- cookies and ignores or refuses planted cookies", async () => {
    const victim = {
      email: "victim@example.test",
      name: "Victim",
      password: "victim-strong-password",
    };
    const attacker = {
      email: "attacker@example.test",
      name: "Attacker",
      password: "attacker-strong-password",
    };
    const signups = await Promise.all(
      [victim, attacker].map((account) => post("sign-up/email", account)),
    );
    expect(signups.map((response) => response.status)).toEqual([200, 200]);
    const signIn = await post("sign-in/email", {
      email: victim.email,
      password: victim.password,
    });
    const raw = signIn.headers.getSetCookie();
    expect(raw.length).toBeGreaterThan(0);
    for (const cookie of raw) {
      // RFC 6265bis 4.1.3.2: __Host- requires Secure, Path=/ and no Domain.
      expect(cookie).toMatch(/^__Host-opensuite\./);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    const victimCookie = cookieOf(signIn);
    const attackerCookie = cookieOf(
      await post("sign-in/email", {
        email: attacker.email,
        password: attacker.password,
      }),
    );
    const attackerValue = attackerCookie.split("=").slice(1).join("=");

    // A parent-domain cookie can only use another name; it is ignored.
    const planted = `__Secure-better-auth.session_token=${attackerValue}`;
    expect(await sessionOf(planted)).toBeNull();
    expect(await sessionOf(`${planted}; ${victimCookie}`)).toMatchObject({
      user: { email: victim.email },
    });
    // Two values for one authentication cookie are refused everywhere.
    const duplicate = `${victimCookie}; __Host-opensuite.session_token=${attackerValue}`;
    const refused = await Promise.all(
      ["/auth/get-session", "/account/me"].map((path) =>
        fetch(`${base}${path}`, { headers: { cookie: duplicate } }),
      ),
    );
    expect(refused.map((response) => response.status)).toEqual([400, 400]);
    expect((await handoff(duplicate)).status).toBe(400);
    // Legacy cookies on this host are cleared on the next auth response.
    const cleared = await fetch(`${base}/auth/get-session`, {
      headers: { cookie: `${planted}; ${victimCookie}` },
    });
    expect(cleared.headers.getSetCookie().join("\n")).toMatch(
      /__Secure-better-auth\.session_token=; Max-Age=0/,
    );
  });
});

describe("identity over HTTP", () => {
  it("disables sign-up on the public Better Auth handler", () => {
    expect(directSignupStatus).toBeGreaterThanOrEqual(400);
    expect(directSignupUsers).toBe(0);
  });
  it("limits repeated password attempts per account", async () => {
    const data = {
      email: "limited@example.test",
      name: "Limited",
      password: "a-strong-test-password",
    };
    expect((await post("sign-up/email", data)).status).toBe(200);
    const attempt = async (remaining: number): Promise<Response> => {
      const response = await post("sign-in/email", {
        email: data.email,
        password: "incorrect-password",
      });
      return remaining === 1 ? response : attempt(remaining - 1);
    };
    const response = await attempt(6);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const dbResult = createDatabase(databaseUrl);
    if (dbResult.isErr()) throw new Error(dbResult.error.message);
    const db = dbResult.value;
    try {
      const user = await db.user.findUniqueOrThrow({
        where: { email: data.email },
      });
      expect(
        await db.auditEvent.count({
          where: { userId: user.id, action: "sign_in.failure" },
        }),
      ).toBe(5);
      expect(
        await db.auditEvent.count({
          where: { userId: null, action: "authentication.rate_limited" },
        }),
      ).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });
  it("enforces account and administrator authorization through HTTP", async () => {
    const ownerData = {
      email: "route-owner@example.test",
      name: "Owner",
      password: "route-strong-password",
    };
    const userData = {
      email: "route-user@example.test",
      name: "User",
      password: "route-strong-password",
    };
    const ownerSignup = await post("sign-up/email", ownerData);
    const userSignup = await post("sign-up/email", userData);
    expect(ownerSignup.status).toBe(200);
    expect(userSignup.status).toBe(200);
    const ownerResponse: unknown = await ownerSignup.json();
    const ownerId = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(ownerResponse).user.id;
    const database = createDatabase(databaseUrl);
    if (database.isErr()) throw new Error(database.error.message);
    const db = database.value;
    try {
      await db.user.update({ where: { id: ownerId }, data: { role: "admin" } });
      const storeResult = createMailboxStore(db, "cd".repeat(32));
      if (storeResult.isErr()) throw new Error(storeResult.error.message);
      expect(
        (
          await storeResult.value.create({
            userId: ownerId,
            accountId: "private-mailbox",
            address: ownerData.email,
            credentialId: "private",
            secret: "private-secret",
          })
        ).isOk(),
      ).toBe(true);
      const login = await post("sign-in/email", {
        email: userData.email,
        password: userData.password,
      });
      const userCookie = login.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; ");
      expect(
        (await fetch(`${base}/account/me`, { headers: { cookie: userCookie } }))
          .status,
      ).toBe(200);
      expect(
        (
          await fetch(`${base}/admin/accounts`, {
            headers: { cookie: userCookie },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${base}/account/mailbox/private-mailbox`, {
            headers: { cookie: userCookie },
          })
        ).status,
      ).toBe(403);
      const adminLogin = await post("sign-in/email", {
        email: ownerData.email,
        password: ownerData.password,
      });
      const routeAdminCookie = adminLogin.headers
        .getSetCookie()
        .map((item) => item.split(";")[0])
        .join("; ");
      expect(
        (
          await fetch(`${base}/admin/accounts`, {
            headers: { cookie: routeAdminCookie },
          })
        ).status,
      ).toBe(200);
      expect(
        await db.auditEvent.count({
          where: { userId: ownerId, action: "admin.accounts.list" },
        }),
      ).toBe(1);
      // The account was created through the administrator route above.
      const device = softwareKey();
      const options = z
        .object({
          id: z.string(),
          options: z.object({ challenge: z.string() }),
        })
        .parse(
          await (
            await post(
              "security-keys/register-options",
              { password: userData.password },
              userCookie,
            )
          ).json(),
        );
      expect(
        (
          await post(
            "security-keys/register",
            {
              id: options.id,
              name: "Admin-created account key",
              response: device.registration(options.options.challenge),
            },
            userCookie,
          )
        ).status,
      ).toBe(200);
      await post("sign-out", {}, userCookie);
      const challenged = await post("sign-in/email", {
        email: userData.email,
        password: userData.password,
      });
      expect(await challenged.json()).toMatchObject({
        twoFactorRedirect: true,
      });
      expect((await handoff(cookieOf(challenged))).status).toBe(401);
    } finally {
      await db.$disconnect();
    }
  });
  it("uses a non-owner database role that can append but cannot change audit history", async () => {
    const ownerResult = createDatabase(databaseUrl);
    if (ownerResult.isErr()) throw new Error(ownerResult.error.message);
    const owner = ownerResult.value;
    const password = "application-test-password-32-characters-long";
    let appDisconnect = resolved;
    try {
      await configureApplicationRole(owner, password);
      const url = new URL(databaseUrl);
      url.username = "opensuite_app";
      url.password = password;
      const appResult = createDatabase(url.toString());
      if (appResult.isErr()) throw new Error(appResult.error.message);
      const application = appResult.value;
      appDisconnect = () => application.$disconnect();
      await application.auditEvent.create({
        data: { action: "test.append", detail: {} },
      });
      expect(
        (
          await application.auditEvent.findMany({
            where: { action: "test.append" },
          })
        ).length,
      ).toBe(1);
      await expect(
        application.$executeRaw`UPDATE "AuditEvent" SET action = 'changed'`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        application.$executeRaw`TRUNCATE "AuditEvent"`,
      ).rejects.toThrow(/permission denied/i);
      const role = z
        .array(z.object({ rolsuper: z.boolean(), owner: z.boolean() }))
        .length(1)
        .parse(
          await application.$queryRaw`SELECT r.rolsuper, (c.relowner = r.oid) AS owner FROM pg_roles r JOIN pg_class c ON c.relname = 'AuditEvent' WHERE r.rolname = current_user`,
        );
      expect(role[0]).toEqual({ rolsuper: false, owner: false });
    } finally {
      await appDisconnect();
      await owner.$disconnect();
    }
  });
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
    const created: unknown = await signup.json();
    expect(
      provisioned.has(
        z.object({ user: z.object({ id: z.string() }) }).parse(created).user.id,
      ),
    ).toBe(true);
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
    const uri = new URL(parsed.totpURI);
    expect(uri.searchParams.get("issuer")).toBe("Esuno");
    expect(decodeURIComponent(uri.pathname)).toContain(data.email);
    expect(decodeURIComponent(uri.pathname)).toContain("Esuno");
    const code = totp(parsed.totpURI);
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
    expect(challengeCookie).toContain("__Host-opensuite.two_factor=");
    // No sibling-origin token before the second factor is verified.
    expect((await handoff(challengeCookie)).status).toBe(401);
    const backup = parsed.backupCodes[0];
    if (backup === undefined) throw new Error("Backup code missing");
    expect(
      (
        await post(
          "two-factor/verify-backup-code",
          { code: backup, trustDevice: true },
          challengeCookie,
        )
      ).status,
    ).toBe(400);
    const verified = await post(
      "two-factor/verify-backup-code",
      { code: backup },
      challengeCookie,
    );
    expect(verified.status).toBe(200);
    expect((await handoff(cookieOf(verified))).status).toBe(200);
    const verifiedCookie = cookieOf(verified);
    expect(
      (
        await post(
          "two-factor/generate-backup-codes",
          { password: "wrong" },
          verifiedCookie,
        )
      ).ok,
    ).toBe(false);
    const regenerated = await post(
      "two-factor/generate-backup-codes",
      { password: data.password },
      verifiedCookie,
    );
    expect(regenerated.status).toBe(200);
    const newCodes = z
      .object({ backupCodes: z.array(z.string()).min(1) })
      .parse(await regenerated.json()).backupCodes;
    await post("sign-out", {}, verifiedCookie);
    const nextChallenge = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    const nextCookie = cookieOf(nextChallenge);
    const oldCode = parsed.backupCodes[1];
    const newCode = newCodes[0];
    if (!oldCode || !newCode) throw new Error("Backup code missing");
    expect(
      (
        await post(
          "two-factor/verify-backup-code",
          { code: oldCode },
          nextCookie,
        )
      ).ok,
    ).toBe(false);
    const newVerification = await post(
      "two-factor/verify-backup-code",
      { code: newCode },
      nextCookie,
    );
    expect(newVerification.status).toBe(200);
    const newCookie = cookieOf(newVerification);
    expect(
      (await post("two-factor/disable", { password: "wrong" }, newCookie)).ok,
    ).toBe(false);
    expect(
      (await post("two-factor/disable", { password: data.password }, newCookie))
        .status,
    ).toBe(200);
    const result = createDatabase(databaseUrl);
    if (result.isErr()) throw new Error("database unavailable");
    try {
      const user = await result.value.user.findUniqueOrThrow({
        where: { email: data.email },
      });
      const events = await result.value.auditEvent.findMany({
        where: { userId: user.id },
        select: { action: true },
      });
      expect(events.map((event) => event.action)).toEqual(
        expect.arrayContaining([
          "mfa.enrol.success",
          "mfa.verify.success",
          "sign_in.challenge",
          "session.revoke.success",
          "mfa.backup_codes.regenerate.success",
          "mfa.disable.success",
        ]),
      );
    } finally {
      await result.value.$disconnect();
    }
  });

  it("rejects a valid legacy trusted-device cookie with whitespace before equals", async () => {
    const account = {
      email: "legacy-trust@example.test",
      name: "Legacy trust",
      password: "legacy-trust-password",
    };
    await directSignUp(account);
    const session = cookieOf(await post("sign-in/email", account));
    const enrollment = z
      .object({ totpURI: z.string() })
      .parse(
        await (
          await post(
            "two-factor/enable",
            { password: account.password },
            session,
          )
        ).json(),
      );
    const enabled = await post(
      "two-factor/verify-totp",
      { code: totp(enrollment.totpURI) },
      session,
    );
    expect(enabled.status).toBe(200);
    await post("sign-out", {}, cookieOf(enabled));
    const pending = cookieOf(await post("sign-in/email", account));
    // Older versions could issue this cookie; use the real plugin to mint it.
    const trusted = await directPost(
      "two-factor/verify-totp",
      { code: totp(enrollment.totpURI), trustDevice: true },
      pending,
    );
    expect(trusted.status).toBe(200);
    const trust = trusted.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-opensuite.trust_device="))
      ?.split(";")[0];
    if (!trust) throw new Error("Missing trusted-device cookie");
    const trustedSession = cookieOf(trusted)
      .split("; ")
      .find((value) => value.startsWith("__Host-opensuite.session_token="));
    if (!trustedSession) throw new Error("Missing trusted session");
    await directPost("sign-out", {}, trustedSession);
    const blocked = await post(
      "sign-in/email",
      account,
      trust.replace("=", " \t="),
    );
    expect(blocked.status).toBe(400);
    expect(blocked.headers.getSetCookie().join(";")).toContain(
      "__Host-opensuite.trust_device=; Max-Age=0",
    );
    expect(blocked.headers.getSetCookie().join(";")).not.toContain(
      "__Host-opensuite.session_token=",
    );
    const normal = await post("sign-in/email", account);
    expect(await normal.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionOf(cookieOf(normal))).toBeNull();
  });

  it("audits operator MFA reset and revokes sessions and pending challenges", async () => {
    const data = {
      email: "reset@example.test",
      name: "Reset",
      password: "reset-strong-password",
    };
    expect((await post("sign-up/email", data)).status).toBe(200);
    const login = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    const sessionCookie = cookieOf(login);
    const enrollment = await post(
      "two-factor/enable",
      { password: data.password },
      sessionCookie,
    );
    expect(enrollment.status).toBe(200);
    const uri = z
      .object({ totpURI: z.string() })
      .parse(await enrollment.json()).totpURI;
    const activation = await post(
      "two-factor/verify-totp",
      { code: totp(uri) },
      sessionCookie,
    );
    expect(activation.status).toBe(200);
    const activeCookie = cookieOf(activation);
    const challenge = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    const pendingCookie = cookieOf(challenge);
    const result = createDatabase(databaseUrl);
    if (result.isErr()) throw new Error("database unavailable");
    try {
      const db = result.value;
      const user = await db.user.findUniqueOrThrow({
        where: { email: data.email },
      });
      await db.verification.create({
        data: {
          id: randomUUID(),
          identifier: "test-pending",
          value: user.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await expect(
        run("node", ["scripts/reset-mfa.mjs", data.email], {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: databaseUrl },
        }),
      ).rejects.toThrow("Command failed");
      await run(
        "node",
        ["scripts/reset-mfa.mjs", data.email, "--confirm", user.id],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: databaseUrl },
        },
      );
      expect(
        await db.twoFactor.findUnique({ where: { userId: user.id } }),
      ).toBeNull();
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(false);
      await db.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true },
      });
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(false);
      // Simulate an already-inconsistent row, then a no-op flag update by the
      // identity plugin. The guard must also run when OLD and NEW are equal.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE "User" DISABLE TRIGGER "User_guardTwoFactorEnabled"`;
        await tx.user.update({
          where: { id: user.id },
          data: { twoFactorEnabled: true },
        });
        await tx.$executeRaw`ALTER TABLE "User" ENABLE TRIGGER "User_guardTwoFactorEnabled"`;
        await tx.user.update({
          where: { id: user.id },
          data: { twoFactorEnabled: true },
        });
        expect(
          (await tx.user.findUniqueOrThrow({ where: { id: user.id } }))
            .twoFactorEnabled,
        ).toBe(false);
      });
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      expect(await db.verification.count({ where: { value: user.id } })).toBe(
        0,
      );
      expect(await sessionOf(sessionCookie)).toBeNull();
      expect(await sessionOf(activeCookie)).toBeNull();
      expect(
        (
          await post(
            "two-factor/verify-totp",
            { code: totp(uri) },
            pendingCookie,
          )
        ).ok,
      ).toBe(false);
      expect(
        await db.auditEvent.count({
          where: { userId: user.id, action: "mfa.operator_reset.success" },
        }),
      ).toBe(1);
    } finally {
      await result.value.$disconnect();
    }
  });

  it("binds security-key assertions to the pending password challenge and rejects replay and counter regression", async () => {
    const data = {
      email: "key-owner@example.test",
      name: "Key owner",
      password: "key-owner-password",
    };
    const other = {
      email: "key-other@example.test",
      name: "Other key owner",
      password: "key-other-password",
    };
    const key = softwareKey();
    const otherKey = softwareKey();
    async function register(
      account: typeof data,
      device: ReturnType<typeof softwareKey>,
    ) {
      await directSignUp(account);
      const cookie = cookieOf(
        await post("sign-in/email", {
          email: account.email,
          password: account.password,
        }),
      );
      expect(
        (
          await post(
            "security-keys/register-options",
            { password: "wrong" },
            cookie,
          )
        ).ok,
      ).toBe(false);
      const optionsResponse = await post(
        "security-keys/register-options",
        { password: account.password },
        cookie,
      );
      expect(optionsResponse.status).toBe(200);
      const options = z
        .object({
          id: z.string(),
          options: z.object({ challenge: z.string() }),
        })
        .parse(await optionsResponse.json());
      const result = await post(
        "security-keys/register",
        {
          id: options.id,
          name: "Test key",
          response: device.registration(options.options.challenge),
        },
        cookie,
      );
      expect(result.status).toBe(200);
      const codes = z
        .object({ backupCodes: z.array(z.string()).length(10) })
        .parse(await result.json()).backupCodes;
      expect(
        (
          await post(
            "security-keys/register",
            {
              id: options.id,
              name: "Replay",
              response: device.registration(options.options.challenge),
            },
            cookie,
          )
        ).ok,
      ).toBe(false);
      await post("sign-out", {}, cookie);
      return codes;
    }
    await register(data, key);
    const rejectedTrust = await post(
      "sign-in/email",
      { email: data.email, password: data.password },
      "__Host-opensuite.trust_device \t=forged",
    );
    expect(rejectedTrust.status).toBe(400);
    expect(rejectedTrust.headers.getSetCookie().join(";")).toContain(
      "__Host-opensuite.trust_device=; Max-Age=0",
    );
    const otherCodes = await register(other, otherKey);
    const otherLogin = await post("sign-in/email", {
      email: other.email,
      password: other.password,
    });
    expect(await otherLogin.json()).toMatchObject({ twoFactorRedirect: true });
    const recoveryCode = otherCodes[0];
    if (!recoveryCode) throw new Error("Missing backup code");
    const otherVerified = await post(
      "two-factor/verify-backup-code",
      { code: recoveryCode },
      cookieOf(otherLogin),
    );
    expect(otherVerified.status).toBe(200);
    await post("sign-out", {}, cookieOf(otherVerified));
    const login = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
    const pending = cookieOf(login);
    expect(await sessionOf(pending)).toBeNull();
    expect((await handoff(pending)).status).toBe(401);
    expect(
      (await post("two-factor/verify-totp", { code: "123456" }, pending)).ok,
    ).toBe(false);
    const options = async () => {
      const response = await post(
        "two-factor/security-key-options",
        {},
        pending,
      );
      expect(response.status).toBe(200);
      return z
        .object({
          challenge: z.string(),
          allowCredentials: z.array(z.object({ id: z.string() })),
        })
        .parse(await response.json());
    };
    const first = await options();
    expect(first.allowCredentials.map((item) => item.id)).toEqual([key.id]);
    expect(
      (
        await post(
          "two-factor/verify-security-key",
          otherKey.assertion(first.challenge, 1),
          pending,
        )
      ).ok,
    ).toBe(false);
    const expired = await options();
    const expiryDb = createDatabase(databaseUrl);
    if (expiryDb.isErr()) throw new Error("database unavailable");
    await expiryDb.value.verification.updateMany({
      where: { identifier: { startsWith: "key-auth-" } },
      data: { expiresAt: new Date(0) },
    });
    await expiryDb.value.$disconnect();
    expect(
      (
        await post(
          "two-factor/verify-security-key",
          key.assertion(expired.challenge, 1),
          pending,
        )
      ).ok,
    ).toBe(false);
    const second = await options();
    const assertion = key.assertion(second.challenge, 1);
    const verified = await post(
      "two-factor/verify-security-key",
      assertion,
      pending,
    );
    expect(verified.status).toBe(200);
    const foreignKeyDb = createDatabase(databaseUrl);
    if (foreignKeyDb.isErr()) throw new Error("database unavailable");
    const foreignKey = await foreignKeyDb.value.securityKey.findUniqueOrThrow({
      where: { credentialId: otherKey.id },
    });
    expect(
      (
        await post(
          "security-keys/remove",
          { id: foreignKey.id, password: data.password },
          cookieOf(verified),
        )
      ).status,
    ).toBe(404);
    await foreignKeyDb.value.$disconnect();
    expect((await handoff(cookieOf(verified))).status).toBe(200);
    expect(
      (await post("two-factor/verify-security-key", assertion, pending)).ok,
    ).toBe(false);
    const next = await post("sign-in/email", {
      email: data.email,
      password: data.password,
    });
    const nextPending = cookieOf(next);
    const active = cookieOf(verified)
      .split("; ")
      .find((item) => item.startsWith("__Host-opensuite.session_token="));
    if (!active) throw new Error("Missing session cookie");
    const pendingOnly = nextPending
      .split("; ")
      .find((item) => item.startsWith("__Host-opensuite.two_factor="));
    if (!pendingOnly) throw new Error("Missing challenge cookie");
    const mixedCookies = `${active}; ${pendingOnly}`;
    expect(await sessionOf(mixedCookies)).toBeNull();
    expect((await handoff(mixedCookies)).status).toBe(401);
    expect(
      (
        await post(
          "one-time-token/verify",
          { token: "x".repeat(40) },
          mixedCookies,
        )
      ).status,
    ).toBe(401);
    const nextOptions = z
      .object({ challenge: z.string() })
      .parse(
        await (
          await post("two-factor/security-key-options", {}, nextPending)
        ).json(),
      );
    expect(
      (
        await directPost(
          "two-factor/verify-security-key",
          key.assertion(nextOptions.challenge, 1),
          nextPending,
        )
      ).status,
    ).toBe(401);
    const counterDb = createDatabase(databaseUrl);
    if (counterDb.isErr()) throw new Error("database unavailable");
    expect(
      (
        await counterDb.value.securityKey.findUniqueOrThrow({
          where: { credentialId: key.id },
        })
      ).counter,
    ).toBe(1n);
    await counterDb.value.$disconnect();
    const retryOptions = z
      .object({ challenge: z.string() })
      .parse(
        await (
          await directPost("two-factor/security-key-options", {}, nextPending)
        ).json(),
      );
    expect(
      (
        await directPost(
          "two-factor/verify-security-key",
          key.assertion(retryOptions.challenge, 2),
          nextPending,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "two-factor/verify-security-key",
          key.assertion(nextOptions.challenge, 2),
          nextPending,
        )
      ).status,
    ).toBe(429);
    const passwordless = await Promise.all(
      [
        "sign-in/passkey",
        "passkey/generate-authenticate-options",
        "passkey/verify-authentication",
      ].map((path) => post(path, {})),
    );
    expect(passwordless.map((response) => response.status)).toEqual([
      404, 404, 404,
    ]);
    const database = createDatabase(databaseUrl);
    if (database.isErr()) throw new Error("database unavailable");
    try {
      const db = database.value;
      const user = await db.user.findUniqueOrThrow({
        where: { email: data.email },
      });
      expect(await db.securityKey.count({ where: { userId: user.id } })).toBe(
        1,
      );
      const actions = (
        await db.auditEvent.findMany({ where: { userId: user.id } })
      ).map((event) => event.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "mfa.key.add.success",
          "mfa.key.enrol_options.failure",
          "mfa.verify.success",
          "mfa.verify.failure",
        ]),
      );
      await run(
        "node",
        ["scripts/reset-mfa.mjs", data.email, "--confirm", user.id],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: databaseUrl },
        },
      );
      expect(await db.securityKey.count({ where: { userId: user.id } })).toBe(
        0,
      );
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(false);
      expect(
        (await post("two-factor/security-key-options", {}, nextPending)).ok,
      ).toBe(false);
    } finally {
      await database.value.$disconnect();
    }
  });
  it("recomputes the sign-in gate while removing keys and TOTP", async () => {
    const account = {
      email: "factor-changes@example.test",
      name: "Factors",
      password: "factor-changes-password",
    };
    await directSignUp(account);
    const cookie = cookieOf(
      await post("sign-in/email", {
        email: account.email,
        password: account.password,
      }),
    );
    let firstCodes: string[] = [];
    async function addDevice(
      device: ReturnType<typeof softwareKey>,
      index: number,
    ) {
      const options = z
        .object({
          id: z.string(),
          options: z.object({ challenge: z.string() }),
        })
        .parse(
          await (
            await post(
              "security-keys/register-options",
              { password: account.password },
              cookie,
            )
          ).json(),
        );
      const result = await post(
        "security-keys/register",
        {
          id: options.id,
          name: `Key ${index + 1}`,
          response: device.registration(options.options.challenge),
        },
        cookie,
      );
      expect(result.status).toBe(200);
      expect(
        z
          .object({ backupCodes: z.array(z.string()) })
          .parse(await result.json()).backupCodes,
      ).toHaveLength(index === 0 ? 10 : 0);
      if (index === 0) {
        const values: unknown = await (
          await post(
            "two-factor/generate-backup-codes",
            { password: account.password },
            cookie,
          )
        ).json();
        firstCodes = z
          .object({ backupCodes: z.array(z.string()) })
          .parse(values).backupCodes;
      }
    }
    await addDevice(softwareKey(), 0);
    await addDevice(softwareKey(), 1);
    let status = z
      .object({
        totp: z.boolean(),
        keys: z.array(z.object({ id: z.string() })),
      })
      .parse(
        await (
          await fetch(`${base}/auth/security-keys/status`, {
            headers: { cookie },
          })
        ).json(),
      );
    expect(status.keys).toHaveLength(2);
    const firstId = status.keys[0]?.id;
    const secondId = status.keys[1]?.id;
    if (!firstId || !secondId) throw new Error("Missing key");
    expect(
      (
        await post(
          "security-keys/remove",
          { id: firstId, password: "wrong" },
          cookie,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await post(
          "security-keys/remove",
          { id: firstId, password: account.password },
          cookie,
        )
      ).status,
    ).toBe(200);
    const enrollment = await post(
      "two-factor/enable",
      { password: account.password },
      cookie,
    );
    const enrollmentData = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
      .parse(await enrollment.json());
    expect(enrollmentData.backupCodes).toEqual(firstCodes);
    const uri = enrollmentData.totpURI;
    const pendingBeforeConfirmation = cookieOf(
      await post("sign-in/email", account),
    );
    const savedBackup = firstCodes[0];
    if (!savedBackup) throw new Error("Missing backup code");
    const restored = await post(
      "two-factor/verify-backup-code",
      { code: savedBackup },
      pendingBeforeConfirmation,
    );
    expect(restored.status).toBe(200);
    await post("sign-out", {}, cookieOf(restored));
    expect(
      (await post("two-factor/verify-totp", { code: totp(uri) }, cookie))
        .status,
    ).toBe(200);
    expect(
      (await post("two-factor/disable", { password: account.password }, cookie))
        .status,
    ).toBe(200);
    expect(
      (await post("two-factor/verify-totp", { code: totp(uri) }, cookie)).ok,
    ).toBe(false);
    status = z
      .object({
        totp: z.boolean(),
        keys: z.array(z.object({ id: z.string() })),
      })
      .parse(
        await (
          await fetch(`${base}/auth/security-keys/status`, {
            headers: { cookie },
          })
        ).json(),
      );
    expect(status.totp).toBe(false);
    expect(status.keys).toHaveLength(1);
    const database = createDatabase(databaseUrl);
    if (database.isErr()) throw new Error("database unavailable");
    try {
      const db = database.value;
      const target = await db.user.findUniqueOrThrow({
        where: { email: account.email },
      });
      const beforeFinalRemoval = (
        await db.auditEvent.findMany({ where: { userId: target.id } })
      ).map((event) => event.action);
      expect(beforeFinalRemoval).toContain("mfa.totp.remove.success");
      expect(beforeFinalRemoval).not.toContain("mfa.disable.success");
      expect(
        (await db.user.findUniqueOrThrow({ where: { email: account.email } }))
          .twoFactorEnabled,
      ).toBe(true);
      expect(
        (
          await post(
            "security-keys/remove",
            { id: secondId, password: account.password },
            cookie,
          )
        ).status,
      ).toBe(200);
      expect(
        (await db.user.findUniqueOrThrow({ where: { email: account.email } }))
          .twoFactorEnabled,
      ).toBe(false);
      const user = await db.user.findUniqueOrThrow({
        where: { email: account.email },
      });
      const actions = (
        await db.auditEvent.findMany({ where: { userId: user.id } })
      ).map((event) => event.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "mfa.enrol.success",
          "mfa.key.add.success",
          "mfa.key.remove.success",
          "mfa.disable.success",
        ]),
      );
      expect(
        (
          await post("sign-in/email", {
            email: account.email,
            password: account.password,
          })
        ).headers
          .getSetCookie()
          .join(";"),
      ).toContain("session_token");
    } finally {
      await database.value.$disconnect();
    }
  });
  it("preserves pending authenticator setup when the first key is added", async () => {
    const account = {
      email: "pending-totp@example.test",
      name: "Pending",
      password: "pending-strong-password",
    };
    await directSignUp(account);
    const cookie = cookieOf(await post("sign-in/email", account));
    const enrollment = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
      .parse(
        await (
          await post(
            "two-factor/enable",
            { password: account.password },
            cookie,
          )
        ).json(),
      );
    const device = softwareKey();
    const secondSession = cookieOf(await post("sign-in/email", account));
    const bound = z
      .object({ id: z.string(), options: z.object({ challenge: z.string() }) })
      .parse(
        await (
          await post(
            "security-keys/register-options",
            { password: account.password },
            cookie,
          )
        ).json(),
      );
    expect(
      (
        await post(
          "security-keys/register",
          {
            id: bound.id,
            name: "Wrong session",
            response: device.registration(bound.options.challenge),
          },
          secondSession,
        )
      ).ok,
    ).toBe(false);
    const options = z
      .object({ id: z.string(), options: z.object({ challenge: z.string() }) })
      .parse(
        await (
          await post(
            "security-keys/register-options",
            { password: account.password },
            cookie,
          )
        ).json(),
      );
    const added = await post(
      "security-keys/register",
      {
        id: options.id,
        name: "Key",
        response: device.registration(options.options.challenge),
      },
      cookie,
    );
    expect(added.status).toBe(200);
    expect(
      z.object({ backupCodes: z.array(z.string()) }).parse(await added.json())
        .backupCodes,
    ).toEqual(enrollment.backupCodes);
    const reopened = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
      .parse(
        await (
          await post(
            "two-factor/enable",
            { password: account.password },
            cookie,
          )
        ).json(),
      );
    expect(new URL(reopened.totpURI).searchParams.get("secret")).toBe(
      new URL(enrollment.totpURI).searchParams.get("secret"),
    );
    expect(reopened.backupCodes).toEqual(enrollment.backupCodes);
    const duplicateOptions = z
      .object({ id: z.string(), options: z.object({ challenge: z.string() }) })
      .parse(
        await (
          await post(
            "security-keys/register-options",
            { password: account.password },
            cookie,
          )
        ).json(),
      );
    expect(
      (
        await post(
          "security-keys/register",
          {
            id: duplicateOptions.id,
            name: "Duplicate",
            response: device.registration(duplicateOptions.options.challenge),
          },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "two-factor/verify-totp",
          { code: totp(enrollment.totpURI) },
          cookie,
        )
      ).status,
    ).toBe(200);
    await post("sign-out", {}, cookie);
    expect((await directPost("two-factor/methods", {}, "")).status).toBe(401);
    expect(
      (await directPost("two-factor/security-key-options", {}, "")).status,
    ).toBe(401);
    const challenge = cookieOf(await post("sign-in/email", account));
    const invalidAssertions = [
      { origin: "https://evil.example.test" },
      { origin: calendarOrigin },
      { rp: "wrong.example.test" },
      { forged: true },
      { type: "webauthn.create" },
    ];
    await invalidAssertions.reduce(async (previous, overrides) => {
      await previous;
      const request = z
        .object({ challenge: z.string() })
        .parse(
          await (
            await directPost("two-factor/security-key-options", {}, challenge)
          ).json(),
        );
      expect(
        (
          await directPost(
            "two-factor/verify-security-key",
            device.assertion(request.challenge, 1, overrides),
            challenge,
          )
        ).status,
      ).toBe(401);
    }, Promise.resolve());
    const exhausted = z
      .object({ challenge: z.string() })
      .parse(
        await (
          await directPost("two-factor/security-key-options", {}, challenge)
        ).json(),
      );
    expect(
      (
        await directPost(
          "two-factor/verify-security-key",
          device.assertion(exhausted.challenge, 1),
          challenge,
        )
      ).status,
    ).toBe(401);
    const secondChallenge = cookieOf(await post("sign-in/email", account));
    await invalidAssertions.reduce(async (previous, overrides) => {
      await previous;
      const request = z
        .object({ challenge: z.string() })
        .parse(
          await (
            await directPost(
              "two-factor/security-key-options",
              {},
              secondChallenge,
            )
          ).json(),
        );
      expect(
        (
          await directPost(
            "two-factor/verify-security-key",
            device.assertion(request.challenge, 1, overrides),
            secondChallenge,
          )
        ).status,
      ).toBe(401);
    }, Promise.resolve());
    const lockDb = createDatabase(databaseUrl);
    if (lockDb.isErr()) throw new Error("database unavailable");
    const lockedUser = await lockDb.value.user.findUniqueOrThrow({
      where: { email: account.email },
    });
    const locked = await lockDb.value.twoFactor.findUniqueOrThrow({
      where: { userId: lockedUser.id },
    });
    expect(locked.failedVerificationCount).toBe(10);
    expect(locked.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    const lockedChallenge = cookieOf(await post("sign-in/email", account));
    const lockedOptions = z
      .object({ challenge: z.string() })
      .parse(
        await (
          await directPost(
            "two-factor/security-key-options",
            {},
            lockedChallenge,
          )
        ).json(),
      );
    expect(
      (
        await directPost(
          "two-factor/verify-security-key",
          device.assertion(lockedOptions.challenge, 1),
          lockedChallenge,
        )
      ).status,
    ).toBe(401);
    expect(
      await lockDb.value.verification.count({
        where: { value: lockedOptions.challenge },
      }),
    ).toBe(1);
    expect((await post("sign-out", {}, lockedChallenge)).status).toBe(200);
    expect(
      await lockDb.value.verification.count({
        where: { value: lockedOptions.challenge },
      }),
    ).toBe(0);
    expect(
      (await directPost("two-factor/methods", {}, lockedChallenge)).status,
    ).toBe(401);
    await lockDb.value.$disconnect();
    expect((await post("sign-out", {}, secondChallenge)).status).toBe(200);
    expect(
      (await directPost("two-factor/methods", {}, secondChallenge)).status,
    ).toBe(401);
  }, 180_000);
  it("completes concurrent key sign-ins with a one-connection pool", async () => {
    const url = new URL(databaseUrl);
    url.searchParams.set("connection_limit", "1");
    const result = createDatabase(url.toString());
    if (result.isErr()) throw new Error("database unavailable");
    const db = result.value;
    let allowSession = true;
    const identity = createIdentity({
      database: db,
      publicOrigin: origin,
      secret: "single-pool-secret-at-least-32-characters",
      provision: () => Promise.resolve(),
      mayStartSession: () => Promise.resolve(allowSession),
    });
    const call = (path: string, body: object, cookie = "") =>
      identity.handler(
        new Request(`${origin}/api/auth/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify(body),
        }),
      );
    try {
      const requests = await [0, 1, 2].reduce(async (previous, index) => {
        const list = await previous;
        const account = {
          name: "Pool",
          email: `pool-${index}@example.test`,
          password: "pool-strong-password",
        };
        await identity.api.signUpEmail({ body: account });
        const cookie = cookieOf(await call("sign-in/email", account));
        const key = softwareKey();
        const registration = z
          .object({
            id: z.string(),
            options: z.object({ challenge: z.string() }),
          })
          .parse(
            await (
              await call(
                "security-keys/register-options",
                { password: account.password },
                cookie,
              )
            ).json(),
          );
        expect(
          (
            await call(
              "security-keys/register",
              {
                id: registration.id,
                name: "Key",
                response: key.registration(registration.options.challenge),
              },
              cookie,
            )
          ).status,
        ).toBe(200);
        await call("sign-out", {}, cookie);
        const pending = cookieOf(
          await call("sign-in/email", { ...account, rememberMe: index !== 0 }),
        );
        const options = z
          .object({ challenge: z.string() })
          .parse(
            await (
              await call("two-factor/security-key-options", {}, pending)
            ).json(),
          );
        return [
          ...list,
          { pending, assertion: key.assertion(options.challenge, 1) },
        ];
      }, Promise.resolve<Array<{ pending: string; assertion: ReturnType<ReturnType<typeof softwareKey>["assertion"]> }>>([]));
      const first = requests[0];
      if (!first) throw new Error("Missing key assertion");
      const attemptsBefore = await db.verification.count({
        where: { identifier: { startsWith: "2fa-attempts-" }, value: "0" },
      });
      const challengesBefore = await db.verification.count({
        where: { identifier: { startsWith: "key-auth-" } },
      });
      const sessionsBefore = await db.session.count();
      await db.user.update({
        where: { email: "pool-0@example.test" },
        data: { disabled: true },
      });
      expect(
        (
          await call(
            "two-factor/verify-security-key",
            first.assertion,
            first.pending,
          )
        ).status,
      ).toBe(401);
      await db.user.update({
        where: { email: "pool-0@example.test" },
        data: { disabled: false },
      });
      allowSession = false;
      expect(
        (
          await call(
            "two-factor/verify-security-key",
            first.assertion,
            first.pending,
          )
        ).status,
      ).toBe(500);
      allowSession = true;
      await db.$executeRaw`CREATE FUNCTION "testFailSessionCreate"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated database failure'; END $$`;
      await db.$executeRaw`CREATE TRIGGER "testFailSessionCreate" BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION "testFailSessionCreate"()`;
      try {
        expect(
          (
            await call(
              "two-factor/verify-security-key",
              first.assertion,
              first.pending,
            )
          ).status,
        ).toBe(500);
      } finally {
        await db.$executeRaw`DROP TRIGGER "testFailSessionCreate" ON "Session"`;
        await db.$executeRaw`DROP FUNCTION "testFailSessionCreate"()`;
      }
      expect(
        await db.verification.count({
          where: { identifier: { startsWith: "2fa-attempts-" }, value: "0" },
        }),
      ).toBe(attemptsBefore);
      expect(
        await db.verification.count({
          where: { identifier: { startsWith: "key-auth-" } },
        }),
      ).toBe(challengesBefore);
      expect(await db.session.count()).toBe(sessionsBefore);
      const responses = await Promise.all(
        requests.map(({ pending, assertion }) =>
          call("two-factor/verify-security-key", assertion, pending),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200,
      ]);
      const shortSession = await db.session.findFirstOrThrow({
        where: { user: { email: "pool-0@example.test" } },
      });
      const regularSession = await db.session.findFirstOrThrow({
        where: { user: { email: "pool-1@example.test" } },
      });
      expect(shortSession.expiresAt.getTime() - Date.now()).toBeLessThan(
        26 * 60 * 60 * 1000,
      );
      expect(regularSession.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        6 * 24 * 60 * 60 * 1000,
      );
    } finally {
      await db.$disconnect();
    }
  }, 180_000);
  it("limits key enrollment and removal password attempts per user", async () => {
    const account = {
      email: "key-limit@example.test",
      name: "Limit",
      password: "limit-strong-password",
    };
    await directSignUp(account);
    const cookie = cookieOf(await post("sign-in/email", account));
    const statuses = await [0, 1, 2, 3, 4, 5].reduce(
      async (previous, index) => {
        const list = await previous;
        const path =
          index % 2 ? "security-keys/remove" : "security-keys/register-options";
        const response = await post(
          path,
          { password: "wrong", id: "missing" },
          cookie,
        );
        return [...list, response.status];
      },
      Promise.resolve<number[]>([]),
    );
    expect(statuses.slice(0, 5).every((status) => status === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
