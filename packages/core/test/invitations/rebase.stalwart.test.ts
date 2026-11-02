import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createDatabase,
  createInvitationStore,
  type PrismaClient,
} from "@opensuite/db";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, expect, it } from "vitest";
import { invitationProtocol } from "../../src/adapters/invitations.ts";
import { createCalendarService } from "../../src/services/calendar.ts";
import { createInvitationService } from "../../src/services/invitations.ts";

const run = promisify(execFile);
const project = `invite-rebase-${randomBytes(8).toString("hex")}`;
const overlay = `/tmp/${project}.yaml`;
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user" as const,
};
const password = "test-password-for-rebase-1481!";
const uid = "rebase@example.test";
let db: PrismaClient;
let base = "";
let client: JmapClient;
let service: ReturnType<typeof createInvitationService>;
let store: {
  getForOwner: (
    userId: string,
    accountId: string,
  ) => Promise<
    Result<
      { accountId: string; address: string; secret: string },
      { kind: string }
    >
  >;
};

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
      { cwd: new URL("../../../../", import.meta.url), maxBuffer: 4_000_000 },
    )
  ).stdout;
const unwrap = <T>(result: Result<T, { kind: string }>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(JSON.stringify(error));
    },
  );
const disconnect = async (database: PrismaClient | undefined) => {
  if (database) await database.$disconnect();
};
const ready = async (attempts: number): Promise<void> => {
  try {
    if ((await fetch(`${base}/healthz/ready`)).ok) return;
  } catch {
    /* starting */
  }
  if (!attempts) throw new Error("Stalwart did not start");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await ready(attempts - 1);
};
const fixture = (sequence: number, title: string, method = "REQUEST") =>
  [
    "From: Organizer <organizer@example.test>",
    "DKIM-Signature: v=1; d=example.test; s=fixture; b=fixture",
    "To: Alice <alice@example.test>",
    "MIME-Version: 1.0",
    `Content-Type: text/calendar; method=${method}; charset=UTF-8`,
    "",
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    "DTSTAMP:20261001T100000Z",
    "DTSTART;TZID=Europe/Lisbon:20261102T100000",
    "DTEND;TZID=Europe/Lisbon:20261102T110000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "ORGANIZER:mailto:organizer@example.test",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@example.test",
    `SUMMARY:${title}`,
    "DESCRIPTION:Organizer description",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

beforeAll(async () => {
  try {
    await writeFile(
      overlay,
      `services:\n  postgres:\n    image: postgres:18.6\n    environment:\n      POSTGRES_PASSWORD: test-password\n      POSTGRES_INITDB_ARGS: --no-sync\n    command: ["postgres", "-c", "fsync=off"]\n    ports: ["127.0.0.1::5432"]\n`,
    );
    await compose("up", "-d");
    const databaseReady = async (attempts: number): Promise<void> => {
      try {
        await compose("exec", "-T", "postgres", "pg_isready", "-U", "postgres");
      } catch (error) {
        if (!attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await databaseReady(attempts - 1);
      }
    };
    await databaseReady(120);
    const dbPort = (await compose("port", "postgres", "5432"))
      .trim()
      .split(":")
      .at(-1);
    if (!dbPort) throw new Error("Missing database port");
    const databaseUrl = `postgresql://postgres:test-password@127.0.0.1:${dbPort}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: new URL("../../../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        maxBuffer: 4_000_000,
      },
    );
    db = unwrap(createDatabase(databaseUrl));
    await db.user.create({
      data: { id: actor.id, email: actor.email, name: "Alice" },
    });
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing Stalwart port");
    base = `http://127.0.0.1:${port}`;
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = unwrap(await admin.createDomain("example.test"));
    const account = unwrap(
      await admin.createAccount("alice", domain.id, password),
    );
    unwrap(await admin.createAccount("organizer", domain.id, password));
    store = {
      getForOwner: (userId, accountId) =>
        Promise.resolve(
          userId === actor.id && accountId === "default"
            ? ok({
                accountId: account.id,
                address: actor.email,
                secret: password,
              })
            : err({ kind: "forbidden" }),
        ),
    };
    client = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    service = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store,
      intentions: createInvitationStore(db),
    });
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    await rm(overlay, { force: true });
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await disconnect(db);
  await compose("down", "--volumes", "--remove-orphans");
  await rm(overlay, { force: true });
}, 60_000);

it("rebases authenticated revisions on local edits and fences later concurrent writes", async () => {
  const session = unwrap(await client.discover());
  const mailAccount = session.primaryAccounts[JmapCapability.mail] ?? "";
  const calendarAccount =
    session.primaryAccounts[JmapCapability.calendars] ?? "";
  const inbox = unwrap(await client.mailboxes(session, mailAccount)).list.find(
    (box) => box.role === "inbox",
  );
  const calendarId = unwrap(
    await createCalendarService({ origin: base, store }).calendars(
      actor,
      "default",
    ),
  ).calendars[0]?.id;
  if (!inbox || !calendarId) throw new Error("Missing inbox or calendar");
  const imported = async (raw: string) => {
    const blob = unwrap(
      await client.upload(session, mailAccount, Buffer.from(raw)),
    );
    const message = unwrap(
      await client.importEmail(session, mailAccount, {
        blobId: blob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const id = randomUUID();
    const timestamp = "2026-11-02T10:00:00Z";
    await db.inboundMessage.create({
      data: {
        id,
        bucket: "fixture",
        objectKey: id,
        receivedAt: new Date(timestamp),
        notification: {
          notificationType: "Received",
          receipt: {
            timestamp,
            processingTimeMillis: 1,
            recipients: [actor.email],
            spamVerdict: { status: "PASS" },
            virusVerdict: { status: "PASS" },
            spfVerdict: { status: "GRAY" },
            dkimVerdict: { status: "PASS" },
            dmarcVerdict: { status: "GRAY" },
            action: {
              type: "S3",
              topicArn: "fixture",
              bucketName: "fixture",
              objectKey: id,
            },
          },
          mail: {
            timestamp,
            source: "organizer@example.test",
            messageId: id,
            destination: [actor.email],
          },
        },
        recipients: {
          create: {
            idempotencyKey: id,
            destination: mailAccount,
            addresses: [actor.email],
            state: "imported",
            remoteId: message.id,
          },
        },
      },
    });
    return message.id;
  };
  const first = {
    accountId: "default",
    calendarId,
    messageId: await imported(fixture(0, "Planning")),
    requestId: randomUUID(),
    action: "accept" as const,
    recurrenceId: null,
  };
  const created = unwrap(await service.act(actor, first));
  if (!created.eventId) throw new Error("Missing event");
  unwrap(
    await client.updateCalendarEvent(
      session,
      calendarAccount,
      created.eventId,
      { title: "Local title", description: "Private note" },
    ),
  );
  const update = {
    ...first,
    messageId: await imported(fixture(1, "Planning")),
    requestId: randomUUID(),
    action: "apply" as const,
  };
  expect(unwrap(await service.act(actor, update)).state).toBe("applied");
  const after = unwrap(
    await client.calendarEvents(session, calendarAccount, [created.eventId]),
  ).list[0];
  expect(after).toMatchObject({
    title: "Local title",
    description: "Private note",
  });
  expect(
    unwrap(await service.act(actor, { ...update, requestId: randomUUID() }))
      .state,
  ).toBe("applied");
  const stale = await service.act(actor, {
    ...first,
    requestId: randomUUID(),
    action: "apply",
  });
  expect(stale.isErr() && stale.error.kind).toBe("conflict");

  class ConcurrentClient extends JmapClient {
    override async updateCalendarEvent(
      ...args: Parameters<JmapClient["updateCalendarEvent"]>
    ) {
      unwrap(
        await client.updateCalendarEvent(args[0], args[1], args[2], {
          description: "Concurrent note",
        }),
      );
      return super.updateCalendarEvent(...args);
    }
  }
  const concurrent = createInvitationService({
    protocol: invitationProtocol,
    origin: base,
    store,
    intentions: createInvitationStore(db),
    client: () =>
      new ConcurrentClient(base, {
        authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: base,
      }),
  });
  const newer = {
    ...update,
    messageId: await imported(fixture(2, "Second title")),
    requestId: randomUUID(),
  };
  expect((await concurrent.act(actor, newer)).isErr()).toBe(true);
  expect(
    unwrap(await service.reconcile(actor, "default", newer.requestId)).state,
  ).toBe("failed");
  expect(
    unwrap(
      await client.calendarEvents(session, calendarAccount, [created.eventId]),
    ).list[0]?.description,
  ).toBe("Concurrent note");
  expect(
    unwrap(await service.act(actor, { ...newer, requestId: randomUUID() }))
      .state,
  ).toBe("applied");
  expect(
    unwrap(
      await client.calendarEvents(session, calendarAccount, [created.eventId]),
    ).list[0],
  ).toMatchObject({ title: "Second title", description: "Concurrent note" });
  const cancel = {
    ...update,
    messageId: await imported(fixture(3, "Planning", "CANCEL")),
    requestId: randomUUID(),
  };
  expect(unwrap(await service.act(actor, cancel)).state).toBe("applied");
  const raw = unwrap(
    await invitationProtocol.findInvitationObject({
      origin: base,
      address: actor.email,
      secret: password,
      uid,
    }),
  );
  expect(raw).toContain("STATUS:CANCELLED");
  expect(raw).toContain("Concurrent note");
  expect(raw).toContain("PARTSTAT=ACCEPTED");
}, 60_000);
