import { invitationProtocol } from "../src/adapters/invitations.ts";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import {
  createDatabase,
  createInvitationStore,
  type PrismaClient,
} from "@opensuite/db";
import { createCalendarService } from "../src/services/calendar.ts";
import { simpleParser } from "mailparser";
import { dkimSign } from "mailauth/lib/dkim/sign";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { fetchCalendars, fetchCalendarObjects } from "tsdav";
import { promisify } from "node:util";
import { JmapCapability, JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvitationService } from "../src/services/invitations.ts";

const run = promisify(execFile);
const project = `invites-${randomBytes(8).toString("hex")}`;
const overlay = `/tmp/${project}.yaml`;
let db: PrismaClient;
let importedId = "";
let fixture = "";
let credentialStore: {
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
      {
        cwd: new URL("../../../", import.meta.url),
        maxBuffer: 4_000_000,
      },
    )
  ).stdout;
const unwrap = <T>(result: Result<T, { kind: string }>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(JSON.stringify(error));
    },
  );
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user" as const,
};
async function seedReceipt(
  accountId: string,
  emailId: string,
  options: { dkim?: string; dmarc?: string; state?: string } = {},
) {
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
          dkimVerdict: { status: options.dkim ?? "PASS" },
          dmarcVerdict: { status: options.dmarc ?? "PASS" },
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
          destination: accountId,
          addresses: [actor.email],
          state: options.state ?? "imported",
          remoteId: emailId,
        },
      },
    },
  });
}
const password = "test-password-for-invitation-9381!";
const fixtureFor = (uid: string) =>
  fixture.replaceAll("local-google-fixture@example.test", uid);
const fixtureSignature =
  "DKIM-Signature: v=1; d=example.test; s=fixture; b=fixture\r\n";
const fixtureKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
async function signedFixture(
  raw: string,
  signingDomain: string,
  maxBodyLength?: number,
) {
  const unsigned = raw.replace(fixtureSignature, "");
  const signature = await dkimSign(unsigned, {
    signatureData: [
      {
        signingDomain,
        selector: "fixture",
        privateKey: fixtureKeys.privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
        ...(maxBodyLength === undefined ? {} : { maxBodyLength }),
      },
    ],
  });
  expect(signature.errors).toEqual([]);
  const signed = signature.signatures + unsigned;
  const publicKey = fixtureKeys.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const verified = await dkimVerify(signed, {
    resolver: (name, type) => {
      expect(name).toBe(`fixture._domainkey.${signingDomain}`);
      expect(type).toBe("TXT");
      return Promise.resolve([[`v=DKIM1; k=rsa; p=${publicKey}`]]);
    },
  });
  expect(verified.results).toHaveLength(1);
  expect(verified.results[0]?.status.result).toBe("pass");
  return signed;
}
let base = "";
let client: JmapClient;
let service: ReturnType<typeof createInvitationService>;
const ready = async (attempts: number): Promise<void> => {
  try {
    if ((await fetch(`${base}/healthz/ready`)).ok) return;
  } catch {
    /* starting */
  }
  if (!attempts) throw new Error("Stalwart did not start");
  await new Promise((resolve) => setTimeout(resolve, 500));
  return ready(attempts - 1);
};
const disconnect = async (database: PrismaClient | undefined) => {
  if (database) await database.$disconnect();
};

