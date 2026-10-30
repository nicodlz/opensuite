import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { okAsync } from "neverthrow";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { PrismaClient } from "../src/db/generated/index.js";
import { configureDriveRole } from "../src/db/role.ts";
import { createStorage } from "../src/adapters/storage.ts";
import { createDrive } from "../src/services/drive.ts";
import { buildServer } from "../src/server.ts";
import type { SessionVerifier } from "../src/domain/session.ts";
import type { DriveCommand } from "@opensuite/contracts";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  reconcileObjects,
  type ReconciliationFinding,
} from "../src/services/reconcile.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);
const inputRunId = process.env[["CLE", "ITO_RUN_ID"].join("")] ?? "local";
const runId =
  inputRunId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 30) || "local";
const project = `opensuite-drive-${runId}-${randomUUID().slice(0, 8)}`;
const args = [
  "compose",
  "--profile",
  "dev",
  "--project-name",
  project,
  "--env-file",
  "deploy/env.example",
  "-f",
  "compose.yaml",
  "-f",
  "compose.test.yaml",
  "-f",
  "apps/drive/test/compose.drive.yaml",
];
const compose = async (...cmd: string[]) =>
  (
    await run("docker", [...args, ...cmd], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
const cleanup = async () => {
  await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
  const filter = `label=com.docker.compose.project=${project}`;
  const leftovers = await Promise.all([
    run("docker", ["ps", "-aq", "--filter", filter]),
    run("docker", ["volume", "ls", "-q", "--filter", filter]),
    run("docker", ["network", "ls", "-q", "--filter", filter]),
  ]);
  if (leftovers.some((result) => result.stdout.trim().length > 0))
    throw new Error(`Fixture cleanup incomplete for ${project}`);
};
let db: PrismaClient;
let storage: ReturnType<typeof createStorage>;
let drive: ReturnType<typeof createDrive>;
let app: ReturnType<typeof buildServer>;
let s3Endpoint: string;
let closeResources = () => Promise.resolve();
const sessions: SessionVerifier = {
  verify: (cookie) =>
    okAsync(cookie === "user=a" ? "a" : cookie === "user=b" ? "b" : null),
};
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const resultId = z.object({ id: z.string() });
const signed = z.object({ id: z.string(), url: z.url().nullable() });
const signedPart = z.object({ url: z.url() });
const command = async (user: string, input: DriveCommand) =>
  drive.command(user, input);

beforeAll(async () => {
  try {
    await compose(
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "360",
      "postgres",
      "localstack",
    );
    const pgPort = /:(\d+)\s*$/.exec(
      await compose("port", "postgres", "5432"),
    )?.[1];
    const s3Port = /:(\d+)\s*$/.exec(
      await compose("port", "localstack", "4566"),
    )?.[1];
    if (pgPort === undefined || s3Port === undefined)
      throw new Error("Missing fixture port");
    const password = (
      await compose(
        "exec",
        "-T",
        "postgres",
        "cat",
        "/run/opensuite/postgres/password",
      )
    ).trim();
    const url = new URL("postgresql://127.0.0.1/opensuite_drive");
    url.port = pgPort;
    url.username = "opensuite";
    url.password = password;
    const admin = new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });
    const drivePassword = "drive-test-password-01234567890123456789";
    try {
      await configureDriveRole(
        admin,
        drivePassword,
        "opensuite",
        "opensuite_drive",
      );
    } finally {
      await admin.$disconnect();
    }
    url.username = "opensuite_drive";
    url.password = drivePassword;
    await run(
      "pnpm",
      ["--filter", "@opensuite/drive", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url.toString() },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const endpoint = `http://127.0.0.1:${s3Port}`;
    s3Endpoint = endpoint;
    storage = createStorage({
      endpoint,
      publicEndpoint: endpoint,
      bucket: "opensuite-drive",
      prefix: "drive/",
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
    });
    drive = createDrive(db, storage, 7_000_000);
    app = buildServer(drive, storage, sessions);
    await app.ready();
    closeResources = async () => {
      await app.close();
      await db.$disconnect();
      storage.close();
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}, 480_000);
afterAll(async () => {
  try {
    await closeResources();
  } finally {
    await cleanup();
  }
}, 300_000);

it("uploads and protects files, shares, links and previews", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const begin = signed.parse(
    await command("a", {
      action: "upload",
      name: "photo.png",
      parentId: null,
      size: bytes.length,
      checksum: digest(bytes),
      contentType: "image/png",
      multipart: false,
    }),
  );
  if (begin.url === null) throw new Error("upload URL missing");
  expect(
    (
      await fetch(begin.url, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: bytes,
      })
    ).ok,
  ).toBe(true);
  await command("a", { action: "finish", id: begin.id });
  await expect(storage.get(storage.key(begin.id, true))).rejects.toMatchObject({
    name: "NoSuchKey",
  });
  // A previously issued upload URL must not mutate the finalized object.
  expect(
    (
      await fetch(begin.url, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: Buffer.alloc(bytes.length),
      })
    ).ok,
  ).toBe(true);
  const download = signedPart.parse(
    await command("a", { action: "download", id: begin.id }),
  );
  const response = await fetch(download.url);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("content-disposition")).toContain("attachment");
  const preview = await app.inject({
    method: "GET",
    url: `/v1/preview/${begin.id}`,
    headers: { cookie: "user=a" },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.headers["content-security-policy"]).toContain("sandbox");
  expect(preview.headers["x-content-type-options"]).toBe("nosniff");
  await expect(
    command("b", { action: "download", id: begin.id }),
  ).rejects.toThrow(/Entry not found/);
  await command("a", {
    action: "share",
    id: begin.id,
    userId: "b",
    access: "read",
  });
  await command("b", { action: "download", id: begin.id });
  const shared = z
    .object({ entries: z.array(resultId) })
    .parse(await command("b", { action: "shared" }));
  expect(shared.entries.map((entry) => entry.id)).toContain(begin.id);
  await expect(
    command("b", { action: "rename", id: begin.id, name: "no" }),
  ).rejects.toThrow(/Entry not found/);
  await command("a", {
    action: "share",
    id: begin.id,
    userId: "b",
    access: "write",
  });
  await command("b", { action: "rename", id: begin.id, name: "renamed.png" });
  await command("a", { action: "unshare", id: begin.id, userId: "b" });
  await expect(
    command("b", { action: "download", id: begin.id }),
  ).rejects.toThrow(/Entry not found/);
  const folder = resultId.parse(
    await command("a", { action: "folder", name: "folder", parentId: null }),
  );
  await command("a", { action: "move", id: begin.id, parentId: folder.id });
  await command("a", { action: "trash", id: begin.id });
  await expect(
    command("a", { action: "download", id: begin.id }),
  ).rejects.toThrow(/Entry not found/);
  await command("a", { action: "restore", id: begin.id });
  const link = z.object({ id: z.string(), token: z.string() }).parse(
    await command("a", {
      action: "link",
      id: begin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  expect(
    (await app.inject({ method: "GET", url: `/v1/public/${link.token}` }))
      .statusCode,
  ).toBe(200);
  await command("a", { action: "unlink", id: begin.id, linkId: link.id });
  expect(
    (await app.inject({ method: "GET", url: `/v1/public/${link.token}` }))
      .statusCode,
  ).toBe(404);
  const expired = z.object({ token: z.string() }).parse(
    await command("a", {
      action: "link",
      id: begin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await db.publicLink.updateMany({
    where: { entryId: begin.id },
    data: { expiresAt: new Date(0) },
  });
  expect(
    (await app.inject({ method: "GET", url: `/v1/public/${expired.token}` }))
      .statusCode,
  ).toBe(404);
  await command("a", { action: "trash", id: begin.id });
  await command("a", { action: "delete", id: begin.id });
}, 120_000);

it("handles multipart and reserves quota before signing", async () => {
  const bytes = Buffer.alloc(5_300_000, 42);
  const begin = signed.parse(
    await command("a", {
      action: "upload",
      name: "large.bin",
      parentId: null,
      size: bytes.length,
      checksum: digest(bytes),
      contentType: "application/octet-stream",
      multipart: true,
    }),
  );
  await expect(
    command("a", {
      action: "upload",
      name: "too-big",
      parentId: null,
      size: 2_000_000,
      checksum: digest(Buffer.alloc(0)),
      contentType: "application/octet-stream",
      multipart: false,
    }),
  ).rejects.toThrow(/Quota/);
  const parts = await Promise.all(
    [1, 2].map(async (partNumber) => {
      const part = signedPart.parse(
        await command("a", { action: "part", id: begin.id, partNumber }),
      );
      const offset = (partNumber - 1) * 5 * 1024 * 1024;
      const uploaded = await fetch(part.url, {
        method: "PUT",
        body: bytes.subarray(offset, offset + 5 * 1024 * 1024),
      });
      expect(uploaded.ok).toBe(true);
      const etag = uploaded.headers.get("etag");
      if (etag === null) throw new Error("missing part ETag");
      return { partNumber, etag };
    }),
  );
  await command("a", { action: "finish", id: begin.id, parts });
  const download = signedPart.parse(
    await command("a", { action: "download", id: begin.id }),
  );
  expect(
    Buffer.from(await (await fetch(download.url)).arrayBuffer()).equals(bytes),
  ).toBe(true);
  await command("a", { action: "trash", id: begin.id });
  await command("a", { action: "delete", id: begin.id });
}, 120_000);

it("reserves a file above 5 GB, enforces quota and issues short-lived part URLs", async () => {
  const large = createDrive(db, storage, 10_000_000_000);
  const input = {
    action: "upload" as const,
    name: "large.bin",
    parentId: null,
    size: 5_000_000_001,
    checksum: digest(Buffer.alloc(0)),
    contentType: "application/octet-stream",
    multipart: true,
  };
  await expect(
    large.command("large-owner", { ...input, multipart: false }),
  ).rejects.toThrow(/multipart/);
  const begin = signed.parse(await large.command("large-owner", input));
  const reservation = await db.entry.findUniqueOrThrow({
    where: { id: begin.id },
  });
  expect(reservation.size).toBe(5_000_000_001n);
  expect(reservation.expiresAt?.getTime()).toBeGreaterThan(
    Date.now() + 23 * 60 * 60 * 1000,
  );
  const part = z.object({ url: z.url(), expiresIn: z.number() }).parse(
    await large.command("large-owner", {
      action: "part",
      id: begin.id,
      partNumber: 1,
    }),
  );
  expect(part.expiresIn).toBeLessThanOrEqual(300);
  await expect(
    large.command("other", { action: "part", id: begin.id, partNumber: 1 }),
  ).rejects.toThrow(/not found/i);
  await expect(
    large.command("large-owner", {
      action: "part",
      id: begin.id,
      partNumber: 955,
    }),
  ).rejects.toThrow(/reserved size/i);
  await expect(large.command("large-owner", input)).rejects.toThrow(/quota/i);
  await large.command("large-owner", { action: "trash", id: begin.id });
  await large.command("large-owner", { action: "delete", id: begin.id });
}, 120_000);

it("rejects invalid bytes and never previews active content", async () => {
  const bytes = Buffer.from("<svg onload=alert(1)></svg>");
  const begin = signed.parse(
    await command("a", {
      action: "upload",
      name: "active.svg",
      parentId: null,
      size: bytes.length,
      checksum: digest(Buffer.from("wrong")),
      contentType: "image/svg+xml",
      multipart: false,
    }),
  );
  if (begin.url === null) throw new Error("upload URL missing");
  expect(
    (
      await fetch(begin.url, {
        method: "PUT",
        headers: { "content-type": "image/svg+xml" },
        body: bytes,
      })
    ).ok,
  ).toBe(true);
  await expect(
    command("a", { action: "finish", id: begin.id }),
  ).rejects.toThrow(/checksum mismatch/);
  await expect(
    command("a", { action: "finish", id: begin.id }),
  ).rejects.toThrow(/not pending/);
  await command("a", { action: "trash", id: begin.id });
  await command("a", { action: "delete", id: begin.id });
  const safe = signed.parse(
    await command("a", {
      action: "upload",
      name: "active.svg",
      parentId: null,
      size: bytes.length,
      checksum: digest(bytes),
      contentType: "image/svg+xml",
      multipart: false,
    }),
  );
  if (safe.url === null) throw new Error("upload URL missing");
  expect(
    (
      await fetch(safe.url, {
        method: "PUT",
        headers: { "content-type": "image/svg+xml" },
        body: bytes,
      })
    ).ok,
  ).toBe(true);
  await command("a", { action: "finish", id: safe.id });
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/v1/preview/${safe.id}`,
        headers: { cookie: "user=a" },
      })
    ).statusCode,
  ).toBe(415);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/command",
        payload: { action: "shared" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/command",
        headers: { cookie: "user=a", "sec-fetch-site": "cross-site" },
        payload: { action: "shared" },
      })
    ).statusCode,
  ).toBe(403);
  const authenticated = await app.inject({
    method: "POST",
    url: "/v1/command",
    headers: { cookie: "user=a" },
    payload: { action: "list", parentId: null, trash: false },
  });
  expect(authenticated.statusCode).toBe(200);
}, 120_000);

it("serializes concurrent quota reservations", async () => {
  const input: DriveCommand = {
    action: "upload",
    name: "reservation.bin",
    parentId: null,
    size: 4_000_000,
    checksum: digest(Buffer.alloc(0)),
    contentType: "application/octet-stream",
    multipart: false,
  };
  const attempts = await Promise.allSettled([
    command("quota-user", input),
    command("quota-user", input),
  ]);
  const created = attempts.filter((attempt) => attempt.status === "fulfilled");
  expect(created).toHaveLength(1);
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(z.unknown().parse(rejected[0]?.reason)).toMatchObject({
    message: "Quota exceeded",
  });
  const entry = created[0];
  if (entry === undefined) throw new Error("reservation missing");
  const reservation = resultId.parse(entry.value);
  await command("quota-user", { action: "trash", id: reservation.id });
  await command("quota-user", { action: "delete", id: reservation.id });
}, 120_000);

it("uses the owner's shared quota under the reservation lock and fails closed", async () => {
  const calls: string[] = [];
  let available = true;
  const metered = createDrive(db, storage, async (owner) => {
    await Promise.resolve();
    calls.push(owner);
    if (!available) throw new Error("offline");
    return {
      quotaBytes: 7_000_000,
      mailBytes: 1_000_000,
      uploadsAllowed: true,
    };
  });
  const folder = resultId.parse(
    await metered.command("meter-owner", {
      action: "folder",
      name: "shared",
      parentId: null,
    }),
  );
  await metered.command("meter-owner", {
    action: "share",
    id: folder.id,
    userId: "meter-writer",
    access: "write",
  });
  const input: DriveCommand = {
    action: "upload",
    name: "reservation.bin",
    parentId: folder.id,
    size: 4_000_000,
    checksum: digest(Buffer.alloc(0)),
    contentType: "application/octet-stream",
    multipart: false,
  };
  const attempts = await Promise.allSettled([
    metered.command("meter-writer", input),
    metered.command("meter-writer", input),
  ]);
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    attempts.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  expect(calls).toEqual(["meter-owner", "meter-owner"]);
  expect(await metered.usage("meter-owner")).toBe(4_000_000);
  available = false;
  await expect(
    metered.command("meter-writer", { ...input, size: 1 }),
  ).rejects.toMatchObject({
    status: 503,
  });
  const fulfilled = attempts.find((result) => result.status === "fulfilled");
  if (fulfilled?.status !== "fulfilled") throw new Error("reservation missing");
  const id = resultId.parse(fulfilled.value).id;
  await metered.command("meter-owner", { action: "trash", id });
  expect(await metered.usage("meter-owner")).toBe(4_000_000);
  await metered.command("meter-owner", { action: "delete", id });
}, 120_000);

it("protects internal usage with the configured bearer token", async () => {
  const token = "x".repeat(32);
  const internal = buildServer(
    drive,
    storage,
    sessions,
    undefined,
    undefined,
    token,
  );
  try {
    expect(
      (await internal.inject("/internal/usage/meter-owner")).statusCode,
    ).toBe(401);
    expect(
      (
        await internal.inject({
          url: "/internal/usage/meter-owner",
          headers: { authorization: `Bearer ${"y".repeat(32)}` },
        })
      ).statusCode,
    ).toBe(401);
    const response = await internal.inject({
      url: "/internal/usage/meter-owner",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ driveBytes: 0 });
  } finally {
    await internal.close();
  }
});

it("reports storage drift and only deletes old, unreferenced staging objects on request", async () => {
  const client = new S3Client({
    endpoint: s3Endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
  const prefix = `reconcile-${randomUUID()}/`;
  const bucket = "opensuite-drive";
  const missingId = randomUUID();
  const mismatchId = randomUUID();
  const orphanId = randomUUID();
  const liveId = randomUUID();
  const orphanKey = `${prefix}pending/${orphanId}`;
  const liveKey = `${prefix}pending/${liveId}`;
  const finalOrphan = `${prefix}objects/${randomUUID()}`;
  const mismatchKey = `${prefix}objects/${mismatchId}`;
  const missingKey = `${prefix}objects/${missingId}`;
  try {
    await db.entry.createMany({
      data: [
        {
          id: missingId,
          ownerId: "reconcile",
          name: "missing",
          kind: "file",
          state: "ready",
          size: 10n,
          objectKey: missingKey,
        },
        {
          id: mismatchId,
          ownerId: "reconcile",
          name: "mismatch",
          kind: "file",
          state: "ready",
          size: 10n,
          objectKey: mismatchKey,
        },
        {
          id: liveId,
          ownerId: "reconcile",
          name: "pending",
          kind: "file",
          state: "pending",
          size: 5n,
        },
      ],
    });
    await Promise.all(
      [orphanKey, liveKey, finalOrphan, mismatchKey].map((Key) =>
        client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: "abc" })),
      ),
    );
    const findings: ReconciliationFinding[] = [];
    const reconcile = (deleteStaging: boolean) =>
      reconcileObjects(
        db,
        client,
        {
          bucket,
          prefix,
          deleteStaging,
          now: new Date(Date.now() + 8 * 86_400_000),
        },
        (finding) => findings.push(finding),
      );
    await reconcile(false);
    expect(findings).toEqual(
      expect.arrayContaining([
        { kind: "missing", key: missingKey, entryId: missingId },
        {
          kind: "size_mismatch",
          key: mismatchKey,
          entryId: mismatchId,
          expected: "10",
          actual: 3,
        },
        { kind: "orphan", key: orphanKey },
        { kind: "orphan", key: finalOrphan },
      ]),
    );
    expect(findings).not.toContainEqual({ kind: "orphan", key: liveKey });
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: orphanKey }),
    );
    // Never retry unconditionally if an S3 substitute lacks this feature.
    const failure: unknown = await reconcile(true).then(
      () => null,
      (error: unknown) => error,
    );
    const failureName =
      failure === null
        ? null
        : z.object({ name: z.string() }).parse(failure).name;
    expect([null, "NotImplemented"]).toContain(failureName);
    const deleted = failure === null;
    expect(
      findings.some(
        (finding) =>
          finding.kind === "deleted_staging" && finding.key === orphanKey,
      ),
    ).toBe(deleted);
    const exists = await client
      .send(new HeadObjectCommand({ Bucket: bucket, Key: orphanKey }))
      .then(
        () => true,
        () => false,
      );
    expect(exists).toBe(!deleted);
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: liveKey }));
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: finalOrphan }),
    );
  } finally {
    await db.entry.deleteMany({
      where: { id: { in: [missingId, mismatchId, liveId] } },
    });
    client.destroy();
  }
}, 120_000);

it("allows a write share to create a file in the owner's folder", async () => {
  const folder = resultId.parse(
    await command("a", {
      action: "folder",
      name: "collaboration",
      parentId: null,
    }),
  );
  await command("a", {
    action: "share",
    id: folder.id,
    userId: "b",
    access: "write",
  });
  const bytes = Buffer.from("shared file");
  const upload = signed.parse(
    await command("b", {
      action: "upload",
      name: "shared.txt",
      parentId: folder.id,
      size: bytes.length,
      checksum: digest(bytes),
      contentType: "text/plain",
      multipart: false,
    }),
  );
  if (upload.url === null) throw new Error("upload URL missing");
  expect(
    (
      await fetch(upload.url, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: bytes,
      })
    ).ok,
  ).toBe(true);
  await command("b", { action: "finish", id: upload.id });
  await expect(
    command("b", { action: "move", id: upload.id, parentId: null }),
  ).rejects.toThrow(/Entry not found/);
  const destination = resultId.parse(
    await command("a", {
      action: "folder",
      name: "destination",
      parentId: null,
    }),
  );
  await command("a", {
    action: "share",
    id: destination.id,
    userId: "b",
    access: "write",
  });
  await command("b", {
    action: "move",
    id: upload.id,
    parentId: destination.id,
  });
  await command("b", { action: "move", id: upload.id, parentId: folder.id });
  await command("a", { action: "trash", id: destination.id });
  await command("a", { action: "delete", id: destination.id });
  const listing = z
    .object({ entries: z.array(resultId) })
    .parse(
      await command("b", { action: "list", parentId: folder.id, trash: false }),
    );
  expect(listing.entries.map((entry) => entry.id)).toContain(upload.id);
  await command("a", { action: "download", id: upload.id });
  await command("a", { action: "trash", id: upload.id });
  await command("a", { action: "delete", id: upload.id });
  await command("a", { action: "trash", id: folder.id });
  await command("a", { action: "delete", id: folder.id });
}, 120_000);

it("isolates the Drive role from the main database", async () => {
  const rows = z
    .array(
      z.object({
        drive_owner: z.boolean(),
        main_connect: z.boolean(),
        superuser: z.boolean(),
      }),
    )
    .parse(
      await db.$queryRaw`SELECT pg_get_userbyid(d.datdba) = current_user AS drive_owner,
      has_database_privilege(current_user, 'opensuite', 'CONNECT') AS main_connect,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
      FROM pg_database d WHERE d.datname = current_database()`,
    );
  expect(rows).toEqual([
    { drive_owner: true, main_connect: false, superuser: false },
  ]);
}, 120_000);

it("expires reservations, rejects further work and sweeps multipart uploads", async () => {
  const input: DriveCommand = {
    action: "upload",
    name: "pending",
    parentId: null,
    size: 6_000_000,
    checksum: digest(Buffer.alloc(0)),
    contentType: "application/octet-stream",
    multipart: true,
  };
  const old = signed.parse(await command("expiry-user", input));
  const pending = await db.entry.findUniqueOrThrow({ where: { id: old.id } });
  if (pending.uploadId === null) throw new Error("multipart upload missing");
  await db.entry.update({
    where: { id: old.id },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    command("expiry-user", { action: "part", id: old.id, partNumber: 1 }),
  ).rejects.toThrow(/expired/);
  await expect(
    command("expiry-user", { action: "finish", id: old.id, parts: [] }),
  ).rejects.toThrow(/expired/);
  const replacement = signed.parse(await command("expiry-user", input));
  await drive.sweepExpired();
  expect(await db.entry.findUnique({ where: { id: old.id } })).toBeNull();
  await expect(
    storage.complete(old.id, pending.uploadId, [
      { partNumber: 1, etag: '"none"' },
    ]),
  ).rejects.toThrow(/./);
  await command("expiry-user", { action: "trash", id: replacement.id });
  await command("expiry-user", { action: "delete", id: replacement.id });
}, 120_000);

it("keeps staging after a failed commit, retries, and removes copied objects on delete", async () => {
  const bytes = Buffer.from("retryable");
  const begin = signed.parse(
    await command("retry-user", {
      action: "upload",
      name: "retry",
      parentId: null,
      size: bytes.length,
      checksum: digest(bytes),
      contentType: "text/plain",
      multipart: false,
    }),
  );
  if (begin.url === null) throw new Error("upload URL missing");
  expect(
    (
      await fetch(begin.url, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: bytes,
      })
    ).ok,
  ).toBe(true);
  const update = vi
    .spyOn(db.entry, "update")
    .mockRejectedValueOnce(new Error("database unavailable"));
  try {
    await expect(
      command("retry-user", { action: "finish", id: begin.id }),
    ).rejects.toThrow(/database unavailable/);
  } finally {
    update.mockRestore();
  }
  expect(
    (await db.entry.findUniqueOrThrow({ where: { id: begin.id } })).state,
  ).toBe("pending");
  await storage.get(storage.key(begin.id, true));
  await storage.get(storage.key(begin.id, false));
  await command("retry-user", { action: "trash", id: begin.id });
  await command("retry-user", { action: "delete", id: begin.id });
  await expect(storage.get(storage.key(begin.id, false))).rejects.toMatchObject(
    { name: "NoSuchKey" },
  );
}, 120_000);

it("returns 404 when preview and public objects are missing", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const begin = signed.parse(
    await command("missing-user", {
      action: "upload",
      name: "lost.png",
      parentId: null,
      size: bytes.length,
      checksum: digest(bytes),
      contentType: "image/png",
      multipart: false,
    }),
  );
  if (begin.url === null) throw new Error("upload URL missing");
  expect(
    (
      await fetch(begin.url, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: bytes,
      })
    ).ok,
  ).toBe(true);
  await command("missing-user", { action: "finish", id: begin.id });
  const link = z.object({ token: z.string() }).parse(
    await command("missing-user", {
      action: "link",
      id: begin.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await storage.remove(begin.id, storage.key(begin.id, false), null);
  const missingSession: SessionVerifier = {
    verify: () => okAsync("missing-user"),
  };
  const server = buildServer(drive, storage, missingSession);
  try {
    expect(
      (await server.inject({ method: "GET", url: `/v1/preview/${begin.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ method: "GET", url: `/v1/public/${link.token}` }))
        .statusCode,
    ).toBe(404);
  } finally {
    await server.close();
  }
  await command("missing-user", { action: "trash", id: begin.id });
  await command("missing-user", { action: "delete", id: begin.id });
}, 120_000);

it("serializes creating children against trash and restricts orphaning", async () => {
  const folder = resultId.parse(
    await command("race-user", {
      action: "folder",
      name: "race",
      parentId: null,
    }),
  );
  const results = await Promise.allSettled([
    command("race-user", { action: "trash", id: folder.id }),
    command("race-user", {
      action: "folder",
      name: "child",
      parentId: folder.id,
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const children = await db.entry.findMany({ where: { parentId: folder.id } });
  const parent = await db.entry.findUniqueOrThrow({ where: { id: folder.id } });
  expect(parent.trashedAt === null || children.length === 0).toBe(true);
  await Promise.all(
    children.map(async (child) => {
      await command("race-user", { action: "trash", id: child.id });
      await command("race-user", { action: "delete", id: child.id });
    }),
  );
  if (parent.trashedAt === null)
    await command("race-user", { action: "trash", id: folder.id });
  await command("race-user", { action: "delete", id: folder.id });
}, 120_000);

it("limits repeated finish attempts per user", async () => {
  await Array.from({ length: 10 }).reduce<Promise<void>>(async (previous) => {
    await previous;
    await expect(
      command("limited-user", { action: "finish", id: "missing" }),
    ).rejects.toThrow(/Entry not found/);
  }, Promise.resolve());
  await expect(
    command("limited-user", { action: "finish", id: "missing" }),
  ).rejects.toThrow(/Too many/);
}, 120_000);

it("restricts database deletion of a folder with children", async () => {
  const folder = resultId.parse(
    await command("fk-user", {
      action: "folder",
      name: "folder",
      parentId: null,
    }),
  );
  const child = resultId.parse(
    await command("fk-user", {
      action: "folder",
      name: "child",
      parentId: folder.id,
    }),
  );
  await expect(db.entry.delete({ where: { id: folder.id } })).rejects.toThrow(
    /foreign key/i,
  );
  await command("fk-user", { action: "trash", id: child.id });
  await command("fk-user", { action: "delete", id: child.id });
  await command("fk-user", { action: "trash", id: folder.id });
  await command("fk-user", { action: "delete", id: folder.id });
}, 120_000);
