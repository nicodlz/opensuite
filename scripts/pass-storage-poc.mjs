#!/usr/bin/env node
// Disposable proof only. Never use with an existing vault or a production key.
// The external CLI and provider responses are checked at runtime. Operations in
// pagination and retry loops must run in order.
/* oxlint-disable eslint/no-await-in-loop, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unnecessary-condition, typescript/no-misused-promises, typescript/restrict-template-expressions */
// @ts-nocheck
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
  CreateBucketCommand,
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
const results = [];
const requiredB2 = [
  "PASS_B2_TEST_ENDPOINT",
  "PASS_B2_TEST_BUCKET",
  "PASS_B2_TEST_KEY_ID",
  "PASS_B2_TEST_APP_KEY",
];
const b2Enabled = requiredB2.every((name) => Boolean(process.env[name]));
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const stamp = () => randomBytes(12).toString("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  if (!condition) {
    const error = new Error(message);
    error.safeReason = message;
    throw error;
  }
};
const image = "opensuite-vaultwarden-s3-poc:1.37.4";
const repo = process.cwd();
const composeFile = path.join(repo, "test-support/pass-storage/compose.yaml");
const bwPath = path.join(repo, "node_modules/.bin/bw");
let activeCleanup = async () => {};
let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    interrupted = true;
    process.stderr.write(`Interrupted (${sig}); removing test resources.\n`);
    void activeCleanup().finally(async () => {
      results.push({
        mode: "runner",
        name: "interrupted",
        status: "fail",
        reason: `received ${sig}`,
      });
      await writeFile(
        values.report,
        `${JSON.stringify({ schema: 1, results }, null, 2)}\n`,
      ).catch(() => {});
      process.exit(1);
    });
  });

