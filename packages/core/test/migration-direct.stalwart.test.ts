import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDatabase, type PrismaClient } from "@opensuite/db";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, expect, it } from "vitest";
import { directMigrationTools } from "../src/adapters/migration-direct.ts";
import { createDirectMigrationService } from "../src/services/migration-direct.ts";
import {
  DIRECT_SOURCE_LIMIT,
  MAIL_IMPORT_DESTINATION_CHANGED,
} from "@opensuite/contracts";
import type {
  DirectConnector,
  DirectSourceRef as SourceRef,
} from "@opensuite/contracts";

const run = promisify(execFile);
const project = `direct-import-${randomBytes(6).toString("hex")}`;
const root = new URL("../../../", import.meta.url);
const actor = {
  id: "owner",
  email: "alice@example.test",
  role: "user",
} as const;
const password = "fixture-destination-password";
const sourcePassword = "fixture-source-password";
const key = "ab".repeat(32);
const value = <T, E>(result: Result<T, E>): T =>
  result.match(
    (v) => v,
    () => {
      throw new Error("Fixture operation failed");
    },
  );
const raw = Buffer.from(
  "From: sender@example.test\r\nTo: alice@example.test\r\nDate: Thu, 02 Jan 2020 03:04:05 +0000\r\nMessage-ID: <direct@example.test>\r\nContent-Type: text/plain\r\n\r\nOriginal bytes\r\n",
);
const reference: SourceRef = {
  mailbox: "[Gmail]/All Mail",
  validity: "1",
  uid: 12,
  size: raw.length,
  labels: ["Project", "Sent"],
  flags: ["\\Seen"],
  date: "2020-01-02T03:04:05.000Z",
  emailId: "gmail-1",
};
let directory = "";
let overlay = "";
let base = "";
let db: PrismaClient;
let disconnect = () => Promise.resolve();
let account = "";
let inbox = "";
let sent = "";
let client: JmapClient;
let loseResponse = false;
let loseWithoutCommit = false;
let discoveryUnavailable = false;
let sourceReads = 0;
let sourceLogins = 0;
let revokeCount = 0;
let allowRevoke = true;
let refs: SourceRef[] = [reference];
let sourceRaw = raw;
let inventoryHook: (() => Promise<void>) | undefined;
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
const wait = async (fn: () => Promise<boolean>) => {
  const poll = async (remaining: number): Promise<void> => {
    if (await fn().catch(() => false)) return;
    if (!remaining) throw new Error("Fixture unavailable");
    await new Promise((resolve) => setTimeout(resolve, 500));
    return poll(remaining - 1);
  };
  return poll(120);
};
const connector: DirectConnector = (source) => {
  sourceLogins++;
  if (
    source.password !== sourcePassword &&
    source.password !== "fixture-oauth-token"
  )
    return Promise.reject(new Error("bad authentication"));
  return Promise.resolve({
    inventory: async () => {
      await inventoryHook?.();
      return refs;
    },
    read: () => {
      sourceReads++;
      return Promise.resolve(sourceRaw);
    },
    close: () => undefined,
  });
};
const fetcher: typeof fetch = async (url, init) => {
  const target = url instanceof Request ? url.url : url.toString();
  if (discoveryUnavailable && target.includes("/.well-known/jmap"))
    return new Response("unavailable", { status: 503 });
  if (
    loseWithoutCommit &&
    typeof init?.body === "string" &&
    init.body.includes('"Email/import"')
  ) {
    loseWithoutCommit = false;
    throw new Error("unknown fixture outcome");
  }
  const response = await fetch(url, init);
  if (
    loseResponse &&
    typeof init?.body === "string" &&
    init.body.includes('"Email/import"')
  ) {
    const body = await response.clone().text();
    if (body.includes('"created"')) {
      loseResponse = false;
      throw new Error("lost fixture response");
    }
  }
  return response;
};
function newService(oauthEnabled = false) {
  return createDirectMigrationService({
    db,
    key,
    origin: base,
    connectSource: connector,
    tools: directMigrationTools,
    oauthEnabled,
    revokeOAuth: () => {
      revokeCount++;
      return Promise.resolve(allowRevoke);
    },
    store: {
      getForOwner: (userId, id) =>
        Promise.resolve(
          userId === actor.id && ["default", account].includes(id)
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
let service: ReturnType<typeof newService>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "direct-import-"));
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
    client = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const session = value(await client.discover());
    account = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = value(await client.mailboxes(session, account)).list;
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

it("reconciles a lost response before resuming, preserves bytes and dates, maps labels and scopes jobs to their owner", async () => {
  const created = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: { Sent: sent },
      source: {
        kind: "gmail",
        username: "source@example.test",
        password: sourcePassword,
      },
    }),
  );
  expect(
    (
      await service.report({ ...actor, id: "other" }, "default", created.id)
    ).isErr(),
  ).toBe(true);
  const stored = await db.mailImportJob.findUniqueOrThrow({
    where: { id: created.id },
  });
  expect(stored.sourceConfig).not.toContain(sourcePassword);
  expect(stored.sourceKind).toBe("gmail");
  loseResponse = true;
  const runUntilStopped = async (remaining: number): Promise<void> => {
    await service.work();
    if (
      value(await service.report(actor, account, created.id)).status !==
      "queued"
    )
      return;
    if (!remaining) throw new Error("Job did not stop");
    await new Promise((resolve) => setTimeout(resolve, 250));
    return runUntilStopped(remaining - 1);
  };
  await runUntilStopped(10);
  const uncertain = value(await service.report(actor, account, created.id));
  expect(uncertain.status).toBe("attention");
  expect(uncertain.messages[0]?.status).toBe("uncertain");
  const before = sourceReads;
  service = newService();
  value(await service.resume(actor, account, created.id));
  await service.work();
  const done = value(await service.report(actor, account, created.id));
  expect(done.status).toBe("completed");
  expect(done.messages[0]?.status).toBe("imported");
  expect(sourceReads).toBe(before);
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: created.id } }))
      .sourceConfig,
  ).toBeNull();
  const session = value(await client.discover());
  const list = value(
    await client.queryEmails(session, account, { limit: 100 }),
  );
  expect(list.ids).toHaveLength(1);
  const messages = value(
    await client.migrationEmails(session, account, list.ids),
  );
  const firstMessage = messages.list[0];
  if (!firstMessage) throw new Error("Missing imported message");
  expect(
    Buffer.from(
      value(await client.download(session, account, firstMessage.blobId)),
    ),
  ).toEqual(raw);
  const detailed = value(await client.emails(session, account, list.ids));
  expect(detailed.list[0]?.receivedAt).toBe("2020-01-02T03:04:05Z");
  expect(detailed.list[0]?.mailboxIds).toMatchObject({
    [inbox]: true,
    [sent]: true,
  });
}, 120_000);

