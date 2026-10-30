import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  createDatabase,
  createDomainStore,
  createMailboxStore,
} from "@opensuite/db";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operatorCommand } from "../../../apps/ingest/src/operator.ts";
import { awsQueue, awsStorage } from "../src/adapters/aws.ts";
import { databaseLedger } from "../src/adapters/database.ts";
import { jmapDelivery } from "../src/adapters/jmap.ts";
import {
  parseNotification,
  resolveRecipients,
} from "../src/domain/notification.ts";
import { IngestService } from "../src/ingest/service.ts";
import { notification } from "./fixtures.ts";
import type { JmapError, Session } from "@opensuite/jmap";

const exec = promisify(execFile);
const root = new URL("../../../", import.meta.url);
const runId = (
  process.env["OPENSUITE_RUN_ID"] ?? randomBytes(5).toString("hex")
)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-");
const project = `opensuite-ingest-${runId}-${randomBytes(3).toString("hex")}`;
const compose = async (...args: string[]) =>
  (
    await exec(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        "test-support/compose.ingest.yaml",
        ...args,
      ],
      { cwd: root, maxBuffer: 4_000_000 },
    )
  ).stdout;
const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const port = async (service: string, target: string) => {
  const p = (await compose("port", service, target)).trim().split(":").at(-1);
  if (p === undefined) throw new Error("Missing port");
  return p;
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const ready = async (url: string, remaining: number): Promise<void> => {
  try {
    if ((await fetch(url)).ok) return;
  } catch {
    /* startup */
  }
  if (remaining === 0) throw new Error("Stalwart did not become ready");
  await pause(500);
  return ready(url, remaining - 1);
};
const rewrite = (base: string, url: string) =>
  `${base}${new URL(url).pathname}${new URL(url).search}`
    .replaceAll("%7B", "{")
    .replaceAll("%7D", "}");
let s3: S3Client | undefined;
let sqs: SQSClient | undefined;
let db: ReturnType<typeof createDatabase> | undefined;
let service: IngestService;
let queue: ReturnType<typeof awsQueue>;
let queueUrl: string;
let clients: Map<
  string,
  {
    client: JmapClient;
    session: Session;
    account: string;
    inbox: string;
    quarantine: string;
  }
>;
let origin: string;
let domainId: string;
const password = "cobalt-rocket-forest-9381!";
const getValue = <T>(result: Result<T, JmapError>) => unwrap(result);

const connectClients = async () => {
  clients = new Map();
  await Promise.all(
    ["alice", "bob"].map(async (name) => {
      const client = new JmapClient(origin, {
        authorization: `Basic ${Buffer.from(`${name}@example.test:${password}`).toString("base64")}`,
      });
      const original = getValue(await client.discover());
      const session = {
        ...original,
        apiUrl: rewrite(origin, original.apiUrl),
        uploadUrl: rewrite(origin, original.uploadUrl),
        downloadUrl: rewrite(origin, original.downloadUrl),
      };
      const account = session.primaryAccounts[JmapCapability.mail];
      if (account === undefined) throw new Error("Missing account");
      const boxes = getValue(await client.mailboxes(session, account)).list;
      const inbox = boxes.find((b) => b.role === "inbox")?.id;
      const quarantine = boxes.find((b) => b.role === "junk")?.id;
      if (inbox === undefined || quarantine === undefined)
        throw new Error("Missing inbox or junk");
      clients.set(name, { client, session, account, inbox, quarantine });
    }),
  );
};

// Static destinations are keyed by the Stalwart account ID they open.
const account = (name: string) => {
  const mailbox = clients.get(name);
  if (mailbox === undefined) throw new Error("Missing client");
  return mailbox.account;
};
// Count by listing the whole mailbox and reading subjects: Stalwart's
// full-text index is asynchronous, so a subject search can miss a copy.
const bySubject = async (
  m: { client: JmapClient; session: Session; account: string },
  subject: string,
) => {
  const all = getValue(
    await m.client.queryEmails(m.session, m.account, {}),
  ).ids;
  if (all.length === 0) return [];
  return getValue(await m.client.emails(m.session, m.account, all))
    .list.filter((email) => email.subject === subject)
    .map((email) => email.id);
};
// Held mail is routed only within the hold window: date it now.
const recent = (recipients: string[], status: string, messageId: string) => {
  const body = notification(recipients, status, messageId);
  const now = new Date().toISOString();
  return JSON.stringify({
    ...body,
    mail: { ...body.mail, timestamp: now },
    receipt: { ...body.receipt, timestamp: now },
  });
};
const connectService = (
  extraRoutes: { address: string; destination: string }[] = [],
) => {
  if (s3 === undefined || db === undefined || db.isErr())
    throw new Error("Clients not initialized");
  const delivery = jmapDelivery(
    ["alice", "bob"].map((name) => {
      const mailbox = clients.get(name);
      if (mailbox === undefined) throw new Error("Missing client");
      return {
        id: mailbox.account,
        origin,
        authorization: `Basic ${Buffer.from(`${name}@example.test:${password}`).toString("base64")}`,
        quarantineMailbox: mailbox.quarantine,
        rewriteSessionUrls: true,
      };
    }),
  );
  service = new IngestService({
    storage: awsStorage(s3, s3, "inbound", "archive", "notifications/", ""),
    ledger: databaseLedger(db.value),
    delivery,
    routes: [
      { address: "alice@example.test", destination: account("alice") },
      { address: "alias@other.test", destination: account("alice") },
      { address: "hidden@example.test", destination: account("bob") },
      ...extraRoutes,
    ],
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 5,
    events: { emit() {} },
  });
};

// Holds the message row lock in a separate transaction until released.
const holdLock = async (messageId: string) => {
  if (db === undefined || db.isErr()) throw new Error("No database");
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = db.value.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "InboundMessage" WHERE "id" = ${messageId} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    },
    { timeout: 60_000 },
  );
  await locked.promise;
  return async () => {
    release.resolve();
    await done;
  };
};
const heldMessage = async (id: string, address: string, subject: string) => {
  if (s3 === undefined || db === undefined || db.isErr())
    throw new Error("Clients not initialized");
  await s3.send(
    new PutObjectCommand({
      Bucket: "inbound",
      Key: id,
      Body: Buffer.from(
        `From: sender@example.test\r\nTo: ${address}\r\nSubject: ${subject}\r\n\r\nRace\r\n`,
      ),
    }),
  );
  const body = recent([address], "PASS", id);
  expect((await service.process(body)).isOk()).toBe(true);
  const row = await db.value.inboundRecipient.findFirstOrThrow({
    where: { messageId: id },
  });
  expect(row.state).toBe("held");
  return { body, key: row.idempotencyKey };
};

