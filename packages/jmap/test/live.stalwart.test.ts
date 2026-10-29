import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JmapCapability,
  JmapClient,
  type JmapError,
  type Session,
} from "../src/index.ts";
import { StalwartAdmin } from "../src/admin.ts";
import type { Result } from "neverthrow";

const run = promisify(execFile);
const runId = (process.env["CLEITO_RUN_ID"] ?? randomBytes(6).toString("hex"))
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-");
const project = `opensuite-jmap-${runId}-${randomBytes(4).toString("hex")}`;
const composeArgs = [
  "compose",
  "-p",
  project,
  "-f",
  "deploy/stalwart/compose.stalwart-test.yaml",
];
const compose = async (...args: string[]) =>
  (
    await run("docker", [...composeArgs, ...args], {
      cwd: new URL("../../../", import.meta.url),
      maxBuffer: 4_000_000,
    })
  ).stdout;
const value = <T>(result: Result<T, JmapError>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const password = "cobalt-rocket-forest-9381!";
let base: string;
let admin: StalwartAdmin;
let alice: JmapClient;
let bob: JmapClient;
let aliceSession: Session;
let bobSession: Session;
let aliceId: string;
let bobId: string;
let domainId: string;
let inbox: string;
let drafts: string;
let sent: string;

const rewrite = (url: string) =>
  `${base}${new URL(url).pathname}${new URL(url).search}`;
const sessionFor = async (client: JmapClient): Promise<Session> => {
  const session = value(await client.discover());
  // This direct-listener fixture has no reverse proxy and advertises the container's
  // internal hostname. Map its advertised endpoint paths to the published port.
  return {
    ...session,
    apiUrl: rewrite(session.apiUrl),
    downloadUrl: rewrite(session.downloadUrl)
      .replaceAll("%7B", "{")
      .replaceAll("%7D", "}"),
    uploadUrl: rewrite(session.uploadUrl)
      .replaceAll("%7B", "{")
      .replaceAll("%7D", "}"),
  };
};
const basic = (user: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const findMailbox = (
  boxes: { id: string; role: string | null }[],
  role: string,
) => {
  const box = boxes.find((item) => item.role === role);
  if (box === undefined) throw new Error(`Missing mailbox ${role}`);
  return box.id;
};
const primary = (session: Session) => {
  const id = session.primaryAccounts[JmapCapability.mail];
  if (id === undefined) throw new Error("Missing primary account");
  return id;
};
const pause = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("Stalwart JMAP integration", () => {
  beforeAll(async () => {
    try {
      await compose("up", "-d");
      const port = (await compose("port", "stalwart", "8080"))
        .trim()
        .split(":")
        .at(-1);
      if (port === undefined) throw new Error("No published port");
      base = `http://127.0.0.1:${port}`;
      const waitReady = async (attempt: number): Promise<void> => {
        try {
          if ((await fetch(`${base}/healthz/ready`)).ok) return;
        } catch {
          /* startup */
        }
        if (attempt === 0) throw new Error("Stalwart did not become ready");
        await pause(500);
        return waitReady(attempt - 1);
      };
      await waitReady(120);
      admin = new StalwartAdmin(base, {
        username: "admin",
        password: "integration-password",
      });
      domainId = value(await admin.createDomain("example.test")).id;
      value(await admin.createAccount("alice", domainId, password));
      value(await admin.createAccount("bob", domainId, password));
      alice = new JmapClient(base, {
        authorization: basic("alice@example.test"),
      });
      bob = new JmapClient(base, { authorization: basic("bob@example.test") });
      aliceSession = await sessionFor(alice);
      bobSession = await sessionFor(bob);
      aliceId = primary(aliceSession);
      bobId = primary(bobSession);
      const boxes = value(await alice.mailboxes(aliceSession, aliceId)).list;
      inbox = findMailbox(boxes, "inbox");
      drafts = findMailbox(boxes, "drafts");
      sent = findMailbox(boxes, "sent");
    } catch (error) {
      await compose("down", "--volumes", "--remove-orphans");
      throw error;
    }
  }, 120_000);
  afterAll(async () => {
    await compose("down", "--volumes", "--remove-orphans");
  }, 60_000);

  it("issues an application credential and suspends the mailbox", async () => {
    const account = value(
      await admin.createAccount("suspended", domainId, password),
    );
    const credential = value(await admin.createAppPassword(account.id));
    const authorization = `Basic ${Buffer.from(`suspended@example.test:${credential.secret}`).toString("base64")}`;
    const client = new JmapClient(base, { authorization });
    expect((await client.discover()).isOk()).toBe(true);
    value(await admin.suspendAccount(account.id));
    expect(
      (await new JmapClient(base, { authorization }).discover()).isErr(),
    ).toBe(true);
  });

  it("provisions idempotently and adds an account alias", async () => {
    expect(value(await admin.createDomain("example.test")).id).toBe(domainId);
    const first = value(await admin.createAccount("alice", domainId, password));
    const again = value(
      await admin.createAccount("alice", domainId, "unused-different-password"),
    );
    expect(again.id).toBe(first.id);
    const alias = value(await admin.createAlias(first.id, "a.alias", domainId));
    expect(
      value(await admin.createAlias(first.id, "a.alias", domainId)),
    ).toEqual(alias);
    const account = value(
      await admin.createAccount("alice", domainId, password),
    );
    expect(
      Object.values(account.aliases).filter((item) => item.name === "a.alias"),
    ).toHaveLength(1);
    const weak = await admin.createAccount("weak", domainId, "123");
    expect(weak.isErr() ? weak.error : undefined).toMatchObject({
      kind: "set",
      method: "x:Account/set",
      type: "invalidProperties",
    });
    const bobAccount = value(
      await admin.createAccount("bob", domainId, password),
    );
    const conflict = await admin.createAlias(
      bobAccount.id,
      "a.alias",
      domainId,
    );
    expect(conflict.isErr()).toBe(true);
  });

  it("imports identical MIME twice, retains bytes, keywords, date and an attachment, then moves it", async () => {
    const raw = [
      "From: Sender <sender@example.test>",
      "To: alice@example.test",
      "Subject: Import test",
      "Message-ID: <import@example.test>",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=example",
      "",
      "--example",
      "Content-Type: text/plain",
      "",
      "Hello",
      "--example",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=example.bin",
      "Content-Transfer-Encoding: base64",
      "",
      "AAECA/8=",
      "--example--",
      "",
    ].join("\r\n");
    const uploaded = value(
      await alice.uploadBlob(
        aliceSession,
        aliceId,
        Buffer.from(raw).toString("base64"),
        "message/rfc822",
      ),
    );
    const input = {
      blobId: uploaded.id,
      mailboxIds: { [inbox]: true },
      keywords: { $seen: true, $flagged: true },
      receivedAt: "2020-01-02T03:04:05Z",
    };
    const missing = await bob.importEmail(bobSession, bobId, {
      blobId: uploaded.id,
      mailboxIds: {
        [findMailbox(
          value(await bob.mailboxes(bobSession, bobId)).list,
          "inbox",
        )]: true,
      },
    });
    expect(missing.isErr() ? missing.error : undefined).toMatchObject({
      kind: "set",
      type: "blobNotFound",
    });
    const imported = value(
      await alice.importEmail(aliceSession, aliceId, input),
    );
    const duplicate = value(
      await alice.importEmail(aliceSession, aliceId, input),
    );
    expect(duplicate.id).not.toBe(imported.id);
    const email = value(
      await alice.emails(aliceSession, aliceId, [imported.id]),
    ).list[0];
    expect(email).toBeDefined();
    if (email === undefined) throw new Error("Imported email not found");
    expect(email.keywords).toMatchObject({ $seen: true, $flagged: true });
    expect(email.receivedAt).toBe("2020-01-02T03:04:05Z");
    expect(
      Buffer.from(
        value(await alice.download(aliceSession, aliceId, email.blobId)),
      ),
    ).toEqual(Buffer.from(raw));
    const attachment = email.attachments[0];
    if (attachment?.blobId === null || attachment?.blobId === undefined)
      throw new Error("Attachment missing");
    expect(
      Buffer.from(
        value(await alice.download(aliceSession, aliceId, attachment.blobId)),
      ),
    ).toEqual(Buffer.from([0, 1, 2, 3, 255]));
    value(
      await alice.updateEmail(aliceSession, aliceId, imported.id, {
        mailboxIds: { [sent]: true },
        keywords: { $answered: true },
      }),
    );
    const moved = value(
      await alice.emails(aliceSession, aliceId, [imported.id]),
    ).list[0];
    expect(moved?.mailboxIds).toEqual({ [sent]: true });
    expect(moved?.keywords).toEqual({ $answered: true, $hasattachment: true });
    expect(
      value(
        await alice.queryEmails(aliceSession, aliceId, {
          filter: { inMailbox: sent },
        }),
      ).ids,
    ).toContain(imported.id);
  });

  it("submits to a local account and sends a reply", async () => {
    const send = async (
      client: JmapClient,
      session: Session,
      accountId: string,
      from: string,
      to: string,
      subject: string,
      messageId: string,
      mailbox: string,
      replyTo?: string,
    ) => {
      const raw = Buffer.from(
        [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Message-ID: <${messageId}@example.test>`,
          ...(replyTo === undefined
            ? []
            : [
                `In-Reply-To: <${replyTo}@example.test>`,
                `References: <${replyTo}@example.test>`,
              ]),
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Hello local delivery",
          "",
        ].join("\r\n"),
      );
      const blob = value(await client.upload(session, accountId, raw));
      const email = value(
        await client.importEmail(session, accountId, {
          blobId: blob.blobId,
          mailboxIds: { [mailbox]: true },
          keywords: { $draft: true },
        }),
      );
      const identity = value(
        await client.identities(session, accountId),
      ).list.find((item) => item.email === from);
      if (identity === undefined)
        throw new Error(`Identity missing for ${from}`);
      value(await client.submit(session, accountId, email.id, identity.id));
    };
    const waitFor = async (
      client: JmapClient,
      session: Session,
      accountId: string,
      subject: string,
    ) => {
      const poll = async (attempt: number): Promise<string[]> => {
        const query = value(
          await client.queryEmails(session, accountId, { filter: { subject } }),
        );
        if (query.ids.length > 0) return query.ids;
        if (attempt === 0) throw new Error(`No delivery for ${subject}`);
        await pause(500);
        return poll(attempt - 1);
      };
      return poll(60);
    };
    await send(
      alice,
      aliceSession,
      aliceId,
      "alice@example.test",
      "bob@example.test",
      "Hello Bob",
      "hello-bob",
      drafts,
    );
    expect(await waitFor(bob, bobSession, bobId, "Hello Bob")).not.toHaveLength(
      0,
    );
    const bobDrafts = findMailbox(
      value(await bob.mailboxes(bobSession, bobId)).list,
      "drafts",
    );
    await send(
      bob,
      bobSession,
      bobId,
      "bob@example.test",
      "alice@example.test",
      "Re: Hello Bob",
      "reply-bob",
      bobDrafts,
      "hello-bob",
    );
    expect(
      await waitFor(alice, aliceSession, aliceId, "Re: Hello Bob"),
    ).not.toHaveLength(0);
  }, 90_000);

  it("imports a message at the advertised HTTP upload limit", async () => {
    value(await admin.createAccount("large", domainId, password));
    const client = new JmapClient(base, {
      authorization: basic("large@example.test"),
    });
    const session = await sessionFor(client);
    const accountId = primary(session);
    const mailbox = findMailbox(
      value(await client.mailboxes(session, accountId)).list,
      "inbox",
    );
    const header = Buffer.from(
      "From: sender@example.test\r\nTo: large@example.test\r\nSubject: Large\r\n\r\n",
    );
    const bytes = Buffer.alloc(50_000_000, 120);
    header.copy(bytes);
    const upload = value(await client.upload(session, accountId, bytes));
    expect(upload.size).toBe(50_000_000);
    const startedAt = Date.now();
    const imported = value(
      await client.importEmail(session, accountId, {
        blobId: upload.blobId,
        mailboxIds: { [mailbox]: true },
      }),
    );
    expect(imported.size).toBe(50_000_000);
    const stored = value(await client.emails(session, accountId, [imported.id]))
      .list[0];
    if (stored === undefined) throw new Error("Large email missing");
    expect(Date.parse(stored.receivedAt)).toBeGreaterThanOrEqual(
      startedAt - 2_000,
    );
    expect(Date.parse(stored.receivedAt)).toBeLessThanOrEqual(
      Date.now() + 2_000,
    );
    expect(stored.keywords).toEqual({ $hasnoattachment: true });
  }, 90_000);

  it("reports the advertised upload size limit as an error", async () => {
    const core = aliceSession.capabilities[JmapCapability.core];
    const limit =
      typeof core === "object" && core !== null && "maxSizeUpload" in core
        ? core.maxSizeUpload
        : undefined;
    expect(limit).toBe(50_000_000);
    const result = await alice.upload(
      aliceSession,
      aliceId,
      new Uint8Array(50_000_001),
    );
    const error = result.isErr() ? result.error : undefined;
    expect(error).toMatchObject({
      kind: "request",
      status: 400,
      type: "urn:ietf:params:jmap:error:limit",
    });
  }, 60_000);
});
