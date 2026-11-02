import { describe, expect, it } from "vitest";
import {
  parseInvitation,
  parseInvitationReply,
} from "../src/adapters/invitations.ts";

const response = (
  changes: {
    from?: string;
    attendee?: string;
    extra?: string;
    method?: string;
  } = {},
) => {
  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${changes.method ?? "REPLY"}`,
    "BEGIN:VEVENT",
    "UID:example-uid",
    "SEQUENCE:3",
    "DTSTAMP:20261102T100000Z",
    "RECURRENCE-ID:20261109T100000Z",
    "ORGANIZER:mailto:organizer@example.test",
    `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${changes.attendee ?? "alice@example.test"}`,
    ...(changes.extra ? [changes.extra] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return Buffer.from(
    [
      `From: ${changes.from ?? "alice@example.test"}`,
      "To: organizer@example.test",
      "DKIM-Signature: v=1; d=example.test; s=fixture; b=fixture",
      "MIME-Version: 1.0",
      `Content-Type: text/calendar; method=${changes.method ?? "REPLY"}; charset=utf-8`,
      "",
      calendar,
      "",
    ].join("\r\n"),
  );
};

describe("attendee response parsing", () => {
  it("parses a single recurrence response while retaining sender evidence", async () => {
    const result = await parseInvitationReply(response());
    expect(result).toMatchObject({
      event: {
        uid: "example-uid",
        sequence: 3,
        organizer: { email: "organizer@example.test" },
        attendees: [{ email: "alice@example.test", partstat: "ACCEPTED" }],
      },
      from: ["alice@example.test"],
      signingDomains: ["example.test"],
      occurrence: `instant:${Date.parse("2026-11-09T10:00:00Z")}`,
    });
    await expect(parseInvitation(response())).rejects.toThrow(
      "Unsupported calendar method",
    );
  });
  it("rejects ambiguous and unsupported response data", async () => {
    await Promise.all(
      [
        "ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.test",
        "UID:another",
        "DTSTAMP:20261102T110000Z",
      ].map((extra) =>
        expect(parseInvitationReply(response({ extra }))).rejects.toThrow(
          "Invalid response",
        ),
      ),
    );
    await expect(
      parseInvitationReply(response({ method: "REQUEST" })),
    ).rejects.toThrow("Unsupported calendar method");
  });
});

describe("organizer calendar messages", () => {
  it("allows the organizer as an attendee without sending a self invitation", async () => {
    const { prepareOrganizedCalendar, organizedAttendees } =
      await import("../src/adapters/invitations/organize.ts");
    const result = prepareOrganizedCalendar({
      previous: null,
      uid: "self-uid",
      organizer: "owner@example.test",
      attendees: [
        "owner@example.test",
        "alice@example.test",
        "bob@example.test",
        "eve@example.test",
      ],
      sequence: 0,
      cancelled: false,
      now: new Date("2026-11-02T10:00:00Z"),
      changes: {
        title: true,
        description: true,
        location: true,
        time: true,
        recurrence: true,
      },
      event: {
        calendarId: "calendar",
        title: "Meeting",
        description: "",
        location: "",
        start: "2026-11-09T10:00:00Z",
        end: "2026-11-09T11:00:00Z",
        allDay: false,
        timeZone: "UTC",
        recurrence: "none",
      },
    });
    expect(result.deliveries.map((item) => item.recipient)).toEqual([
      "alice@example.test",
      "bob@example.test",
      "eve@example.test",
    ]);
    for (const item of result.deliveries) {
      for (const other of [
        "alice@example.test",
        "bob@example.test",
        "eve@example.test",
      ].filter((address) => address !== item.recipient))
        expect(item.calendar).not.toContain(`mailto:${other}`);
    }
    expect(organizedAttendees(result.calendar)).toContainEqual({
      email: "owner@example.test",
      partstat: "ACCEPTED",
    });
  });
  it("keeps unexposed properties and exceptions while isolating recipients", async () => {
    const { prepareOrganizedCalendar } =
      await import("../src/adapters/invitations/organize.ts");
    const previous = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:uid",
      "SEQUENCE:1",
      "DTSTAMP:20261101T100000Z",
      "DTSTART:20261109T100000Z",
      "DTEND:20261109T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "ORGANIZER:mailto:owner@example.test",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:old@example.test",
      "ATTENDEE:mailto:old2@example.test",
      "ATTENDEE:mailto:old3@example.test",
      "X-PRIVATE:preserved",
      "ATTACH:https://example.test/private-file",
      "SUMMARY:Old",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "DESCRIPTION:Private reminder",
      "END:VALARM",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:uid",
      "SEQUENCE:1",
      "RECURRENCE-ID:20261116T100000Z",
      "DTSTAMP:20261101T100000Z",
      "DTSTART:20261116T120000Z",
      "DTEND:20261116T130000Z",
      "ORGANIZER:mailto:owner@example.test",
      "ATTENDEE:mailto:old@example.test",
      "X-EXCEPTION:preserved",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = prepareOrganizedCalendar({
      previous,
      uid: "uid",
      organizer: "owner@example.test",
      attendees: ["new@example.test"],
      sequence: 2,
      cancelled: false,
      now: new Date("2026-11-02T10:00:00Z"),
      changes: {
        title: true,
        description: false,
        location: false,
        time: false,
        recurrence: false,
      },
      event: {
        calendarId: "calendar",
        title: "New",
        description: "",
        location: "",
        start: "2026-11-09T10:00:00Z",
        end: "2026-11-09T11:00:00Z",
        allDay: false,
        timeZone: "UTC",
        recurrence: "weekly",
      },
    });
    expect(result.calendar).toContain("X-PRIVATE:preserved");
    expect(result.calendar).toContain("X-EXCEPTION:preserved");
    expect(result.calendar).toContain("RRULE:FREQ=WEEKLY;COUNT=4");
    expect(result.calendar).toContain("RECURRENCE-ID:20261116T100000Z");
    const { hasOrganizedOccurrence } =
      await import("../src/adapters/invitations/organize.ts");
    expect(
      hasOrganizedOccurrence(
        result.calendar,
        `instant:${Date.parse("2026-11-23T10:00:00Z")}`,
      ),
    ).toBe(true);
    expect(
      hasOrganizedOccurrence(
        result.calendar,
        `instant:${Date.parse("2026-12-23T10:00:00Z")}`,
      ),
    ).toBe(false);
    const request = result.deliveries.find((item) => item.method === "REQUEST");
    const cancel = result.deliveries.find((item) => item.method === "CANCEL");
    expect(
      result.deliveries.filter((item) => item.method === "CANCEL"),
    ).toHaveLength(3);
    expect(result.calendar).not.toContain("old2@example.test");
    expect(result.calendar).not.toContain("old3@example.test");
    expect(request?.recipient).toBe("new@example.test");
    expect(request?.calendar).not.toContain("old@example.test");
    expect(result.calendar).toContain("BEGIN:VALARM");
    expect(result.calendar).toContain(
      "ATTACH:https://example.test/private-file",
    );
    expect(request?.calendar).not.toContain("BEGIN:VALARM");
    expect(request?.calendar).not.toContain("ATTACH:");
    expect(request?.calendar).not.toContain("X-PRIVATE");
    expect(request?.calendar).not.toContain("X-EXCEPTION");
    expect(cancel?.recipient).toBe("old@example.test");
    expect(cancel?.calendar).not.toContain("new@example.test");
    expect(cancel?.calendar).toContain("METHOD:CANCEL");
    expect(cancel?.calendar).toContain("SEQUENCE:2");
  });
});

describe("organizer rebase", () => {
  it("accepts local description edits but refuses attendee status changes", async () => {
    const { rebaseOrganized } =
      await import("../src/adapters/invitations/organizer-rebase.ts");
    const original = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:uid",
      "SEQUENCE:1",
      "DTSTART:20261109T100000Z",
      "DTEND:20261109T110000Z",
      "ORGANIZER:mailto:owner@example.test",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alice@example.test",
      "DESCRIPTION:Before",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(
      rebaseOrganized(
        original,
        original.replace("DESCRIPTION:Before", "DESCRIPTION:After"),
        "uid",
        "owner@example.test",
        false,
      ),
    ).toBe(1);
    expect(() =>
      rebaseOrganized(
        original,
        original.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"),
        "uid",
        "owner@example.test",
        false,
      ),
    ).toThrow("Conflicting series edit");
    const { restoreOrganizerParticipants } =
      await import("../src/adapters/invitations/organizer-rebase.ts");
    const altered = original.replace(
      "PARTSTAT=NEEDS-ACTION",
      "PARTSTAT=ACCEPTED",
    );
    expect(
      rebaseOrganized(original, altered, "uid", "owner@example.test", true),
    ).toBe(1);
    expect(restoreOrganizerParticipants(original, altered)).toContain(
      "PARTSTAT=NEEDS-ACTION",
    );
    expect(() =>
      rebaseOrganized(
        original,
        original.replace(
          "DTSTART:20261109T100000Z",
          "DTSTART:20261109T120000Z",
        ),
        "uid",
        "owner@example.test",
        false,
      ),
    ).toThrow("Conflicting series edit");
    expect(
      rebaseOrganized(
        original,
        original.replace(
          "DTSTART:20261109T100000Z",
          "DTSTART:20261109T120000Z",
        ),
        "uid",
        "owner@example.test",
        true,
      ),
    ).toBe(1);
  });
});