it("deduplicates an exact message and removes cancelled source credentials", async () => {
  const created = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "imap",
        host: "mail.example.test",
        port: 993,
        username: "source",
        password: sourcePassword,
      },
    }),
  );
  await service.work();
  expect(
    value(await service.report(actor, account, created.id)).messages[0]?.status,
  ).toBe("duplicate");
  const next = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "imap",
        host: "mail.example.test",
        port: 993,
        username: "source",
        password: sourcePassword,
      },
    }),
  );
  const logins = sourceLogins;
  value(await service.cancel(actor, account, next.id));
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: next.id } }))
      .sourceConfig,
  ).toBeNull();
  await service.work();
  expect(sourceLogins).toBe(logins);
  expect(value(await service.report(actor, account, next.id)).status).toBe(
    "cancelled",
  );
}, 120_000);

it("refuses OAuth by default, retries a failed revocation, and removes its encrypted token only after success", async () => {
  const input = {
    accountId: "default",
    mailboxId: inbox,
    labels: {},
    source: {
      kind: "gmail" as const,
      username: "source@example.test",
      oauthAccessToken: "fixture-oauth-token",
    },
  };
  expect((await service.create(actor, input)).isErr()).toBe(true);
  service = newService(true);
  refs = [];
  const created = value(await service.create(actor, input));
  allowRevoke = false;
  await service.work();
  expect(value(await service.report(actor, account, created.id)).status).toBe(
    "attention",
  );
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: created.id } }))
      .sourceConfig,
  ).not.toBeNull();
  allowRevoke = true;
  value(await service.resume(actor, account, created.id));
  await service.work();
  expect(value(await service.report(actor, account, created.id)).status).toBe(
    "completed",
  );
  expect(revokeCount).toBe(2);
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: created.id } }))
      .sourceConfig,
  ).toBeNull();
}, 120_000);

