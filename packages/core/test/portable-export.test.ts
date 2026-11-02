import { simpleParser } from "mailparser";
import { fetchCalendarObjects, fetchCalendars } from "tsdav";
import type * as TSDav from "tsdav";
import { expect, it, vi } from "vitest";
import { mboxMessage } from "../src/adapters/portable-export.ts";
import { splitMbox } from "../src/adapters/migration-mail.ts";

vi.mock("tsdav", async (original) => ({
  ...(await original<typeof TSDav>()),
  fetchCalendars: vi.fn<typeof fetchCalendars>(),
  fetchCalendarObjects: vi.fn<typeof fetchCalendarObjects>(),
}));

const object = (uid: string, offset: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fixture//EN",
    "BEGIN:VTIMEZONE",
    "TZID:Example/Local",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTART;TZID=Example/Local:20261102T100000",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "EXDATE;TZID=Example/Local:20261116T100000",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "RECURRENCE-ID;TZID=Example/Local:20261109T100000",
    "DTSTART;TZID=Example/Local:20261109T120000",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

it("preserves events and references when calendar time-zone definitions conflict", async () => {
  const ICAL = (await import("ical.js")).default;
  const { exportCalendars } =
    await import("../src/adapters/portable-export.ts");
  vi.mocked(fetchCalendars).mockResolvedValue([
    { url: "https://mail.example.test/dav/cal/a/cal/" },
  ]);
  vi.mocked(fetchCalendarObjects).mockResolvedValue([
    { url: "a.ics", data: object("first", "+0100") },
    { url: "b.ics", data: object("second", "+0200") },
    { url: "bad.ics", data: "not a calendar" },
  ]);
  const result = await exportCalendars({
    origin: "https://mail.example.test",
    address: "a@example.test",
    secret: "fixture",
  });
  expect(result.exported).toBe(2);
  expect(result.failures).toHaveLength(1);
  expect(result.warnings).toContain(
    "Conflicting time-zone identifiers were renamed to preserve their definitions.",
  );
  expect(result.warnings).toContain(
    "Calendar names, colours and membership are not retained in the combined file.",
  );
  const parsed = ICAL.Component.fromString(result.root.toString());
  const zones = parsed.getAllSubcomponents("vtimezone");
  expect(zones).toHaveLength(2);
  const zoneOffsets = new Map(
    zones.map((zone) => [
      zone.getFirstPropertyValue("tzid"),
      zone
        .getFirstSubcomponent("standard")
        ?.getFirstPropertyValue("tzoffsetto")
        ?.toString(),
    ]),
  );
  const events = parsed.getAllSubcomponents("vevent");
  expect(events).toHaveLength(4);
  for (const [uid, offset] of [
    ["first", "+01:00"],
    ["second", "+02:00"],
  ]) {
    const matching = events.filter(
      (event) => event.getFirstPropertyValue("uid") === uid,
    );
    expect(matching).toHaveLength(2);
    const master = matching.find(
      (event) => !event.hasProperty("recurrence-id"),
    );
    const exception = matching.find((event) =>
      event.hasProperty("recurrence-id"),
    );
    const tzid = master?.getFirstProperty("dtstart")?.getParameter("tzid");
    if (typeof tzid !== "string") throw new Error("Missing time zone");
    expect(zoneOffsets.get(tzid)).toBe(offset);
    expect(master?.getFirstProperty("exdate")?.getParameter("tzid")).toBe(tzid);
    expect(
      exception?.getFirstProperty("recurrence-id")?.getParameter("tzid"),
    ).toBe(tzid);
    expect(exception?.getFirstProperty("dtstart")?.getParameter("tzid")).toBe(
      tzid,
    );
  }
});

it("reuses conflicting zone definitions across many calendar objects", async () => {
  const ICAL = (await import("ical.js")).default;
  const { exportCalendars } =
    await import("../src/adapters/portable-export.ts");
  vi.mocked(fetchCalendars).mockResolvedValue([
    { url: "https://mail.example.test/dav/cal/a/cal/" },
  ]);
  const collect = async (count: number) => {
    vi.mocked(fetchCalendarObjects).mockResolvedValue([
      { url: "original.ics", data: object("original", "+0100") },
      ...Array.from({ length: count }, (_, i) => ({
        url: `copy-${i}.ics`,
        data: object(`copy-${i}`, i % 2 === 0 ? "+0200" : "+0300"),
      })),
    ]);
    return exportCalendars({
      origin: "https://mail.example.test",
      address: "a@example.test",
      secret: "fixture",
    });
  };
  const small = await collect(100);
  const large = await collect(600);
  expect(large.failures).toEqual([]);
  expect(large.exported).toBe(601);
  const smallText = small.root.toString();
  const largeText = large.root.toString();
  expect(largeText.length).toBeLessThan(smallText.length * 7);
  const parsed = ICAL.Component.fromString(largeText);
  const zones = parsed.getAllSubcomponents("vtimezone");
  expect(zones).toHaveLength(3);
  const offsets = new Map(
    zones.map((zone) => [
      String(zone.getFirstPropertyValue("tzid")),
      zone
        .getFirstSubcomponent("standard")
        ?.getFirstPropertyValue("tzoffsetto")
        ?.toString(),
    ]),
  );
  const events = parsed.getAllSubcomponents("vevent");
  expect(events).toHaveLength(1202);
  for (const event of events) {
    const uid = String(event.getFirstPropertyValue("uid"));
    const expected =
      uid === "original"
        ? "+01:00"
        : Number(uid.slice(5)) % 2 === 0
          ? "+02:00"
          : "+03:00";
    const tzid = event.getFirstProperty("dtstart")?.getParameter("tzid");
    if (typeof tzid !== "string") throw new Error("Missing time zone");
    expect(tzid.length).toBeLessThan(100);
    expect(offsets.get(tzid)).toBe(expected);
    const references = ["exdate", "recurrence-id"].flatMap((property) =>
      event.getAllProperties(property),
    );
    expect(
      references.map((reference) => reference.getParameter("tzid")),
    ).toEqual([tzid]);
  }
});

it("keeps zone references distinct when an input uses a generated identifier", async () => {
  const ICAL = (await import("ical.js")).default;
  const { exportCalendars } =
    await import("../src/adapters/portable-export.ts");
  const options = {
    origin: "https://mail.example.test",
    address: "a@example.test",
    secret: "fixture",
  };
  vi.mocked(fetchCalendars).mockResolvedValue([
    { url: "https://mail.example.test/dav/cal/a/cal/" },
  ]);
  const initial = [
    { url: "original.ics", data: object("original", "+0100") },
    { url: "conflict.ics", data: object("conflict", "+0200") },
  ];
  vi.mocked(fetchCalendarObjects).mockResolvedValue(initial);
  const first = await exportCalendars(options);
  const renamed = first.root
    .getAllSubcomponents("vtimezone")
    .map((zone) => String(zone.getFirstPropertyValue("tzid")))
    .find((id) => id !== "Example/Local");
  if (!renamed) throw new Error("Missing renamed time zone");
  const source = ICAL.Component.fromString(object("reuse", "+0200"));
  const other = ICAL.Component.fromString(object("collision", "+0300"));
  const otherZone = other.getFirstSubcomponent("vtimezone");
  if (!otherZone) throw new Error("Missing time zone");
  otherZone.updatePropertyWithValue("tzid", renamed);
  source.addSubcomponent(otherZone);
  for (const event of other.getAllSubcomponents("vevent")) {
    for (const name of ["dtstart", "exdate", "recurrence-id"])
      for (const property of event.getAllProperties(name))
        property.setParameter("tzid", renamed);
    source.addSubcomponent(event);
  }
  vi.mocked(fetchCalendarObjects).mockResolvedValue([
    ...initial,
    { url: "both.ics", data: source.toString() },
  ]);
  const result = await exportCalendars(options);
  expect(result.failures).toEqual([]);
  const parsed = ICAL.Component.fromString(result.root.toString());
  const offsets = new Map(
    parsed
      .getAllSubcomponents("vtimezone")
      .map((zone) => [
        String(zone.getFirstPropertyValue("tzid")),
        zone
          .getFirstSubcomponent("standard")
          ?.getFirstPropertyValue("tzoffsetto")
          ?.toString(),
      ]),
  );
  expect(offsets.size).toBe(3);
  for (const [uid, expected] of [
    ["reuse", "+02:00"],
    ["collision", "+03:00"],
  ]) {
    const events = parsed
      .getAllSubcomponents("vevent")
      .filter((event) => event.getFirstPropertyValue("uid") === uid);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const tzid = event.getFirstProperty("dtstart")?.getParameter("tzid");
      if (typeof tzid !== "string") throw new Error("Missing time zone");
      expect(offsets.get(tzid)).toBe(expected);
      const references = ["exdate", "recurrence-id"].flatMap((name) =>
        event.getAllProperties(name),
      );
      expect(
        references.map((reference) => reference.getParameter("tzid")),
      ).toEqual([tzid]);
    }
  }
});

