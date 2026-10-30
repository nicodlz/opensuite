import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { okAsync } from "neverthrow";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { PrismaClient } from "../src/db/generated/index.js";
import { createStorage } from "../src/adapters/storage.ts";
import { createDrive } from "../src/services/drive.ts";
import { buildServer } from "../src/server.ts";
import type { SessionVerifier } from "../src/domain/session.ts";
import type { DriveCommand } from "@opensuite/contracts";

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
  expect(Buffer.from(await (await fetch(download.url)).arrayBuffer())).toEqual(
    bytes,
  );
  await command("a", { action: "trash", id: begin.id });
  await command("a", { action: "delete", id: begin.id });
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