describe("local ingestion pipeline", () => {
  beforeAll(async () => {
    try {
      await compose("up", "-d", "--wait", "--wait-timeout", "240");
      const pg = await port("postgres", "5432");
      const aws = `http://127.0.0.1:${await port("localstack", "4566")}`;
      origin = `http://127.0.0.1:${await port("stalwart", "8080")}`;
      await ready(`${origin}/healthz/ready`, 120);
      const databaseUrl = `postgresql://ingest:test-password@127.0.0.1:${pg}/ingest`;
      await exec(
        "pnpm",
        ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
        { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl } },
      );
      db = createDatabase(databaseUrl);
      unwrap(db);
      const config = {
        region: "us-east-1",
        endpoint: aws,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      };
      s3 = new S3Client({ ...config, forcePathStyle: true });
      sqs = new SQSClient(config);
      const found = await sqs.send(
        new GetQueueUrlCommand({ QueueName: "inbound" }),
      );
      if (found.QueueUrl === undefined) throw new Error("Missing queue URL");
      queueUrl = found.QueueUrl.replace(/https?:\/\/[^/]+/, aws);
      queue = awsQueue(sqs, queueUrl);
      const admin = new StalwartAdmin(origin, {
        username: "admin",
        password: "integration-password",
      });
      domainId = getValue(await admin.createDomain("example.test")).id;
      await Promise.all(
        ["alice", "bob"].map(async (name) =>
          getValue(await admin.createAccount(name, domainId, password)),
        ),
      );
      await connectClients();
      connectService();
    } catch (error) {
      await compose("down", "--volumes", "--remove-orphans");
      throw error;
    }
  }, 300_000);
  afterAll(async () => {
    if (db?.isOk()) await db.value.$disconnect();
    s3?.destroy();
    sqs?.destroy();
    await compose("down", "--volumes", "--remove-orphans");
  }, 60_000);
  it("imports envelope recipients and deduplicates SQS redelivery after a simulated crash", async () => {
    if (s3 === undefined || sqs === undefined)
      throw new Error("Clients not initialized");
    const body = JSON.stringify(
      notification([
        "alice@example.test",
        "alias@other.test",
        "hidden@example.test",
      ]),
    );
    const raw = Buffer.from(
      "From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Ingest\r\n\r\nHello\r\n",
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "inbound", Key: "ses-1", Body: raw }),
    );
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }),
    );
    const item = unwrap(await queue.receive())[0];
    if (item === undefined) throw new Error("No queue message");
    expect((await service.process(item.body)).isOk()).toBe(true); // crash after durable import, before delete
    expect((await service.handle(queue, item)).isOk()).toBe(true);
    await Promise.all(
      ["alice", "bob"].map(async (name) => {
        const m = clients.get(name);
        if (m === undefined) throw new Error("Missing client");
        const ids = await bySubject(m, "Ingest");
        expect(ids).toHaveLength(1);
        const email = getValue(await m.client.emails(m.session, m.account, ids))
          .list[0];
        if (email === undefined) throw new Error("Missing email");
        expect(
          Buffer.from(
            getValue(
              await m.client.download(m.session, m.account, email.blobId),
            ),
          ),
        ).toEqual(raw);
      }),
    );
  }, 90_000);
  it("quarantines a failed verdict, holds unknown recipients and routes them once provisioned", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const raw = Buffer.from(
      "From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Quarantine\r\n\r\nSuspicious\r\n",
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "inbound", Key: "ses-fail", Body: raw }),
    );
    // unknown@ will become Bob's alias; late@ an alias of Alice, who already
    // received the message and must not receive it twice.
    const body = recent(
      ["alice@example.test", "unknown@example.test", "late@example.test"],
      "FAIL",
      "ses-fail",
    );
    expect((await service.process(body)).isOk()).toBe(true);
    const rows = await db.value.inboundRecipient.findMany({
      where: { messageId: "ses-fail" },
    });
    expect(rows.map((row) => row.state).toSorted()).toEqual([
      "held",
      "held",
      "quarantined",
    ]);
    const alice = clients.get("alice");
    const bob = clients.get("bob");
    if (alice === undefined || bob === undefined)
      throw new Error("Missing mailboxes");
    const importedId = rows.find(
      (row) => row.state === "quarantined",
    )?.remoteId;
    if (importedId === undefined || importedId === null)
      throw new Error("Missing quarantined email ID");
    const email = getValue(
      await alice.client.emails(alice.session, alice.account, [importedId]),
    ).list[0];
    expect(email?.mailboxIds[alice.quarantine]).toBe(true);
    const client = s3;
    const storage = awsStorage(
      client,
      client,
      "inbound",
      "archive",
      "notifications/",
      "",
    );
    // The held recipients keep the original message object.
    expect(unwrap(await storage.bufferKeys())).toContain("ses-fail");
    // A replay before provisioning changes nothing.
    expect((await service.reconcile(3600)).isOk()).toBe(true);
    expect(unwrap(await storage.bufferKeys())).toContain("ses-fail");
    connectService([
      { address: "unknown@example.test", destination: account("bob") },
      { address: "late@example.test", destination: account("alice") },
    ]);
    try {
      expect((await service.reconcile(3600)).isOk()).toBe(true);
      expect((await service.reconcile(3600)).isOk()).toBe(true);
    } finally {
      connectService();
    }
    const after = await db.value.inboundRecipient.findMany({
      where: { messageId: "ses-fail" },
    });
    expect(
      after
        .map((row) => `${row.destination} ${row.state}`)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        `${account("alice")} quarantined`,
        `${account("bob")} quarantined`,
        "late@example.test rerouted",
        "unknown@example.test rerouted",
      ].toSorted((a, b) => a.localeCompare(b)),
    );
    const delivered = await bySubject(bob, "Quarantine");
    expect(delivered).toHaveLength(1);
    // Alice already had it: still exactly one copy.
    expect(await bySubject(alice, "Quarantine")).toHaveLength(1);
    const copy = getValue(
      await bob.client.emails(bob.session, bob.account, delivered),
    ).list[0];
    if (copy === undefined) throw new Error("Missing Bob's copy");
    expect(
      Buffer.from(
        getValue(
          await bob.client.download(bob.session, bob.account, copy.blobId),
        ),
      ),
    ).toEqual(raw);
    expect(unwrap(await storage.bufferKeys())).not.toContain("ses-fail");
    expect(
      (
        await db.value.inboundMessage.findUniqueOrThrow({
          where: { id: "ses-fail" },
        })
      ).state,
    ).toBe("imported");
  }, 120_000);

  it("keeps a held recipient until an audited operator rejection", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const raw = Buffer.from(
      "From: sender@example.test\r\nTo: nobody@example.test\r\nSubject: Held\r\n\r\nWaiting\r\n",
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "inbound", Key: "ses-held", Body: raw }),
    );
    const body = recent(["nobody@example.test"], "PASS", "ses-held");
    expect((await service.process(body)).isOk()).toBe(true);
    const row = await db.value.inboundRecipient.findFirstOrThrow({
      where: { messageId: "ses-held" },
    });
    expect(row.state).toBe("held");
    const client = s3;
    const storage = awsStorage(
      client,
      client,
      "inbound",
      "archive",
      "notifications/",
      "",
    );
    expect(unwrap(await storage.bufferKeys())).toContain("ses-held");
    const dependencies = {
      db: db.value,
      ledger: databaseLedger(db.value),
      delivery: jmapDelivery([]),
      storage,
    };
    expect(
      JSON.stringify(await operatorCommand(dependencies, ["list", "held"])),
    ).toContain(row.idempotencyKey);
    await expect(
      operatorCommand(dependencies, [
        "reject",
        row.idempotencyKey,
        "operator",
        "short",
      ]),
    ).rejects.toThrow("too_small");
    const reason = "No such mailbox; sender informed";
    await operatorCommand(dependencies, [
      "reject",
      row.idempotencyKey,
      "operator",
      reason,
    ]);
    await expect(
      operatorCommand(dependencies, [
        "reject",
        row.idempotencyKey,
        "operator",
        reason,
      ]),
    ).rejects.toThrow("Only a held recipient");
    expect(
      await db.value.inboundResolutionAudit.findMany({
        where: { recipientKey: row.idempotencyKey },
      }),
    ).toEqual([
      expect.objectContaining({
        action: "reject",
        previousState: "held",
        operator: "operator",
        reason,
      }),
    ]);
    // The next replay finds the message complete and deletes the object.
    expect((await service.reconcile(3600)).isOk()).toBe(true);
    expect(unwrap(await storage.bufferKeys())).not.toContain("ses-held");
    expect(
      (
        await db.value.inboundMessage.findUniqueOrThrow({
          where: { id: "ses-held" },
        })
      ).state,
    ).toBe("imported");
  }, 90_000);

  for (const first of ["reject", "route"] as const)
    it(`keeps a rejection and its audit consistent with delivery when ${first} reaches the lock first`, async () => {
      if (s3 === undefined || db === undefined || db.isErr())
        throw new Error("Clients not initialized");
      const id = `ses-race-${first}`;
      const address = `race-${first}@example.test`;
      const subject = `Race ${first}`;
      const { body, key } = await heldMessage(id, address, subject);
      const client = s3;
      const dependencies = {
        db: db.value,
        ledger: databaseLedger(db.value),
        delivery: jmapDelivery([]),
        storage: awsStorage(
          client,
          client,
          "inbound",
          "archive",
          "notifications/",
          "",
        ),
      };
      const release = await holdLock(id);
      const settled = new Set<string>();
      const reject = () =>
        operatorCommand(dependencies, [
          "reject",
          key,
          "operator",
          "Race test rejection",
        ]).then(
          () => "rejected",
          (error: unknown) =>
            error instanceof Error ? error.message : "error",
        );
      connectService([{ address, destination: account("bob") }]);
      let rejection: Promise<string>;
      let routing: Promise<unknown>;
      try {
        if (first === "reject") {
          rejection = reject();
          await pause(300);
          routing = service.process(body);
        } else {
          routing = service.process(body);
          await pause(300);
          rejection = reject();
        }
        void rejection.then(() => settled.add("reject"));
        void routing.then(() => settled.add("route"));
        await pause(500);
        // Both are waiting for the lock.
        expect([...settled]).toEqual([]);
        await release();
        await Promise.all([rejection, routing]);
      } finally {
        connectService();
      }
      const outcome = await rejection;
      const row = await db.value.inboundRecipient.findUniqueOrThrow({
        where: { idempotencyKey: key },
      });
      const audits = await db.value.inboundResolutionAudit.count({
        where: { recipientKey: key, action: "reject" },
      });
      const bob = clients.get("bob");
      if (bob === undefined) throw new Error("Missing Bob");
      const copies = (await bySubject(bob, subject)).length;
      // Either the rejection won (recorded, nothing delivered) or routing
      // won (delivered once, rejection refused and not audited).
      expect(
        outcome === "rejected"
          ? [row.state, audits, copies]
          : [row.state, audits, copies, outcome],
      ).toEqual(
        outcome === "rejected"
          ? ["rejected", 1, 0]
          : [
              "rerouted",
              0,
              1,
              "Only a held recipient or one whose destination is not configured can be rejected",
            ],
      );
      // Finish the message either way: the object goes once nothing is left.
      expect((await service.reconcile(3600)).isOk()).toBe(true);
      expect(unwrap(await dependencies.storage.bufferKeys())).not.toContain(id);
    }, 90_000);

  it("does not route a held address when the window ends while waiting for the lock", async () => {
    if (db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const id = "ses-race-window";
    const address = "window@example.test";
    const { body } = await heldMessage(id, address, "Race window");
    const parsed = parseNotification(body);
    if (parsed.isErr()) throw new Error(parsed.error);
    const release = await holdLock(id);
    // The address is now known, but the window ends before the lock frees.
    const preparing = databaseLedger(db.value).prepare(
      parsed.value,
      resolveRecipients([address], [{ address, destination: account("bob") }]),
      { rerouteUntil: Date.now() + 300 },
    );
    await pause(700);
    await release();
    expect((await preparing).isOk()).toBe(true);
    expect(
      (
        await db.value.inboundRecipient.findMany({ where: { messageId: id } })
      ).map((row) => `${row.destination} ${row.state}`),
    ).toEqual([`${address} held`]);
    // Clean up: an operator rejection lets replay remove the object.
    const key = (
      await db.value.inboundRecipient.findFirstOrThrow({
        where: { messageId: id },
      })
    ).idempotencyKey;
    const updated = await db.value.inboundRecipient.updateMany({
      where: { idempotencyKey: key, state: "held" },
      data: { state: "rejected" },
    });
    expect(updated.count).toBe(1);
    expect((await service.reconcile(3600)).isOk()).toBe(true);
  }, 90_000);

  it("rejects held mail after the hold window with an audit and never routes it late", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-expired",
        Body: Buffer.from(
          "From: sender@example.test\r\nTo: gone@example.test\r\nSubject: Expired\r\n\r\nOld\r\n",
        ),
      }),
    );
    // The fixture date (January 2026) is beyond the default 14-day window.
    const body = JSON.stringify(
      notification(["gone@example.test"], "PASS", "ses-expired"),
    );
    expect((await service.process(body)).isOk()).toBe(true);
    const row = await db.value.inboundRecipient.findFirstOrThrow({
      where: { messageId: "ses-expired" },
    });
    expect(row.state).toBe("held");
    connectService([
      { address: "gone@example.test", destination: account("bob") },
    ]);
    try {
      expect((await service.reconcile(3600)).isOk()).toBe(true);
    } finally {
      connectService();
    }
    expect(
      (
        await db.value.inboundRecipient.findUniqueOrThrow({
          where: { idempotencyKey: row.idempotencyKey },
        })
      ).state,
    ).toBe("rejected");
    expect(
      await db.value.inboundResolutionAudit.findMany({
        where: { recipientKey: row.idempotencyKey },
      }),
    ).toEqual([
      expect.objectContaining({
        action: "expire",
        operator: "system:expiry",
        previousState: "held",
        reason: "Hold window of 14 days elapsed",
      }),
    ]);
    // Never routed: no mailbox recipient was created for it.
    expect(
      (
        await db.value.inboundRecipient.findMany({
          where: { messageId: "ses-expired" },
        })
      ).map((item) => `${item.destination} ${item.state}`),
    ).toEqual(["gone@example.test rejected"]);
    const client = s3;
    expect(
      unwrap(
        await awsStorage(
          client,
          client,
          "inbound",
          "archive",
          "notifications/",
          "",
        ).bufferKeys(),
      ),
    ).not.toContain("ses-expired");
  }, 90_000);

  it("delivers to a mailbox linked after start-up, without a restart, and only into its own account", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const prisma = db.value;
    const store = unwrap(createMailboxStore(prisma, "ef".repeat(32)));
    const linked = jmapDelivery([], {
      origin,
      credential: async (accountId) => store.getForAccount(accountId),
    });
    // Built before the mailbox exists, as a running worker would be.
    const dependencies = {
      storage: awsStorage(s3, s3, "inbound", "archive", "notifications/", ""),
      ledger: databaseLedger(prisma),
      delivery: linked,
      routes: [],
      resolveRoutes: async (addresses: string[]) =>
        createDomainStore(prisma).routes(addresses),
      bucket: "inbound",
      bufferPrefix: "",
      topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
      maxAttempts: 5,
      events: { emit() {} },
    };
    const dynamic = new IngestService(dependencies);
    const raw = Buffer.from(
      "From: sender@example.test\r\nTo: carol@example.test\r\nSubject: Linked\r\n\r\nWelcome\r\n",
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "inbound", Key: "ses-linked", Body: raw }),
    );
    const body = recent(["carol@example.test"], "PASS", "ses-linked");
    expect((await dynamic.process(body)).isOk()).toBe(true);
    expect(
      (
        await prisma.inboundRecipient.findFirstOrThrow({
          where: { messageId: "ses-linked" },
        })
      ).state,
    ).toBe("held");

    // Provision Carol as signup and bootstrap do: a Stalwart account, then
    // only the user and its encrypted mailbox link, with no address record.
    const admin = new StalwartAdmin(origin, {
      username: "admin",
      password: "integration-password",
    });
    const created = getValue(
      await admin.createAccount("carol", domainId, password),
    );
    const carolClient = new JmapClient(origin, {
      authorization: `Basic ${Buffer.from(`carol@example.test:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: origin,
    });
    const session = getValue(await carolClient.discover());
    const carolAccount = session.primaryAccounts[JmapCapability.mail];
    if (carolAccount === undefined) throw new Error("Missing account");
    // The API stores the management API's account ID; delivery checks it
    // against the JMAP session.
    expect(created.id).toBe(carolAccount);
    const boxes = getValue(
      await carolClient.mailboxes(session, carolAccount),
    ).list;
    const carol = { client: carolClient, session, account: carolAccount };
    const inbox = boxes.find((box) => box.role === "inbox")?.id;
    const junk = boxes.find((box) => box.role === "junk")?.id;
    if (inbox === undefined || junk === undefined)
      throw new Error("Missing inbox or junk");
    await prisma.user.create({
      data: { id: "carol", name: "Carol", email: "carol@example.test" },
    });
    unwrap(
      await store.create({
        userId: "carol",
        accountId: carolAccount,
        address: "carol@example.test",
        credentialId: "carol",
        secret: password,
      }),
    );

    expect((await dynamic.process(body)).isOk()).toBe(true);
    const delivered = await bySubject(carol, "Linked");
    expect(delivered).toHaveLength(1);
    const email = getValue(
      await carolClient.emails(session, carolAccount, delivered),
    ).list[0];
    expect(email?.mailboxIds).toEqual({ [inbox]: true });
    if (email === undefined) throw new Error("Missing email");
    expect(
      Buffer.from(
        getValue(
          await carolClient.download(session, carolAccount, email.blobId),
        ),
      ),
    ).toEqual(raw);
    expect(
      (
        await prisma.inboundMessage.findUniqueOrThrow({
          where: { id: "ses-linked" },
        })
      ).state,
    ).toBe("imported");

    // Quarantine without a configured mailbox ID goes to the junk role.
    const suspect = Buffer.from(
      "From: sender@example.test\r\nTo: carol@example.test\r\nSubject: Linked junk\r\n\r\nSpam\r\n",
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-linked-junk",
        Body: suspect,
      }),
    );
    expect(
      (
        await dynamic.process(
          recent(["carol@example.test"], "FAIL", "ses-linked-junk"),
        )
      ).isOk(),
    ).toBe(true);
    const quarantined = await bySubject(carol, "Linked junk");
    expect(quarantined).toHaveLength(1);
    expect(
      getValue(await carolClient.emails(session, carolAccount, quarantined))
        .list[0]?.mailboxIds,
    ).toEqual({ [junk]: true });

    // A link whose credential opens another account (here Alice's) is
    // never used.
    await prisma.user.create({
      data: { id: "mallory", name: "Mallory", email: "mallory@example.test" },
    });
    unwrap(
      await store.create({
        userId: "mallory",
        accountId: "not-alice",
        address: "alice@example.test",
        credentialId: "mallory",
        secret: password,
      }),
    );
    const misdirected = await linked.import(
      "not-alice",
      suspect,
      false,
      new Date().toISOString(),
      "misdirected",
      new Map(),
      () => Promise.resolve(ok(undefined)),
    );
    expect(misdirected.isErr() && misdirected.error.message).toBe(
      "Destination credential is for another account",
    );
    // Disabling the mailbox stops delivery at once.
    await prisma.mailboxLink.update({
      where: { userId: "carol" },
      data: { status: "disabling" },
    });
    const disabled = await linked.import(
      carolAccount,
      suspect,
      false,
      new Date().toISOString(),
      "disabled",
      new Map(),
      () => Promise.resolve(ok(undefined)),
    );
    expect(disabled.isErr() && disabled.error.message).toBe(
      "Destination is not configured",
    );
    // So does disabling its user.
    await prisma.mailboxLink.update({
      where: { userId: "carol" },
      data: { status: "active" },
    });
    await prisma.user.update({
      where: { id: "carol" },
      data: { disabled: true },
    });
    const blocked = await linked.import(
      carolAccount,
      suspect,
      false,
      new Date().toISOString(),
      "blocked",
      new Map(),
      () => Promise.resolve(ok(undefined)),
    );
    expect(blocked.isErr() && blocked.error.message).toBe(
      "Destination is not configured",
    );
    await prisma.user.update({
      where: { id: "carol" },
      data: { disabled: false },
    });
    // Mail routed before its mailbox was disabled waits without end; an
    // operator can reject it and the next pass deletes its object.
    const closed = new IngestService({
      ...dependencies,
      delivery: jmapDelivery([], {
        origin,
        credential: () => Promise.resolve(err({ kind: "not_found" })),
      }),
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-linked-closed",
        Body: suspect,
      }),
    );
    const closedBody = recent(
      ["carol@example.test"],
      "PASS",
      "ses-linked-closed",
    );
    await closed.process(closedBody);
    const stuck = await prisma.inboundRecipient.findFirstOrThrow({
      where: { messageId: "ses-linked-closed" },
    });
    expect([stuck.state, stuck.error]).toEqual([
      "failed",
      "Destination is not configured",
    ]);
    await operatorCommand(
      {
        db: prisma,
        ledger: databaseLedger(prisma),
        delivery: linked,
        storage: dependencies.storage,
      },
      [
        "reject",
        stuck.idempotencyKey,
        "operator",
        "Mailbox closed; sender told",
      ],
    );
    expect(
      await prisma.inboundResolutionAudit.findFirstOrThrow({
        where: { recipientKey: stuck.idempotencyKey },
      }),
    ).toMatchObject({ action: "reject", previousState: "failed" });
    expect((await closed.process(closedBody)).isOk()).toBe(true);
    await expect(
      s3.send(
        new GetObjectCommand({ Bucket: "inbound", Key: "ses-linked-closed" }),
      ),
    ).rejects.toThrow(/does not exist/);
    expect(await bySubject(carol, "Linked junk")).toHaveLength(1);
  }, 90_000);
  it("replays an archived notification after queue loss with a large attachment", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const header = Buffer.from(
      "From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Large archive\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=abc\r\n\r\n--abc\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=large.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    );
    const raw = Buffer.concat([
      header,
      Buffer.from(
        Buffer.alloc(20_000_000, 65)
          .toString("base64")
          .replace(/.{76}/g, "$&\r\n"),
      ),
      Buffer.from("\r\n--abc--\r\n"),
    ]);
    await s3.send(
      new PutObjectCommand({ Bucket: "inbound", Key: "ses-large", Body: raw }),
    );
    const storage = awsStorage(
      s3,
      s3,
      "inbound",
      "archive",
      "notifications/",
      "",
    );
    unwrap(
      await storage.archive(
        "external-large.json",
        JSON.stringify(
          notification(["alice@example.test"], "PASS", "ses-large"),
        ),
      ),
    );
    expect((await service.reconcile(1)).isOk()).toBe(true);
    const alice = clients.get("alice");
    if (alice === undefined) throw new Error("Missing Alice");
    const rows = await db.value.inboundRecipient.findMany({
      where: { messageId: "ses-large" },
    });
    expect(rows[0]?.state).toBe("imported");
    const importedId = rows[0]?.remoteId;
    if (importedId === undefined || importedId === null)
      throw new Error("No imported email ID");
    const ids = [importedId];
    const email = getValue(
      await alice.client.emails(alice.session, alice.account, ids),
    ).list[0];
    if (email === undefined) throw new Error("Missing email");
    expect(email.attachments[0]?.size).toBe(20_000_000);
    const stored = Buffer.from(
      getValue(
        await alice.client.download(alice.session, alice.account, email.blobId),
      ),
    );
    expect(stored.equals(raw)).toBe(true);
  }, 120_000);

  it("retains failed delivery during a server outage and retries after recovery", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-outage",
        Body: "From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Recovery\r\n\r\nHello\r\n",
      }),
    );
    const body = JSON.stringify(
      notification(["alice@example.test"], "PASS", "ses-outage"),
    );
    await compose("stop", "stalwart");
    try {
      expect((await service.process(body)).isErr()).toBe(true);
    } finally {
      await compose("start", "stalwart");
      origin = `http://127.0.0.1:${await port("stalwart", "8080")}`;
      await ready(`${origin}/healthz/ready`, 120);
      await connectClients();
      connectService();
    }
    expect((await service.process(body)).isOk()).toBe(true);
    const rows = await db.value.inboundRecipient.findMany({
      where: { messageId: "ses-outage" },
    });
    expect(rows[0]?.state).toBe("imported");
    expect(rows[0]?.attempts).toBe(0);
  }, 120_000);
  it("reconciles a lost import response against Stalwart without a duplicate", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const alice = clients.get("alice");
    if (alice === undefined) throw new Error("Missing Alice");
    const raw = Buffer.from(
      "Message-ID: <reconcile@example.test>\r\nFrom: sender@example.test\r\nTo: alice@example.test\r\nSubject: Reconcile\r\n\r\nHello\r\n",
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-reconcile",
        Body: raw,
      }),
    );
    const delivery = jmapDelivery([
      {
        id: account("alice"),
        origin,
        authorization: `Basic ${Buffer.from(`alice@example.test:${password}`).toString("base64")}`,
        quarantineMailbox: alice.quarantine,
        rewriteSessionUrls: true,
      },
    ]);
    const ledger = databaseLedger(db.value);
    const recovering = new IngestService({
      storage: awsStorage(s3, s3, "inbound", "archive", "notifications/", ""),
      ledger,
      delivery: {
        ...delivery,
        async import(...args) {
          const result = await delivery.import(...args);
          return result.isErr()
            ? result
            : err({ message: "response lost", ambiguous: true });
        },
      },
      routes: [
        { address: "alice@example.test", destination: account("alice") },
      ],
      bucket: "inbound",
      bufferPrefix: "",
      topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
      maxAttempts: 5,
      events: { emit() {} },
    });
    const body = JSON.stringify(
      notification(["alice@example.test"], "PASS", "ses-reconcile"),
    );
    expect((await recovering.process(body)).isErr()).toBe(true);
    expect((await recovering.process(body)).isOk()).toBe(true);
    const stored = await db.value.inboundMessage.findUniqueOrThrow({
      where: { id: "ses-reconcile" },
    });
    expect(stored.notification).toMatchObject({ notificationType: "Received" });
    expect((await recovering.reconcile(1)).isOk()).toBe(true);
    const row = await db.value.inboundRecipient.findFirstOrThrow({
      where: { messageId: "ses-reconcile" },
    });
    expect(row.state).toBe("imported");
    const ids = await bySubject(alice, "Reconcile");
    expect(ids).toHaveLength(1);
    const email = getValue(
      await alice.client.emails(alice.session, alice.account, ids),
    ).list[0];
    expect(email?.receivedAt).toBe("2026-01-02T03:04:05Z");
    expect(row.remoteId).toBe(ids[0]);
  }, 90_000);

  it("moves a stale claim to uncertain and fences its old owner", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const body = JSON.stringify(
      notification(["alice@example.test"], "PASS", "ses-stale"),
    );
    const parsed = parseNotification(body);
    if (parsed.isErr()) throw new Error(parsed.error);
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-stale",
        Body: "Message-ID: <stale@example.test>\r\n\r\nbody",
      }),
    );
    const ledger = databaseLedger(db.value);
    const rows = unwrap(
      await ledger.prepare(
        parsed.value,
        resolveRecipients(
          ["alice@example.test"],
          [{ address: "alice@example.test", destination: account("alice") }],
        ),
      ),
    );
    const key = rows[0]?.key;
    if (key === undefined) throw new Error("Missing row");
    expect(unwrap(await ledger.claim(key, "old-owner"))).toBe(true);
    expect(unwrap(await ledger.startImport(key, "old-owner"))).toBe(true);
    await db.value.inboundRecipient.update({
      where: { idempotencyKey: key },
      data: { claimedAt: new Date(Date.now() - 700_000) },
    });
    expect((await service.process(body)).isErr()).toBe(true);
    expect(
      (
        await ledger.finish(key, "imported", "late", undefined, "old-owner")
      ).isErr(),
    ).toBe(true);
    const row = await db.value.inboundRecipient.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    expect(row.state).toBe("uncertain");
    expect((await service.reconcile(1)).isErr()).toBe(true);
    expect(
      (
        await db.value.inboundRecipient.findUniqueOrThrow({
          where: { idempotencyKey: key },
        })
      ).state,
    ).toBe("uncertain");
  }, 90_000);
  it("retries expired claims that never reached import and preserves legacy claims", async () => {
    if (db === undefined || db.isErr()) throw new Error("Missing database");
    const ledger = databaseLedger(db.value);
    const body = JSON.stringify(
      notification(["alice@example.test"], "PASS", "ses-prestart"),
    );
    const parsed = parseNotification(body);
    if (parsed.isErr()) throw new Error(parsed.error);
    const rows = unwrap(
      await ledger.prepare(
        parsed.value,
        resolveRecipients(
          ["alice@example.test"],
          [{ address: "alice@example.test", destination: account("alice") }],
        ),
      ),
    );
    const key = rows[0]?.key;
    if (key === undefined) throw new Error("Missing recipient");
    expect(unwrap(await ledger.claim(key, "old"))).toBe(true);
    await db.value.inboundRecipient.update({
      where: { idempotencyKey: key },
      data: { claimedAt: new Date(Date.now() - 700_000) },
    });
    unwrap(await ledger.expireClaims());
    expect(
      (
        await db.value.inboundRecipient.findUniqueOrThrow({
          where: { idempotencyKey: key },
        })
      ).state,
    ).toBe("failed");
    expect(unwrap(await ledger.startImport(key, "old"))).toBe(false);
    expect(unwrap(await ledger.claim(key, "legacy"))).toBe(true);
    await db.value.inboundRecipient.update({
      where: { idempotencyKey: key },
      data: { claimedAt: null, legacy: true },
    });
    unwrap(await ledger.expireClaims());
    expect(
      (
        await db.value.inboundRecipient.findUniqueOrThrow({
          where: { idempotencyKey: key },
        })
      ).state,
    ).toBe("uncertain");
    await db.value.inboundRecipient.update({
      where: { idempotencyKey: key },
      data: { state: "failed", legacy: false },
    });
    expect(unwrap(await ledger.claim(key, "permanent-owner"))).toBe(true);
    unwrap(
      await ledger.finish(
        key,
        "failed",
        undefined,
        "invalidEmail",
        "permanent-owner",
        true,
      ),
    );
    unwrap(await ledger.resetFailures());
    const rejected = await db.value.inboundRecipient.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    expect(rejected).toMatchObject({
      state: "failed",
      permanent: true,
      attempts: 1,
    });
    expect(unwrap(await ledger.claim(key, "retry-owner"))).toBe(false);
  });

  it("finds an unmarked legacy import by Message-ID and hash and audits its resolution", async () => {
    if (db === undefined || db.isErr() || s3 === undefined)
      throw new Error("Missing clients");
    const alice = clients.get("alice");
    if (alice === undefined) throw new Error("Missing mailbox");
    const raw = Buffer.from(
      "Message-ID: <legacy-recovery@example.test>\r\nFrom: sender@example.test\r\nSubject: Legacy Recovery\r\n\r\noriginal\r\n",
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "inbound",
        Key: "ses-legacy-recovery",
        Body: raw,
      }),
    );
    const ledger = databaseLedger(db.value);
    const body = JSON.stringify(
      notification(["alice@example.test"], "PASS", "ses-legacy-recovery"),
    );
    const parsed = parseNotification(body);
    if (parsed.isErr()) throw new Error(parsed.error);
    const rows = unwrap(
      await ledger.prepare(
        parsed.value,
        resolveRecipients(
          ["alice@example.test"],
          [{ address: "alice@example.test", destination: account("alice") }],
        ),
      ),
    );
    const key = rows[0]?.key;
    if (key === undefined) throw new Error("Missing recipient");
    const uploaded = getValue(
      await alice.client.upload(alice.session, alice.account, raw),
    );
    const imported = getValue(
      await alice.client.importEmail(alice.session, alice.account, {
        blobId: uploaded.blobId,
        mailboxIds: { [alice.inbox]: true },
      }),
    );
    await db.value.inboundRecipient.update({
      where: { idempotencyKey: key },
      data: { state: "importing", claimedAt: null, legacy: true },
    });
    const delivery = jmapDelivery([
      {
        id: account("alice"),
        origin,
        authorization: `Basic ${Buffer.from(`alice@example.test:${password}`).toString("base64")}`,
        quarantineMailbox: alice.quarantine,
        rewriteSessionUrls: true,
      },
    ]);
    const dependencies = {
      db: db.value,
      ledger,
      delivery,
      storage: awsStorage(s3, s3, "inbound", "archive", "notifications/", ""),
    };
    expect(
      JSON.stringify(await operatorCommand(dependencies, ["inspect", key])),
    ).toBe(
      JSON.stringify({
        key,
        legacy: true,
        matches: [imported.id],
      }),
    );
    await expect(
      operatorCommand(dependencies, [
        "resolve",
        key,
        "imported",
        "wrong",
        "operator",
        "Verified legacy copy",
      ]),
    ).rejects.toThrow("Remote ID must be a verified candidate");
    await operatorCommand(dependencies, [
      "resolve",
      key,
      "imported",
      imported.id,
      "operator",
      "Verified legacy copy",
    ]);
    const row = await db.value.inboundRecipient.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    expect(row.state).toBe("imported");
    expect(row.remoteId).toBe(imported.id);
    const audit = await db.value.inboundResolutionAudit.findFirstOrThrow({
      where: { recipientKey: key },
    });
    expect(audit).toMatchObject({
      operator: "operator",
      action: "imported",
      previousState: "uncertain",
      remoteId: imported.id,
    });
    await expect(
      db.value.inboundResolutionAudit.delete({ where: { id: audit.id } }),
    ).rejects.toThrow(/append-only/);
  }, 90_000);
});
