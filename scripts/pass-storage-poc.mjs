#!/usr/bin/env node
// Disposable proof only. Never use with an existing vault or a production key.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { chromium } from "@playwright/test";

const run = promisify(execFile);
const { values } = parseArgs({ options: { report: { type: "string" } } });
if (!values.report) {
  process.stderr.write(
    "usage: node scripts/pass-storage-poc.mjs --report PATH\n",
  );
  process.exit(2);
}
/** @typedef {{mode: string, name: string, status: string, seconds?: number, reason?: string, prefix?: string}} Result */
/** @type {Result[]} */
const results = [];
const reportPath = values.report;
/** @type {{gitHead: string, workingTreeClean: boolean, images: Record<string, string>}} */
const evidence = { gitHead: "", workingTreeClean: false, images: {} };
async function writeReport() {
  await writeFile(
    reportPath,
    `${JSON.stringify({ schema: 2, evidence, results }, null, 2)}\n`,
  );
}
const requiredB2 = [
  "PASS_B2_TEST_ENDPOINT",
  "PASS_B2_TEST_BUCKET",
  "PASS_B2_TEST_KEY_ID",
  "PASS_B2_TEST_APP_KEY",
];
const b2SetCount = requiredB2.filter((name) =>
  Boolean(process.env[name]),
).length;
const b2Enabled = b2SetCount === requiredB2.length;
const labels = [
  "setup and account",
  "attachment upload and download",
  "Send upload and download",
  "restart persistence",
  "storage outage",
  "outage recovery and integrity",
  "attachment deletion",
  "bucket and local data isolation",
];
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function check(condition, message) {
  if (!condition) throw new ProofError(message);
}
class ProofError extends Error {}
const stamp = () => randomBytes(12).toString("hex");
/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const image = "esuno-vaultwarden-s3-poc-not-for-production:1.37.4";
const officialImage =
  "vaultwarden/server@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055";
/** @type {Record<string, string>} */
const hostEnv = {};
for (const key of [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
]) {
  const value = process.env[key];
  if (value !== undefined) hostEnv[key] = value;
}
/** @param {import("node:net").Server} server */
async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}
/** @param {import("node:net").Server} server @param {string} host */
async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(undefined));
  });
}
/** @param {string} text @returns {unknown} */
function parseJson(text) {
  return JSON.parse(text);
}
/** @param {unknown} value @param {string} key */
function stringField(value, key) {
  /** @type {unknown} */
  const field =
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return typeof field === "string" ? field : "";
}
/** @typedef {{id?: string, attachments?: {id: string}[]}} Item */
/** @param {string} text @returns {Item} */
function itemJson(text) {
  const value = parseJson(text);
  const id = stringField(value, "id");
  /** @type {unknown} */
  const attachments =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "attachments")
      : undefined;
  return {
    id,
    ...(Array.isArray(attachments)
      ? {
          attachments: attachments.map((entry) => ({
            id: stringField(entry, "id"),
          })),
        }
      : {}),
  };
}

/** @param {S3Client} client @param {string} bucket @param {string} prefix */
async function cleanupPrefix(client, bucket, prefix) {
  // Every page depends on the marker returned by the preceding page.
  let keyMarker, uploadIdMarker;
  /* oxlint-disable eslint/no-await-in-loop -- Pagination and aborts must finish before continuing. */
  do {
    /** @type {import("@aws-sdk/client-s3").ListMultipartUploadsCommandOutput} */
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
      }),
    );
    await Promise.all(
      (page.Uploads ?? []).map(async (upload) => {
        check(
          upload.Key && upload.UploadId,
          "multipart upload is missing its identity",
        );
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }),
    );
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
  let versionKey, versionId;
  do {
    /** @type {import("@aws-sdk/client-s3").ListObjectVersionsCommandOutput} */
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(versionKey ? { KeyMarker: versionKey } : {}),
        ...(versionId ? { VersionIdMarker: versionId } : {}),
      }),
    );
    const objects = [
      ...(page.Versions ?? []),
      ...(page.DeleteMarkers ?? []),
    ].map(({ Key, VersionId }) => {
      check(Key && VersionId, "object version is missing its identity");
      return { Key, VersionId };
    });
    if (objects.length) {
      const deleted = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      check(!deleted.Errors?.length, "provider reported deletion errors");
    }
    versionKey = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionId = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (versionKey);
  /* oxlint-enable eslint/no-await-in-loop */
  const remaining = await client.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  check(
    !(
      remaining.Versions?.length ||
      remaining.DeleteMarkers?.length ||
      uploads.Uploads?.length
    ),
    "objects or uploads remain under test prefix",
  );
}