it("quotes mboxrd lines reversibly and produces independently readable mail", async () => {
  const raw = Buffer.from(
    "From: a@example.test\r\nTo: b@example.test\r\nSubject: Test\r\n\r\nFrom one\r\n>From two\r\nBinary: \xff\rFrom not-a-new-line\r\n",
    "latin1",
  );
  const framed = mboxMessage(raw);
  expect(framed.toString("latin1")).toContain(">From one\r\n>>From two");
  async function* source() {
    yield await Promise.resolve(framed);
  }
  const messages = [];
  for await (const message of splitMbox(source(), {
    variant: "mboxrd",
    maxMessageBytes: 100_000,
    maxArchiveBytes: 100_000,
  }))
    messages.push(message);
  expect(messages[0]?.subarray(0, raw.length)).toEqual(raw);
  const first = messages[0];
  if (!first) throw new Error("Missing message");
  expect((await simpleParser(first)).subject).toBe("Test");
});

it("stops a blob read at the byte limit even without a length header", async () => {
  const { JmapClient } = await import("@opensuite/jmap");
  let cancelled = false;
  const fetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(5));
            controller.enqueue(new Uint8Array(5));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
  const client = new JmapClient("https://mail.example.test", {
    authorization: "Basic fixture",
    fetch: fetcher,
  });
  const session = {
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
    username: "fixture",
    apiUrl: "https://mail.example.test/api",
    downloadUrl: "https://mail.example.test/{accountId}/{blobId}",
    uploadUrl: "https://mail.example.test/upload",
    state: "state",
  };
  const result = await client.portableBlob(session, "account", "blob", 6);
  expect(result.isErr()).toBe(true);
  expect(cancelled).toBe(true);
});