it("reports Message-ID collisions, imports missing IDs without claiming deduplication, and handles bad source authentication", async () => {
  service = newService();
  sourceRaw = Buffer.from(
    raw.toString().replace("Original bytes", "Different bytes"),
  );
  refs = [{ ...reference, size: sourceRaw.length }];
  const input = {
    accountId: "default",
    mailboxId: inbox,
    labels: {},
    source: {
      kind: "gmail" as const,
      username: "source@example.test",
      password: sourcePassword,
    },
  };
  const collision = value(await service.create(actor, input));
  await service.work();
  const report = value(await service.report(actor, account, collision.id));
  expect(report.status).toBe("attention");
  expect(report.messages[0]?.status).toBe("failed");
  value(await service.cancel(actor, account, collision.id));
  await service.work();

  sourceRaw = Buffer.from(
    "From: sender@example.test\r\nTo: alice@example.test\r\n\r\nNo ID\r\n",
  );
  refs = [{ ...reference, size: sourceRaw.length }];
  const missing = value(await service.create(actor, input));
  await service.work();
  expect(
    value(await service.report(actor, account, missing.id)).messages[0]?.status,
  ).toBe("imported");
  const again = value(await service.create(actor, input));
  await service.work();
  expect(
    value(await service.report(actor, account, again.id)).messages[0]?.status,
  ).toBe("imported");

  const bad = value(
    await service.create(actor, {
      ...input,
      source: { ...input.source, password: "incorrect" },
    }),
  );
  await service.work();
  expect(value(await service.report(actor, account, bad.id)).status).toBe(
    "attention",
  );
  value(await service.cancel(actor, account, bad.id));
  await service.work();
}, 120_000);

it("keeps an unprovable import uncertain, stops later imports, and requires confirmed abandonment", async () => {
  sourceRaw = Buffer.from(
    "From: sender@example.test\r\nMessage-ID: <unknown@example.test>\r\n\r\nUnknown\r\n",
  );
  refs = [
    { ...reference, size: sourceRaw.length },
    { ...reference, uid: 13, size: sourceRaw.length },
  ];
  const job = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "gmail",
        username: "source@example.test",
        password: sourcePassword,
      },
    }),
  );
  loseWithoutCommit = true;
  const reads = sourceReads;
  await service.work();
  let report = value(await service.report(actor, account, job.id));
  expect(report.messages.map((message) => message.status)).toEqual([
    "uncertain",
    "pending",
  ]);
  expect(sourceReads - reads).toBe(1);
  value(await service.resume(actor, account, job.id));
  await service.work();
  report = value(await service.report(actor, account, job.id));
  expect(report.messages.map((message) => message.status)).toEqual([
    "uncertain",
    "pending",
  ]);
  expect(sourceReads - reads).toBe(1);
  value(await service.cancel(actor, account, job.id));
  await service.work();
  report = value(await service.report(actor, account, job.id));
  expect(report.abandonment?.uncertainCount).toBe(1);
  expect((await service.abandon(actor, account, job.id, 2)).isErr()).toBe(true);
  expect(value(await service.abandon(actor, account, job.id, 1))).toEqual({
    abandoned: true,
  });
}, 120_000);

it("expires credentials and requires a fresh credential before resuming an unstarted inventory", async () => {
  refs = [];
  service = newService();
  const job = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "gmail",
        username: "source@example.test",
        password: sourcePassword,
      },
    }),
  );
  await db.mailImportJob.update({
    where: { id: job.id },
    data: { sourceExpiresAt: new Date(0) },
  });
  await service.work();
  const expired = value(await service.report(actor, account, job.id));
  expect(expired.status).toBe("attention");
  expect(expired.error).toContain("expired");
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: job.id } }))
      .sourceConfig,
  ).toBeNull();
  expect((await service.resume(actor, account, job.id)).isErr()).toBe(true);
  value(await service.resume(actor, account, job.id, sourcePassword));
  await service.work();
  expect(value(await service.report(actor, account, job.id)).status).toBe(
    "completed",
  );
}, 120_000);

