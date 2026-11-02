import { describe, expect, it } from "vitest";
import {
  calendarIssues,
  applyParsed,
  splitCalendars as parseFiles,
} from "../src/adapters/migration-calendar.ts";
import {
  calendarWriteAccess,
  unsafeSimpleEdit,
} from "../src/domain/calendar-edit.ts";
import { previewCalendarEvent } from "../src/domain/migration-calendar.ts";
import type { CalendarEvent } from "@opensuite/jmap";

const splitCalendars = (...files: Parameters<typeof parseFiles>) => {
  const result = parseFiles(...files);
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
};
const calendar = (events: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${events}END:VCALENDAR\r\n`;
const event = (uid: string, extra = "") =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:20260101\r\nDTEND;VALUE=DATE:20260102\r\nSUMMARY:Title\r\n${extra}END:VEVENT\r\n`;
describe("calendar import preview", () => {
  it("reconciles an uncertain reservation only when the source and event match", () => {
    const identity = { source: "original.ics", eventId: null };
    const existing = {
      id: "existing",
      uid: "u",
      title: "Title",
      calendarIds: { calendar: true },
    };
    expect(
      previewCalendarEvent(
        { uid: "u", title: "Title" },
        [existing],
        identity,
        "calendar",
        "original.ics",
      ),
    ).toMatchObject({ previewState: "duplicate" });
    expect(
      previewCalendarEvent(
        { uid: "u", title: "Changed" },
        [existing],
        identity,
        "calendar",
        "original.ics",
      ),
    ).toMatchObject({ previewState: "conflict" });
    expect(
      previewCalendarEvent(
        { uid: "u", title: "Title" },
        [existing],
        identity,
        "calendar",
        "other.ics",
      ),
    ).toMatchObject({ previewState: "conflict" });
  });
  it("previews a conflicting source even after its imported event was deleted", () => {
    const identity = { source: "original.ics", eventId: "deleted-event" };
    expect(
      previewCalendarEvent({ uid: "u" }, [], identity, "calendar", "other.ics"),
    ).toMatchObject({
      previewState: "conflict",
      previewReason: "UID belongs to a different source",
    });
    expect(
      previewCalendarEvent(
        { uid: "u" },
        [],
        identity,
        "calendar",
        "original.ics",
      ),
    ).toMatchObject({ previewState: "new" });
  });
});
describe("calendar import parsing", () => {
  it("groups exceptions, flags unsupported fields, and keeps invalid entries in the report", () => {
    const source = calendar(
      event("a", "X-EXTRA:hello\r\n") +
        event("a", "RECURRENCE-ID;VALUE=DATE:20260108\r\n") +
        event(""),
    );
    const rows = splitCalendars([{ name: "export.ics", content: source }]);
    expect(rows.map((row) => row.state)).toEqual(["failed", "pending"]);
    expect(rows[0]?.error).toContain("UID");
    expect(rows[1]?.source.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(
      calendarIssues(rows[1]?.source ?? "", {
        uid: "a",
        title: "Title",
        start: "2026-01-01",
        duration: "P1D",
        recurrenceOverrides: {},
      }).join(" "),
    ).toContain("X-EXTRA");
    expect(calendarIssues(rows[1]?.source ?? "", { uid: "a" })).toContain(
      "Verify exception property: SUMMARY",
    );
  });
  it("returns an unavailable error for corrupt stored parsing metadata", () => {
    const row = splitCalendars([
      { name: "fixture.ics", content: calendar(event("a")) },
    ])[0];
    if (!row) throw new Error("Missing row");
    row.issues = "not-json";
    const result = applyParsed(row, [{ uid: "a" }]);
    expect(result.isErr() && result.error.kind).toBe("unavailable");
    expect(row.event).toBeNull();
  });
  it("excludes email alarms and reports them while retaining display alarms", () => {
    const alarms =
      "BEGIN:VALARM\r\nACTION:EMAIL\r\nTRIGGER:-PT1H\r\nATTENDEE:mailto:person@example.test\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n";
    const row = splitCalendars([
      { name: "alarms.ics", content: calendar(event("a", alarms)) },
    ])[0];
    expect(row?.source).not.toContain("ACTION:EMAIL");
    expect(row?.source).toContain("ACTION:DISPLAY");
    expect(row?.issues).toContain("Alarm not imported: EMAIL");
  });
  it("warns when conversion does not retain the source time zone", () => {
    const source = calendar(
      event("zone", "").replace(
        "DTSTART;VALUE=DATE:20260101",
        "DTSTART;TZID=Europe/Lisbon:20260101T090000",
      ),
    );
    expect(
      calendarIssues(source, {
        uid: "zone",
        start: "2026-01-01T09:00:00",
        duration: "PT1H",
        timeZone: null,
      }).join(" "),
    ).toContain("Time zone may not be preserved: Europe/Lisbon");
  });
  it("rejects oversized uploads and too many events, and reports orphan exceptions", () => {
    expect(() =>
      splitCalendars([{ name: "big", content: "a".repeat(750_001) }]),
    ).toThrow("Calendar files exceed the upload limit");
    expect(() =>
      splitCalendars([
        {
          name: "many",
          content: calendar(
            Array.from({ length: 201 }, (_, i) => event(String(i))).join(""),
          ),
        },
      ]),
    ).toThrow("Too many events");
    const longUid = splitCalendars([
      { name: "uid", content: calendar(event("🙂".repeat(300))) },
    ]);
    expect(longUid[0]?.error).toContain("UID");
    expect(() => splitCalendars([{ name: "invalid", content: "x\0" }])).toThrow(
      "invalid characters",
    );
    const zone = `BEGIN:VTIMEZONE\r\nTZID:Custom\r\nX-LARGE:${"x".repeat(30_000)}\r\nEND:VTIMEZONE\r\n`;
    const oversizedShared = splitCalendars([
      {
        name: "zone",
        content: calendar(
          zone +
            Array.from({ length: 80 }, (_, i) => event(String(i))).join(""),
        ),
      },
    ]);
    expect(oversizedShared[0]?.error).toContain("import limit");
    const rows = splitCalendars([
      {
        name: "orphan",
        content: calendar(event("x", "RECURRENCE-ID;VALUE=DATE:20260108\r\n")),
      },
    ]);
    expect(rows[0]?.error).toContain("missing series master");
  });
});
describe("simple calendar editor", () => {
  it("shares target write-rights decisions between editing and imports", () => {
    const calendars = [
      { id: "allowed", myRights: { mayWriteAll: true } },
      { id: "denied", myRights: { mayWriteAll: false } },
    ];
    expect(calendarWriteAccess(calendars, "allowed")).toBe("allowed");
    expect(calendarWriteAccess(calendars, "denied")).toBe("forbidden");
    expect(calendarWriteAccess(calendars, "missing")).toBe("not_found");
  });
  const rich = {
    id: "x",
    calendarIds: { x: true },
    title: "",
    description: "",
    locations: null,
    start: "2026-01-01T00:00:00",
    duration: "PT1H",
    timeZone: "UTC",
    showWithoutTime: false,
    recurrenceRules: [{ frequency: "weekly", count: 3 }],
    excludedRecurrenceRules: null,
    recurrenceOverrides: { "2026-01-08T00:00:00": { title: "Exception" } },
  } satisfies CalendarEvent;
  it("rejects edits which would discard exceptions or complex recurrence but permits unrelated title changes", () => {
    expect(unsafeSimpleEdit(rich, { recurrenceOverrides: null })).toBe(true);
    expect(unsafeSimpleEdit(rich, { recurrenceRules: null })).toBe(true);
    expect(unsafeSimpleEdit(rich, { start: "2026-01-02T00:00:00" })).toBe(true);
    expect(unsafeSimpleEdit(rich, { title: "New title" })).toBe(false);
  });
});