it("adds a standard recurrence only when the complete rule is supported", async () => {
  const ICAL = (await import("ical.js")).default;
  const { addCalendarRules } =
    await import("../src/adapters/portable-export.ts");
  const root = ICAL.Component.fromString(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261014T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  expect(
    addCalendarRules(root, "series", [
      {
        "@type": "RecurrenceRule",
        frequency: "weekly",
        interval: 2,
        byDay: [{ day: "we" }],
      },
    ]),
  ).toBe(true);
  const parsed = ICAL.Component.fromString(root.toString());
  expect(
    parsed
      .getFirstSubcomponent("vevent")
      ?.getFirstProperty("rrule")
      ?.getFirstValue()
      ?.toString(),
  ).toContain("FREQ=WEEKLY");
  const unsupported = ICAL.Component.fromString(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261014T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  expect(
    addCalendarRules(unsupported, "series", [
      { frequency: "weekly", skip: "forward" },
    ]),
  ).toBe(false);
  expect(
    unsupported.getFirstSubcomponent("vevent")?.getFirstProperty("rrule"),
  ).toBeNull();
});

it("exports a supported excluded occurrence as a zoned EXDATE", async () => {
  const ICAL = (await import("ical.js")).default;
  const { addCalendarExclusion } =
    await import("../src/adapters/portable-export.ts");
  const root = ICAL.Component.fromString(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART;TZID=Europe/Paris:20261014T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  expect(
    addCalendarExclusion(root, "series", "2026-10-21T10:00:00", {
      excluded: true,
    }),
  ).toBe(true);
  const parsed = ICAL.Component.fromString(root.toString());
  const exdate = parsed
    .getFirstSubcomponent("vevent")
    ?.getFirstProperty("exdate");
  expect(exdate?.getParameter("tzid")).toBe("Europe/Paris");
  expect(exdate?.getFirstValue()?.toString()).toBe("2026-10-21T10:00:00");
  expect(
    addCalendarExclusion(root, "series", "2026-10-28T10:00:00", {
      title: "Changed",
    }),
  ).toBe(false);
});

it("bounds an oversized upstream error body", async () => {
  const { JmapClient } = await import("@opensuite/jmap");
  let cancelled = false;
  const fetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(40_000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 502 },
      ),
    );
  const client = new JmapClient("https://mail.example.test", {
    authorization: "Basic fixture",
    fetch: fetcher,
  });
  const session = {
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
    username: "fixture",
    apiUrl: "https://mail.example.test/api",
    downloadUrl: "https://mail.example.test/{accountId}/{blobId}",
    uploadUrl: "https://mail.example.test/upload",
    state: "state",
  };
  const result = await client.portableBlob(session, "account", "blob", 6);
  expect(result.isErr() && result.error.kind).toBe("http");
  if (result.isOk() || result.error.kind !== "http")
    throw new Error("Expected HTTP error");
  expect(result.error.body).toBe("");
  expect(cancelled).toBe(true);
});

it("reports a bounded set of calendar warnings without failing a large export", async () => {
  const { ok } = await import("neverthrow");
  const { createPortableExportService } =
    await import("../src/services/portable-export.ts");
  const { JmapClient } = await import("@opensuite/jmap");
  const { z } = await import("zod");
  const events = Array.from({ length: 600 }, (_, index) => ({
    id: `id${String(index)}`,
    uid: `uid${String(index)}`,
    isOrigin: true,
    version: 1,
    priority: 0,
    customA: "one",
    customB: "two",
    ...(index === 0
      ? {
          recurrenceOverrides: {
            "2026-11-09T00:00:00": { title: "Moved" },
            "2026-11-16T00:00:00": { excluded: true },
          },
        }
      : {}),
  }));
  const session = {
    capabilities: {},
    accounts: {},
    primaryAccounts: { "urn:ietf:params:jmap:calendars": "calendar" },
    username: "fixture",
    apiUrl: "https://mail.example.test/api",
    downloadUrl: "https://mail.example.test/{accountId}/{blobId}",
    uploadUrl: "https://mail.example.test/upload",
    state: "state",
  };
  const fetcher: typeof fetch = (url, init) => {
    const target =
      url instanceof Request ? url.url : url instanceof URL ? url.href : url;
    if (target.endsWith("/.well-known/jmap"))
      return Promise.resolve(Response.json(session));
    if (typeof init?.body !== "string") throw new Error("Missing request body");
    const body = z
      .object({
        methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      })
      .parse(JSON.parse(init.body));
    const { position } = z
      .object({ position: z.number() })
      .parse(body.methodCalls[0]?.[1]);
    const list = events.slice(position, position + 50);
    return Promise.resolve(
      Response.json({
        sessionState: "state",
        methodResponses: [
          [
            "CalendarEvent/query",
            {
              accountId: "calendar",
              ids: list.map((event) => event.id),
              queryState: "q",
            },
            "query",
          ],
          [
            "CalendarEvent/get",
            { accountId: "calendar", list, state: "s", notFound: [] },
            "events",
          ],
        ],
      }),
    );
  };
  const fields = new Map(events.map((event) => [event.uid, new Set<string>()]));
  fields.get("uid0")?.add("all-day");
  fields.get("uid0")?.add("recurrence-id");
  fields.get("uid0")?.add("exdate");
  const service = createPortableExportService({
    origin: "https://mail.example.test",
    store: {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "account",
            address: "a@example.test",
            secret: "fixture",
          }),
        ),
    },
    client: () =>
      new JmapClient("https://mail.example.test", {
        authorization: "Basic fixture",
        fetch: fetcher,
      }),
    tools: {
      calendars: () =>
        Promise.resolve({
          root: {},
          fields,
          occurrences: new Map([
            ["uid0", new Set(["2026-11-09", "2026-11-16"])],
          ]),
          warnings: [],
          failures: [],
          exported: events.length,
        }),
      addRules: () => false,
      addExclusion: () => false,
      serialize: () => Buffer.from("fixture"),
      mboxMessage: (value) => value,
    },
  });
  const result = await service.export(
    { id: "owner", email: "a@example.test", role: "user" },
    { format: "ics", accountId: "default" },
  );
  if (result.isErr()) throw new Error(result.error.kind);
  expect(result.value.exported).toBe(600);
  expect(result.value.warnings).toHaveLength(1001);
  expect(result.value.warnings.at(-1)).toContain(
    "Additional warnings were omitted",
  );
  expect(
    result.value.warnings.some((warning) =>
      /isOrigin|version|priority|recurrence exception is not represented/.test(
        warning,
      ),
    ),
  ).toBe(false);
});

