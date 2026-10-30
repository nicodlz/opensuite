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
import { createAliasMail } from "../../../apps/api/src/adapters/alias-mail.ts";
import { ok } from "neverthrow";
import {
  createAliasStore,
  createAddressStore,
  createDatabase,
  createMailPushStore,
  createMailboxStore,
  createPushStore,
  type PrismaClient,
} from "../../db/src/index.ts";
import { createAddressService } from "../../core/src/services/addresses.ts";
import { createAliasService } from "../../core/src/services/aliases.ts";
import type { Result } from "neverthrow";
import { startMailNotifier } from "../../../apps/api/src/adapters/mail-notifier.ts";
import type { NotificationPayload } from "../../core/src/services/notifications.ts";

const run = promisify(execFile);
const runId = (
  process.env["OPENSUITE_RUN_ID"] ?? randomBytes(6).toString("hex")
)
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
let aliasDb: PrismaClient | undefined;
const pgContainer = `${project}-db`;

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

// Polling depends on the result of the preceding attempt.
/* oxlint-disable eslint/no-await-in-loop */
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await pause(100);
  }
  throw new Error("Notifier timed out");
};
/* oxlint-enable eslint/no-await-in-loop */

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
      await run("docker", [
        "run",
        "-d",
        "--name",
        pgContainer,
        "-e",
        "POSTGRES_PASSWORD=test-password",
        "-e",
        "POSTGRES_INITDB_ARGS=--no-sync",
        "-p",
        "127.0.0.1::5432",
        "postgres:18.6",
      ]);
      const waitPg = async (attempt: number): Promise<void> => {
        try {
          await run("docker", [
            "exec",
            pgContainer,
            "pg_isready",
            "-U",
            "postgres",
          ]);
        } catch {
          if (!attempt) throw new Error("PostgreSQL unavailable");
          await pause(500);
          await waitPg(attempt - 1);
        }
      };
      await waitPg(120);
      const pgPort = /:(\d+)\s*$/.exec(
        (await run("docker", ["port", pgContainer, "5432"])).stdout,
      )?.[1];
      if (!pgPort) throw new Error("PostgreSQL port missing");
      const databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${pgPort}/postgres`;
      await run(
        "pnpm",
        ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl },
          maxBuffer: 4_000_000,
        },
      );
      const database = createDatabase(databaseUrl);
      if (database.isErr()) throw new Error("PostgreSQL configuration failed");
      aliasDb = database.value;
    } catch (error) {
      await run("docker", ["rm", "-fv", pgContainer]).catch(() => undefined);
      await compose("down", "--volumes", "--remove-orphans");
      throw error;
    }
  }, 120_000);
  afterAll(async () => {
    await aliasDb?.$disconnect();
    await run("docker", ["rm", "-fv", pgContainer]).catch(() => undefined);
    await compose("down", "--volumes", "--remove-orphans");
  }, 180_000);

  it("notifies fresh inbox creations, ignores old imports and moves, and resumes its persisted state", async () => {
    if (!aliasDb) throw new Error("Missing database");
    const db = aliasDb;
    const userId = "notification-owner";
    await db.user.create({
      data: {
        id: userId,
        email: "notification-owner@example.test",
        name: "Fixture",
      },
    });
    const mailboxResult = createMailboxStore(db, "ab".repeat(32));
    if (mailboxResult.isErr()) throw new Error("Mailbox store unavailable");
    const mailboxes = mailboxResult.value;
    const created = await mailboxes.create({
      userId,
      accountId: aliceId,
      address: "alice@example.test",
      credentialId: "fixture",
      secret: password,
    });
    if (created.isErr()) throw new Error("Mailbox link unavailable");
    const push = createPushStore(db);
    await push.subscribe(userId, {
      product: "mail",
      endpoint: "https://push.example/notify",
      p256dh: "key",
      auth: "auth",
      userAgent: "test",
    });
    const calls: NotificationPayload[] = [];
    const start = (withPush = true) =>
      startMailNotifier({
        store: createMailPushStore(db),
        mailboxes: {
          getForOwner: async (ownerId, accountId) =>
            mailboxes.getForOwner(ownerId, accountId),
        },
        origin: base,
        dispatcher: {
          notify: (_user, _product, payload) => {
            calls.push(payload);
            return Promise.resolve();
          },
        },
        options: {
          pollMs: withPush ? 30000 : 250,
          refreshMs: 250,
          freshnessMs: 900000,
          burstMs: 100,
          burstThreshold: 3,
          pushConnections: withPush ? 1 : 0,
        },
        log: () => undefined,
      });
    const importMessage = async (
      subject: string,
      mailbox: string,
      receivedAt: string,
    ) => {
      const raw = Buffer.from(
        `From: Sender <sender@example.test>\r\nTo: alice@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@example.test>\r\n\r\nBody\r\n`,
      );
      const blob = value(await alice.upload(aliceSession, aliceId, raw));
      return value(
        await alice.importEmail(aliceSession, aliceId, {
          blobId: blob.blobId,
          mailboxIds: { [mailbox]: true },
          receivedAt,
        }),
      );
    };
    let stop: (() => Promise<void>) | undefined;
    try {
      await importMessage(
        "notification-baseline",
        inbox,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      );
      stop = start();
      await until(async () =>
        Boolean(
          (await db.mailPushState.findUnique({ where: { userId } }))?.state,
        ),
      );
      const cursor = async () =>
        (await db.mailPushState.findUniqueOrThrow({ where: { userId } })).state;
      const initial = await cursor();
      expect(calls).toHaveLength(0);
      await pause(1000); // Allow the EventSource to connect; the poll interval is deliberately longer than this test.
      const fresh = await importMessage(
        "notification-fresh",
        inbox,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      );
      await until(() => calls.length === 1);
      expect(calls[0]).toMatchObject({
        title: "Sender",
        body: "notification-fresh",
        tag: `mail:${fresh.id}`,
        url: `/mail?thread=${encodeURIComponent(fresh.threadId)}&message=${encodeURIComponent(fresh.id)}`,
        icon: "/icons/mail-192.png",
      });
      await until(async () => (await cursor()) !== initial);
      const beforeImports = await cursor();
      await importMessage("notification-old", inbox, "2020-01-02T03:04:05Z");
      const junk = findMailbox(
        value(await alice.mailboxes(aliceSession, aliceId)).list,
        "junk",
      );
      const inJunk = await importMessage(
        "notification-junk",
        junk,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      );
      await until(async () => (await cursor()) !== beforeImports);
      // Ensure the junk creation is processed before its subsequent move.
      await until(
        async () =>
          (await cursor()) ===
          value(await alice.emailState(aliceSession, aliceId)).state,
      );
      const beforeMove = await cursor();
      value(
        await alice.updateEmail(aliceSession, aliceId, inJunk.id, {
          mailboxIds: { [inbox]: true },
        }),
      );
      await until(async () => (await cursor()) !== beforeMove);
      expect(calls).toHaveLength(1);
      await stop();
      const persisted = (
        await db.mailPushState.findUniqueOrThrow({ where: { userId } })
      ).state;
      const restartMessage = await importMessage(
        "notification-restart",
        inbox,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      );
      stop = start(false); // A restarted polling-only worker resumes the same cursor.
      await until(() => calls.length === 2);
      expect(calls[1]).toMatchObject({
        tag: `mail:${restartMessage.id}`,
        url: `/mail?thread=${encodeURIComponent(restartMessage.threadId)}&message=${encodeURIComponent(restartMessage.id)}`,
      });
      await until(
        async () =>
          (await db.mailPushState.findUniqueOrThrow({ where: { userId } }))
            .state !== persisted,
      );
      await pause(700);
      expect(calls).toHaveLength(2);
      await stop();
      await db.mailPushState.update({
        where: { userId },
        data: { state: "invalid-state" },
      });
      const lostState = await alice.emailChanges(
        aliceSession,
        aliceId,
        "invalid-state",
      );
      expect(lostState.isErr() && lostState.error).toMatchObject({
        kind: "method",
        type: "invalidArguments",
      });
      await importMessage(
        "notification-lost-state",
        inbox,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      );
      stop = start(false);
      await until(async () => (await cursor()) !== "invalid-state");
      await pause(500);
      expect(calls).toHaveLength(2);
    } finally {
      await stop?.();
      await push.unsubscribe(userId, "mail", "https://push.example/notify");
      await db.mailboxLink.deleteMany({ where: { userId } });
    }
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
    value(await admin.revokeApplicationPasswords(account.id));
    value(await admin.resumeAccount(account.id));
    expect(
      (await new JmapClient(base, { authorization }).discover()).isErr(),
    ).toBe(true);
    const replacement = value(await admin.createAppPassword(account.id));
    const replacementAuth = `Basic ${Buffer.from(`suspended@example.test:${replacement.secret}`).toString("base64")}`;
    expect(
      (
        await new JmapClient(base, {
          authorization: replacementAuth,
        }).discover()
      ).isOk(),
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
    expect(
      value(await alice.identities(aliceSession, aliceId)).list.map(
        (item) => item.email,
      ),
    ).toContain("a.alias@example.test");
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
    value(await admin.removeAlias(first.id, "a.alias", domainId));
    expect(
      value(await alice.identities(aliceSession, aliceId)).list.map(
        (item) => item.email,
      ),
    ).not.toContain("a.alias@example.test");
  });

  it("delivers to an alias, stops after removal, restores delivery and sends replies as the alias", async () => {
    const account = value(
      await admin.createAccount("alice", domainId, password),
    );
    const address = "private-reply@example.test";
    if (!aliasDb) throw new Error("Missing alias database");
    const adapter = createAliasMail(
      { origin: base, username: "admin", password: "integration-password" },
      {
        getForOwner: () =>
          Promise.resolve(
            ok({
              accountId: account.id,
              address: "alice@example.test",
              secret: password,
            }),
          ),
      },
    );
    const send = async (
      client: JmapClient,
      session: Session,
      accountId: string,
      from: string,
      to: string,
      subject: string,
    ) => {
      const box = findMailbox(
        value(await client.mailboxes(session, accountId)).list,
        "drafts",
      );
      const raw = Buffer.from(
        `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@example.test>\r\n\r\nHello\r\n`,
      );
      const blob = value(await client.upload(session, accountId, raw));
      const email = value(
        await client.importEmail(session, accountId, {
          blobId: blob.blobId,
          mailboxIds: { [box]: true },
          keywords: { $draft: true },
        }),
      );
      const identity = value(
        await client.identities(session, accountId),
      ).list.find((item) => item.email === from);
      if (!identity) throw new Error("missing identity");
      value(await client.submit(session, accountId, email.id, identity.id));
    };
    const delivered = async (
      client: JmapClient,
      session: Session,
      id: string,
      subject: string,
    ) => {
      const poll = async (remaining: number): Promise<boolean> => {
        if (
          value(await client.queryEmails(session, id, { filter: { subject } }))
            .ids.length > 0
        )
          return true;
        if (remaining === 0) return false;
        await pause(250);
        return poll(remaining - 1);
      };
      return poll(40);
    };
    expect(
      (
        await adapter.set(
          account.id,
          "private-reply",
          domainId,
          address,
          "alice",
          true,
        )
      ).isOk(),
    ).toBe(true);
    await send(
      bob,
      bobSession,
      bobId,
      "bob@example.test",
      address,
      "alias-first",
    );
    expect(await delivered(alice, aliceSession, aliceId, "alias-first")).toBe(
      true,
    );
    await send(
      alice,
      aliceSession,
      aliceId,
      address,
      "bob@example.test",
      "alias-reply",
    );
    expect(await delivered(bob, bobSession, bobId, "alias-reply")).toBe(true);
    const replyIds = value(
      await bob.queryEmails(bobSession, bobId, {
        filter: { subject: "alias-reply" },
      }),
    ).ids;
    const reply = value(await bob.emails(bobSession, bobId, replyIds)).list[0];
    expect(reply?.from?.[0]?.email).toBe(address);
    const userId = "stalwart-alias-owner";
    await aliasDb.user.create({
      data: { id: userId, email: "alias-owner@example.test", name: "Fixture" },
    });
    await aliasDb.mailboxLink.create({
      data: {
        userId,
        accountId: account.id,
        address: "alice@example.test",
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const domain = await aliasDb.domain.create({
      data: {
        userId,
        name: "example.test",
        status: "verified",
        stalwartId: domainId,
      },
    });
    const reservation = await aliasDb.address.create({
      data: {
        userId,
        domainId: domain.id,
        localPart: "private-reply",
        isAlias: true,
      },
    });
    const row = await aliasDb.emailAlias.create({
      data: {
        userId,
        domainId: domain.id,
        addressId: reservation.id,
        address,
        localPart: "private-reply",
        ready: true,
      },
    });
    const aliases = createAliasService(createAliasStore(aliasDb), adapter, 10);
    expect((await aliases.transition(userId, row.id, "disable")).isOk()).toBe(
      true,
    );
    expect(
      value(await alice.identities(aliceSession, aliceId)).list.some(
        (item) => item.email === address,
      ),
    ).toBe(false);
    await send(
      bob,
      bobSession,
      bobId,
      "bob@example.test",
      address,
      "alias-disabled",
    );
    expect(
      await delivered(alice, aliceSession, aliceId, "alias-disabled"),
    ).toBe(false);
    expect(
      (
        await adapter.set(
          account.id,
          "private-reply",
          domainId,
          address,
          "alice",
          true,
        )
      ).isOk(),
    ).toBe(true);
    await send(
      bob,
      bobSession,
      bobId,
      "bob@example.test",
      address,
      "alias-restored",
    );
    expect(
      await delivered(alice, aliceSession, aliceId, "alias-restored"),
    ).toBe(true);
    value(await admin.removeAlias(account.id, "private-reply", domainId));
    const addresses = createAddressService(
      createAddressStore(aliasDb, ["example.test"]),
      adapter,
      () => Promise.resolve(5),
      () => Promise.resolve(ok(undefined)),
      ["example.test"],
    );
    const actor = {
      id: userId,
      email: "alias-owner@example.test",
      role: "user" as const,
    };
    const created = await addresses.create(actor, {
      domainId: domain.id,
      localPart: "extra-mailbox",
    });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) throw new Error("address provisioning failed");
    expect(created.value.ready).toBe(true);
    const ownSender = await addresses.canSendAs(userId, created.value.address);
    const otherSender = await addresses.canSendAs(
      "another-user",
      created.value.address,
    );
    expect(ownSender.isOk() && ownSender.value).toBe(created.value.id);
    expect(otherSender.isOk() && otherSender.value).toBeNull();
    await send(
      bob,
      bobSession,
      bobId,
      "bob@example.test",
      created.value.address,
      "extra-before-removal",
    );
    expect(
      await delivered(alice, aliceSession, aliceId, "extra-before-removal"),
    ).toBe(true);
    expect((await addresses.remove(actor, created.value.id)).isOk()).toBe(true);
    await send(
      bob,
      bobSession,
      bobId,
      "bob@example.test",
      created.value.address,
      "extra-after-removal",
    );
    expect(
      await delivered(alice, aliceSession, aliceId, "extra-after-removal"),
    ).toBe(false);
  }, 60_000);

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