/** Start an HTTP relay on the selected host interface. @param {string} address @param {number} targetPort @param {() => boolean} unavailable */
async function startRelay(address, targetPort, unavailable) {
  const relay = http.createServer((req, res) => {
    if (unavailable()) {
      res.writeHead(503);
      res.end();
      return;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await listen(relay, address);
  return relay;
}

/** @param {import("node:net").Server} server */
function serverPort(server) {
  const addr = server.address();
  check(addr && typeof addr !== "string", "listener has no TCP port");
  return addr.port;
}

const repo = process.cwd();
const composeFile = path.join(repo, "test-support/pass-storage/compose.yaml");
const bwPath = path.join(repo, "node_modules/.bin/bw");
/** @type {() => Promise<void | boolean>} */
let activeCleanup = async () => {};
const runState = { interrupted: false };
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    runState.interrupted = true;
    process.stderr.write(`Interrupted (${sig}); removing test resources.\n`);
    void (async () => {
      await activeCleanup();
      results.push({
        mode: "runner",
        name: "interrupted",
        status: "fail",
        reason: `received ${sig}`,
      });
      results.push({
        mode: "b2",
        name: "provider proof",
        status: "skip",
        reason: "not run: interrupted",
      });
      await writeReport().catch(() => {});
      process.exit(1);
    })();
  });

/** @param {"official" | "localstack" | "b2"} mode */
async function executeMode(mode) {
  const project = `pass-storage-${stamp()}`;
  const prefixBase =
    mode === "b2"
      ? process.env["PASS_B2_TEST_PREFIX"] || "pass-storage-tests/"
      : "pass-storage-tests/";
  check(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(prefixBase) &&
      !prefixBase.includes("..") &&
      !prefixBase.includes("//"),
    "test prefix must be a nonempty safe path ending in /",
  );
  const prefix = `${prefixBase}${project}/`;
  const bucket =
    mode === "b2" ? process.env["PASS_B2_TEST_BUCKET"] : "opensuite-pass-proof";
  const key = mode === "b2" ? process.env["PASS_B2_TEST_KEY_ID"] : "test";
  const secret = mode === "b2" ? process.env["PASS_B2_TEST_APP_KEY"] : "test";
  const endpoint =
    mode === "b2"
      ? process.env["PASS_B2_TEST_ENDPOINT"]
      : "http://localstack:4566";
  check(
    bucket && key && secret && endpoint,
    "test configuration is incomplete",
  );
  const url = new URL(endpoint);
  check(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (mode !== "b2" || url.protocol === "https:"),
    "endpoint must have no credentials or query, and B2 must use HTTPS",
  );
  const region =
    mode === "b2"
      ? process.env["PASS_B2_TEST_REGION"] ||
        /^s3\.([^.]+)\.backblazeb2\.com$/.exec(url.hostname)?.[1]
      : "us-east-1";
  check(region, "cannot infer B2 region; set PASS_B2_TEST_REGION");
  const temp = await mkdtemp(path.join(os.tmpdir(), "pass-storage-"));
  const params = new URLSearchParams({
    endpoint,
    region,
    enable_virtual_host_style: "false",
    default_storage_class: "STANDARD",
  });
  /** @param {string} part */
  const uri = (part) => `s3://${bucket}/${prefix}${part}?${params.toString()}`;
  const env = {
    ...hostEnv,
    POC_IMAGE: mode === "official" ? officialImage : image,
    POC_ATTACHMENTS_URI: uri("attachments"),
    POC_SENDS_URI: uri("sends"),
    POC_ACCESS_KEY: key,
    POC_SECRET_KEY: secret,
    POC_DOMAIN: "http://localhost",
  };
  const baseArgs = [
    "compose",
    "--project-name",
    project,
    "--file",
    composeFile,
  ];
  const controller = new AbortController();
  /** @param {AbortSignal | undefined} signal @param {...string} args */
  const dockerRaw = async (signal, ...args) =>
    (
      await run("docker", args, {
        env,
        timeout: 360000,
        maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      })
    ).stdout;
  /** @param {...string} args */
  const docker = (...args) => dockerRaw(controller.signal, ...args);
  /** @param {...string} args */
  const compose = (...args) => docker(...baseArgs, ...args);
  /** @param {...string} args */
  const cleanDocker = (...args) => dockerRaw(undefined, ...args);
  /** @type {S3Client | undefined} */
  let s3;
  /** @type {https.Server | undefined} */
  let server;
  /** @type {http.Server | undefined} */
  let storageProxy;
  let storageUnavailable = false;
  /** @type {import("@playwright/test").Browser | undefined} */
  let browser;
  /** @type {Promise<boolean> | undefined} */
  let cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      let failed = false;
      let stackStopped = false;
      controller.abort();
      if (mode === "official")
        await cleanDocker("rm", "-f", `${project}-official-data`).catch(
          () => "",
        );
      if (browser)
        await browser.close().catch(() => {
          failed = true;
        });
      if (server) await closeServer(server);
      if (storageProxy) await closeServer(storageProxy);
      try {
        await cleanDocker(
          ...baseArgs,
          "down",
          "--volumes",
          "--remove-orphans",
          "--timeout",
          "10",
        );
        const filter = `label=com.docker.compose.project=${project}`;
        /* oxlint-disable eslint/no-await-in-loop -- Check each Docker resource kind after teardown. */
        for (const args of [
          ["ps", "-aq"],
          ["volume", "ls", "-q"],
          ["network", "ls", "-q"],
        ]) {
          check(
            !(await cleanDocker(...args, "--filter", filter)).trim(),
            "Compose resources remain",
          );
        }
        /* oxlint-enable eslint/no-await-in-loop */
        stackStopped = true;
      } catch {
        failed = true;
        process.stderr.write(`Cleanup failed for project ${project}.\n`);
      }
      if (mode === "b2" && s3 && stackStopped) {
        try {
          await cleanupPrefix(s3, bucket, prefix);
        } catch {
          failed = true;
          process.stderr.write(
            "B2 prefix cleanup failed; inspect the reported prefix.\n",
          );
        }
      }
      if (mode === "b2" && s3 && !stackStopped) {
        failed = true;
        process.stderr.write(
          "B2 prefix was not purged because Compose cleanup failed.\n",
        );
      }
      s3?.destroy();
      await rm(temp, { recursive: true, force: true }).catch(() => {
        failed = true;
      });
      results.push({
        mode,
        name: "cleanup",
        status: failed ? "fail" : "pass",
        ...(failed ? { reason: "resource or prefix cleanup failed" } : {}),
      });
      return failed;
    })());
  activeCleanup = cleanup;
  // Record the generated prefix in the report so an operator can recover from
  // a failed B2 cleanup without exposing the credentials or endpoint.
  const modeInfo = { mode, prefix };
  results.push({ ...modeInfo, name: "run", status: "info" });
  // Persist the prefix before any provider writes, even if this process is killed.
  await writeReport();
  let phase = "initialization";
  /** @param {string | undefined} name @param {() => Promise<void>} fn */
  const test = async (name, fn) => {
    check(name, "missing case name");
    const start = Date.now();
    try {
      await fn();
      results.push({
        mode,
        name,
        status: "pass",
        seconds: (Date.now() - start) / 1000,
      });
      process.stdout.write(`PASS ${mode}: ${name}\n`);
      return true;
    } catch (error) {
      // Only deliberately constructed assertion messages are reported. Child
      // process and provider errors can contain secrets or URLs: never print them.
      const reason =
        error instanceof ProofError
          ? error.message
          : `${phase} failed; inspect prerequisites and rerun`;
      results.push({
        mode,
        name,
        status: "fail",
        reason,
        seconds: (Date.now() - start) / 1000,
      });
      process.stdout.write(`FAIL ${mode}: ${name}: ${reason}\n`);
      return false;
    }
  };
  /** @type {Record<string, string>} */
  let cliEnv = {};
  let port = 0,
    root = "",
    itemId = "",
    attachmentId = "",
    sendUrl = "";
  /** @type {string[]} */
  let originalKeys = [];
  const attachmentBytes = randomBytes(8192);
  const sendBytes = randomBytes(6144);
  const attachmentFile = path.join(temp, "attachment.bin");
  const sendFile = path.join(temp, "send.bin");
  const downloadFile = path.join(temp, "download.bin");
  const list = async () => {
    check(s3, "S3 client is unavailable");
    /** @type {string | undefined} */
    let token;
    /** @type {string[]} */
    const keys = [];
    /* oxlint-disable eslint/no-await-in-loop -- S3 continuation tokens are sequential. */
    do {
      /** @type {import("@aws-sdk/client-s3").ListObjectsV2CommandOutput} */
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      keys.push(
        ...(page.Contents ?? []).flatMap((x) => (x.Key ? [x.Key] : [])),
      );
      token = page.NextContinuationToken;
    } while (token);
    /* oxlint-enable eslint/no-await-in-loop */
    return keys.toSorted((a, b) => a.localeCompare(b));
  };
  /** @param {...string} args */
  const cli = async (...args) => {
    try {
      return (
        await run(bwPath, [...args, "--nointeraction"], {
          env: cliEnv,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
          signal: controller.signal,
        })
      ).stdout.trim();
    } catch {
      throw new ProofError(`Bitwarden CLI ${args[0]} failed`);
    }
  };
  const downloadAttachment = async () => {
    await rm(downloadFile, { force: true });
    await cli(
      "get",
      "attachment",
      attachmentId,
      "--itemid",
      itemId,
      "--output",
      downloadFile,
    );
    return readFile(downloadFile);
  };
  const downloadSend = async () => {
    await rm(downloadFile, { force: true });
    await cli("receive", sendUrl, "--output", downloadFile);
    return readFile(downloadFile);
  };
  const setup = async () =>
    test(labels[0], async () => {
      phase = "POC image inspection (build the image first)";
      await run(
        "docker",
        ["image", "inspect", mode === "official" ? officialImage : image],
        { env: hostEnv, timeout: 30000 },
      );
      await writeFile(attachmentFile, attachmentBytes);
      await writeFile(sendFile, sendBytes);
      const keyPath = path.join(temp, "tls.key");
      const certPath = path.join(temp, "tls.crt");
      await run(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { env: hostEnv, timeout: 30000 },
      );
      phase = "PostgreSQL and object storage startup";
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "240",
        "postgres",
        ...(mode !== "b2" ? ["localstack"] : []),
      );
      let hostEndpoint = endpoint;
      if (mode !== "b2") {
        const mapped = (await compose("port", "localstack", "4566"))
          .trim()
          .match(/:(\d+)$/)?.[1];
        check(mapped, "LocalStack host port unavailable");
        hostEndpoint = `http://127.0.0.1:${mapped}`;
        // Vaultwarden returns presigned URLs for S3-backed downloads. The
        // container and host CLI must reach the same endpoint and signed Host.
        // Bind only to Docker's host bridge, never to a public interface.
        const gateway = (
          await docker(
            "network",
            "inspect",
            "bridge",
            "--format",
            "{{(index .IPAM.Config 0).Gateway}}",
          )
        ).trim();
        check(
          /^\d+\.\d+\.\d+\.\d+$/.test(gateway),
          "Docker bridge gateway unavailable",
        );
        storageProxy = await startRelay(
          gateway,
          Number(mapped),
          () => storageUnavailable,
        );
        params.set("endpoint", `http://${gateway}:${serverPort(storageProxy)}`);
        env.POC_ATTACHMENTS_URI = uri("attachments");
        env.POC_SENDS_URI = uri("sends");
      }
      phase = "bucket setup";
      s3 = new S3Client({
        endpoint: hostEndpoint,
        region,
        forcePathStyle: true,
        credentials: { accessKeyId: key, secretAccessKey: secret },
        maxAttempts: 2,
      });
      if (mode !== "b2")
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      phase = "Vaultwarden startup";
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "240",
        "vaultwarden",
      );
      await compose("up", "-d", "--wait", "--wait-timeout", "240", "gateway");
      port = Number(
        (await compose("port", "gateway", "80")).trim().match(/:(\d+)$/)?.[1],
      );
      check(port, "Vaultwarden host port unavailable");
      server = https.createServer(
        { key: await readFile(keyPath), cert: await readFile(certPath) },
        (req, res) => {
          const upstream = http.request(
            {
              host: "127.0.0.1",
              port,
              path: req.url,
              method: req.method,
              headers: { ...req.headers, "x-forwarded-proto": "https" },
            },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", () => {
            res.writeHead(502);
            res.end();
          });
          req.pipe(upstream);
        },
      );
      await listen(server, "127.0.0.1");
      root = `https://localhost:${serverPort(server)}`;
      const email = `proof-${stamp()}@example.invalid`;
      const password = `Proof-${stamp()}-Aa9!`;
      cliEnv = {
        ...hostEnv,
        BITWARDENCLI_APPDATA_DIR: path.join(temp, "cli"),
        NODE_EXTRA_CA_CERTS: certPath,
        PASS_FIXTURE_PASSWORD: password,
      };
      phase = "web vault signup";
      browser = await chromium.launch({
        executablePath: chromium.executablePath(),
        env: hostEnv,
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      page.setDefaultTimeout(120000);
      phase = "web vault page load";
      await page.goto(root, { timeout: 120000 });
      phase = "web vault registration form";
      await page.getByRole("link", { name: "Create account" }).click();
      await page.locator("input[type=email]").fill(email);
      await page.getByRole("button", { name: "Continue" }).click();
      phase = "web vault password form";
      await page.locator("#input-password-form_new-password").fill(password);
      await page
        .locator("#input-password-form_new-password-confirm")
        .fill(password);
      await page.locator("#input-password-form_check-for-breaches").uncheck();
      await page.getByRole("button", { name: "Create account" }).click();
      phase = "web vault account creation";
      await page
        .getByText("Your new account has been created!")
        .waitFor({ timeout: 120000 });
      await browser.close();
      browser = undefined;
      phase = "Bitwarden CLI login and item creation";
      await cli("config", "server", root);
      cliEnv["BW_SESSION"] = await cli(
        "login",
        email,
        "--passwordenv",
        "PASS_FIXTURE_PASSWORD",
        "--raw",
      );
      const template = {
        name: "Disposable storage proof",
        type: 2,
        secureNote: { type: 0 },
      };
      const item = itemJson(
        await cli(
          "create",
          "item",
          Buffer.from(JSON.stringify(template)).toString("base64"),
        ),
      );
      itemId = item.id ?? "";
      check(itemId, "CLI did not return an item ID");
    });
  const runCases = async () => {
    if (mode === "official") {
      await test("official DATA_FOLDER rejects S3", async () => {
        let output = "";
        try {
          await docker(
            "run",
            "--rm",
            "--name",
            `${project}-official-data`,
            "-e",
            "I_REALLY_WANT_VOLATILE_STORAGE=true",
            "-e",
            "DATA_FOLDER=s3://fixture/prefix",
            "-e",
            "DATABASE_URL=sqlite:///tmp/test.sqlite3",
            officialImage,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            "stdout" in error &&
            typeof error.stdout === "string"
          )
            output += error.stdout;
          if (
            error instanceof Error &&
            "stderr" in error &&
            typeof error.stderr === "string"
          )
            output += error.stderr;
        }
        check(
          output.includes("S3 support is not enabled"),
          "official DATA_FOLDER did not report disabled S3",
        );
      });
    }
    const ready = await setup();
    if (!ready) {
      for (const name of mode === "official"
        ? ["official attachment upload rejects S3"]
        : [...labels.slice(1), "multipart cleanup"])
        results.push({ mode, name, status: "skip", reason: "setup failed" });
      return;
    }
    if (mode === "official") {
      await test("official attachment upload rejects S3", async () => {
        let rejected = false;
        try {
          await cli(
            "create",
            "attachment",
            "--file",
            attachmentFile,
            "--itemid",
            itemId,
          );
        } catch {
          rejected = true;
        }
        check(
          rejected,
          "official image unexpectedly accepted an S3 attachment",
        );
        const logs = await compose("logs", "--no-color", "vaultwarden");
        check(
          logs.includes("S3 support is not enabled"),
          "official attachment failure did not report disabled S3",
        );
      });
      return;
    }
    if (!(await runTransferCases())) {
      for (const name of labels.slice(3))
        results.push({
          mode,
          name,
          status: "skip",
          reason: "upload prerequisite failed",
        });
      results.push({
        mode,
        name: "multipart cleanup",
        status: "skip",
        reason: "upload prerequisite failed",
      });
      return;
    }
    await runRestartCase();
    await runOutageRecoveryCases();
    await runIsolationCases();
  };
  const runTransferCases = async () => {
    phase = "attachment API";
    const attachmentOk = await test(labels[1], async () => {
      const item = itemJson(
        await cli(
          "create",
          "attachment",
          "--file",
          attachmentFile,
          "--itemid",
          itemId,
        ),
      );
      attachmentId = item.attachments?.[0]?.id ?? "";
      check(attachmentId, "CLI did not return attachment ID");
      check(
        (await downloadAttachment()).equals(attachmentBytes),
        "downloaded attachment differs from fixture",
      );
    });
    phase = "Send API";
    const sendOk = await test(labels[2], async () => {
      const sendOutput = await cli("send", "--file", sendFile, "--raw");
      // Current CLI releases return a Send object even with --raw; older
      // versions can return the URL directly.
      sendUrl = sendOutput.startsWith("{")
        ? stringField(parseJson(sendOutput), "accessUrl")
        : sendOutput;
      check(
        typeof sendUrl === "string" && sendUrl.startsWith("https://"),
        "CLI did not return a Send URL",
      );
      check(
        (await downloadSend()).equals(sendBytes),
        "downloaded Send differs from fixture",
      );
    });
    return attachmentOk && sendOk;
  };
  const runRestartCase = async () => {
    phase = "restart and download";
    await test(labels[3], async () => {
      await compose("restart", "vaultwarden");
      port = Number(
        (await compose("port", "gateway", "80")).trim().match(/:(\d+)$/)?.[1],
      );
      check(port, "Vaultwarden port unavailable after restart");
      let readyAfterRestart = false;
      /* oxlint-disable eslint/no-await-in-loop -- Retry only after the preceding readiness check. */
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/alive`);
          if (response.ok) {
            readyAfterRestart = true;
            break;
          }
        } catch {}
        await delay(1000);
      }
      /* oxlint-enable eslint/no-await-in-loop */
      check(
        readyAfterRestart,
        "Vaultwarden did not become ready after restart",
      );
      check(
        (await downloadAttachment()).equals(attachmentBytes),
        "attachment changed after restart",
      );
      check(
        (await downloadSend()).equals(sendBytes),
        "Send changed after restart",
      );
    });
  };
  const runOutageRecoveryCases = async () => {
    phase = "bucket listing";
    originalKeys = await list();
    const container = (await compose("ps", "-q", "vaultwarden")).trim();
    const outage = { disconnected: false };
    phase = "storage outage";
    await test(labels[4], async () => {
      await docker("network", "disconnect", `${project}_s3`, container);
      outage.disconnected = true;
      port = Number(
        (await compose("port", "gateway", "80")).trim().match(/:(\d+)$/)?.[1],
      );
      check(
        port && (await fetch(`http://127.0.0.1:${port}/alive`)).ok,
        "vault became unreachable during storage outage",
      );
      await compose(
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        "vaultwarden",
        "-d",
        "vaultwarden",
      );
      const storageEndpoint = params.get("endpoint");
      check(storageEndpoint, "storage endpoint is missing");
      if (mode !== "b2") {
        const relayResponse = await fetch(storageEndpoint, {
          signal: AbortSignal.timeout(5000),
        });
        check(
          relayResponse.status < 500,
          "storage relay was unavailable before the server upload",
        );
      }
      let serverCannotReachStorage = false;
      try {
        await compose(
          "exec",
          "-T",
          "vaultwarden",
          "curl",
          "--silent",
          "--show-error",
          "--max-time",
          "5",
          "-o",
          "/dev/null",
          storageEndpoint,
        );
      } catch {
        serverCannotReachStorage = true;
      }
      check(
        serverCannotReachStorage,
        "Vaultwarden can still reach the storage endpoint",
      );
      let readFailed = false,
        writeFailed = false;
      storageUnavailable = true;
      try {
        await downloadAttachment();
      } catch {
        readFailed = true;
      } finally {
        storageUnavailable = false;
      }
      try {
        await cli(
          "create",
          "attachment",
          "--file",
          attachmentFile,
          "--itemid",
          itemId,
        );
      } catch {
        writeFailed = true;
      }
      check(writeFailed, "expected attachment upload to report an error");
      if (mode !== "b2")
        check(
          readFailed,
          "expected attachment download to report an error when the endpoint is unavailable to the client",
        );
      else if (!readFailed)
        results.push({
          mode,
          name: "presigned read during server outage",
          status: "info",
          reason: "client could still reach B2 directly",
        });
    });
    storageUnavailable = false;
    if (outage.disconnected) {
      await docker("network", "connect", `${project}_s3`, container);
      port = Number(
        (await compose("port", "gateway", "80")).trim().match(/:(\d+)$/)?.[1],
      );
    }
    phase = "storage recovery";
    await test(labels[5], async () => {
      check(
        (await downloadAttachment()).equals(attachmentBytes),
        "original attachment changed after outage",
      );
      check(
        (await downloadSend()).equals(sendBytes),
        "original Send changed after outage",
      );
      check(
        JSON.stringify(await list()) === JSON.stringify(originalKeys),
        "bucket objects changed during failed upload",
      );
      await cli("sync");
      const item = itemJson(await cli("get", "item", itemId));
      check(
        item.attachments?.length === 1 &&
          item.attachments[0]?.id === attachmentId,
        "failed upload left attachment metadata behind",
      );
      const recoveryBytes = randomBytes(4096);
      const recoveryFile = path.join(temp, "recovery.bin");
      await writeFile(recoveryFile, recoveryBytes);
      const before = new Set((item.attachments ?? []).map((entry) => entry.id));
      const updated = itemJson(
        await cli(
          "create",
          "attachment",
          "--file",
          recoveryFile,
          "--itemid",
          itemId,
        ),
      );
      const recoveryId = updated.attachments?.find(
        (entry) => !before.has(entry.id),
      )?.id;
      check(recoveryId, "recovery upload did not return a new attachment");
      await rm(downloadFile, { force: true });
      await cli(
        "get",
        "attachment",
        recoveryId,
        "--itemid",
        itemId,
        "--output",
        downloadFile,
      );
      check(
        (await readFile(downloadFile)).equals(recoveryBytes),
        "recovery attachment differs from fixture",
      );
      await cli("delete", "attachment", recoveryId, "--itemid", itemId);
      check(
        JSON.stringify(await list()) === JSON.stringify(originalKeys),
        "recovery attachment object remains after deletion",
      );
    });
  };
  const runIsolationCases = async () => {
    phase = "attachment deletion";
    await test(labels[6], async () => {
      const attachmentKeys = (await list()).filter((k) =>
        k.startsWith(`${prefix}attachments/`),
      );
      const attachmentKey = attachmentKeys[0];
      check(
        attachmentKeys.length === 1 && attachmentKey,
        "expected one attachment object before deletion",
      );
      await cli("delete", "attachment", attachmentId, "--itemid", itemId);
      check(
        !(await list()).includes(attachmentKey),
        "attachment object remains after deletion",
      );
    });
    phase = "bucket and local data isolation";
    await test(labels[7], async () => {
      const keys = await list();
      check(
        originalKeys.length === 2 &&
          originalKeys.filter((k) => k.startsWith(`${prefix}attachments/`))
            .length === 1 &&
          originalKeys.filter((k) => k.startsWith(`${prefix}sends/`)).length ===
            1,
        "expected exactly one attachment and one Send object under the dedicated prefix",
      );
      if (mode !== "b2") {
        check(s3, "S3 client is unavailable");
        const entireBucket = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        check(
          (entireBucket.Contents ?? []).every((entry) =>
            entry.Key?.startsWith(prefix),
          ),
          "objects appeared outside the dedicated prefix",
        );
      }
      check(
        keys.length === 1 && keys[0]?.startsWith(`${prefix}sends/`),
        "unexpected objects or Send object missing",
      );
      const config = await fetch(`http://127.0.0.1:${port}/admin/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      check(config.ok, `admin config save returned ${config.status}`);
      await compose(
        "exec",
        "-T",
        "vaultwarden",
        "sh",
        "-c",
        'test -s /data/rsa_key.pem && test -s /data/config.json && for dir in /data/attachments /data/sends; do if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then exit 1; fi; done',
      );
      check(
        (await list()).every((k) => !/rsa_key|config\.json/.test(k)),
        "server key or configuration appeared in bucket",
      );
    });
    await test("multipart cleanup", async () => {
      check(s3, "S3 client is unavailable");
      const cleanupTestPrefix = `${prefix}cleanup-fixture/`;
      const created = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: `${cleanupTestPrefix}partial`,
        }),
      );
      check(created.UploadId, "multipart upload was not created");
      await cleanupPrefix(s3, bucket, cleanupTestPrefix);
    });
  };
  try {
    await runCases();
  } finally {
    await cleanup();
    activeCleanup = async () => {};
  }
}

try {
  evidence.gitHead = (
    await run("git", ["rev-parse", "HEAD"], { env: hostEnv })
  ).stdout.trim();
  evidence.workingTreeClean = !(
    await run("git", ["status", "--porcelain"], { env: hostEnv })
  ).stdout.trim();
  const imageReferences = [
    ["official", officialImage],
    ["poc", image],
    [
      "postgres",
      "postgres:18.6@sha256:979bccfde35445db618c65107d27d08c6c21339d8dc3ad4c830c6633947be0e4",
    ],
    [
      "localstack",
      "localstack/localstack:4.14.0@sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a",
    ],
    [
      "gateway",
      "caddy:2.11.7@sha256:5e5286cb37d44086d651a5363f05f43a692ce4d649d88fb1bd844579f45fa9e8",
    ],
  ];
  await Promise.all(
    imageReferences.map(async ([name, reference]) => {
      check(name && reference, "missing image reference");
      evidence.images[name] = (
        await run(
          "docker",
          ["image", "inspect", reference, "--format", "{{.Id}}"],
          { env: hostEnv },
        )
      ).stdout.trim();
    }),
  );
  await writeReport();
  await executeMode("official");
  await executeMode("localstack");
  if (b2Enabled && !runState.interrupted) await executeMode("b2");
  else
    results.push({
      mode: "b2",
      name: "provider proof",
      status: "skip",
      reason: runState.interrupted
        ? "not run: interrupted"
        : b2SetCount === 0
          ? "not run: no credentials"
          : "not run: partial credentials",
    });
} catch {
  results.push({
    mode: "runner",
    name: "setup",
    status: "fail",
    reason: "invalid configuration or unexpected setup failure",
  });
  await activeCleanup();
} finally {
  await writeReport();
}
process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
