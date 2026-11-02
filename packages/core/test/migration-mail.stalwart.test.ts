import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDatabase, type PrismaClient } from "@opensuite/db";
import { createReadinessService } from "@opensuite/core";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { createMailMigrationService } from "../src/services/migration-mail.ts";
import { migrationMailTools } from "../src/adapters/migration-mail.ts";
import { buildServer } from "../../../apps/api/src/server.ts";

const run = promisify(execFile);
const project = `mail-import-${randomBytes(6).toString("hex")}`;
const root = new URL("../../../", import.meta.url);
const actor = {
  id: "owner",
  email: "alice@example.test",
  role: "user",
} as const;
const password = "local-fixture-password-9234";
const key = "ab".repeat(32);
const value = <T, E>(result: Result<T, E>): T =>
  result.match(
    (v) => v,
    () => {
      throw new Error("Fixture operation failed");
    },
  );
let directory = "";
let overlay = "";
let base = "";
let db: PrismaClient;
let disconnect = () => Promise.resolve();
let account = "";
let inbox = "";
let sent = "";
let diagnostic: JmapClient;
let service: ReturnType<typeof createMailMigrationService>;
let loseResponse = false;
let failUpload = false;
let accountEnabled = true;
const compose = async (...args: string[]) =>
  (
    await run(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        "deploy/stalwart/compose.stalwart-test.yaml",
        "-f",
        overlay,
        ...args,
      ],
      { cwd: root, maxBuffer: 4_000_000 },
    )
  ).stdout;
