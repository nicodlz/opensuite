import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createDatabase } from "@opensuite/db";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awsQueue, awsStorage } from "../src/adapters/aws.ts";
import { databaseLedger } from "../src/adapters/database.ts";
import { IngestService } from "../src/ingest/service.ts";
import { notification } from "./fixtures.ts";
import type { Delivery } from "../src/ingest/contracts.ts";
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
      const database = unwrap(db);
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
      const domain = getValue(await admin.createDomain("example.test"));
      await Promise.all(
        ["alice", "bob"].map(async (name) =>
          getValue(await admin.createAccount(name, domain.id, password)),
        ),
      );
      await connectClients();
      const delivery: Delivery = {
        async import(destination, bytes, quarantine) {
          const mailbox = clients.get(destination);
          if (mailbox === undefined)
            return err({ message: "Unknown destination" });
          const upload = await mailbox.client.upload(
            mailbox.session,
            mailbox.account,
            bytes,
          );
          if (upload.isErr())
            return err({ message: JSON.stringify(upload.error) });
          const imported = await mailbox.client.importEmail(
            mailbox.session,
            mailbox.account,
            {
              blobId: upload.value.blobId,
              mailboxIds: {
                [quarantine ? mailbox.quarantine : mailbox.inbox]: true,
              },
            },
          );
          return imported.isErr()
            ? err({ message: JSON.stringify(imported.error), ambiguous: true })
            : ok(imported.value.id);
        },
      };
      service = new IngestService({
        storage: awsStorage(s3, s3, "inbound", "archive", "notifications/", ""),
        ledger: databaseLedger(database),
        delivery,
        routes: [
          { address: "alice@example.test", destination: "alice" },
          { address: "alias@other.test", destination: "alice" },
          { address: "hidden@example.test", destination: "bob" },
        ],
        bucket: "inbound",
        bufferPrefix: "",
        topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
        maxAttempts: 5,
        events: { emit() {} },
      });
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
        const ids = getValue(
          await m.client.queryEmails(m.session, m.account, {
            filter: { subject: "Ingest" },
          }),
        ).ids;
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
  it("quarantines a failed verdict and retains the object for an unknown recipient", async () => {
    if (s3 === undefined || db === undefined || db.isErr())
      throw new Error("Clients not initialized");
    const raw = Buffer.from(
      "From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Quarantine\r\n\r\nSuspicious\r\n",
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "inbound", Key: "ses-fail", Body: raw }),
    );
    const result = await service.process(
      JSON.stringify(
        notification(
          ["alice@example.test", "unknown@example.test"],
          "FAIL",
          "ses-fail",
        ),
      ),
    );
    expect(result.isOk()).toBe(true);
    const rows = await db.value.inboundRecipient.findMany({
      where: { messageId: "ses-fail" },
    });
    expect(rows.map((row) => row.state).toSorted()).toEqual([
      "quarantined",
      "rejected",
    ]);
    const alice = clients.get("alice");
    if (alice === undefined) throw new Error("Missing Alice");
    const importedId = rows.find(
      (row) => row.state === "quarantined",
    )?.remoteId;
    if (importedId === undefined || importedId === null)
      throw new Error("Missing quarantined email ID");
    const email = getValue(
      await alice.client.emails(alice.session, alice.account, [importedId]),
    ).list[0];
    expect(email?.mailboxIds[alice.quarantine]).toBe(true);
    const list = unwrap(
      await awsStorage(
        s3,
        s3,
        "inbound",
        "archive",
        "notifications/",
        "",
      ).bufferKeys(),
    );
    expect(list).toContain("ses-fail");
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
    }
    expect((await service.process(body)).isOk()).toBe(true);
    const rows = await db.value.inboundRecipient.findMany({
      where: { messageId: "ses-outage" },
    });
    expect(rows[0]?.state).toBe("imported");
    expect(rows[0]?.attempts).toBe(2);
  }, 120_000);
});