async function executeMode(mode) {
  const project = `pass-storage-${stamp()}`;
  const prefixBase =
    mode === "b2"
      ? process.env.PASS_B2_TEST_PREFIX || "pass-storage-tests/"
      : "pass-storage-tests/";
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(prefixBase) &&
      !prefixBase.includes("..") &&
      !prefixBase.includes("//"),
    "test prefix must be a nonempty safe path ending in /",
  );
  const prefix = `${prefixBase}${project}/`;
  const bucket =
    mode === "b2" ? process.env.PASS_B2_TEST_BUCKET : "opensuite-pass-proof";
  const key = mode === "b2" ? process.env.PASS_B2_TEST_KEY_ID : "test";
  const secret = mode === "b2" ? process.env.PASS_B2_TEST_APP_KEY : "test";
  const endpoint =
    mode === "b2"
      ? process.env.PASS_B2_TEST_ENDPOINT
      : "http://localstack:4566";
  const url = new URL(endpoint);
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (mode === "localstack" || url.protocol === "https:"),
    "endpoint must have no credentials or query, and B2 must use HTTPS",
  );
  const region =
    mode === "b2"
      ? process.env.PASS_B2_TEST_REGION ||
        /^s3\.([^.]+)\.backblazeb2\.com$/.exec(url.hostname)?.[1]
      : "us-east-1";
  assert(region, "cannot infer B2 region; set PASS_B2_TEST_REGION");
  const temp = await mkdtemp(path.join(os.tmpdir(), "pass-storage-"));
  const params = new URLSearchParams({
    endpoint,
    region,
    enable_virtual_host_style: "false",
    default_storage_class: "STANDARD",
  });
  const uri = (part) => `s3://${bucket}/${prefix}${part}?${params}`;
  const env = {
    ...process.env,
    POC_IMAGE: image,
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
  const dockerRaw = async (signal, ...args) =>
    (
      await run("docker", args, {
        env,
        timeout: 360000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      })
    ).stdout;
  const docker = (...args) => dockerRaw(controller.signal, ...args);
  const compose = (...args) => docker(...baseArgs, ...args);
  const cleanDocker = (...args) => dockerRaw(undefined, ...args);
  let s3;
  let server;
  let storageProxy;
  let storageUnavailable = false;
  let browser;
  let cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      let failed = false;
      controller.abort();
      if (browser)
        await browser.close().catch(() => {
          failed = true;
        });
      if (server) await new Promise((resolve) => server.close(resolve));
      if (storageProxy)
        await new Promise((resolve) => storageProxy.close(resolve));
      if (mode === "b2" && s3) {
        try {
          // The prefix is unique to this run. Remove all versions and delete markers,
          // including partial uploads that completed before a later failure.
          let keyMarker, versionIdMarker;
          do {
            const page = await s3.send(
              new ListObjectVersionsCommand({
                Bucket: bucket,
                Prefix: prefix,
                KeyMarker: keyMarker,
                VersionIdMarker: versionIdMarker,
              }),
            );
            const objects = [
              ...(page.Versions ?? []),
              ...(page.DeleteMarkers ?? []),
            ].map(({ Key, VersionId }) => ({ Key, VersionId }));
            if (objects.length) {
              const deleted = await s3.send(
                new DeleteObjectsCommand({
                  Bucket: bucket,
                  Delete: { Objects: objects, Quiet: true },
                }),
              );
              assert(
                !deleted.Errors?.length,
                "provider reported deletion errors",
              );
            }
            keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
            versionIdMarker = page.IsTruncated
              ? page.NextVersionIdMarker
              : undefined;
          } while (keyMarker);
          const remaining = await s3.send(
            new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }),
          );
          assert(
            !(remaining.Versions?.length || remaining.DeleteMarkers?.length),
            "objects remain under test prefix",
          );
        } catch {
          failed = true;
          process.stderr.write(
            "B2 prefix cleanup failed; inspect the generated test prefix using provider tools.\n",
          );
        }
      }
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
        for (const args of [
          ["ps", "-aq"],
          ["volume", "ls", "-q"],
          ["network", "ls", "-q"],
        ]) {
          assert(
            !(await cleanDocker(...args, "--filter", filter)).trim(),
            "Compose resources remain",
          );
        }
      } catch {
        failed = true;
        process.stderr.write(`Cleanup failed for project ${project}.\n`);
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
  await writeFile(
    values.report,
    `${JSON.stringify({ schema: 1, results }, null, 2)}\n`,
  );
  let phase = "initialization";
  const test = async (name, fn) => {
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
        error?.safeReason || `${phase} failed; inspect prerequisites and rerun`;
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
  let cliEnv, port, root, itemId, attachmentId, sendUrl, originalKeys;
  const attachmentBytes = randomBytes(8192);
  const sendBytes = randomBytes(6144);
  const attachmentFile = path.join(temp, "attachment.bin");
  const sendFile = path.join(temp, "send.bin");
  const downloadFile = path.join(temp, "download.bin");
  const list = async () => {
    let token;
    const keys = [];
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      keys.push(...(page.Contents ?? []).map((x) => x.Key));
      token = page.NextContinuationToken;
    } while (token);
    return keys.toSorted((a, b) => a.localeCompare(b));
  };
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
    } catch (cause) {
      const error = new Error("Bitwarden CLI failed");
      error.safeReason = `Bitwarden CLI ${args[0]} failed (exit ${typeof cause.code === "number" ? cause.code : "unknown"})`;
      throw error;
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
  try {
    const ready = await test(labels[0], async () => {
      phase = "POC image inspection (build the image first)";
      await run("docker", ["image", "inspect", image], { timeout: 30000 });
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
        { timeout: 30000 },
      );
      phase = "PostgreSQL and object storage startup";
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "240",
        "postgres",
        ...(mode === "localstack" ? ["localstack"] : []),
      );
      let hostEndpoint = endpoint;
      if (mode === "localstack") {
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
        storageProxy = http.createServer((req, res) => {
          if (storageUnavailable) {
            res.writeHead(503);
            res.end();
            return;
          }
          const upstream = http.request(
            {
              host: "127.0.0.1",
              port: Number(mapped),
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
        await new Promise((resolve, reject) => {
          storageProxy.once("error", reject);
          storageProxy.listen(0, gateway, resolve);
        });
        params.set(
          "endpoint",
          `http://${gateway}:${storageProxy.address().port}`,
        );
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
      if (mode === "localstack")
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
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      root = `https://localhost:${server.address().port}`;
      const email = `proof-${stamp()}@example.invalid`;
      const password = `Proof-${stamp()}-Aa9!`;
      cliEnv = {
        ...process.env,
        BITWARDENCLI_APPDATA_DIR: path.join(temp, "cli"),
        NODE_EXTRA_CA_CERTS: certPath,
        PASS_FIXTURE_PASSWORD: password,
      };
      phase = "web vault signup";
      browser = await chromium.launch({
        executablePath: chromium.executablePath(),
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      page.setDefaultTimeout(60000);
      await page.goto(root);
      await page.getByRole("link", { name: "Create account" }).click();
      await page.locator("input[type=email]").fill(email);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("#input-password-form_new-password").fill(password);
      await page
        .locator("#input-password-form_new-password-confirm")
        .fill(password);
      await page.locator("#input-password-form_check-for-breaches").uncheck();
      await page.getByRole("button", { name: "Create account" }).click();
      await page
        .getByText("Your new account has been created!")
        .waitFor({ timeout: 120000 });
      await browser.close();
      browser = undefined;
      phase = "Bitwarden CLI login and item creation";
      await cli("config", "server", root);
      cliEnv.BW_SESSION = await cli(
        "login",
        email,
        "--passwordenv",
        "PASS_FIXTURE_PASSWORD",
        "--raw",
      );
      const template = JSON.parse(await cli("get", "template", "item"));
      template.name = "Disposable storage proof";
      template.type = 2;
      template.secureNote = { type: 0 };
      const item = JSON.parse(
        await cli(
          "create",
          "item",
          Buffer.from(JSON.stringify(template)).toString("base64"),
        ),
      );
      itemId = item.id;
      check(itemId, "CLI did not return an item ID");
    });
    if (!ready) {
      for (const name of labels.slice(1))
        results.push({ mode, name, status: "skip", reason: "setup failed" });
      return;
    }
    phase = "attachment API";
    const attachmentOk = await test(labels[1], async () => {
      const item = JSON.parse(
        await cli(
          "create",
          "attachment",
          "--file",
          attachmentFile,
          "--itemid",
          itemId,
        ),
      );
      attachmentId = item.attachments?.[0]?.id;
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
        ? JSON.parse(sendOutput).accessUrl
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
    if (!attachmentOk || !sendOk) {
      for (const name of labels.slice(3))
        results.push({
          mode,
          name,
          status: "skip",
          reason: "upload prerequisite failed",
        });
      return;
    }
    phase = "restart and download";
    await test(labels[3], async () => {
      await compose("restart", "vaultwarden");
      port = Number(
        (await compose("port", "gateway", "80")).trim().match(/:(\d+)$/)?.[1],
      );
      check(port, "Vaultwarden port unavailable after restart");
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/alive`);
          if (response.ok) break;
        } catch {}
        await delay(1000);
      }
      check(
        (await downloadAttachment()).equals(attachmentBytes),
        "attachment changed after restart",
      );
      check(
        (await downloadSend()).equals(sendBytes),
        "Send changed after restart",
      );
    });
    phase = "bucket listing";
    originalKeys = await list();
    const container = (await compose("ps", "-q", "vaultwarden")).trim();
    let disconnected = false;
    phase = "storage outage";
    await test(labels[4], async () => {
      await docker("network", "disconnect", `${project}_s3`, container);
      disconnected = true;
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
      storageUnavailable = true;
      let readFailed = false,
        writeFailed = false;
      try {
        await downloadAttachment();
      } catch {
        readFailed = true;
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
      if (mode === "localstack")
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
    if (disconnected) {
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
      const item = JSON.parse(await cli("get", "item", itemId));
      check(
        item.attachments?.length === 1 &&
          item.attachments[0].id === attachmentId,
        "failed upload left attachment metadata behind",
      );
    });
    phase = "attachment deletion";
    await test(labels[6], async () => {
      const attachmentKeys = (await list()).filter((k) =>
        k.startsWith(`${prefix}attachments/`),
      );
      check(
        attachmentKeys.length === 1,
        "expected one attachment object before deletion",
      );
      await cli("delete", "attachment", attachmentId, "--itemid", itemId);
      check(
        !(await list()).includes(attachmentKeys[0]),
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
      if (mode === "localstack") {
        const entireBucket = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        check(
          (entireBucket.Contents ?? []).every((entry) =>
            entry.Key.startsWith(prefix),
          ),
          "objects appeared outside the dedicated prefix",
        );
      }
      check(
        keys.length === 1 && keys[0].startsWith(`${prefix}sends/`),
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
        "test -s /data/rsa_key.pem && test -s /data/config.json",
      );
      check(
        (await list()).every((k) => !/rsa_key|config\.json/.test(k)),
        "server key or configuration appeared in bucket",
      );
    });
  } finally {
    await cleanup();
    activeCleanup = async () => {};
  }
}

try {
  await executeMode("localstack");
  if (b2Enabled && !interrupted) await executeMode("b2");
  else
    results.push({
      mode: "b2",
      name: "provider proof",
      status: "skip",
      reason: "not run: no credentials",
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
  await writeFile(
    values.report,
    `${JSON.stringify({ schema: 1, results }, null, 2)}\n`,
  );
}
process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