it("requires revoking an old Google grant before replacing its token", async () => {
  refs = [];
  service = newService(true);
  const job = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "gmail",
        username: "source@example.test",
        oauthAccessToken: "fixture-oauth-token",
      },
    }),
  );
  allowRevoke = false;
  await service.work();
  expect(
    (await service.resume(actor, account, job.id, "new-token")).isErr(),
  ).toBe(true);
  expect((await service.revoke(actor, account, job.id)).isErr()).toBe(true);
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: job.id } }))
      .sourceConfig,
  ).not.toBeNull();
  allowRevoke = true;
  expect(value(await service.revoke(actor, account, job.id))).toEqual({
    revoked: true,
  });
  const disabled = newService(false);
  expect(
    (await disabled.resume(actor, account, job.id, "new-token")).isErr(),
  ).toBe(true);
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: job.id } }))
      .sourceConfig,
  ).toBeNull();
  value(await service.resume(actor, account, job.id, "new-token"));
  await service.work();
  expect(value(await service.report(actor, account, job.id)).status).toBe(
    "completed",
  );
}, 120_000);

it("retries inventory after its lease expires without completing or deleting credentials", async () => {
  refs = [];
  service = newService();
  const job = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "gmail",
        username: "source@example.test",
        password: sourcePassword,
      },
    }),
  );
  inventoryHook = async () => {
    await db.mailImportJob.update({
      where: { id: job.id },
      data: { claimUntil: new Date(0) },
    });
  };
  try {
    await service.work();
  } finally {
    inventoryHook = undefined;
  }
  const stored = await db.mailImportJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(stored.status).toBe("queued");
  expect(stored.inventoryReady).toBe(false);
  expect(stored.sourceConfig).not.toBeNull();
  await service.work();
  expect(value(await service.report(actor, account, job.id)).status).toBe(
    "completed",
  );
}, 120_000);

it("reports source inventory limits and the supported recovery for a changed destination", async () => {
  refs = [];
  service = newService();
  const input = {
    accountId: "default",
    mailboxId: inbox,
    labels: {},
    source: {
      kind: "gmail" as const,
      username: "source@example.test",
      password: sourcePassword,
    },
  };
  const limited = value(await service.create(actor, input));
  inventoryHook = () =>
    Promise.reject(
      Object.assign(new Error("limit"), { code: DIRECT_SOURCE_LIMIT }),
    );
  try {
    await service.work();
  } finally {
    inventoryHook = undefined;
  }
  const limitReport = value(await service.report(actor, account, limited.id));
  expect(limitReport.status).toBe("attention");
  expect(limitReport.error).toContain("1,000 messages");
  expect(limitReport.recovery?.action).toBe("resume");
  value(await service.cancel(actor, account, limited.id));
  await service.work();

  const changed = value(await service.create(actor, input));
  await db.mailImportJob.update({
    where: { id: changed.id },
    data: { status: "attention", error: MAIL_IMPORT_DESTINATION_CHANGED },
  });
  expect(
    value(await service.report(actor, account, changed.id)).recovery?.action,
  ).toBe("cancel");
  expect((await service.resume(actor, account, changed.id)).isErr()).toBe(true);
  value(await service.cancel(actor, account, changed.id));
  await service.work();
}, 120_000);

it("revokes an OAuth credential on cancellation even when destination discovery fails", async () => {
  refs = [];
  service = newService(true);
  const job = value(
    await service.create(actor, {
      accountId: "default",
      mailboxId: inbox,
      labels: {},
      source: {
        kind: "gmail",
        username: "source@example.test",
        oauthAccessToken: "fixture-oauth-token",
      },
    }),
  );
  value(await service.cancel(actor, account, job.id));
  const before = revokeCount;
  discoveryUnavailable = true;
  service = newService(true);
  await service.work();
  expect(revokeCount).toBe(before + 1);
  expect(
    (await db.mailImportJob.findUniqueOrThrow({ where: { id: job.id } }))
      .sourceConfig,
  ).toBeNull();
  discoveryUnavailable = false;
  value(await service.cancel(actor, account, job.id));
  await service.work();
  expect(value(await service.report(actor, account, job.id)).status).toBe(
    "cancelled",
  );
}, 120_000);