const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });
const now = () => performance.now();
const wait = async (
  fn: () => Promise<boolean>,
  remaining = 120,
): Promise<void> => {
  if (await fn().catch(() => false)) return;
  if (!remaining) throw new Error("Fixture did not become ready");
  await pause();
  await wait(fn, remaining - 1);
};
const fetcher: typeof fetch = async (url, init) => {
  const target = url instanceof Request ? url.url : url.toString();
  if (failUpload && target.includes("/upload/")) {
    failUpload = false;
    return new Response("fixture upload failure", { status: 503 });
  }
  const response = await fetch(url, init);
  if (
    loseResponse &&
    typeof init?.body === "string" &&
    init.body.includes('"Email/import"')
  ) {
    loseResponse = false;
    throw new Error("fixture lost response");
  }
  return response;
};
function newService() {
  return createMailMigrationService({
    tools: migrationMailTools,
    db,
    key,
    origin: base,
    store: {
      getForOwner: (userId, id) =>
        Promise.resolve(
          accountEnabled &&
            userId === actor.id &&
            ["default", account].includes(id)
            ? ok({ accountId: account, address: actor.email, secret: password })
            : err({ kind: "not_found" }),
        ),
    },
    client: () =>
      new JmapClient(base, {
        authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
        fetch: fetcher,
        rewriteSessionUrlsToOrigin: base,
      }),
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mail-import-"));
  overlay = join(directory, "compose.yaml");
  await writeFile(
    overlay,
    'services:\n  pg:\n    image: postgres:18.6\n    environment:\n      POSTGRES_PASSWORD: test-password\n      POSTGRES_INITDB_ARGS: --no-sync\n    ports:\n      - "127.0.0.1::5432"\n',
  );
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    const pgPort = (await compose("port", "pg", "5432"))
      .trim()
      .split(":")
      .at(-1);
    if (!port || !pgPort) throw new Error("Missing fixture ports");
    base = `http://127.0.0.1:${port}`;
    await wait(async () => (await fetch(`${base}/healthz/ready`)).ok);
    await wait(async () => {
      await compose("exec", "-T", "pg", "pg_isready", "-U", "postgres");
      return true;
    });
    const url = `postgresql://postgres:test-password@127.0.0.1:${pgPort}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: url },
        maxBuffer: 4_000_000,
      },
    );
    db = value(createDatabase(url));
    disconnect = () => db.$disconnect();
    await db.user.create({
      data: { id: actor.id, name: "Owner", email: actor.email },
    });
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = value(await admin.createDomain("example.test"));
    value(await admin.createAccount("alice", domain.id, password));
    diagnostic = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const session = value(await diagnostic.discover());
    account = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = value(await diagnostic.mailboxes(session, account)).list;
    inbox = boxes.find((box) => box.role === "inbox")?.id ?? "";
    sent = boxes.find((box) => box.role === "sent")?.id ?? "";
    if (!account || !inbox || !sent)
      throw new Error("Missing fixture mailboxes");
    service = newService();
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    throw error;
  }
}, 180_000);
afterAll(async () => {
  await disconnect();
  if (overlay) await compose("down", "--volumes", "--remove-orphans");
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

it("imports raw MIME and mapped labels, deduplicates, and recovers an uncertain response after restart", async () => {
  const raw = Buffer.from(
    "From: sender@example.test\r\nTo: alice@example.test\r\nDate: Thu, 02 Jan 2020 03:04:05 +0000\r\nMessage-ID: <import-one@example.test>\r\nX-Gmail-Labels: Sent,Starred\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=x.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECA/8=\r\n--x--\r\n",
  );
  const create = (data: Buffer, format: "mbox" | "eml") =>
    service.create(actor, {
      accountId: "default",
      format,
      variant: "mboxrd",
      base64: data.toString("base64"),
      mailboxId: inbox,
      labels: { Sent: sent },
    });
  const archive = Buffer.concat([
    Buffer.from("From sender Thu Jan 2 06:04:05 2020 +0000\r\n"),
    raw,
  ]);
  const job = value(await create(archive, "mbox"));
  expect(
    (
      await service.report({ ...actor, id: "other" }, "default", job.id)
    ).isErr(),
  ).toBe(true);
  loseResponse = true;
  await service.work();
  expect(
    value(await service.report(actor, "default", job.id)).messages[0]?.status,
  ).toBe("uncertain");
  service = newService();
  value(await service.resume(actor, "default", job.id));
  await service.work();
  expect(
    value(await service.report(actor, "default", job.id)).messages[0]?.status,
  ).toBe("imported");
  const session = value(await diagnostic.discover());
  const ids = value(await diagnostic.queryEmails(session, account)).ids;
  expect(ids).toHaveLength(1);
  const email = value(await diagnostic.emails(session, account, ids)).list[0];
  if (!email) throw new Error("Imported message missing");
  expect(
    Buffer.from(
      value(await diagnostic.download(session, account, email.blobId)),
    ),
  ).toEqual(raw);
  expect(email.mailboxIds).toMatchObject({ [inbox]: true, [sent]: true });
  expect(email.keywords).toMatchObject({ $flagged: true });
  expect(email.receivedAt).toBe("2020-01-02T06:04:05Z");
  expect(email.sentAt).toBe("2020-01-02T03:04:05Z");
  expect(email.attachments).toHaveLength(1);
  const attachment = email.attachments[0]?.blobId;
  if (attachment === undefined || attachment === null)
    throw new Error("Missing attachment blob");
  expect(
    Buffer.from(value(await diagnostic.download(session, account, attachment))),
  ).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  const duplicate = value(await create(raw, "eml"));
  await service.work();
  expect(
    value(await service.report(actor, "default", duplicate.id)),
  ).toMatchObject({ status: "completed", messages: [{ status: "duplicate" }] });
  expect(
    value(await diagnostic.queryEmails(session, account)).ids,
  ).toHaveLength(1);
}, 120_000);

it("retains failures for resume, safely cancels, and never retries an unresolved import", async () => {
  const empty = value(
    await service.create(actor, {
      accountId: "default",
      format: "mbox",
      variant: "mboxo",
      base64: "",
      mailboxId: inbox,
      labels: {},
    }),
  );
  await service.work();
  expect(value(await service.report(actor, "default", empty.id))).toMatchObject(
    { status: "completed", total: 0 },
  );
  const raw = Buffer.from(
    "From: sender@example.test\r\nTo: alice@example.test\r\nMessage-ID: <second@example.test>\r\n\r\nSecond\r\n",
  );
  const create = () =>
    service.create(actor, {
      accountId: "default",
      format: "eml",
      variant: "mboxo",
      base64: raw.toString("base64"),
      mailboxId: inbox,
      labels: {},
    });
  const failed = value(await create());
  failUpload = true;
  await service.work();
  expect(
    value(await service.report(actor, "default", failed.id)),
  ).toMatchObject({
    status: "attention",
    messages: [{ status: "failed", error: "Upload failed" }],
  });
  const saved = await db.mailImportJob.findUnique({ where: { id: failed.id } });
  expect(saved?.archive).toBeTruthy();
  expect(saved?.archive).not.toContain(raw.toString("base64"));
  value(await service.resume(actor, "default", failed.id));
  await service.work();
  expect(value(await service.report(actor, "default", failed.id)).status).toBe(
    "completed",
  );
  expect(
    (await db.mailImportJob.findUnique({ where: { id: failed.id } }))?.archive,
  ).toBeNull();

  const cancelled = value(await create());
  value(await service.cancel(actor, "default", cancelled.id));
  await service.work();
  expect(
    value(await service.report(actor, "default", cancelled.id)).status,
  ).toBe("cancelled");

  const unresolved = value(await create());
  await db.mailImportItem.update({
    where: { jobId_index: { jobId: unresolved.id, index: 0 } },
    data: { status: "importing" },
  });
  const session = value(await diagnostic.discover());
  const before = value(await diagnostic.queryEmails(session, account)).ids
    .length;
  await service.work();
  const report = value(await service.report(actor, "default", unresolved.id));
  expect(report).toMatchObject({
    status: "attention",
    messages: [{ status: "uncertain" }],
  });
  expect(
    value(await diagnostic.queryEmails(session, account)).ids,
  ).toHaveLength(before);
  value(await service.cancel(actor, "default", unresolved.id));
  await service.work();
  expect(
    value(await service.report(actor, "default", unresolved.id)),
  ).toMatchObject({
    status: "attention",
    cancelRequested: true,
    messages: [{ status: "uncertain" }],
  });
  expect((await create()).isErr()).toBe(true);
  const pending = await db.mailImportItem.findUnique({
    where: { jobId_index: { jobId: unresolved.id, index: 0 } },
  });
  if (pending === null) throw new Error("Missing import intent");
  const uploaded = value(await diagnostic.upload(session, account, raw));
  value(
    await diagnostic.importEmail(session, account, {
      blobId: uploaded.blobId,
      mailboxIds: { [inbox]: true },
      keywords: { [pending.marker]: true },
    }),
  );
  value(await service.resume(actor, "default", unresolved.id));
  await service.work();
  expect(
    value(await service.report(actor, "default", unresolved.id)),
  ).toMatchObject({ status: "cancelled", messages: [{ status: "imported" }] });
  expect(
    value(await diagnostic.queryEmails(session, account)).ids,
  ).toHaveLength(before + 1);
}, 120_000);

it("exposes progress only to the signed-in mailbox owner", async () => {
  const app = await buildServer({
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: now,
    }),
    migrationMail: service,
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) => {
        const id = headers.get("cookie");
        return Promise.resolve(
          id === "owner" || id === "other"
            ? { id, email: `${id}@example.test`, role: "user" }
            : null,
        );
      },
    },
  });
  try {
    const headers = { origin: "https://suite.example.test", cookie: "owner" };
    const created = await app.inject({
      method: "POST",
      url: "/mail/imports/create",
      headers,
      payload: {
        accountId: "default",
        format: "eml",
        variant: "mboxo",
        base64: Buffer.from(
          "Message-ID: <http@example.test>\r\n\r\nBody",
        ).toString("base64"),
        mailboxId: inbox,
        labels: {},
      },
    });
    expect(created.statusCode).toBe(200);
    const parsed = z.object({ id: z.string() }).parse(created.json());
    const listed = await app.inject({
      method: "POST",
      url: "/mail/imports/list",
      headers,
      payload: { accountId: "default" },
    });
    expect(listed.statusCode).toBe(200);
    const jobs = z
      .object({
        jobs: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(listed.json()).jobs;
    expect(jobs.find((job) => job.id === parsed.id)?.status).toBe("queued");
    const payload = { accountId: "default", jobId: parsed.id };
    const forbidden = await app.inject({
      method: "POST",
      url: "/mail/imports/report",
      headers: { ...headers, cookie: "other" },
      payload,
    });
    expect(forbidden.statusCode).toBe(403);
    const report = await app.inject({
      method: "POST",
      url: "/mail/imports/report",
      headers,
      payload,
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      id: parsed.id,
      status: "queued",
      total: 1,
    });
    expect(report.headers["cache-control"]).toBe("no-store");
    const cancelled = await app.inject({
      method: "POST",
      url: "/mail/imports/cancel",
      headers,
      payload,
    });
    expect(cancelled.statusCode).toBe(200);
    await service.work();
  } finally {
    await app.close();
  }
}, 120_000);

it("does not start queued imports while mailbox access is revoked", async () => {
  const raw = Buffer.from("Message-ID: <revoked@example.test>\r\n\r\nBody\r\n");
  const job = value(
    await service.create(actor, {
      accountId: "default",
      format: "eml",
      variant: "mboxo",
      base64: raw.toString("base64"),
      mailboxId: inbox,
      labels: {},
    }),
  );
  accountEnabled = false;
  try {
    await service.work();
    expect(
      (await db.mailImportJob.findUnique({ where: { id: job.id } }))?.status,
    ).toBe("attention");
    const session = value(await diagnostic.discover());
    const emails = value(
      await diagnostic.emails(
        session,
        account,
        value(await diagnostic.queryEmails(session, account)).ids,
      ),
    ).list;
    expect(
      emails.some((email) => email.messageId?.includes("revoked@example.test")),
    ).toBe(false);
  } finally {
    accountEnabled = true;
  }
  value(await service.cancel(actor, "default", job.id));
  await service.work();
}, 120_000);
