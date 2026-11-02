import { portableExportTools } from "@opensuite/core/adapters/portable-export";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import ICAL from "ical.js";
import { simpleParser } from "mailparser";
import { fetchCalendars } from "tsdav";
import { JmapClient, JmapCapability } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCalendarService } from "../src/services/calendar.ts";
import { createPortableExportService } from "../src/services/portable-export.ts";
import { splitMbox } from "../src/adapters/migration-mail.ts";

const run = promisify(execFile);
const project = `portable-export-${randomBytes(6).toString("hex")}`;
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
        ...args,
      ],
      { cwd: new URL("../../../", import.meta.url), maxBuffer: 4_000_000 },
    )
  ).stdout;
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user",
} as const;
const password = "portable-fixture-password-1234";
const value = <T, E>(result: Result<T, E>) =>
  result.match(
    (v) => v,
    () => {
      throw new Error("Fixture failed");
    },
  );
let base = "";
let account = "";
let otherAccount = "";
let client: JmapClient;
let service: ReturnType<typeof createPortableExportService>;
let calendar: ReturnType<typeof createCalendarService>;
const store = {
  getForOwner: (user: string, id: string) =>
    Promise.resolve(
      user === actor.id && (id === "default" || id === account)
        ? ok({ accountId: account, address: actor.email, secret: password })
        : err({ kind: "not_found" }),
    ),
};
const ready = async (attempts: number): Promise<void> => {
  if (
    await fetch(`${base}/healthz/ready`)
      .then((r) => r.ok)
      .catch(() => false)
  )
    return;
  if (!attempts) throw new Error("Stalwart did not start");
  await new Promise((resolve) => setTimeout(resolve, 500));
  return ready(attempts - 1);
};
beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    base = `http://127.0.0.1:${port}`;
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = value(await admin.createDomain("example.test"));
    account = value(await admin.createAccount("alice", domain.id, password)).id;
    otherAccount = value(
      await admin.createAccount("bob", domain.id, password),
    ).id;
    const factory = (credential: { address: string; secret: string }) =>
      new JmapClient(base, {
        authorization: `Basic ${Buffer.from(`${credential.address}:${credential.secret}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: base,
      });
    client = factory({ address: actor.email, secret: password });
    service = createPortableExportService({
      tools: portableExportTools,
      origin: base,
      store,
      client: factory,
    });
    calendar = createCalendarService({ origin: base, store, client: factory });
  } catch (error) {
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    throw error;
  }
}, 120_000);
afterAll(async () => {
  await compose("down", "--volumes", "--remove-orphans");
}, 60_000);
it("exports MIME and recurring calendar data from the local server", async () => {
  const session = value(await client.discover());
  const mailAccount = session.primaryAccounts[JmapCapability.mail];
  if (!mailAccount) throw new Error("Missing mail account");
  const inbox = value(await client.mailboxes(session, mailAccount)).list.find(
    (box) => box.role === "inbox",
  );
  if (!inbox) throw new Error("Missing inbox");
  const raw = Buffer.from(
    "From: Alice <alice@example.test>\r\nTo: Bob <bob@example.test>\r\nSubject: Portable\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nFrom a line\r\n",
  );
  const blob = value(await client.upload(session, mailAccount, raw));
  const imported = value(
    await client.importEmail(session, mailAccount, {
      blobId: blob.blobId,
      mailboxIds: { [inbox.id]: true },
    }),
  );
  const eml = value(
    await service.export(actor, {
      format: "eml",
      accountId: "default",
      ids: [imported.id],
    }),
  );
  expect(Buffer.from(eml.content, "base64")).toEqual(raw);
  expect((await simpleParser(Buffer.from(eml.content, "base64"))).subject).toBe(
    "Portable",
  );
  const mbox = value(
    await service.export(actor, {
      format: "mbox",
      accountId: "default",
      ids: [imported.id, "missing"],
    }),
  );
  expect(mbox.failures).toHaveLength(1);
  const missing = value(
    await service.export(actor, {
      format: "eml",
      accountId: "default",
      ids: ["missing"],
    }),
  );
  expect(missing.exported).toBe(0);
  expect(missing.failures).toEqual([
    { id: "missing", reason: "Message not found." },
  ]);
  const restored: Buffer[] = [];
  async function* source() {
    yield await Promise.resolve(Buffer.from(mbox.content, "base64"));
  }
  for await (const message of splitMbox(source(), {
    variant: "mboxrd",
    maxMessageBytes: 1_000_000,
    maxArchiveBytes: 1_000_000,
  }))
    restored.push(message);
  expect(restored[0]?.subarray(0, raw.length)).toEqual(raw);
  const calendars = value(await calendar.calendars(actor, "default")).calendars;
  const calendarId = calendars[0]?.id;
  if (!calendarId) throw new Error("Missing calendar");
  value(
    await calendar.createEvent(actor, "default", {
      calendarId,
      title: "Weekly",
      description: "",
      location: "",
      start: "2026-10-14T08:00:00.000Z",
      end: "2026-10-14T09:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Paris",
      recurrence: "weekly",
    }),
  );
  const authorization = `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`;
  const home = `${base}/dav/cal/${encodeURIComponent(actor.email)}/`;
  const davCalendars = await fetchCalendars({
    account: {
      accountType: "caldav",
      serverUrl: base,
      rootUrl: base,
      homeUrl: home,
    },
    headers: { authorization },
  });
  const davCalendar = davCalendars[0];
  if (!davCalendar) throw new Error("Missing DAV calendar");
  const objectUrl = new URL("exception.ics", davCalendar.url);
  const importedCalendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fixture//EN",
    "BEGIN:VEVENT",
    "UID:exception@example.test",
    "DTSTART:20261102T100000Z",
    "DURATION:PT1H",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "SUMMARY:Original",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:exception@example.test",
    "RECURRENCE-ID:20261109T100000Z",
    "DTSTART:20261109T120000Z",
    "DURATION:PT1H",
    "SUMMARY:Moved",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const put = await fetch(objectUrl, {
    method: "PUT",
    headers: {
      authorization,
      "Content-Type": "text/calendar",
      "If-None-Match": "*",
    },
    body: importedCalendar,
  });
  expect(put.ok).toBe(true);
  const allDayCalendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fixture//EN",
    "BEGIN:VEVENT",
    "UID:all-day-exception@example.test",
    "DTSTART;VALUE=DATE:20261102",
    "DURATION:P1D",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "EXDATE;VALUE=DATE:20261116",
    "SUMMARY:All day",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:all-day-exception@example.test",
    "RECURRENCE-ID;VALUE=DATE:20261109",
    "DTSTART;VALUE=DATE:20261110",
    "DURATION:P1D",
    "SUMMARY:Moved all day",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const allDayPut = await fetch(new URL("all-day.ics", davCalendar.url), {
    method: "PUT",
    headers: {
      authorization,
      "Content-Type": "text/calendar",
      "If-None-Match": "*",
    },
    body: allDayCalendar,
  });
  expect(allDayPut.ok).toBe(true);
  const ics = value(
    await service.export(actor, { format: "ics", accountId: "default" }),
  );
  expect(ics.failures).toEqual([]);
  const root = ICAL.Component.fromString(
    Buffer.from(ics.content, "base64").toString(),
  );
  const event = root
    .getAllSubcomponents("vevent")
    .find((item) => item.getFirstPropertyValue("summary") === "Weekly");
  const allDay = root
    .getAllSubcomponents("vevent")
    .find(
      (item) =>
        item.getFirstPropertyValue("uid") ===
          "all-day-exception@example.test" &&
        !item.hasProperty("recurrence-id"),
    );
  expect(allDay?.getAllProperties("exdate")).toHaveLength(1);
  expect(
    root
      .getAllSubcomponents("vevent")
      .some(
        (item) =>
          item.getFirstPropertyValue("summary") === "Moved all day" &&
          item.hasProperty("recurrence-id"),
      ),
  ).toBe(true);
  expect(
    ics.warnings.some((warning) =>
      warning.includes("recurrence exception is not represented"),
    ),
  ).toBe(false);
  const moved = root
    .getAllSubcomponents("vevent")
    .find((item) => item.getFirstPropertyValue("summary") === "Moved");
  expect(moved?.getFirstProperty("recurrence-id")).toBeTruthy();
  expect(event?.getFirstPropertyValue("uid")).toBeTruthy();
  expect(event?.getFirstProperty("rrule")).toBeTruthy();
  const calendarAccount = session.primaryAccounts[JmapCapability.calendars];
  if (!calendarAccount) throw new Error("Missing calendar account");
  const exportedBlob = value(
    await client.upload(
      session,
      calendarAccount,
      Buffer.from(ics.content, "base64"),
      "text/calendar",
    ),
  );
  const parsed = value(
    await client.parseCalendar(session, calendarAccount, exportedBlob.blobId),
  );
  expect(parsed.notParsable ?? []).toEqual([]);
  const parsedEvents = parsed.parsed?.[exportedBlob.blobId] ?? [];
  expect(
    parsedEvents.some(
      (item) =>
        item["title"] === "Weekly" &&
        Boolean(item["recurrenceRules"] || item["recurrenceRule"]),
    ),
  ).toBe(true);
  expect(
    parsedEvents.some(
      (item) =>
        item["uid"] === "exception@example.test" &&
        Boolean(item["recurrenceOverrides"]),
    ),
  ).toBe(true);
  expect(event?.getFirstProperty("dtstart")?.getParameter("tzid")).toBe(
    "Europe/Paris",
  );
  const denied = await service.export(actor, {
    format: "eml",
    accountId: otherAccount,
    ids: [imported.id],
  });
  expect(denied.isErr() && denied.error.kind).toBe("forbidden");
  expect(
    (
      await service.export(
        { ...actor, id: "bob" },
        { format: "ics", accountId: "default" },
      )
    ).isErr(),
  ).toBe(true);
}, 60_000);
