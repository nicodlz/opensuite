import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { request as httpsRequest } from "node:https";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { createPassFixture } from "./pass-fixture.js";

const run = promisify(execFile);
const { project, env, args, compose, chooseSubnets } =
  createPassFixture("pass");
Object.assign(env, {
  PASS_LOGIN_RATELIMIT_SECONDS: "3600",
  PASS_LOGIN_RATELIMIT_MAX_BURST: "2",
});
const sql = (database: string, statement: string) =>
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "opensuite",
    "-d",
    database,
    "-c",
    statement,
  );
const port = async (service: string, internal = "8080") => {
  const result = /:(\d+)\s*$/.exec(
    await compose("port", service, internal),
  )?.[1];
  if (result === undefined) throw new Error(`Missing ${service} port`);
  return result;
};
let proxy = "";
let direct = "";
let beforeProvision = "";
let afterFirstProvision = "";
let afterSecondProvision = "";
let ca = "";
let fixtureDirectory = "";
let passwordRotated = "";
let conflictMessage = "";
const request = (
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  new Promise<{ status: number; headers: Headers; text: string }>(
    (resolve, reject) => {
      const client = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: Number(proxy),
          servername: "pass.localhost",
          ca,
          path,
          method: init.method ?? "GET",
          headers: { ...init.headers, host: "pass.localhost" },
          timeout: 10_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") headers.set(name, value);
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      client.on("timeout", () =>
        client.destroy(new Error("Proxy request timeout")),
      );
      client.on("error", reject);
      client.end(init.body);
    },
  );
const cleanup = async () => {
  try {
    await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
  } finally {
    if (fixtureDirectory)
      await rm(fixtureDirectory, { recursive: true, force: true });
  }
};

const prepareSecrets = async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "opensuite-pass-"));
  const adminFile = join(fixtureDirectory, "admin-phc");
  const salt = randomBytes(16).toString("base64").replace(/=+$/, "");
  const hash = randomBytes(32).toString("base64").replace(/=+$/, "");
  await writeFile(adminFile, `$argon2id$v=19$m=19456,t=2,p=1$${salt}$${hash}`, {
    mode: 0o600,
  });
  await run("chmod", ["755", fixtureDirectory]);
  await run("chmod", ["644", adminFile]);
  env.PASS_ADMIN_TOKEN_FILE = adminFile;
};
const provisionExistingDatabase = async () => {
  // Initialize the volume without Pass, as on an existing installation.
  await compose("up", "-d", "--wait", "--wait-timeout", "180", "postgres");
  await sql(
    "postgres",
    "CREATE ROLE opensuite_app LOGIN; CREATE ROLE opensuite_drive LOGIN",
  );
  beforeProvision = await sql(
    "postgres",
    "SELECT count(*) FROM pg_database WHERE datname='opensuite_pass'",
  );
  await sql("postgres", "CREATE DATABASE opensuite_pass");
  try {
    await compose("run", "--rm", "--no-deps", "pass-provision");
    throw new Error("Foreign-owned database was accepted");
  } catch (error) {
    conflictMessage = error instanceof Error ? error.message : "";
  }
  await sql("postgres", "DROP DATABASE opensuite_pass");
  await sql(
    "postgres",
    "DO $$ BEGIN EXECUTE format('CREATE ROLE opensuite_pass LOGIN PASSWORD %L', md5(random()::text)); END $$; CREATE TABLE pass_old_verifier AS SELECT rolpassword FROM pg_authid WHERE rolname='opensuite_pass'",
  );
  await compose("run", "--rm", "--no-deps", "pass-provision");
  passwordRotated = await sql(
    "postgres",
    "SELECT rolpassword <> (SELECT rolpassword FROM pass_old_verifier) FROM pg_authid WHERE rolname='opensuite_pass'",
  );
  afterFirstProvision = await sql(
    "postgres",
    "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='opensuite_pass'",
  );
  await compose("run", "--rm", "--no-deps", "pass-provision");
  afterSecondProvision = await sql(
    "postgres",
    "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='opensuite_pass'",
  );
};
const startServices = async () => {
  await compose("up", "-d", "--wait", "--wait-timeout", "180", "pass", "caddy");
  proxy = await port("caddy", "443");
  ca = await compose(
    "exec",
    "-T",
    "caddy",
    "cat",
    "/data/caddy/pki/authorities/local/root.crt",
  );
  direct = await port("pass");
};

const writeConfig = (config: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        ...args,
        "run",
        "--rm",
        "-T",
        "--no-deps",
        "--entrypoint",
        "/bin/sh",
        "pass",
        "-c",
        "cat > /data/config.json",
      ],
      { env, stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Could not write fixture config")),
    );
    child.stdin.end(config);
  });

const spoofedHeaders = (index: number) => ({
  "content-type": "application/x-www-form-urlencoded",
  "x-real-ip": `198.51.100.${String(index)}`,
  "x-forwarded-for": `203.0.113.${String(index)}`,
});