it("retains typed JMAP method errors for portable export operations", async () => {
  const { JmapClient } = await import("@opensuite/jmap");
  const session = {
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
    username: "fixture",
    apiUrl: "https://mail.example.test/api",
    downloadUrl: "https://mail.example.test/{accountId}/{blobId}",
    uploadUrl: "https://mail.example.test/upload",
    state: "state",
  };
  const single = new JmapClient("https://mail.example.test", {
    authorization: "Basic fixture",
    fetch: () =>
      Promise.resolve(
        Response.json({
          sessionState: "s",
          methodResponses: [["error", { type: "invalidArguments" }, "0"]],
        }),
      ),
  });
  const metadata = await single.portableMetadata(session, "account", ["id"]);
  expect(metadata.isErr() && metadata.error).toMatchObject({
    kind: "method",
    method: "Email/get",
    type: "invalidArguments",
  });
  const pages = new JmapClient("https://mail.example.test", {
    authorization: "Basic fixture",
    fetch: () =>
      Promise.resolve(
        Response.json({
          sessionState: "s",
          methodResponses: [
            ["error", { type: "stateMismatch" }, "query"],
            ["error", { type: "stateMismatch" }, "events"],
          ],
        }),
      ),
  });
  const calendar = await pages.portableCalendarPage(session, "account", 0);
  expect(calendar.isErr() && calendar.error).toMatchObject({
    kind: "method",
    method: "CalendarEvent/query",
    type: "stateMismatch",
  });
});