beforeAll(async () => {
  try {
    await writeFile(
      overlay,
      `services:
  postgres:
    image: postgres:18.6
    environment:
      POSTGRES_PASSWORD: test-password
      POSTGRES_INITDB_ARGS: --no-sync
    command: ["postgres", "-c", "fsync=off"]
    ports: ["127.0.0.1::5432"]
`,
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
    const dbUrl = `postgresql://postgres:test-password@127.0.0.1:${dbPort}/postgres`;
    await run(
      "pnpm",
      ["--filter", "@opensuite/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: new URL("../../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: dbUrl },
        maxBuffer: 4_000_000,
      },
    );
    db = unwrap(createDatabase(dbUrl));
    await db.user.create({
      data: { id: actor.id, email: actor.email, name: "Alice" },
    });
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing port");
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
    const store = {
      getForOwner: (userId: string, accountId: string) =>
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
    credentialStore = store;
    unwrap(await admin.createAlias(account.id, "alternate", domain.id));
    unwrap(await admin.createAccount("organizer", domain.id, password));
    client = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    // Emulate the trusted ingestion ledger for the Google-style imported fixtures.
    const importEmail = client.importEmail.bind(client);
    client.importEmail = async (...args) => {
      const result = await importEmail(...args);
      if (result.isOk()) await seedReceipt(args[1], result.value.id);
      return result;
    };
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

describe("received invitations with Stalwart", () => {
  it("reads a received Google-style calendar part without submitting a reply", async () => {
    const session = unwrap(await client.discover());
    const accountId = session.primaryAccounts[JmapCapability.mail];
    if (!accountId) throw new Error("Missing mail account");
    const boxes = unwrap(await client.mailboxes(session, accountId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    if (!inbox) throw new Error("Missing inbox");
    const raw = [
      "From: Organizer <organizer@example.test>",
      "DKIM-Signature: v=1; d=example.test; s=fixture; b=fixture",
      "To: Alice <alice@example.test>",
      "Subject: Invitation: planning",
      "MIME-Version: 1.0",
      "Content-Type: text/calendar; method=REQUEST; charset=UTF-8",
      "",
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:local-google-fixture@example.test",
      "DTSTAMP:20261001T100000Z",
      "DTSTART;TZID=Europe/Lisbon:20261102T100000",
      "DTEND;TZID=Europe/Lisbon:20261102T110000",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@example.test",
      "SUMMARY:Planning",
      "LOCATION:Room 101",
      "CATEGORIES:Planning,Private",
      "X-GOOGLE-TEST:unexposed-property",
      "DESCRIPTION:Join https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    fixture = raw;
    const upload = unwrap(
      await client.upload(session, accountId, Buffer.from(raw)),
    );
    const imported = unwrap(
      await client.importEmail(session, accountId, {
        blobId: upload.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    importedId = imported.id;
    const invitation = unwrap(
      await service.read(actor, "default", imported.id),
    );
    expect(invitation.senderStatus).toBe("verified");
    expect(invitation.events[0]).toMatchObject({
      uid: "local-google-fixture@example.test",
      title: "Planning",
      timeZone: "Europe/Lisbon",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(
      (
        await service.read({ ...actor, id: "other" }, "default", imported.id)
      ).isErr(),
    ).toBe(true);
    const sent = boxes.find((box) => box.role === "sent");
    if (!sent) throw new Error("Missing sent mailbox");
    expect(
      unwrap(
        await client.queryEmails(session, accountId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toEqual([]);
  });
  it("accepts a request, submits a REPLY once, and applies a newer update", async () => {
    const calendar = createCalendarService({
      origin: base,
      store: credentialStore,
    });
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const input = {
      accountId: "default",
      messageId: importedId,
      calendarId,
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    const result = await service.act(actor, input);
    if (result.isErr())
      throw new Error(
        `act failed ${JSON.stringify(result.error)} ${JSON.stringify(await db.invitationOperation.findMany())}`,
      );
    expect(result.value.state).toBe("sent");
    expect(unwrap(await service.act(actor, input))).toEqual(result.value);
    const session = unwrap(await client.discover());
    const headers = {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
    };
    const davCalendars = await fetchCalendars({
      account: {
        accountType: "caldav",
        serverUrl: base,
        rootUrl: base,
        homeUrl: `${base}/dav/cal/${encodeURIComponent(actor.email)}/`,
      },
      headers,
    });
    const objects = (
      await Promise.all(
        davCalendars.map((collection) =>
          fetchCalendarObjects({
            calendar: collection,
            headers,
            urlFilter: (url) => !url.endsWith("/"),
          }),
        ),
      )
    ).flat();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.data).toContain("X-GOOGLE-TEST:unexposed-property");
    expect(objects[0]?.data).toContain("PARTSTAT=ACCEPTED");
    expect(objects[0]?.data).toContain(
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
    );
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const sent = unwrap(await client.mailboxes(session, mailId)).list.find(
      (box) => box.role === "sent",
    );
    if (!sent) throw new Error("Missing sent mailbox");
    const sentIds = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids;
    expect(sentIds).toHaveLength(1);
    const email = unwrap(await client.emails(session, mailId, sentIds)).list[0];
    if (!email) throw new Error("Missing reply");
    const message = await simpleParser(
      Buffer.from(unwrap(await client.download(session, mailId, email.blobId))),
    );
    const to = Array.isArray(message.to) ? message.to[0] : message.to;
    expect(to?.value[0]?.address).toBe("organizer@example.test");
    const part = message.attachments.find(
      (item) => item.contentType === "text/calendar",
    );
    expect(part?.content.toString()).toContain("METHOD:REPLY");
    expect(part?.content.toString()).toContain("PARTSTAT=ACCEPTED");
    expect(part?.content.toString()).toContain(
      "UID:local-google-fixture@example.test",
    );
    expect(part?.content.toString()).toContain(
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
    );
    const contentType = part?.headers.get("content-type");
    expect(contentType).toMatchObject({ params: { method: "REPLY" } });
    const inbox = unwrap(await client.mailboxes(session, mailId)).list.find(
      (box) => box.role === "inbox",
    );
    if (!inbox) throw new Error("Missing inbox");
    const repeatedBlob = unwrap(
      await client.upload(session, mailId, Buffer.from(fixture)),
    );
    const repeatedMail = unwrap(
      await client.importEmail(session, mailId, {
        blobId: repeatedBlob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    expect(
      unwrap(
        await service.act(actor, {
          ...input,
          requestId: randomUUID(),
          messageId: repeatedMail.id,
          action: "apply",
        }),
      ).state,
    ).toBe("applied");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(1);
    const update = fixture
      .replace("SUMMARY:Planning", "SEQUENCE:1\r\nSUMMARY:Updated planning")
      .replace("CATEGORIES:Planning,Private\r\n", "")
      .replace("LOCATION:Room 101\r\n", "");
    const blob = unwrap(
      await client.upload(session, mailId, Buffer.from(update)),
    );
    const imported = unwrap(
      await client.importEmail(session, mailId, {
        blobId: blob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const updated = await service.act(actor, {
      ...input,
      requestId: randomUUID(),
      messageId: imported.id,
      action: "apply",
    });
    if (updated.isErr())
      throw new Error(
        `update failed ${JSON.stringify(updated.error)} ${JSON.stringify(await db.invitationOperation.findMany())}`,
      );
    expect(updated.value).toMatchObject({
      state: "applied",
      eventId: result.value.eventId,
    });
    const updatedObjects = (
      await Promise.all(
        davCalendars.map((collection) =>
          fetchCalendarObjects({
            calendar: collection,
            headers,
            urlFilter: (url) => !url.endsWith("/"),
          }),
        ),
      )
    ).flat();
    expect(updatedObjects[0]?.data).toContain("CATEGORIES:Planning,Private");
    expect(updatedObjects[0]?.data).toContain(
      "X-GOOGLE-TEST:unexposed-property",
    );
    expect(updatedObjects[0]?.data).toContain("PARTSTAT=ACCEPTED");
    expect(updatedObjects[0]?.data).not.toContain("LOCATION:Room 101");
    const stale = await service.act(actor, {
      ...input,
      requestId: randomUUID(),
      action: "apply",
    });
    expect(stale.isErr() && stale.error.kind).toBe("conflict");
    const listed = unwrap(
      await calendar.events(actor, "default", {
        start: "2026-11-01T00:00:00Z",
        end: "2026-11-05T00:00:00Z",
      }),
    );
    expect(listed.events.map((event) => event.title)).toEqual([
      "Updated planning",
    ]);
    const cancellation = [
      "From: Organizer <organizer@example.test>",
      "DKIM-Signature: v=1; d=example.test; s=fixture; b=fixture",
      "To: Alice <alice@example.test>",
      "MIME-Version: 1.0",
      "Content-Type: text/calendar; method=CANCEL; charset=UTF-8",
      "",
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:local-google-fixture@example.test",
      "SEQUENCE:2",
      "DTSTAMP:20261002T100000Z",
      "RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000",
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
      "ATTENDEE:mailto:alice@example.test",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const cancelledBlob = unwrap(
      await client.upload(session, mailId, Buffer.from(cancellation)),
    );
    const cancelledMessage = unwrap(
      await client.importEmail(session, mailId, {
        blobId: cancelledBlob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const cancelled = await service.act(actor, {
      ...input,
      requestId: randomUUID(),
      messageId: cancelledMessage.id,
      action: "apply",
    });
    if (cancelled.isErr())
      throw new Error(
        `cancel failed ${JSON.stringify(cancelled.error)} ${JSON.stringify(await db.invitationOperation.findMany())}`,
      );
    expect(cancelled.value.state).toBe("applied");
    const range = {
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-25T00:00:00Z",
    };
    const after = unwrap(await calendar.events(actor, "default", range));
    expect(after.events.map((event) => event.start)).toEqual([
      "2026-11-02T10:00:00.000Z",
      "2026-11-16T10:00:00.000Z",
    ]);
    const seriesCancellation = cancellation
      .replace("RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000\r\n", "")
      .replace("SEQUENCE:2", "SEQUENCE:3");
    const seriesBlob = unwrap(
      await client.upload(session, mailId, Buffer.from(seriesCancellation)),
    );
    const seriesMail = unwrap(
      await client.importEmail(session, mailId, {
        blobId: seriesBlob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const seriesInput = {
      ...input,
      requestId: randomUUID(),
      messageId: seriesMail.id,
      action: "apply" as const,
    };
    const seriesResult = await service.act(actor, seriesInput);
    if (seriesResult.isErr()) {
      const op = await db.invitationOperation.findUniqueOrThrow({
        where: { id: seriesInput.requestId },
        include: { series: true },
      });
      const raw = await invitationProtocol.findInvitationObject({
        origin: base,
        address: actor.email,
        secret: password,
        uid: "local-google-fixture@example.test",
      });
      throw new Error(
        `series cancellation: ${JSON.stringify({ error: seriesResult.error, phase: op.phase, expected: op.calendar, actual: raw.isOk() ? raw.value : raw.error })}`,
      );
    }
    expect(seriesResult.value.state).toBe("applied");
    expect(
      unwrap(await calendar.events(actor, "default", range)).events,
    ).toEqual([]);
    expect(
      unwrap(
        await service.act(actor, { ...seriesInput, requestId: randomUUID() }),
      ).state,
    ).toBe("applied");
    const spoof = fixture
      .replace(
        "Organizer <organizer@example.test>",
        "Attacker <attacker@example.test>",
      )
      .replaceAll("local-google-fixture@example.test", "spoof@example.test");
    const spoofBlob = unwrap(
      await client.upload(session, mailId, Buffer.from(spoof)),
    );
    const spoofMail = unwrap(
      await client.importEmail(session, mailId, {
        blobId: spoofBlob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const denied = await service.act(actor, {
      ...input,
      requestId: randomUUID(),
      messageId: spoofMail.id,
    });
    expect(denied.isErr() && denied.error.kind).toBe("forbidden");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(1);
  });
  it("reconciles an uncertain submission without sending twice and keeps unknown failures pending", async () => {
    const session = unwrap(await client.discover());
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const inbox = unwrap(await client.mailboxes(session, mailId)).list.find(
      (box) => box.role === "inbox",
    );
    const sent = unwrap(await client.mailboxes(session, mailId)).list.find(
      (box) => box.role === "sent",
    );
    if (!inbox || !sent) throw new Error("Missing mailbox");
    const calendar = createCalendarService({
      origin: base,
      store: credentialStore,
    });
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const importInvite = async (uid: string) => {
      const raw = fixture.replaceAll("local-google-fixture@example.test", uid);
      const blob = unwrap(
        await client.upload(session, mailId, Buffer.from(raw)),
      );
      return unwrap(
        await client.importEmail(session, mailId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      ).id;
    };
    class UncertainClient extends JmapClient {
      override async submit(...args: Parameters<JmapClient["submit"]>) {
        const submitted = await super.submit(...args);
        return submitted.isErr()
          ? submitted
          : err({ kind: "network" as const, message: "response lost" });
      }
    }
    const auth = `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`;
    const uncertain = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new UncertainClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const input = {
      accountId: "default",
      calendarId,
      messageId: await importInvite("uncertain@example.test"),
      requestId: randomUUID(),
      action: "tentative" as const,
      recurrenceId: null,
    };
    expect((await uncertain.act(actor, input)).isErr()).toBe(true);
    expect(
      (
        await db.invitationOperation.findUniqueOrThrow({
          where: { id: input.requestId },
        })
      ).phase,
    ).toBe("sending");
    class WrongEnvelopeClient extends JmapClient {
      override async submissions(
        ...args: Parameters<JmapClient["submissions"]>
      ) {
        return (await super.submissions(...args)).map((result) =>
          Object.assign({}, result, {
            list: result.list.map((item) =>
              Object.assign({}, item, {
                envelope: {
                  mailFrom: { email: "alice@example.test" },
                  rcptTo: [{ email: "other@example.test" }],
                },
              }),
            ),
          }),
        );
      }
    }
    const wrongEnvelope = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new WrongEnvelopeClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    expect(
      unwrap(await wrongEnvelope.reconcile(actor, "default", input.requestId))
        .state,
    ).toBe("pending");
    expect(
      unwrap(await service.reconcile(actor, "default", input.requestId)).state,
    ).toBe("sent");
    expect(
      unwrap(await service.reconcile(actor, "default", input.requestId)).state,
    ).toBe("sent");
    const count = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids.length;
    expect(count).toBe(2);
    const sentIds = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids;
    const tentative = unwrap(
      await client.emails(session, mailId, sentIds),
    ).list.find((email) => email.subject === "Invitation response: tentative");
    if (!tentative) throw new Error("Missing tentative reply");
    const reply = await simpleParser(
      Buffer.from(
        unwrap(await client.download(session, mailId, tentative.blobId)),
      ),
    );
    expect(
      reply.attachments
        .find((item) => item.contentType === "text/calendar")
        ?.content.toString(),
    ).toContain("PARTSTAT=TENTATIVE");
    class NoSubmissionClient extends JmapClient {
      override submit(): ReturnType<JmapClient["submit"]> {
        return Promise.resolve(
          err({ kind: "network", message: "unknown result" }),
        );
      }
    }
    const noSubmission = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new NoSubmissionClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const pending = {
      ...input,
      messageId: await importInvite("pending@example.test"),
      requestId: randomUUID(),
      action: "decline" as const,
    };
    expect((await noSubmission.act(actor, pending)).isErr()).toBe(true);
    expect(
      unwrap(await service.reconcile(actor, "default", pending.requestId))
        .state,
    ).toBe("pending");
    expect(
      unwrap(await service.reconcile(actor, "default", pending.requestId))
        .state,
    ).toBe("pending");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(count);
    expect(
      (
        await service.reconcile(
          { ...actor, id: "other" },
          "default",
          pending.requestId,
        )
      ).isErr(),
    ).toBe(true);
  });
  it("recovers a calendar write whose response was lost and a pre-submission draft failure", async () => {
    const session = unwrap(await client.discover());
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = unwrap(await client.mailboxes(session, mailId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    const sent = boxes.find((box) => box.role === "sent");
    if (!inbox || !sent) throw new Error("Missing mailbox");
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const importInvite = async (uid: string) => {
      const blob = unwrap(
        await client.upload(
          session,
          mailId,
          Buffer.from(
            fixture.replaceAll("local-google-fixture@example.test", uid),
          ),
        ),
      );
      return unwrap(
        await client.importEmail(session, mailId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      ).id;
    };
    const auth = `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`;
    class LostCalendarClient extends JmapClient {
      override async createCalendarEvent(
        ...args: Parameters<JmapClient["createCalendarEvent"]>
      ) {
        const created = await super.createCalendarEvent(...args);
        return created.isErr()
          ? created
          : err({ kind: "network" as const, message: "response lost" });
      }
    }
    const lost = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new LostCalendarClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const input = {
      accountId: "default",
      calendarId,
      messageId: await importInvite("calendar-lost@example.test"),
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    expect((await lost.act(actor, input)).isErr()).toBe(true);
    expect(
      (
        await db.invitationOperation.findUniqueOrThrow({
          where: { id: input.requestId },
        })
      ).phase,
    ).toMatch(/^calendarWriting:/);
    expect(
      unwrap(await service.reconcile(actor, "default", input.requestId)).state,
    ).toBe("sent");
    class UnwrittenCalendarClient extends JmapClient {
      override createCalendarEvent(): ReturnType<
        JmapClient["createCalendarEvent"]
      > {
        return Promise.resolve(
          err({ kind: "network", message: "write did not reach server" }),
        );
      }
    }
    const unwritten = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new UnwrittenCalendarClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const unwrittenInput = {
      ...input,
      requestId: randomUUID(),
      messageId: await importInvite("calendar-not-written@example.test"),
    };
    expect((await unwritten.act(actor, unwrittenInput)).isErr()).toBe(true);
    expect(
      unwrap(
        await service.reconcile(actor, "default", unwrittenInput.requestId),
      ).state,
    ).toBe("sent");
    class UnwrittenUpdateClient extends JmapClient {
      override updateCalendarEvent(): ReturnType<
        JmapClient["updateCalendarEvent"]
      > {
        return Promise.resolve(
          err({ kind: "network", message: "update did not reach server" }),
        );
      }
    }
    const failedUpdate = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new UnwrittenUpdateClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const updateRaw = fixture
      .replaceAll(
        "local-google-fixture@example.test",
        "calendar-not-written@example.test",
      )
      .replace("SUMMARY:Planning", "SEQUENCE:1\r\nSUMMARY:Recovered update");
    const updateBlob = unwrap(
      await client.upload(session, mailId, Buffer.from(updateRaw)),
    );
    const updateMessage = unwrap(
      await client.importEmail(session, mailId, {
        blobId: updateBlob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const updateInput = {
      ...unwrittenInput,
      messageId: updateMessage.id,
      requestId: randomUUID(),
      action: "apply" as const,
    };
    expect((await failedUpdate.act(actor, updateInput)).isErr()).toBe(true);
    expect(
      unwrap(await service.reconcile(actor, "default", updateInput.requestId))
        .state,
    ).toBe("applied");
    const recovered = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).events(actor, "default", {
        start: "2026-11-01T00:00:00Z",
        end: "2026-11-05T00:00:00Z",
      }),
    );
    expect(
      recovered.events.some((event) => event.title === "Recovered update"),
    ).toBe(true);
    class FailedDraftClient extends JmapClient {
      override upload(
        ...args: Parameters<JmapClient["upload"]>
      ): ReturnType<JmapClient["upload"]> {
        if (args[3]?.startsWith("text/calendar;"))
          return Promise.resolve(
            err({ kind: "network", message: "draft upload failed" }),
          );
        return super.upload(...args);
      }
    }
    const failedDraft = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new FailedDraftClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const draftInput = {
      ...input,
      requestId: randomUUID(),
      messageId: await importInvite("draft-failure@example.test"),
      action: "decline" as const,
    };
    expect((await failedDraft.act(actor, draftInput)).isErr()).toBe(true);
    expect(
      (
        await db.invitationOperation.findUniqueOrThrow({
          where: { id: draftInput.requestId },
        })
      ).phase,
    ).toMatch(/^draftCreating:/);
    expect(
      unwrap(await service.reconcile(actor, "default", draftInput.requestId))
        .state,
    ).toBe("sent");
    expect(
      unwrap(await service.reconcile(actor, "default", draftInput.requestId))
        .state,
    ).toBe("sent");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(5);
    const sentIds = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids;
    const emails = unwrap(await client.emails(session, mailId, sentIds)).list;
    const decline = emails.find(
      (email) => email.subject === "Invitation response: declined",
    );
    if (!decline) throw new Error("Missing decline reply");
    const parsed = await simpleParser(
      Buffer.from(
        unwrap(await client.download(session, mailId, decline.blobId)),
      ),
    );
    expect(
      parsed.attachments
        .find((item) => item.contentType === "text/calendar")
        ?.content.toString(),
    ).toContain("PARTSTAT=DECLINED");
  });
  it("accepts a recipient alias only while its owner may send as that identity", async () => {
    const session = unwrap(await client.discover());
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = unwrap(await client.mailboxes(session, mailId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    const sent = boxes.find((box) => box.role === "sent");
    if (!inbox || !sent) throw new Error("Missing mailbox");
    expect(
      unwrap(await client.identities(session, mailId)).list.map(
        (item) => item.email,
      ),
    ).toContain("alternate@example.test");
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    let authorized = true;
    let sendAllowed = true;
    let guarded = 0;
    const aliasService = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      canSendAs: (_user, address) =>
        Promise.resolve(
          authorized && address === "alternate@example.test" ? "alias:1" : null,
        ),
      beforeAliasSend: (_user, id) => {
        if (id === "alias:1") guarded += 1;
        return Promise.resolve(authorized && sendAllowed);
      },
    });
    const importInvite = async (uid: string) => {
      const raw = fixture
        .replaceAll("local-google-fixture@example.test", uid)
        .replaceAll("alice@example.test", "alternate@example.test");
      const blob = unwrap(
        await client.upload(session, mailId, Buffer.from(raw)),
      );
      return unwrap(
        await client.importEmail(session, mailId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      ).id;
    };
    const input = {
      accountId: "default",
      calendarId,
      messageId: await importInvite("alias-invite@example.test"),
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
      recipient: "alternate@example.test",
    };
    expect(unwrap(await aliasService.act(actor, input)).state).toBe("sent");
    expect(guarded).toBe(1);
    const sentIds = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids;
    const messages = unwrap(await client.emails(session, mailId, sentIds)).list;
    expect(
      messages.some((message) =>
        message.from?.some(
          (address) => address.email === "alternate@example.test",
        ),
      ),
    ).toBe(true);
    sendAllowed = false;
    const pending = {
      ...input,
      requestId: randomUUID(),
      messageId: await importInvite("alias-pending@example.test"),
    };
    expect((await aliasService.act(actor, pending)).isErr()).toBe(true);
    expect(
      (
        await db.invitationOperation.findUniqueOrThrow({
          where: { id: pending.requestId },
        })
      ).phase,
    ).toBe("prepared");
    authorized = false;
    expect(
      (
        await aliasService.reconcile(actor, "default", pending.requestId)
      ).isErr(),
    ).toBe(true);
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(sentIds.length);
    const denied = await aliasService.act(actor, {
      ...input,
      requestId: randomUUID(),
      messageId: await importInvite("revoked-alias@example.test"),
    });
    expect(denied.isErr() && denied.error.kind).toBe("forbidden");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(sentIds.length);
    authorized = true;
    sendAllowed = true;
    expect(
      unwrap(await aliasService.reconcile(actor, "default", pending.requestId))
        .state,
    ).toBe("sent");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(sentIds.length + 1);
  });
  it("fences a delayed calendar write when reconciliation retries", async () => {
    const session = unwrap(await client.discover());
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = unwrap(await client.mailboxes(session, mailId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    const sent = boxes.find((box) => box.role === "sent");
    if (!inbox || !sent) throw new Error("Missing mailbox");
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const uid = "delayed-write@example.test";
    const blob = unwrap(
      await client.upload(
        session,
        mailId,
        Buffer.from(
          fixture.replaceAll("local-google-fixture@example.test", uid),
        ),
      ),
    );
    const message = unwrap(
      await client.importEmail(session, mailId, {
        blobId: blob.blobId,
        mailboxIds: { [inbox.id]: true },
      }),
    );
    const before = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids.length;
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    class DelayedClient extends JmapClient {
      override async createCalendarEvent(
        ...args: Parameters<JmapClient["createCalendarEvent"]>
      ) {
        started.resolve();
        await released.promise;
        return super.createCalendarEvent(...args);
      }
    }
    const delayed = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new DelayedClient(base, {
          authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const input = {
      accountId: "default",
      calendarId,
      messageId: message.id,
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    const pending = delayed.act(actor, input);
    await started.promise;
    try {
      expect(
        unwrap(await service.reconcile(actor, "default", input.requestId))
          .state,
      ).toBe("sent");
    } finally {
      released.resolve();
    }
    expect((await pending).isErr()).toBe(true);
    const accountId = session.primaryAccounts[JmapCapability.calendars] ?? "";
    const events = unwrap(
      await client.calendarEventPage(session, accountId, {
        filter: {},
        position: 0,
        limit: 500,
      }),
    ).events.list;
    expect(events.filter((event) => event.uid === uid)).toHaveLength(1);
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(before + 1);
  });
  it("releases a rejected submission but reconciles an uncertain follow-up", async () => {
    const session = unwrap(await client.discover());
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = unwrap(await client.mailboxes(session, mailId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    const sent = boxes.find((box) => box.role === "sent");
    if (!inbox || !sent) throw new Error("Missing mailbox");
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const importInvite = async (uid: string) => {
      const blob = unwrap(
        await client.upload(
          session,
          mailId,
          Buffer.from(
            fixture.replaceAll("local-google-fixture@example.test", uid),
          ),
        ),
      );
      return unwrap(
        await client.importEmail(session, mailId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      ).id;
    };
    const auth = `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`;
    class RejectedSubmissionClient extends JmapClient {
      override submit(): ReturnType<JmapClient["submit"]> {
        return Promise.resolve(
          err({
            kind: "set",
            method: "EmailSubmission/set",
            id: "item",
            type: "forbiddenFrom",
          }),
        );
      }
    }
    const rejected = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new RejectedSubmissionClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const before = unwrap(
      await client.queryEmails(session, mailId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids.length;
    const input = {
      accountId: "default",
      calendarId,
      messageId: await importInvite("submission-rejected@example.test"),
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    expect((await rejected.act(actor, input)).isErr()).toBe(true);
    expect(
      unwrap(await service.reconcile(actor, "default", input.requestId)).state,
    ).toBe("failed");
    const retry = { ...input, requestId: randomUUID() };
    expect(unwrap(await service.act(actor, retry)).state).toBe("sent");
    class FollowupFailureClient extends JmapClient {
      override async submit(...args: Parameters<JmapClient["submit"]>) {
        const result = await super.submit(...args);
        return result.isErr()
          ? result
          : err({
              kind: "set" as const,
              method: "Email/set",
              id: args[2],
              type: "forbidden",
            });
      }
    }
    const followup = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new FollowupFailureClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const uncertain = {
      ...input,
      messageId: await importInvite("followup-uncertain@example.test"),
      requestId: randomUUID(),
    };
    expect((await followup.act(actor, uncertain)).isErr()).toBe(true);
    expect(
      (
        await db.invitationOperation.findUniqueOrThrow({
          where: { id: uncertain.requestId },
        })
      ).phase,
    ).toBe("sending");
    expect(
      unwrap(await service.reconcile(actor, "default", uncertain.requestId))
        .state,
    ).toBe("sent");
    expect(
      unwrap(
        await client.queryEmails(session, mailId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(before + 2);
  });
  it("requires trusted organizer provenance or explicit confirmation of a new invitation", async () => {
    const session = unwrap(await client.discover());
    const accountId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = unwrap(await client.mailboxes(session, accountId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    const sent = boxes.find((box) => box.role === "sent");
    if (!inbox || !sent) throw new Error("Missing mailbox");
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const auth = `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`;
    const direct = new JmapClient(base, {
      authorization: auth,
      rewriteSessionUrlsToOrigin: base,
    });
    const imported = async (raw: string, trusted = false) => {
      const blob = unwrap(
        await direct.upload(session, accountId, Buffer.from(raw)),
      );
      return unwrap(
        await (trusted ? client : direct).importEmail(session, accountId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      ).id;
    };
    const sentBefore = unwrap(
      await client.queryEmails(session, accountId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids.length;
    const raw = fixtureFor("unverified-new@example.test").replace(
      "From: Organizer",
      "Authentication-Results: forged; dkim=pass\r\nFrom: Organizer",
    );
    const messageId = await imported(raw);
    const input = {
      accountId: "default",
      calendarId,
      messageId,
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    expect(
      unwrap(await service.read(actor, "default", messageId)).senderStatus,
    ).toBe("unverified");
    expect((await service.act(actor, input)).isErr()).toBe(true);
    expect(
      unwrap(
        await client.queryEmails(session, accountId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(sentBefore);
    expect(unwrap(await service.confirm(actor, input)).state).toBe("sent");
    expect(unwrap(await service.confirm(actor, input)).state).toBe("sent");
    const knownUid = "verified-existing@example.test";
    const knownId = await imported(fixtureFor(knownUid), true);
    const known = { ...input, messageId: knownId, requestId: randomUUID() };
    const knownResult = unwrap(await service.act(actor, known));
    expect(knownResult.state).toBe("sent");
    class CalendarUnavailableClient extends JmapClient {
      override async discover(...args: Parameters<JmapClient["discover"]>) {
        return (await super.discover(...args)).map((value) =>
          Object.assign({}, value, {
            primaryAccounts: Object.fromEntries(
              Object.entries(value.primaryAccounts).filter(
                ([key]) => key !== JmapCapability.calendars,
              ),
            ),
          }),
        );
      }
    }
    const unavailableCalendar = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new CalendarUnavailableClient(base, {
          authorization: auth,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    expect(
      unwrap(await unavailableCalendar.read(actor, "default", knownId))
        .senderStatus,
    ).toBe("unverified");
    const unavailableAuthentication = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: {
        ...createInvitationStore(db),
        authentication: () => Promise.reject(new Error("ledger unavailable")),
      },
    });
    expect(
      unwrap(await unavailableAuthentication.read(actor, "default", knownId))
        .senderStatus,
    ).toBe("unverified");
    const deniedOnFailure = await unavailableAuthentication.act(actor, {
      ...known,
      requestId: randomUUID(),
    });
    expect(deniedOnFailure.isErr() && deniedOnFailure.error.kind).toBe(
      "unavailable",
    );

    const forgedRequest = fixtureFor(knownUid).replace(
      "SUMMARY:Planning",
      "SEQUENCE:9\r\nSUMMARY:Forged change",
    );
    const forgedId = await imported(forgedRequest);
    const forged = {
      ...known,
      messageId: forgedId,
      requestId: randomUUID(),
      action: "apply" as const,
    };
    expect(
      unwrap(await service.read(actor, "default", forgedId)).senderStatus,
    ).toBe("unverified");
    expect((await service.act(actor, forged)).isErr()).toBe(true);
    expect((await service.confirm(actor, forged)).isErr()).toBe(true);
    const cancel = forgedRequest
      .replace("method=REQUEST", "method=CANCEL")
      .replace("METHOD:REQUEST", "METHOD:CANCEL");
    const cancelId = await imported(cancel);
    expect(
      (
        await service.act(actor, {
          ...forged,
          messageId: cancelId,
          requestId: randomUUID(),
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await service.confirm(actor, {
          ...forged,
          messageId: cancelId,
          requestId: randomUUID(),
        })
      ).isErr(),
    ).toBe(true);
    const changedOrganizer = fixtureFor(knownUid)
      .replaceAll("organizer@example.test", "attacker@example.test")
      .replace("SUMMARY:Planning", "SEQUENCE:10\r\nSUMMARY:Other organizer");
    const otherId = await imported(changedOrganizer, true);
    expect(
      unwrap(await service.read(actor, "default", otherId)).senderStatus,
    ).toBe("unverified");
    expect(
      (
        await service.act(actor, {
          ...forged,
          messageId: otherId,
          requestId: randomUUID(),
        })
      ).isErr(),
    ).toBe(true);
    const listed = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).events(actor, "default", {
        start: "2026-11-01T00:00:00Z",
        end: "2026-11-05T00:00:00Z",
      }),
    );
    expect(listed.events.some((event) => event.title === "Forged change")).toBe(
      false,
    );
    expect(listed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seriesId: knownResult.eventId,
          title: "Planning",
        }),
      ]),
    );
    expect(
      unwrap(
        await client.queryEmails(session, accountId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(sentBefore + 2);
    // A calendar event without an invitation-series row is still an existing
    // event and must not be adopted by an unverified confirmation.
    const orphanUid = "existing-without-series@example.test";
    const orphanId = await imported(fixtureFor(orphanUid), true);
    expect(
      unwrap(
        await service.act(actor, {
          ...input,
          messageId: orphanId,
          requestId: randomUUID(),
        }),
      ).state,
    ).toBe("sent");
    await db.invitationSeries.deleteMany({
      where: { userId: actor.id, uid: orphanUid },
    });
    const impersonationId = await imported(
      fixtureFor(orphanUid).replace("SUMMARY:Planning", "SUMMARY:Impersonated"),
    );
    const orphanConfirm = await service.confirm(actor, {
      ...input,
      messageId: impersonationId,
      requestId: randomUUID(),
    });
    expect(orphanConfirm.isErr() && orphanConfirm.error.kind).toBe("conflict");
    const grayId = await imported(fixtureFor("gray-verdict@example.test"));
    await seedReceipt(accountId, grayId, { dkim: "GRAY", dmarc: "GRAY" });
    expect(
      unwrap(await service.read(actor, "default", grayId)).senderStatus,
    ).toBe("unverified");
    expect(
      (
        await service.act(actor, {
          ...input,
          messageId: grayId,
          requestId: randomUUID(),
        })
      ).isErr(),
    ).toBe(true);
    const ambiguousRaw = fixtureFor("ambiguous-sender@example.test").replace(
      "From: Organizer <organizer@example.test>",
      "From: Organizer <organizer@example.test>\r\nFrom: attacker@example.test",
    );
    const ambiguousId = await imported(ambiguousRaw, true);
    expect(
      unwrap(await service.read(actor, "default", ambiguousId)).senderStatus,
    ).toBe("unverified");
    const ambiguous = {
      ...input,
      messageId: ambiguousId,
      requestId: randomUUID(),
    };
    expect((await service.act(actor, ambiguous)).isErr()).toBe(true);
    expect((await service.confirm(actor, ambiguous)).isErr()).toBe(true);
    const dkimId = await imported(fixtureFor("dkim-pass@example.test"));
    await seedReceipt(accountId, dkimId, { dkim: "PASS", dmarc: "GRAY" });
    expect(
      unwrap(await service.read(actor, "default", dkimId)).senderStatus,
    ).toBe("verified");
    expect(
      unwrap(
        await service.act(actor, {
          ...input,
          messageId: dkimId,
          requestId: randomUUID(),
        }),
      ).state,
    ).toBe("sent");
    const dmarcId = await imported(fixtureFor("dmarc-pass@example.test"));
    await seedReceipt(accountId, dmarcId, { dkim: "GRAY", dmarc: "PASS" });
    expect(
      unwrap(await service.read(actor, "default", dmarcId)).senderStatus,
    ).toBe("verified");
    expect(
      unwrap(
        await service.act(actor, {
          ...input,
          messageId: dmarcId,
          requestId: randomUUID(),
        }),
      ).state,
    ).toBe("sent");
    const quarantinedId = await imported(
      fixtureFor("quarantined@example.test"),
    );
    await seedReceipt(accountId, quarantinedId, { state: "quarantined" });
    expect(
      unwrap(await service.read(actor, "default", quarantinedId)).senderStatus,
    ).toBe("unverified");
    expect(
      (
        await service.act(actor, {
          ...input,
          messageId: quarantinedId,
          requestId: randomUUID(),
        })
      ).isErr(),
    ).toBe(true);
    const otherMailboxId = await imported(
      fixtureFor("other-mailbox@example.test"),
    );
    await seedReceipt("another-account", otherMailboxId);
    expect(
      unwrap(await service.read(actor, "default", otherMailboxId)).senderStatus,
    ).toBe("unverified");
  });

  it("requires local DKIM alignment even when an ingestion verdict passes", async () => {
    const session = unwrap(await client.discover());
    const accountId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const boxes = unwrap(await client.mailboxes(session, accountId)).list;
    const inbox = boxes.find((box) => box.role === "inbox");
    const sent = boxes.find((box) => box.role === "sent");
    if (!inbox || !sent) throw new Error("Missing mailbox");
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const direct = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const imported = async (raw: string, dkim = "PASS", dmarc = "GRAY") => {
      const blob = unwrap(
        await direct.upload(session, accountId, Buffer.from(raw)),
      );
      const message = unwrap(
        await direct.importEmail(session, accountId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      );
      await seedReceipt(accountId, message.id, { dkim, dmarc });
      return message.id;
    };
    const sentBefore = unwrap(
      await client.queryEmails(session, accountId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids.length;
    const uid = "signed-organizer@example.test";
    const aligned = await imported(
      await signedFixture(fixtureFor(uid), "example.test"),
    );
    expect(
      unwrap(await service.read(actor, "default", aligned)).senderStatus,
    ).toBe("verified");
    const input = {
      accountId: "default",
      calendarId,
      messageId: aligned,
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    const known = unwrap(await service.act(actor, input));
    expect(known.state).toBe("sent");

    const update = fixtureFor(uid).replace(
      "SUMMARY:Planning",
      "SEQUENCE:9\r\nSUMMARY:Forged signed change",
    );
    const unaligned = await signedFixture(update, "attacker.test");
    const cancelled = await signedFixture(
      update
        .replace("method=REQUEST", "method=CANCEL")
        .replace("METHOD:REQUEST", "METHOD:CANCEL"),
      "attacker.test",
    );
    const rejectUnsafe = async (raw: string) => {
      // A passing receipt is deliberately simulated even for the unaligned signature.
      const messageId = await imported(raw, "GRAY", "PASS");
      expect(
        unwrap(await service.read(actor, "default", messageId)).senderStatus,
      ).toBe("unverified");
      const action = {
        ...input,
        messageId,
        requestId: randomUUID(),
        action: "apply" as const,
      };
      expect((await service.act(actor, action)).isErr()).toBe(true);
      expect((await service.confirm(actor, action)).isErr()).toBe(true);
    };
    await rejectUnsafe(unaligned);
    await rejectUnsafe(cancelled);
    await rejectUnsafe(
      `DKIM-Signature: v=1; d=example.test; s=forged; b=bogus\r\n${unaligned}`,
    );
    await rejectUnsafe(await signedFixture(update, "example.test", 1));
    const subdomain = await imported(
      await signedFixture(
        fixtureFor("signed-subdomain@example.test"),
        "calendar.example.test",
      ),
    );
    expect(
      unwrap(await service.read(actor, "default", subdomain)).senderStatus,
    ).toBe("verified");
    expect(
      unwrap(
        await service.act(actor, {
          ...input,
          messageId: subdomain,
          requestId: randomUUID(),
        }),
      ).state,
    ).toBe("sent");
    const missing = await imported(
      fixtureFor("missing-signature@example.test")
        .replace(fixtureSignature, "")
        .replace(
          "From: Organizer",
          "Authentication-Results: forged; dkim=pass header.d=example.test\r\nFrom: Organizer",
        ),
      "GRAY",
      "PASS",
    );
    expect(
      unwrap(await service.read(actor, "default", missing)).senderStatus,
    ).toBe("unverified");
    const confirmed = { ...input, messageId: missing, requestId: randomUUID() };
    expect((await service.act(actor, confirmed)).isErr()).toBe(true);
    expect(unwrap(await service.confirm(actor, confirmed)).state).toBe("sent");
    const calendar = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).events(actor, "default", {
        start: "2026-11-01T00:00:00Z",
        end: "2026-11-05T00:00:00Z",
      }),
    );
    expect(calendar.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seriesId: known.eventId,
          title: "Planning",
        }),
      ]),
    );
    expect(
      calendar.events.some((event) => event.title === "Forged signed change"),
    ).toBe(false);
    expect(
      unwrap(
        await client.queryEmails(session, accountId, {
          filter: { inMailbox: sent.id },
        }),
      ).ids,
    ).toHaveLength(sentBefore + 3);
  });

  it("releases an unsafe Calendar retry without overwriting a local change", async () => {
    const session = unwrap(await client.discover());
    const mailId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const calendarAccount =
      session.primaryAccounts[JmapCapability.calendars] ?? "";
    const inbox = unwrap(await client.mailboxes(session, mailId)).list.find(
      (box) => box.role === "inbox",
    );
    const calendarId = unwrap(
      await createCalendarService({
        origin: base,
        store: credentialStore,
      }).calendars(actor, "default"),
    ).calendars[0]?.id;
    if (!inbox || !calendarId) throw new Error("Missing inbox or calendar");
    const imported = async (raw: string) => {
      const blob = unwrap(
        await client.upload(session, mailId, Buffer.from(raw)),
      );
      return unwrap(
        await client.importEmail(session, mailId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      ).id;
    };
    const uid = "unsafe-calendar-retry@example.test";
    const input = {
      accountId: "default",
      calendarId,
      messageId: await imported(fixtureFor(uid)),
      requestId: randomUUID(),
      action: "accept" as const,
      recurrenceId: null,
    };
    const created = unwrap(await service.act(actor, input));
    if (!created.eventId) throw new Error("Missing created event");
    class UnwrittenUpdateClient extends JmapClient {
      override updateCalendarEvent(): ReturnType<
        JmapClient["updateCalendarEvent"]
      > {
        return Promise.resolve(
          err({ kind: "network", message: "update did not reach server" }),
        );
      }
    }
    const failedUpdate = createInvitationService({
      protocol: invitationProtocol,
      origin: base,
      store: credentialStore,
      intentions: createInvitationStore(db),
      client: () =>
        new UnwrittenUpdateClient(base, {
          authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
          rewriteSessionUrlsToOrigin: base,
        }),
    });
    const update = {
      ...input,
      messageId: await imported(
        fixtureFor(uid).replace(
          "SUMMARY:Planning",
          "SEQUENCE:1\r\nSUMMARY:Organizer update",
        ),
      ),
      requestId: randomUUID(),
      action: "apply" as const,
    };
    expect((await failedUpdate.act(actor, update)).isErr()).toBe(true);
    expect(
      (
        await db.invitationOperation.findUniqueOrThrow({
          where: { id: update.requestId },
        })
      ).phase,
    ).toMatch(/^calendarWriting:/);
    unwrap(
      await client.updateCalendarEvent(
        session,
        calendarAccount,
        created.eventId,
        { title: "Local change", description: "Local personal note" },
      ),
    );
    expect(
      unwrap(await service.reconcile(actor, "default", update.requestId)).state,
    ).toBe("failed");
    const operation = await db.invitationOperation.findUniqueOrThrow({
      where: { id: update.requestId },
      include: { series: true },
    });
    expect(operation.series.pendingId).toBeNull();
    expect(
      unwrap(
        await client.calendarEvents(session, calendarAccount, [
          created.eventId,
        ]),
      ).list[0]?.title,
    ).toBe("Local change");
  });
});
