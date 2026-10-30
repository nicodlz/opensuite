import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { request as httpsRequest } from "node:https";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const id = randomBytes(5).toString("hex");
const project = `opensuite-pass-${id}`;
const octet = (randomBytes(1).readUInt8() % 200) + 20;
const env = {
  ...process.env,
  PASS_TEST_SUBNET: `10.239.${String(octet)}.0/24`,
  PASS_TEST_PROXY_IP: `10.239.${String(octet)}.2`,
};
const args = [
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
const compose = async (...command: string[]) =>
  (
    await run("docker", [...args, ...command], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
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
const port = async (service: string, internal = "80") => {
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
  await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
};

describe("Pass Compose integration", () => {
  beforeAll(async () => {
    try {
      // Initialize the volume without Pass, as on an existing installation.
      await compose("up", "-d", "--wait", "--wait-timeout", "180", "postgres");
      await sql("postgres", "CREATE ROLE opensuite_app LOGIN");
      beforeProvision = await sql(
        "postgres",
        "SELECT count(*) FROM pg_database WHERE datname='opensuite_pass'",
      );
      await compose("run", "--rm", "--no-deps", "pass-provision");
      afterFirstProvision = await sql(
        "postgres",
        "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='opensuite_pass'",
      );
      await compose("run", "--rm", "--no-deps", "pass-provision");
      afterSecondProvision = await sql(
        "postgres",
        "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='opensuite_pass'",
      );
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "pass",
        "caddy",
      );
      proxy = await port("caddy", "443");
      ca = await compose(
        "exec",
        "-T",
        "caddy",
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      );
      direct = await port("pass");
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
  });

  test("starts and answers its health endpoint", async () => {
    const health = await fetch(`http://127.0.0.1:${direct}/alive`);
    expect(health.status).toBe(200);
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
  });

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

  test("retains generated keys and database records after restart", async () => {
    await sql(
      "opensuite_pass",
      "SET ROLE opensuite_pass; CREATE TABLE pass_persistence_probe (marker text); INSERT INTO pass_persistence_probe VALUES ('disposable-marker')",
    );
    const key = (
      await compose("exec", "-T", "pass", "sha256sum", "/data/rsa_key.pem")
    ).trim();
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