const connectAsPass = (database: string) =>
  compose(
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "--entrypoint",
    "/bin/sh",
    "pass-provision",
    "-c",
    'export PGPASSWORD="$(cat /run/opensuite/pass-database/password)"; exec psql -h postgres -U opensuite_pass -d "$1" -c "SELECT 1"',
    "sh",
    database,
  );

const runWith = (name: string, value: string) =>
  compose("run", "--rm", "-T", "--no-deps", "-e", `${name}=${value}`, "pass");

describe("Pass Compose integration", () => {
  beforeAll(async () => {
    try {
      await chooseSubnets();
      await prepareSecrets();
      await provisionExistingDatabase();
      await startServices();
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 300_000);
  afterAll(cleanup, 60_000);

  test("provisions twice on a previously initialized volume", () => {
    expect(beforeProvision.trim()).toBe("0");
    expect(afterFirstProvision.trim()).toBe("opensuite_pass");
    expect(afterSecondProvision.trim()).toBe("opensuite_pass");
    expect(passwordRotated.trim()).toBe("t");
    expect(conflictMessage).toContain("database is owned by another role");
  });

  test("starts and answers its health endpoint", async () => {
    const health = await fetch(`http://127.0.0.1:${direct}/alive`);
    expect(health.status).toBe(200);
  });

  test("rejects a shared site origin and a nonstandard HTTPS port", async () => {
    await expect(runWith("PASS_PUBLIC_HOST", "localhost")).rejects.toThrow(
      "separate public hostname",
    );
    await expect(runWith("PASS_HTTPS_PORT", "8443")).rejects.toThrow(
      "requires HTTPS_PORT=443",
    );
  }, 120_000);

  test("runs as a non-root user with a read-only root filesystem", async () => {
    expect((await compose("exec", "-T", "pass", "id", "-u")).trim()).toBe(
      "1000",
    );
    await expect(
      compose("exec", "-T", "pass", "touch", "/root-fs-probe"),
    ).rejects.toThrow("Command failed");
    const container = (await compose("ps", "-q", "pass")).trim();
    const options = (
      await run("docker", [
        "inspect",
        "--format",
        "{{.HostConfig.ReadonlyRootfs}}",
        container,
      ])
    ).stdout.trim();
    expect(options).toBe("true");
  });

  test("migrates tables under the dedicated database role", async () => {
    const owners = await sql(
      "opensuite_pass",
      "SELECT pg_get_userbyid(c.relowner), count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' GROUP BY 1 ORDER BY 1",
    );
    expect(owners.trim()).toMatch(/^opensuite_pass\|[1-9][0-9]*$/);
    const rights = await sql(
      "postgres",
      "SELECT has_database_privilege('opensuite_pass','opensuite_pass','CONNECT'), has_database_privilege('opensuite_app','opensuite_pass','CONNECT')",
    );
    expect(rights.trim()).toBe("t|f");
    const isolation = await sql(
      "postgres",
      "SELECT has_database_privilege('opensuite_pass','opensuite','CONNECT'), has_database_privilege('opensuite_pass','opensuite_drive','CONNECT'), has_database_privilege('opensuite_app','opensuite','CONNECT'), has_database_privilege('opensuite_drive','opensuite_drive','CONNECT')",
    );
    expect(isolation.trim()).toBe("f|f|t|t");
    await Promise.all(
      ["opensuite", "opensuite_drive"].map(async (database) => {
        await expect(connectAsPass(database)).rejects.toThrow(
          "permission denied",
        );
      }),
    );
    expect(await connectAsPass("opensuite_pass")).toContain("1");
  }, 120_000);

  test("serves the client configuration through Caddy", async () => {
    const response = await request("/api/config");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ object: "config" });
  });

  test("rejects uninvited registration", async () => {
    const response = await request(
      "/identity/accounts/register/send-verification-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.invalid" }),
      },
    );
    expect(response.status).toBe(400);
    expect(response.text).toContain("Registration not allowed");
  });

  test("upgrades a notification websocket through Caddy", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const client = httpsRequest({
        hostname: "127.0.0.1",
        port: Number(proxy),
        servername: "pass.localhost",
        ca,
        path: "/notifications/anonymous-hub?token=disposable",
        headers: {
          host: "pass.localhost",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
        },
        timeout: 10_000,
      });
      client.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode ?? 0);
      });
      client.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      client.on("timeout", () =>
        client.destroy(new Error("Websocket timeout")),
      );
      client.on("error", reject);
      client.end();
    });
    expect(status).toBe(101);
  });

  test("blocks the public admin and supplies the security headers", async () => {
    expect((await request("/admin")).status).toBe(404);
    expect((await request("/admin/users")).status).toBe(404);
    const variants = await Promise.all(
      ["/ADMIN", "/%61dmin", "//admin", "/admin/"].map((path) => request(path)),
    );
    expect(variants.map((response) => response.status)).toEqual([
      404, 404, 404, 404,
    ]);
    const admin = await fetch(`http://127.0.0.1:${direct}/admin/`);
    expect(admin.status).toBe(200);
    expect((await admin.text()).toLowerCase()).toContain("token");
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("server")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeTruthy();
  });

  test("retains generated keys and database records after recreation", async () => {
    await sql(
      "opensuite_pass",
      "SET ROLE opensuite_pass; CREATE TABLE pass_persistence_probe (marker text); INSERT INTO pass_persistence_probe VALUES ('disposable-marker')",
    );
    const key = (
      await compose("exec", "-T", "pass", "sha256sum", "/data/rsa_key.pem")
    ).trim();
    await compose("stop", "pass");
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
      "postgres",
    );
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
      "pass",
    );
    direct = await port("pass");
    expect(
      (
        await compose("exec", "-T", "pass", "sha256sum", "/data/rsa_key.pem")
      ).trim(),
    ).toBe(key);
    expect(
      (
        await sql("opensuite_pass", "SELECT marker FROM pass_persistence_probe")
      ).trim(),
    ).toBe("disposable-marker");
    expect((await request("/api/config")).status).toBe(200);
  }, 240_000);

  test("ignores spoofed client IP headers on public and loopback listeners", async () => {
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: "web",
      password: "disposable",
      scope: "api offline_access",
      username: "nobody@example.invalid",
      device_identifier: "00000000-0000-4000-8000-000000000001",
      device_name: "fixture",
      device_type: "14",
    }).toString();
    const directAttempt = async (index: number) =>
      (
        await fetch(`http://127.0.0.1:${direct}/identity/connect/token`, {
          method: "POST",
          headers: spoofedHeaders(index),
          body,
        })
      ).status;
    const directStatuses = [
      await directAttempt(1),
      await directAttempt(2),
      await directAttempt(3),
    ];
    expect(directStatuses).toEqual([400, 400, 429]);
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
      "pass",
    );
    direct = await port("pass");
    const proxyAttempt = async (index: number) =>
      (
        await request("/identity/connect/token", {
          method: "POST",
          headers: spoofedHeaders(index),
          body,
        })
      ).status;
    const proxyStatuses = [
      await proxyAttempt(1),
      await proxyAttempt(2),
      await proxyAttempt(3),
    ];
    expect(proxyStatuses).toEqual([400, 400, 429]);
  }, 240_000);

  test("isolates the Pass listener on its own network", async () => {
    const container = (await compose("ps", "-q", "pass")).trim();
    const result = await run("docker", [
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      container,
    ]);
    const networks = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(result.stdout));
    expect(Object.keys(networks)).toEqual([`${project}_pass-network`]);
  });

  test("guards saved signup settings on startup", async () => {
    try {
      await compose("stop", "pass");
      await [
        '{"disable_admin_token":true}',
        '{"signups_domains_whitelist":"example.invalid"}',
        '{"admin_token":"fixture"}',
      ].reduce(async (previous, config) => {
        await previous;
        await writeConfig(config);
        await expect(
          compose("run", "--rm", "-T", "--no-deps", "pass"),
        ).rejects.toThrow("restricted setting");
      }, Promise.resolve());
      await writeConfig('{"signups_allowed":true}');
      await expect(
        compose(
          "up",
          "-d",
          "--no-deps",
          "--force-recreate",
          "--wait",
          "--wait-timeout",
          "20",
          "pass",
        ),
      ).rejects.toThrow("Command failed");
      expect(await compose("logs", "--no-color", "pass")).toContain(
        "saved configuration contains a restricted setting",
      );
      env.PASS_ALLOW_SAVED_SIGNUPS = "true";
      await compose(
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "180",
        "pass",
      );
      expect((await request("/api/config")).status).toBe(200);
      await compose("stop", "pass");
      await compose(
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "/bin/sh",
        "pass",
        "-c",
        "rm /data/config.json",
      );
    } finally {
      env.PASS_ALLOW_SAVED_SIGNUPS = "false";
      await compose(
        "run",
        "--rm",
        "-T",
        "--no-deps",
        "--entrypoint",
        "/bin/sh",
        "pass",
        "-c",
        "rm -f /data/config.json",
      );
    }
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
      "pass",
    );
  }, 240_000);

  test("runs without the application, mail, Drive or ingest services", async () => {
    const services = await compose(
      "ps",
      "--services",
      "--filter",
      "status=running",
    );
    expect(services.split(/\s+/)).not.toContain("api");
    expect(services.split(/\s+/)).not.toContain("stalwart");
    expect(services.split(/\s+/)).not.toContain("drive");
    expect(services.split(/\s+/)).not.toContain("ingest");
    expect((await request("/alive")).status).toBe(200);
  });
});
