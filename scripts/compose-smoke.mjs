#!/usr/bin/env node
// Starts a throwaway copy of the Compose stack, checks it end to end through
// the reverse proxy, writes a JUnit report and always destroys the stack.
//
//   CLEITO_RUN_ID=local-1 node scripts/compose-smoke.mjs --report smoke.xml
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import process from "node:process";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

const { values } = parseArgs({
  options: { report: { type: "string" }, keep: { type: "boolean" } },
});
if (values.report === undefined) {
  process.stderr.write("usage: compose-smoke.mjs --report PATH [--keep]\n");
  process.exit(2);
}
const reportPath = values.report;

const runId = (process.env.CLEITO_RUN_ID ?? `local-${String(Date.now())}`)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-");
const project = `opensuite-smoke-${runId}`;
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  "deploy/env.example",
  "--file",
  "compose.yaml",
  "--file",
  "compose.test.yaml",
];

/** @param {...string} args */
const compose = async (...args) => {
  const { stdout } = await run("docker", [...composeArgs, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

/**
 * Host port published for a service's container port, e.g. 443.
 * @param {string} service
 * @param {string} port
 */
const hostPort = async (service, port, protocol = "tcp") => {
  const out = await compose("port", "--protocol", protocol, service, port);
  const match = /:(\d+)\s*$/.exec(out.trim());
  if (match?.[1] === undefined)
    throw new Error(`no host port for ${service}:${port}`);
  return Number(match[1]);
};

/**
 * @typedef {{ status: number, headers: import("node:http").IncomingHttpHeaders, body: string }} Reply
 */

/**
 * HTTPS request to the proxy, verified against Caddy's local CA.
 * @param {number} port
 * @param {string} ca
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Reply>}
 */
const request = (port, ca, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        servername: "localhost",
        ca,
        headers: { host: "localhost", ...headers },
        timeout: 10_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout on ${path}`)));
    req.on("error", reject);
    req.end();
  });

/**
 * @param {number} port
 * @returns {Promise<string>}
 */
const smtpBanner = (port) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(10_000, () => socket.destroy(new Error("SMTP timeout")));
    socket.once("data", (data) => {
      socket.end("QUIT\r\n");
      resolve(data.toString("utf8"));
    });
    socket.on("error", reject);
  });

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** @type {{ name: string, seconds: number, failure?: string }[]} */
const cases = [];
/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
const test = async (name, fn) => {
  const started = performance.now();
  try {
    await fn();
    cases.push({ name, seconds: (performance.now() - started) / 1000 });
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cases.push({
      name,
      seconds: (performance.now() - started) / 1000,
      failure: message,
    });
    process.stdout.write(`FAIL ${name}: ${message}\n`);
  }
};

/** @type {Record<string, string>} */
const entities = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" };
/** @param {string} text */
const xml = (text) => text.replace(/[<>&"]/g, (c) => entities[c] ?? c);

const writeReport = () => {
  const failures = cases.filter((c) => c.failure !== undefined).length;
  const body = cases
    .map((c) => {
      const open = `    <testcase classname="compose-smoke" name="${xml(c.name)}" time="${c.seconds.toFixed(3)}"`;
      return c.failure === undefined
        ? `${open}/>`
        : `${open}>\n      <failure message="${xml(c.failure)}"/>\n    </testcase>`;
    })
    .join("\n");
  writeFileSync(
    reportPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="compose-smoke" tests="${String(cases.length)}" failures="${String(failures)}">\n${body}\n  </testsuite>\n</testsuites>\n`,
  );
  return failures;
};

/**
 * Removes the stack and its volumes unless `--keep` was passed.
 * @returns {Promise<number>} 1 when the removal failed, otherwise 0
 */
const cleanup = async () => {
  if (values.keep === true) {
    process.stdout.write(
      `kept project ${project}; remove with docker compose -p ${project} down -v\n`,
    );
    return 0;
  }
  try {
    await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
    return 0;
  } catch (error) {
    process.stderr.write(`cleanup failed: ${String(error)}\n`);
    return 1;
  }
};

let failures = 1;
try {
  await test("stack starts and every service reports healthy", async () => {
    // `--wait` treats finished one-shot jobs as failures, so wait for the
    // long-running services first, then run the settings job to completion.
    const longRunning = ["caddy", "api", "postgres", "stalwart"];
    await compose(
      "up",
      "--detach",
      "--build",
      "--wait",
      "--wait-timeout",
      "300",
      ...longRunning,
    );
    await compose(
      "up",
      "--no-deps",
      "--exit-code-from",
      "stalwart-setup",
      "stalwart-setup",
    );
    const services = (await compose("ps", "--format", "json"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const unhealthy = services.filter((s) => s.Health !== "healthy");
    assert(
      services.length >= 4,
      `expected 4 running services, got ${String(services.length)}`,
    );
    assert(
      unhealthy.length === 0,
      `not healthy: ${unhealthy.map((s) => `${s.Service}=${s.Health || s.State}`).join(", ")}`,
    );
  });

  const httpsPort = await hostPort("caddy", "443");
  const ca = await compose(
    "exec",
    "-T",
    "caddy",
    "cat",
    "/data/caddy/pki/authorities/local/root.crt",
  );
  const adminPassword = (
    await compose(
      "exec",
      "-T",
      "stalwart",
      "cat",
      "/run/opensuite/stalwart-admin/password",
    )
  ).trim();
  const adminAuth = `Basic ${Buffer.from(`admin:${adminPassword}`).toString("base64")}`;

  await test("API liveness through the proxy over verified TLS", async () => {
    const res = await request(httpsPort, ca, "/api/health");
    assert(res.status === 200, `status ${String(res.status)}`);
    assert(JSON.parse(res.body).status === "ok", `body ${res.body}`);
  });

  await test("API readiness through the proxy", async () => {
    const res = await request(httpsPort, ca, "/api/ready");
    assert(res.status === 200, `status ${String(res.status)}: ${res.body}`);
    assert(JSON.parse(res.body).status === "ready", `body ${res.body}`);
  });

  await test("JMAP discovery leads to an authenticated session", async () => {
    const discovery = await request(httpsPort, ca, "/.well-known/jmap");
    assert(
      [301, 302, 307, 308].includes(discovery.status),
      `discovery status ${String(discovery.status)}`,
    );
    const location = new URL(
      String(discovery.headers.location),
      "https://localhost",
    );
    // Stalwart answers an anonymous session request without any account.
    const anonymous = await request(httpsPort, ca, location.pathname);
    assert(
      anonymous.status === 200,
      `anonymous session status ${String(anonymous.status)}`,
    );
    assert(
      Object.keys(JSON.parse(anonymous.body).accounts ?? {}).length === 0,
      "anonymous session exposes accounts",
    );
    const session = await request(httpsPort, ca, location.pathname, {
      authorization: adminAuth,
    });
    assert(session.status === 200, `session status ${String(session.status)}`);
    const body = JSON.parse(session.body);
    assert(
      "urn:ietf:params:jmap:core" in (body.capabilities ?? {}),
      "JMAP core capability missing",
    );
    assert(body.username === "admin", `session user ${String(body.username)}`);
    assert(
      String(body.apiUrl).startsWith("https://localhost/"),
      `apiUrl ${String(body.apiUrl)}`,
    );
    const wrong = await request(httpsPort, ca, location.pathname, {
      authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}`,
    });
    assert(
      wrong.status === 401,
      `wrong password status ${String(wrong.status)}`,
    );
  });

  await test("mail server settings job completed", async () => {
    const setup = (
      await compose("ps", "--all", "--format", "json", "stalwart-setup")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(setup.length === 1, "stalwart-setup container missing");
    assert(
      setup[0].ExitCode === 0,
      `stalwart-setup exit code ${String(setup[0].ExitCode)}`,
    );
    // Idempotent: a second run against the configured server succeeds too.
    await compose(
      "up",
      "--no-deps",
      "--force-recreate",
      "--exit-code-from",
      "stalwart-setup",
      "stalwart-setup",
    );
  });

  await test("a client cannot spoof X-Forwarded-For through the proxy", async () => {
    // The proxy replaces the header; Stalwart would reject this value (400).
    const res = await request(httpsPort, ca, "/.well-known/jmap", {
      "x-forwarded-for": "garbage",
    });
    assert(res.status === 307, `status ${String(res.status)}`);
  });

  for (const kind of ["caldav", "carddav"]) {
    await test(`${kind === "caldav" ? "CalDAV" : "CardDAV"} discovery through the proxy`, async () => {
      const res = await request(httpsPort, ca, `/.well-known/${kind}`);
      assert(
        [301, 302, 307, 308].includes(res.status),
        `status ${String(res.status)}`,
      );
      assert(
        String(res.headers.location).includes("/dav"),
        `location ${String(res.headers.location)}`,
      );
    });
  }

  await test("SMTP listener greets on the published port", async () => {
    const banner = await smtpBanner(await hostPort("stalwart", "25"));
    assert(banner.startsWith("220 "), `banner ${banner.trim()}`);
  });

  await test("unknown paths are not proxied to internal services", async () => {
    const res = await request(httpsPort, ca, "/admin");
    assert(res.status === 404, `status ${String(res.status)}`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  cases.push({ name: "smoke setup", seconds: 0, failure: message });
  process.stdout.write(`FAIL smoke setup: ${message}\n`);
} finally {
  failures = writeReport() + (await cleanup());
}
process.exitCode = failures === 0 ? 0 : 1;
