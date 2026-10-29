import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";

const run = promisify(execFile);
const suffix = (process.env["CLEITO_RUN_ID"] ?? "local")
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-")
  .slice(0, 30);
const project = `opensuite-blob-${suffix}-${String(process.pid)}`;
const bucket = "mail-fixture-bucket";
const backupBucket = "mail-fixture-backup";
const mime = Buffer.from(
  [
    "From: sender@example.invalid",
    "To: recipient@example.invalid",
    "Subject: Blob integration fixture",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="fixture-boundary"',
    "",
    "--fixture-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "A message with an attachment.",
    "--fixture-boundary",
    'Content-Type: application/octet-stream; name="fixture.bin"',
    'Content-Disposition: attachment; filename="fixture.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAECA/7/",
    "--fixture-boundary--",
    "",
  ].join("\r\n"),
);

test("S3 mail blobs survive restart, outage and a consistent restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensuite-blob-"));
  const secretFile = join(directory, "secret");
  // The server runs as uid 2000. These are throwaway local-service credentials.
  await writeFile(secretFile, "local-fixture-secret", { mode: 0o644 });
  const env = {
    ...process.env,
    MAIL_BLOB_STORE: "s3",
    MAIL_S3_ENDPOINT: "http://minio:9000",
    MAIL_S3_REGION: "us-east-1",
    MAIL_S3_BUCKET: bucket,
    MAIL_S3_PREFIX: "mail/",
    MAIL_S3_KEY_ID: "local-fixture-key",
    MAIL_S3_SECRET_FILE: secretFile,
    MAIL_S3_ALLOW_SWITCH: "1",
    LOCALSTACK_AUTH_TOKEN: "",
    LOCALSTACK_IMAGE:
      "localstack/localstack:4.14.0@sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a",
  };
  // Docker may need to traverse the temporary directory as the server UID.
  await run("chmod", ["755", directory]);
  const composeArgs = [
    "compose",
    "--project-name",
    project,
    "--profile",
    "dev",
    "--env-file",
    "deploy/env.example",
    "-f",
    "compose.yaml",
    "-f",
    "compose.test.yaml",
    "-f",
    "test-support/stalwart-compose.yaml",
  ];
  const docker = async (...args: string[]) =>
    (await run("docker", args, { env, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const compose = (...args: string[]) => docker(...composeArgs, ...args);
  // The CLI runs inside the disposable LocalStack container and is explicitly
  // confined to the disposable MinIO endpoint; no provider is contacted.
  const aws = (...args: string[]) =>
    compose(
      "exec",
      "-T",
      "-e",
      "AWS_ACCESS_KEY_ID=local-fixture-key",
      "-e",
      "AWS_SECRET_ACCESS_KEY=local-fixture-secret",
      "localstack",
      "aws",
      "--endpoint-url",
      "http://minio:9000",
      "--region",
      "us-east-1",
      ...args,
    );
  const setup = () =>
    compose(
      "up",
      "--no-deps",
      "--force-recreate",
      "--exit-code-from",
      "stalwart-setup",
      "stalwart-setup",
    );
  const startMail = () =>
    compose("up", "-d", "--wait", "--wait-timeout", "180", "stalwart");

  let stage = "start";
  try {
    await compose(
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "stalwart",
      "localstack",
      "minio",
    );
    await aws("s3api", "create-bucket", "--bucket", bucket);
    env.MAIL_S3_ALLOW_SWITCH = "0";
    await expect(setup()).rejects.toThrow("Command failed");
    env.MAIL_S3_ALLOW_SWITCH = "1";
    const firstSetup = await setup();
    expect(firstSetup).toContain("restart Stalwart");
    await compose("restart", "stalwart");
    await startMail();
    env.MAIL_S3_ALLOW_SWITCH = "0";
    expect(await setup()).toContain("upload/download succeeded");
    expect(await setup()).toContain("upload/download succeeded");
    env.MAIL_S3_BUCKET = "different-fixture-bucket";
    await expect(setup()).rejects.toThrow("Command failed");
    env.MAIL_S3_BUCKET = bucket;
    stage = "import";

    const portOutput = await compose("port", "stalwart", "8080");
    const port = /:(\d+)\s*$/.exec(portOutput)?.[1];
    expect(port).toBeDefined();
    let base = `http://127.0.0.1:${port}`;
    const password = (
      await compose(
        "exec",
        "-T",
        "stalwart",
        "cat",
        "/run/opensuite/stalwart-admin/password",
      )
    ).trim();
    const headers = {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
      "x-forwarded-for": "192.0.2.10",
    };
    const request = (path: string, init: RequestInit = {}) => {
      const requestHeaders = new Headers(init.headers);
      for (const [key, value] of Object.entries(headers))
        requestHeaders.set(key, value);
      return fetch(`${base}${path}`, {
        ...init,
        headers: requestHeaders,
        signal: AbortSignal.timeout(45_000),
      });
    };
    const session = z
      .object({ primaryAccounts: z.record(z.string(), z.string()) })
      .parse(await (await request("/jmap/session")).json());
    const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
    expect(accountId).toBeTruthy();
    const jmap = async (method: string, args: object) => {
      const response = await request("/jmap/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
          methodCalls: [[method, args, "t"]],
        }),
      });
      expect(response.status).toBe(200);
      const body = z
        .object({
          methodResponses: z.array(
            z.tuple([
              z.string(),
              z.record(z.string(), z.unknown()),
              z.string(),
            ]),
          ),
        })
        .parse(await response.json());
      expect(body.methodResponses[0]?.[0]).toBe(method);
      return body.methodResponses[0]?.[1] ?? {};
    };
    const mailboxes = await jmap("Mailbox/get", { accountId });
    const inbox = z
      .array(z.object({ role: z.string().nullable(), id: z.string() }))
      .parse(mailboxes["list"])
      .find((box) => box.role === "inbox");
    if (!inbox) throw new Error("inbox missing");
    const upload = await request(`/jmap/upload/${accountId}/`, {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: mime,
    });
    expect(upload.status).toBe(200);
    const uploaded = z
      .object({ blobId: z.string() })
      .parse(await upload.json());
    const imported = await jmap("Email/import", {
      accountId,
      emails: {
        fixture: { blobId: uploaded.blobId, mailboxIds: { [inbox.id]: true } },
      },
    });
    expect(imported["notCreated"]).toBeUndefined();
    const emailId = z
      .object({ fixture: z.object({ id: z.string() }) })
      .parse(imported["created"]).fixture.id;
    const email = await jmap("Email/get", {
      accountId,
      ids: [emailId],
      properties: ["id", "blobId", "attachments"],
    });
    const item = z
      .array(
        z.object({ blobId: z.string(), attachments: z.array(z.unknown()) }),
      )
      .parse(email["list"])[0];
    if (!item) throw new Error("imported email missing");
    expect(item.attachments).toHaveLength(1);
    const download = () =>
      request(`/jmap/download/${accountId}/${item.blobId}/fixture.eml`);
    const checkBytes = async () => {
      const response = await download();
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(mime);
    };
    const objects = await aws("s3api", "list-objects-v2", "--bucket", bucket);
    expect(objects).toContain('"Key": "mail/');
    stage = "mail restart";
    await compose("restart", "stalwart");
    await startMail();
    const restartedPort = /:(\d+)\s*$/.exec(
      await compose("port", "stalwart", "8080"),
    )?.[1];
    expect(restartedPort).toBeDefined();
    base = `http://127.0.0.1:${restartedPort}`;
    await checkBytes();
    stage = "S3 outage";
    await compose("stop", "minio");
    const unavailable = await download();
    expect(unavailable.status).toBeGreaterThanOrEqual(500);
    expect((await unavailable.text()).length).toBeGreaterThan(0);
    await compose("start", "minio");
    await compose("up", "-d", "--wait", "--wait-timeout", "180", "minio");
    stage = "S3 recovery";
    await checkBytes();

    // Freeze all writes, copy both stores, and restore into a newly created volume
    // and a reconstructed bucket before allowing the server to run again.
    await compose("stop", "stalwart");
    stage = "backup and restore";
    await aws("s3api", "create-bucket", "--bucket", backupBucket);
    await aws("s3", "sync", `s3://${bucket}/`, `s3://${backupBucket}/`);
    const volume = `${project}_stalwart-data`;
    const image =
      "alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a";
    await docker(
      "run",
      "--rm",
      "-v",
      `${volume}:/source:ro`,
      "-v",
      `${directory}:/backup`,
      image,
      "sh",
      "-c",
      "cd /source && tar cf /backup/data.tar .",
    );
    await compose("rm", "-f", "stalwart");
    await docker("volume", "rm", volume);
    await docker(
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.volume=stalwart-data",
      volume,
    );
    await docker(
      "run",
      "--rm",
      "-v",
      `${volume}:/target`,
      "-v",
      `${directory}:/backup:ro`,
      image,
      "sh",
      "-c",
      "cd /target && tar xf /backup/data.tar",
    );
    await aws("s3", "rm", `s3://${bucket}/`, "--recursive");
    await aws("s3", "sync", `s3://${backupBucket}/`, `s3://${bucket}/`);
    await startMail();
    const restoredPort = /:(\d+)\s*$/.exec(
      await compose("port", "stalwart", "8080"),
    )?.[1];
    expect(restoredPort).toBeDefined();
    base = `http://127.0.0.1:${restoredPort}`;
    await checkBytes();
    const restored = await jmap("Email/get", {
      accountId,
      ids: [emailId],
      properties: ["id"],
    });
    expect(restored["list"]).toEqual([{ id: emailId }]);
  } catch (error) {
    throw new Error(`integration failed during ${stage}`, { cause: error });
  } finally {
    try {
      await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 900_000);
