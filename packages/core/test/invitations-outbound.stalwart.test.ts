import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createDatabase,
  createInvitationStore,
  createOrganizedInvitationStore,
  createOrganizedReplyScanStore,
  type PrismaClient,
} from "@opensuite/db";
import { JmapCapability, JmapClient, type JmapError } from "@opensuite/jmap";
import ICAL from "ical.js";
import { simpleParser } from "mailparser";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { ok, err, type Result } from "neverthrow";
import { fetchCalendarObjects, fetchCalendars } from "tsdav";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  invitationProtocol,
  organizerProtocol,
} from "../src/adapters/invitations.ts";
import { createCalendarService } from "../src/services/calendar.ts";
import { guardOrganizedCalendar } from "../src/services/invitations/organizer-calendar.ts";
import {
  reconcileOrganizerPending,
  scanOrganizerReplies,
} from "../src/services/invitations/organizer-scan.ts";
import { createOrganizerService } from "../src/services/invitations-outbound.ts";

const run = promisify(execFile);
const project = `organizer-${randomBytes(8).toString("hex")}`;
const overlay = `/tmp/${project}.yaml`;
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
      { cwd: new URL("../../../", import.meta.url), maxBuffer: 4_000_000 },
    )
  ).stdout;
const unwrap = <T>(result: Result<T, { kind: string }>) =>
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
const password = "test-password-for-invitation-9381!";
let db: PrismaClient;
let service: ReturnType<typeof createOrganizerService>;
let calendar: ReturnType<typeof createCalendarService>;
let client: JmapClient;
let base: string;
let scans: ReturnType<typeof createOrganizedReplyScanStore>;
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
async function caldavObject(uid: string) {
  const home = `/dav/cal/${encodeURIComponent(actor.email)}/`;
  const headers = {
    authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
  };
  const localFetch: typeof fetch = (resource, options) => {
    const url = new URL(
      resource instanceof Request ? resource.url : resource.toString(),
      base,
    );
    return fetch(`${base}${url.pathname}${url.search}`, options);
  };
  const calendars = await fetchCalendars({
    account: {
      accountType: "caldav",
      serverUrl: base,
      rootUrl: base,
      homeUrl: `${base}${home}`,
    },
    headers,
    fetch: localFetch,
  });
  const objects = (
    await Promise.all(
      calendars.map((item) =>
        fetchCalendarObjects({
          calendar: item,
          headers,
          fetch: localFetch,
          urlFilter: (url) => !url.endsWith("/"),
        }),
      ),
    )
  ).flat();
  const object = objects.find((item) => {
    if (typeof item.data !== "string") return false;
    const component = ICAL.Component.fromString(item.data);
    return component
      .getAllSubcomponents("vevent")
      .some((event) => event.getFirstPropertyValue("uid") === uid);
  });
  if (!object || typeof object.data !== "string")
    throw new Error("Missing CalDAV object");
  const url = new URL(object.url, base);
  return {
    url: `${base}${url.pathname}${url.search}`,
    data: object.data,
    headers,
  };
}
const ready = async (url: string, tries: number): Promise<void> => {
  try {
    if ((await fetch(url)).ok) return;
  } catch {
    /* starting */
  }
  if (!tries) throw new Error("Stalwart did not start");
  await new Promise((resolve) => setTimeout(resolve, 500));
  return ready(url, tries - 1);
};
beforeAll(async () => {
  try {
    await writeFile(
      overlay,
      `services:\n  postgres:\n    image: postgres:18.6\n    environment:\n      POSTGRES_PASSWORD: test-password\n      POSTGRES_INITDB_ARGS: --no-sync\n    command: ["postgres", "-c", "fsync=off"]\n    ports: ["127.0.0.1::5432"]\n`,
    );
    await compose("up", "-d");
    const databaseReady = async (tries: number): Promise<void> => {
      try {
        await compose("exec", "-T", "postgres", "pg_isready", "-U", "postgres");
      } catch (error) {
        if (!tries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await databaseReady(tries - 1);
      }
    };
    await databaseReady(120);
    const dbPort = (await compose("port", "postgres", "5432"))
      .trim()
      .split(":")
      .at(-1);
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
    base = `http://127.0.0.1:${port}`;
    await ready(`${base}/healthz/ready`, 120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = unwrap(await admin.createDomain("example.test"));
    const account = unwrap(
      await admin.createAccount("alice", domain.id, password),
    );
    unwrap(await admin.createAccount("organizer", domain.id, password));
    unwrap(await admin.createAccount("bob", domain.id, password));
    await db.mailboxLink.create({
      data: {
        userId: actor.id,
        accountId: account.id,
        address: actor.email,
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const store = {
      getForOwner: (userId: string, accountId: string) =>
        Promise.resolve(
          userId === actor.id &&
            (accountId === "default" || accountId === account.id)
            ? ok({
                accountId: account.id,
                address: actor.email,
                secret: password,
              })
            : err({ kind: "forbidden" }),
        ),
    };
    credentialStore = store;
    client = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const organized = createOrganizedInvitationStore(db);
    scans = createOrganizedReplyScanStore(db);
    calendar = guardOrganizedCalendar(
      createCalendarService({ origin: base, store }),
      store,
      organized,
      base,
    );
    service = createOrganizerService({
      origin: base,
      store,
      organized,
      scans,
      intentions: createInvitationStore(db),
      protocol: invitationProtocol,
      organizerProtocol,
    });
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    throw error;
  }
}, 180_000);
const disconnect = async (database: PrismaClient | undefined) => {
  if (database) await database.$disconnect();
};
afterAll(async () => {
  await disconnect(db);
  await compose("down", "--volumes", "--remove-orphans");
  await rm(overlay, { force: true });
}, 60_000);

describe("organizer invitations with Stalwart", () => {
  it("creates, sends, updates and cancels a recurring invitation once", async () => {
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const event = {
      calendarId,
      title: "Planning",
      description: "Agenda",
      location: "Room",
      start: "2026-11-09T10:00:00.000Z",
      end: "2026-11-09T11:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Lisbon",
      recurrence: "weekly" as const,
    };
    const input = {
      accountId: "default",
      requestId: randomUUID(),
      eventId: null,
      organizer: actor.email,
      attendees: ["organizer@example.test"],
      event,
      cancel: false,
    };
    const result = unwrap(await service.organize(actor, input));
    if (result.state !== "sent")
      throw new Error(
        `not sent: ${JSON.stringify(result)} ${JSON.stringify(await db.organizedOperation.findMany({ include: { deliveries: true } }))}`,
      );
    expect(result.eventId).toBeTruthy();
    expect(unwrap(await service.organize(actor, input))).toEqual(result);
    const eventId = result.eventId ?? "";
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees,
    ).toMatchObject([
      { email: "organizer@example.test", partstat: "NEEDS-ACTION" },
    ]);
    expect(
      (
        await service.status({ ...actor, id: "other" }, "default", eventId)
      ).isErr(),
    ).toBe(true);
    expect(
      (await calendar.deleteEvent(actor, "default", eventId)).isErr(),
    ).toBe(true);
    const saved = await db.organizedSeries.findFirstOrThrow({
      where: { eventId },
    });
    const session = unwrap(await client.discover());
    const accountId = session.primaryAccounts[JmapCapability.mail] ?? "";
    const inbox = unwrap(await client.mailboxes(session, accountId)).list.find(
      (box) => box.role === "inbox",
    );
    if (!inbox) throw new Error("Missing inbox");
    const importReply = async (
      from: string,
      attendee: string,
      sequence: number,
      stamp: string,
      partstat: string,
      authenticated: boolean,
      signingDomain = "example.test",
    ) => {
      const raw = [
        `From: ${from}`,
        `To: ${actor.email}`,
        `DKIM-Signature: v=1; d=${signingDomain}; s=fixture; b=fixture`,
        "MIME-Version: 1.0",
        "Content-Type: text/calendar; method=REPLY; charset=UTF-8",
        "",
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REPLY",
        "BEGIN:VEVENT",
        `UID:${saved.uid}`,
        `SEQUENCE:${sequence}`,
        `DTSTAMP:${stamp}`,
        `ORGANIZER:mailto:${actor.email}`,
        `ATTENDEE;PARTSTAT=${partstat}:mailto:${attendee}`,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
      const blob = unwrap(
        await client.upload(session, accountId, Buffer.from(raw)),
      );
      const imported = unwrap(
        await client.importEmail(session, accountId, {
          blobId: blob.blobId,
          mailboxIds: { [inbox.id]: true },
        }),
      );
      if (authenticated) {
        const id = randomUUID();
        const timestamp = new Date().toISOString();
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
                dmarcVerdict: { status: "PASS" },
                action: {
                  type: "S3",
                  topicArn: "fixture",
                  bucketName: "fixture",
                  objectKey: id,
                },
              },
              mail: {
                timestamp,
                source: from,
                messageId: id,
                destination: [actor.email],
              },
            },
            recipients: {
              create: {
                idempotencyKey: id,
                destination: accountId,
                addresses: [actor.email],
                state: "imported",
                remoteId: imported.id,
              },
            },
          },
        });
      }
      return imported.id;
    };
    const process = async (
      from: string,
      attendee: string,
      sequence: number,
      stamp: string,
      partstat: string,
      authenticated = true,
      signingDomain = "example.test",
    ) =>
      unwrap(
        await service.reply(
          actor,
          "default",
          await importReply(
            from,
            attendee,
            sequence,
            stamp,
            partstat,
            authenticated,
            signingDomain,
          ),
        ),
      );
    const stamp = "20261102T100000Z";
    expect(
      await process(
        "organizer@example.test",
        "organizer@example.test",
        0,
        stamp,
        "ACCEPTED",
        false,
      ),
    ).toMatchObject({ senderStatus: "unverified", result: "unverified" });
    expect(
      await process(
        "bob@example.test",
        "organizer@example.test",
        0,
        stamp,
        "ACCEPTED",
      ),
    ).toMatchObject({ senderStatus: "unverified", result: "unverified" });
    const unalignedId = await importReply(
      "organizer@example.test",
      "organizer@example.test",
      0,
      stamp,
      "ACCEPTED",
      true,
      "attacker.test",
    );
    await scanOrganizerReplies(scans, service);
    expect(
      unwrap(await service.unverified(actor, "default")).messageIds,
    ).toContain(unalignedId);
    expect(
      (
        await db.organizedReplyScan.findFirstOrThrow({
          where: { messageId: unalignedId },
        })
      ).finished,
    ).toBe(true);
    expect(
      (await scans.candidates()).some((item) => item.messageId === unalignedId),
    ).toBe(false);
    expect(
      unwrap(await service.reply(actor, "default", unalignedId)),
    ).toMatchObject({
      senderStatus: "unverified",
      result: "unverified",
      event: {
        uid: saved.uid,
        attendees: [{ email: "organizer@example.test" }],
      },
    });
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees[0]
        ?.partstat,
    ).toBe("NEEDS-ACTION");
    const verifiedId = await importReply(
      "organizer@example.test",
      "organizer@example.test",
      0,
      stamp,
      "ACCEPTED",
      true,
    );
    const authUnavailable = createOrganizerService({
      origin: base,
      store: credentialStore,
      organized: createOrganizedInvitationStore(db),
      scans,
      protocol: invitationProtocol,
      organizerProtocol,
      intentions: {
        ...createInvitationStore(db),
        authentication: () => Promise.reject(new Error("database unavailable")),
      },
    });
    expect(
      unwrap(await authUnavailable.reply(actor, "default", verifiedId)),
    ).toMatchObject({ senderStatus: "unverified", verificationPending: true });
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees[0]
        ?.partstat,
    ).toBe("NEEDS-ACTION");
    await db.organizedSeries.update({
      where: { id: saved.id },
      data: { pendingId: "temporary-operation" },
    });
    await scanOrganizerReplies(scans, service);
    expect(
      (
        await db.organizedReplyScan.findFirstOrThrow({
          where: { messageId: verifiedId },
        })
      ).outcome,
    ).toBe("pending");
    expect(
      (await scans.candidates()).some((item) => item.messageId === verifiedId),
    ).toBe(false);
    await db.organizedSeries.update({
      where: { id: saved.id },
      data: { pendingId: null },
    });
    await scanOrganizerReplies(scans, service);
    expect(
      (
        await db.organizedReplyScan.findFirstOrThrow({
          where: { messageId: verifiedId },
        })
      ).outcome,
    ).toBe("applied");
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees[0]
        ?.partstat,
    ).toBe("ACCEPTED");
    expect(
      unwrap(await service.reply(actor, "default", verifiedId)),
    ).toMatchObject({ senderStatus: "verified", result: "duplicate" });
    expect(
      await process(
        "organizer@example.test",
        "organizer@example.test",
        0,
        stamp,
        "ACCEPTED",
      ),
    ).toMatchObject({ senderStatus: "verified", result: "duplicate" });
    expect(
      await process(
        "organizer@example.test",
        "organizer@example.test",
        0,
        stamp,
        "DECLINED",
      ),
    ).toMatchObject({ senderStatus: "verified", result: "conflict" });
    expect(
      await process(
        "organizer@example.test",
        "organizer@example.test",
        0,
        "20261101T100000Z",
        "DECLINED",
      ),
    ).toMatchObject({ senderStatus: "verified", result: "stale" });
    expect(
      await process(
        "bob@example.test",
        "bob@example.test",
        0,
        stamp,
        "DECLINED",
      ),
    ).toMatchObject({ senderStatus: "verified", result: "conflict" });
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees[0]
        ?.partstat,
    ).toBe("ACCEPTED");
    const range = {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    };
    const occurrences = unwrap(
      await calendar.events(actor, "default", range),
    ).events;
    const next = occurrences.find(
      (item) => item.start === "2026-11-16T10:00:00.000Z",
    );
    if (!next) throw new Error("Missing recurring occurrence");
    const update = {
      ...input,
      requestId: randomUUID(),
      eventId: next.id,
      event: {
        ...event,
        title: "Updated",
        start: "2026-11-16T11:00:00.000Z",
        end: "2026-11-16T12:00:00.000Z",
      },
      attendees: ["organizer@example.test", "bob@example.test"],
    };
    expect(unwrap(await service.organize(actor, update)).state).toBe("sent");
    expect(
      unwrap(await calendar.events(actor, "default", range)).events[0]?.start,
    ).toBe("2026-11-09T11:00:00.000Z");
    expect(
      await process(
        "organizer@example.test",
        "organizer@example.test",
        0,
        "20261103T100000Z",
        "DECLINED",
      ),
    ).toMatchObject({ senderStatus: "verified", result: "stale" });
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees[0]
        ?.partstat,
    ).toBe("NEEDS-ACTION");
    const removed = {
      ...update,
      requestId: randomUUID(),
      eventId,
      event: {
        ...event,
        title: "Updated",
        start: "2026-11-09T11:00:00.000Z",
        end: "2026-11-09T12:00:00.000Z",
      },
      attendees: ["bob@example.test"],
    };
    expect(unwrap(await service.organize(actor, removed)).state).toBe("sent");
    expect(
      unwrap(
        await service.organize(actor, {
          ...removed,
          requestId: randomUUID(),
          cancel: true,
        }),
      ).state,
    ).toBe("sent");
    const sent = unwrap(await client.mailboxes(session, accountId)).list.find(
      (box) => box.role === "sent",
    );
    if (!sent) throw new Error("Missing sent mailbox");
    const sentIds = unwrap(
      await client.queryEmails(session, accountId, {
        filter: { inMailbox: sent.id },
      }),
    ).ids;
    expect(sentIds).toHaveLength(6);
    const emails = unwrap(
      await client.emails(session, accountId, sentIds),
    ).list;
    const methods: string[] = [];
    const inspectAt = async (index: number): Promise<void> => {
      const email = emails[index];
      if (!email) return;
      const message = await simpleParser(
        Buffer.from(
          unwrap(await client.download(session, accountId, email.blobId)),
        ),
      );
      const to = Array.isArray(message.to) ? message.to[0] : message.to;
      const recipient = to?.value[0]?.address;
      const body =
        message.attachments
          .find((part) => part.contentType === "text/calendar")
          ?.content.toString() ?? "";
      expect(body).toContain(`mailto:${recipient}`);
      expect(body).not.toContain(
        `mailto:${recipient === "bob@example.test" ? "organizer@example.test" : "bob@example.test"}`,
      );
      methods.push(body.includes("METHOD:CANCEL") ? "CANCEL" : "REQUEST");
      await inspectAt(index + 1);
    };
    await inspectAt(0);
    expect(methods.filter((method) => method === "CANCEL")).toHaveLength(2);
    expect(
      unwrap(await calendar.deleteEvent(actor, "default", eventId)),
    ).toEqual({
      success: true,
    });
  }, 120_000);
  it.each(["network", "partial"] as const)(
    "reconciles an uncertain %s submission without sending it twice",
    async (failure) => {
      const faulty = new JmapClient(base, {
        authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: base,
      });
      const realSubmit = faulty.submit.bind(faulty);
      let submissions = 0;
      faulty.submit = async (...args) => {
        submissions += 1;
        const outcome = await realSubmit(...args);
        return outcome.isErr()
          ? outcome
          : failure === "network"
            ? err({ kind: "network", message: "Lost submission response" })
            : err({
                kind: "method",
                method: "EmailSubmission/set",
                type: "serverPartialFail",
              });
      };
      const serviceWithLostResponse = createOrganizerService({
        origin: base,
        store: credentialStore,
        client: () => faulty,
        organized: createOrganizedInvitationStore(db),
        intentions: createInvitationStore(db),
        protocol: invitationProtocol,
        organizerProtocol,
      });
      const calendarId = unwrap(await calendar.calendars(actor, "default"))
        .calendars[0]?.id;
      if (!calendarId) throw new Error("Missing calendar");
      const input = {
        accountId: "default",
        requestId: randomUUID(),
        eventId: null,
        organizer: actor.email,
        attendees: ["bob@example.test"],
        cancel: false,
        event: {
          calendarId,
          title: "Uncertain",
          description: "",
          location: "",
          start: "2026-11-10T10:00:00.000Z",
          end: "2026-11-10T11:00:00.000Z",
          allDay: false,
          timeZone: "UTC",
          recurrence: "none" as const,
        },
      };
      const result = unwrap(
        await serviceWithLostResponse.organize(actor, input),
      );
      expect(result.state).toBe("pending");
      expect(submissions).toBe(1);
      const repeated = unwrap(
        await serviceWithLostResponse.organize(actor, input),
      );
      expect(repeated.state).toBe("sent");
      expect(
        unwrap(
          await serviceWithLostResponse.reconcile(
            actor,
            "default",
            input.requestId,
          ),
        ).state,
      ).toBe("sent");
      expect(submissions).toBe(1);
    },
    120_000,
  );
  it.each([
    {
      name: "method",
      failure: {
        kind: "method",
        method: "EmailSubmission/set",
        type: "serverFail",
      } satisfies JmapError,
    },
    {
      name: "request limit",
      failure: {
        kind: "request",
        status: 429,
        type: "tooManyRequests",
      } satisfies JmapError,
    },
    {
      name: "HTTP refusal",
      failure: {
        kind: "http",
        status: 403,
        body: "Forbidden",
      } satisfies JmapError,
    },
  ])(
    "releases a definitively rejected $name submission",
    async ({ failure }) => {
      const faulty = new JmapClient(base, {
        authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: base,
      });
      faulty.submit = () => Promise.resolve(err(failure));
      const rejectedService = createOrganizerService({
        origin: base,
        store: credentialStore,
        client: () => faulty,
        organized: createOrganizedInvitationStore(db),
        intentions: createInvitationStore(db),
        protocol: invitationProtocol,
        organizerProtocol,
      });
      const calendarId = unwrap(await calendar.calendars(actor, "default"))
        .calendars[0]?.id;
      if (!calendarId) throw new Error("Missing calendar");
      const input = {
        accountId: "default",
        requestId: randomUUID(),
        eventId: null,
        organizer: actor.email,
        attendees: ["bob@example.test"],
        cancel: false,
        event: {
          calendarId,
          title: "Rejected delivery",
          description: "",
          location: "",
          start: "2026-11-17T10:00:00.000Z",
          end: "2026-11-17T11:00:00.000Z",
          allDay: false,
          timeZone: "UTC",
          recurrence: "none" as const,
        },
      };
      const rejected = unwrap(await rejectedService.organize(actor, input));
      expect(rejected.state).toBe("failed");
      const operation = await db.organizedOperation.findUniqueOrThrow({
        where: { id: input.requestId },
        include: { series: true, deliveries: true },
      });
      expect(operation.series.pendingId).toBeNull();
      expect(operation.deliveries[0]?.phase).toBe("rejected");
      const retry = unwrap(
        await service.organize(actor, {
          ...input,
          requestId: randomUUID(),
          eventId: rejected.eventId,
          event: { ...input.event, title: "Delivery retried" },
        }),
      );
      expect(retry.state).toBe("sent");
    },
    120_000,
  );
  it("releases a definitively rejected calendar write and forbids unauthorized organizers", async () => {
    const faulty = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    faulty.createCalendarEvent = () =>
      Promise.resolve(
        err({
          kind: "set",
          method: "CalendarEvent/set",
          id: "item",
          type: "invalidProperties",
        }),
      );
    const rejectedService = createOrganizerService({
      origin: base,
      store: credentialStore,
      client: () => faulty,
      organized: createOrganizedInvitationStore(db),
      intentions: createInvitationStore(db),
      protocol: invitationProtocol,
      organizerProtocol,
    });
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const input = {
      accountId: "default",
      requestId: randomUUID(),
      eventId: null,
      organizer: actor.email,
      attendees: ["bob@example.test"],
      cancel: false,
      event: {
        calendarId,
        title: "Rejected",
        description: "",
        location: "",
        start: "2026-11-10T10:00:00.000Z",
        end: "2026-11-10T11:00:00.000Z",
        allDay: false,
        timeZone: "UTC",
        recurrence: "none" as const,
      },
    };
    const forbidden = await rejectedService.organize(actor, {
      ...input,
      requestId: randomUUID(),
      organizer: "other@example.test",
    });
    expect(forbidden.isErr() && forbidden.error.kind).toBe("forbidden");
    const result = unwrap(await rejectedService.organize(actor, input));
    expect(result.state).toBe("failed");
    const stored = await db.organizedOperation.findUniqueOrThrow({
      where: { id: input.requestId },
      include: { series: true, deliveries: true },
    });
    expect(stored.series.pendingId).toBeNull();
    expect(stored.deliveries[0]?.phase).toBe("reserved");
  }, 120_000);
  it("retries failures before or during a calendar write without duplicating the event", async () => {
    const flaky = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const realCalendars = flaky.calendars.bind(flaky);
    const realCreate = flaky.createCalendarEvent.bind(flaky);
    let calendarCalls = 0;
    let createCalls = 0;
    flaky.calendars = async (...args) => {
      calendarCalls += 1;
      return calendarCalls === 2
        ? err({ kind: "network", message: "temporary read failure" })
        : realCalendars(...args);
    };
    flaky.createCalendarEvent = async (...args) => {
      createCalls += 1;
      if (createCalls === 1)
        return err({
          kind: "network",
          message: "request not sent",
          beforeRequest: true,
        });
      return realCreate(...args);
    };
    const recovering = createOrganizerService({
      origin: base,
      store: credentialStore,
      client: () => flaky,
      organized: createOrganizedInvitationStore(db),
      intentions: createInvitationStore(db),
      protocol: invitationProtocol,
      organizerProtocol,
    });
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const input = {
      accountId: "default",
      requestId: randomUUID(),
      eventId: null,
      organizer: actor.email,
      attendees: ["bob@example.test"],
      cancel: false,
      event: {
        calendarId,
        title: "Retry",
        description: "",
        location: "",
        start: "2026-11-11T10:00:00.000Z",
        end: "2026-11-11T11:00:00.000Z",
        allDay: false,
        timeZone: "UTC",
        recurrence: "none" as const,
      },
    };
    expect(unwrap(await recovering.organize(actor, input)).state).toBe(
      "pending",
    );
    expect(
      (
        await db.organizedOperation.findUniqueOrThrow({
          where: { id: input.requestId },
        })
      ).phase,
    ).toBe("reserved");
    expect(
      unwrap(await recovering.reconcile(actor, "default", input.requestId))
        .state,
    ).toBe("pending");
    expect(
      (
        await db.organizedOperation.findUniqueOrThrow({
          where: { id: input.requestId },
        })
      ).phase,
    ).toMatch(/^writing:/);
    const recovered = unwrap(
      await recovering.reconcile(actor, "default", input.requestId),
    );
    expect(recovered.state).toBe("sent");
    expect(createCalls).toBe(2);
    const events = unwrap(
      await calendar.events(actor, "default", {
        start: "2026-11-11T00:00:00.000Z",
        end: "2026-11-12T00:00:00.000Z",
      }),
    ).events;
    expect(events.filter((event) => event.title === "Retry")).toHaveLength(1);
  }, 120_000);
  it.each(["same", "other", "deleted"] as const)(
    "recovers a calendar write after a concurrent CalDAV %s edit",
    async (change) => {
      const calendarId = unwrap(await calendar.calendars(actor, "default"))
        .calendars[0]?.id;
      if (!calendarId) throw new Error("Missing calendar");
      const event = {
        calendarId,
        title: `Concurrent ${change}`,
        description: "Original description",
        location: "Room",
        start: "2026-11-13T10:00:00.000Z",
        end: "2026-11-13T11:00:00.000Z",
        allDay: false,
        timeZone: "UTC",
        recurrence: "none" as const,
      };
      const input = {
        accountId: "default",
        requestId: randomUUID(),
        eventId: null,
        organizer: actor.email,
        attendees: ["bob@example.test"],
        cancel: false,
        event,
      };
      const created = unwrap(await service.organize(actor, input));
      expect(created.state).toBe("sent");
      const eventId = created.eventId ?? "";
      const series = await db.organizedSeries.findFirstOrThrow({
        where: { userId: actor.id, eventId },
      });
      const object = await caldavObject(series.uid);
      const racing = new JmapClient(base, {
        authorization: object.headers.authorization,
        rewriteSessionUrlsToOrigin: base,
      });
      const update = racing.updateCalendarEvent.bind(racing);
      let writeCount = 0;
      let rejection = "";
      let davStatus = 0;
      racing.updateCalendarEvent = async (...args) => {
        writeCount += 1;
        if (writeCount === 1) {
          if (change === "same") {
            const component = ICAL.Component.fromString(object.data);
            component
              .getFirstSubcomponent("vevent")
              ?.updatePropertyWithValue("description", "Edited via CalDAV");
            const edited = await fetch(object.url, {
              method: "PUT",
              headers: { ...object.headers, "content-type": "text/calendar" },
              body: component.toString(),
            });
            davStatus = edited.status;
          } else if (change === "deleted") {
            const deleted = await fetch(object.url, {
              method: "DELETE",
              headers: object.headers,
            });
            davStatus = deleted.status;
          } else {
            const uid = randomUUID();
            const added = await fetch(
              `${base}/dav/cal/${encodeURIComponent(actor.email)}/default/${uid}.ics`,
              {
                method: "PUT",
                headers: { ...object.headers, "content-type": "text/calendar" },
                body: [
                  "BEGIN:VCALENDAR",
                  "VERSION:2.0",
                  "PRODID:-//Esuno//Test//EN",
                  "BEGIN:VEVENT",
                  `UID:${uid}`,
                  "DTSTAMP:20261101T000000Z",
                  "DTSTART:20261114T100000Z",
                  "DTEND:20261114T110000Z",
                  "SUMMARY:Concurrent calendar edit",
                  "END:VEVENT",
                  "END:VCALENDAR",
                  "",
                ].join("\r\n"),
              },
            );
            davStatus = added.status;
          }
        }
        const result = await update(...args);
        if (result.isErr() && "type" in result.error)
          rejection = result.error.type;
        return result;
      };
      const store = createOrganizedInvitationStore(db);
      let fenced = false;
      const organized = {
        ...store,
        reject: async (userId: string, id: string, from: string) => {
          if (change === "same" && !fenced && from.startsWith("writing:")) {
            fenced = await store.transition(
              userId,
              id,
              from,
              `writing:${randomUUID()}`,
            );
          }
          return store.reject(userId, id, from);
        },
      };
      const recovering = createOrganizerService({
        origin: base,
        store: credentialStore,
        client: () => racing,
        organized,
        intentions: createInvitationStore(db),
        protocol: invitationProtocol,
        organizerProtocol,
      });
      const edit = {
        ...input,
        requestId: randomUUID(),
        eventId,
        event: { ...event, title: `Updated ${change}` },
      };
      expect(unwrap(await recovering.organize(actor, edit)).state).toBe(
        "pending",
      );
      expect(rejection).toBe("stateMismatch");
      expect(
        change === "same" ? [200, 204] : [change === "other" ? 201 : 204],
      ).toContain(davStatus);
      expect(
        unwrap(await recovering.status(actor, "default", eventId))
          .pendingOperationId,
      ).toBe(edit.requestId);
      const ageOperation = () =>
        db.organizedOperation.update({
          where: { id: edit.requestId },
          data: { updatedAt: new Date(Date.now() - 120_000) },
        });
      await ageOperation();
      const candidate = (await organized.pending()).find(
        (item) => item.operationId === edit.requestId,
      );
      if (!candidate) throw new Error("Missing recovery candidate");
      const claims = await Promise.all([
        organized.claimRecovery(
          candidate.userId,
          candidate.operationId,
          candidate.updatedAt,
        ),
        organized.claimRecovery(
          candidate.userId,
          candidate.operationId,
          candidate.updatedAt,
        ),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await ageOperation();
      await reconcileOrganizerPending(organized, recovering);
      const firstRecovery = await db.organizedOperation.findUniqueOrThrow({
        where: { id: edit.requestId },
      });
      expect(
        change === "same"
          ? firstRecovery.phase.startsWith("writing:")
          : firstRecovery.phase,
      ).toBe(change === "same" ? true : change === "other" ? "sent" : "failed");
      expect(fenced).toBe(change === "same");
      expect(
        (
          await db.organizedSeries.findUniqueOrThrow({
            where: { id: series.id },
          })
        ).pendingId,
      ).toBe(change === "same" ? edit.requestId : null);
      if (change === "same") {
        await ageOperation();
        await reconcileOrganizerPending(organized, recovering);
      }
      const stored = await db.organizedSeries.findUniqueOrThrow({
        where: { id: series.id },
      });
      expect(stored.pendingId).toBeNull();
      expect(
        (
          await db.organizedOperation.findUniqueOrThrow({
            where: { id: edit.requestId },
          })
        ).phase,
      ).toBe(change === "other" ? "sent" : "failed");
      const retried =
        change === "same"
          ? unwrap(
              await service.organize(actor, {
                ...edit,
                requestId: randomUUID(),
              }),
            )
          : null;
      expect(retried?.state ?? null).toBe(change === "same" ? "sent" : null);
      const events = unwrap(
        await calendar.events(actor, "default", {
          start: "2026-11-13T00:00:00.000Z",
          end: "2026-11-14T00:00:00.000Z",
        }),
      ).events;
      const editedEvent = events.find((item) => item.seriesId === eventId);
      const expectedEdit: unknown = expect.objectContaining({
        title: "Updated same",
        description: "Edited via CalDAV",
      });
      expect(change === "same" ? editedEvent : null).toEqual(
        change === "same" ? expectedEdit : null,
      );
    },
    120_000,
  );
  it("adopts safe CalDAV edits and preserves them during organizer updates", async () => {
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const event = {
      calendarId,
      title: "Before rebase",
      description: "Original",
      location: "Room",
      start: "2026-11-12T10:00:00.000Z",
      end: "2026-11-12T11:00:00.000Z",
      allDay: false,
      timeZone: "UTC",
      recurrence: "none" as const,
    };
    const input = {
      accountId: "default",
      requestId: randomUUID(),
      eventId: null,
      organizer: actor.email,
      attendees: ["bob@example.test"],
      cancel: false,
      event,
    };
    const created = unwrap(await service.organize(actor, input));
    const eventId = created.eventId ?? "";
    expect(created.state).toBe("sent");
    const session = unwrap(await client.discover());
    const calendarAccount =
      session.primaryAccounts[JmapCapability.calendars] ?? "";
    unwrap(
      await client.updateCalendarEvent(session, calendarAccount, eventId, {
        description: "Edited externally",
      }),
    );
    const updated = unwrap(
      await service.organize(actor, {
        ...input,
        requestId: randomUUID(),
        eventId,
        event: { ...event, title: "After rebase" },
      }),
    );
    expect(updated.state).toBe("sent");
    const range = {
      start: "2026-11-12T00:00:00.000Z",
      end: "2026-11-13T00:00:00.000Z",
    };
    expect(
      unwrap(await calendar.events(actor, "default", range)).events.find(
        (item) => item.seriesId === eventId,
      )?.description,
    ).toBe("Edited externally");
    unwrap(
      await client.updateCalendarEvent(session, calendarAccount, eventId, {
        title: "Another local edit",
      }),
    );
    expect(
      unwrap(await service.status(actor, "default", eventId)).attendees[0]
        ?.email,
    ).toBe("bob@example.test");
  }, 120_000);
  it("shares scan capacity across accounts and excludes mail older than the first event", async () => {
    const session = unwrap(await client.discover());
    const accountId = session.primaryAccounts[JmapCapability.mail] ?? "";
    await db.user.create({
      data: { id: "second", email: "second@example.test", name: "Second" },
    });
    await db.mailboxLink.create({
      data: {
        userId: "second",
        accountId: "second-account",
        address: "second@example.test",
        credentialId: "fixture",
        secret: "v1.AAAAAAAAAAAAAAAA.A.AAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const secondSeries = await db.organizedSeries.create({
      data: {
        id: randomUUID(),
        userId: "second",
        accountId: "second-account",
        uid: randomUUID(),
        organizer: "second@example.test",
        calendarId: "calendar",
      },
    });
    const store = createOrganizedInvitationStore(db);
    const responseInput = {
      seriesId: secondSeries.id,
      userId: "second",
      revision: secondSeries.revision,
      sequence: secondSeries.sequence,
      occurrence: "master",
      timestamp: 100,
      partstat: "ACCEPTED",
    };
    expect(
      await store.response({
        ...responseInput,
        attendee: "alice@example.test",
      }),
    ).toBe("applied");
    expect(
      await store.response({ ...responseInput, attendee: "bob@example.test" }),
    ).toBe("retry");
    const refreshed = await db.organizedSeries.findUniqueOrThrow({
      where: { id: secondSeries.id },
    });
    expect(
      await store.response({
        ...responseInput,
        revision: refreshed.revision,
        attendee: "bob@example.test",
      }),
    ).toBe("applied");
    const time = new Date(Date.now() + 1000);
    const records = Array.from({ length: 61 }, (_, index) => ({
      id: randomUUID(),
      destination: index === 60 ? "second-account" : accountId,
    }));
    const old = { id: randomUUID(), destination: "second-account" };
    await db.inboundMessage.createMany({
      data: [
        ...records.map(({ id }) => ({
          id,
          bucket: "fixture",
          objectKey: id,
          notification: {},
          receivedAt: time,
        })),
        {
          id: old.id,
          bucket: "fixture",
          objectKey: old.id,
          notification: {},
          receivedAt: new Date(time.getTime() - 86_400_000),
        },
      ],
    });
    await db.inboundRecipient.createMany({
      data: [...records, old].map(({ id, destination }) => ({
        idempotencyKey: id,
        messageId: id,
        destination,
        addresses: [],
        state: "imported",
        remoteId: id,
        updatedAt: id === old.id ? new Date(time.getTime() - 86_400_000) : time,
      })),
    });
    const candidates = await scans.candidates();
    expect(candidates).toHaveLength(50);
    expect(
      candidates.some(
        (item) =>
          item.userId === "second" && item.messageId === records[60]?.id,
      ),
    ).toBe(true);
    expect(candidates.some((item) => item.messageId === old.id)).toBe(false);
  }, 120_000);
  it("retries a submission known to have failed before the request", async () => {
    const flaky = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const realSubmit = flaky.submit.bind(flaky);
    let submissions = 0;
    flaky.submit = async (...args) => {
      submissions += 1;
      return submissions === 1
        ? err({
            kind: "network",
            message: "connection refused",
            beforeRequest: true,
          })
        : realSubmit(...args);
    };
    const recovering = createOrganizerService({
      origin: base,
      store: credentialStore,
      client: () => flaky,
      organized: createOrganizedInvitationStore(db),
      intentions: createInvitationStore(db),
      protocol: invitationProtocol,
      organizerProtocol,
    });
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const input = {
      accountId: "default",
      requestId: randomUUID(),
      eventId: null,
      organizer: actor.email,
      attendees: ["bob@example.test"],
      cancel: false,
      event: {
        calendarId,
        title: "Refused",
        description: "",
        location: "",
        start: "2026-11-13T10:00:00.000Z",
        end: "2026-11-13T11:00:00.000Z",
        allDay: false,
        timeZone: "UTC",
        recurrence: "none" as const,
      },
    };
    expect(unwrap(await recovering.organize(actor, input)).state).toBe(
      "pending",
    );
    const operation = await db.organizedOperation.findUniqueOrThrow({
      where: { id: input.requestId },
      include: { deliveries: true },
    });
    expect(operation.deliveries[0]?.phase).toBe("prepared");
    expect(
      unwrap(await recovering.reconcile(actor, "default", input.requestId))
        .state,
    ).toBe("sent");
    expect(submissions).toBe(2);
  }, 120_000);
  it("releases a reserved update when the external calendar changes before any write", async () => {
    const calendarId = unwrap(await calendar.calendars(actor, "default"))
      .calendars[0]?.id;
    if (!calendarId) throw new Error("Missing calendar");
    const event = {
      calendarId,
      title: "Reserved",
      description: "Original",
      location: "",
      start: "2026-11-14T10:00:00.000Z",
      end: "2026-11-14T11:00:00.000Z",
      allDay: false,
      timeZone: "UTC",
      recurrence: "none" as const,
    };
    const input = {
      accountId: "default",
      requestId: randomUUID(),
      eventId: null,
      organizer: actor.email,
      attendees: [],
      cancel: false,
      event,
    };
    const created = unwrap(await service.organize(actor, input));
    const eventId = created.eventId ?? "";
    expect(created.state).toBe("sent");
    const flaky = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const realCalendars = flaky.calendars.bind(flaky);
    let calls = 0;
    flaky.calendars = async (...args) => {
      calls += 1;
      return calls === 2
        ? err({ kind: "network", message: "temporary read failure" })
        : realCalendars(...args);
    };
    const recovering = createOrganizerService({
      origin: base,
      store: credentialStore,
      client: () => flaky,
      organized: createOrganizedInvitationStore(db),
      intentions: createInvitationStore(db),
      protocol: invitationProtocol,
      organizerProtocol,
    });
    const edit = {
      ...input,
      requestId: randomUUID(),
      eventId,
      event: { ...event, title: "Updated" },
    };
    expect(unwrap(await recovering.organize(actor, edit)).state).toBe(
      "pending",
    );
    const session = unwrap(await client.discover());
    const accountId = session.primaryAccounts[JmapCapability.calendars] ?? "";
    unwrap(
      await client.updateCalendarEvent(session, accountId, eventId, {
        description: "Changed externally",
      }),
    );
    expect(
      unwrap(await recovering.reconcile(actor, "default", edit.requestId))
        .state,
    ).toBe("failed");
    const operation = await db.organizedOperation.findUniqueOrThrow({
      where: { id: edit.requestId },
      include: { series: true },
    });
    expect(operation.series.pendingId).toBeNull();
    expect(
      unwrap(
        await service.organize(actor, { ...edit, requestId: randomUUID() }),
      ).state,
    ).toBe("sent");
  }, 120_000);
});
