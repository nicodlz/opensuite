import { describe, expect, it } from "vitest";
import type { Result } from "neverthrow";
import {
  invitationProtocol,
  parseInvitation,
} from "../src/adapters/invitations.ts";
import { alignedSigningDomains } from "../src/domain/invitations/alignment.ts";

const invitation = (
  changes: { method?: string; mimeMethod?: string; calendar?: string } = {},
) => {
  const calendar = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    `METHOD:${changes.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    "UID:google-example@example.test",
    "SEQUENCE:3",
    "DTSTAMP:20261001T100000Z",
    "DTSTART;TZID=Europe/Lisbon:20261102T100000",
    "DTEND;TZID=Europe/Lisbon:20261102T110000",
    "RRULE:FREQ=WEEKLY;COUNT=5",
    "EXDATE;TZID=Europe/Lisbon:20261116T100000",
    "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
    "ATTENDEE;CN=Alice;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@example.test",
    "SUMMARY:Weekly planning",
    "CATEGORIES:Planning,Private",
    "DESCRIPTION:Join https://meet.google.com/abc-defg-hij",
    "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:google-example@example.test",
    "SEQUENCE:3",
    "RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000",
    "DTSTAMP:20261001T100000Z",
    "DTSTART;TZID=Europe/Lisbon:20261109T120000",
    "DTEND;TZID=Europe/Lisbon:20261109T130000",
    "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alice@example.test",
    "SUMMARY:Moved planning",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return Buffer.from(
    [
      "From: Organizer <organizer@example.test>",
      "To: Alice <alice@example.test>",
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="test-boundary"`,
      "",
      "--test-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Invitation",
      "--test-boundary",
      `Content-Type: text/calendar; charset=utf-8; method=${changes.mimeMethod ?? changes.method ?? "REQUEST"}`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(changes.calendar ?? calendar).toString("base64"),
      "--test-boundary--",
      "",
    ].join("\r\n"),
  );
};

describe("invitation MIME parsing", () => {
  it("extracts only unambiguous DKIM signing domains from MIME headers", async () => {
    const withHeaders = (headers: string) =>
      Buffer.from(
        invitation().toString().replace("To: Alice", `${headers}\r\nTo: Alice`),
      );
    expect((await parseInvitation(invitation())).signingDomains).toEqual([]);
    expect(
      (
        await parseInvitation(
          withHeaders(
            "DKIM-Signature: v=1;\r\n d=Calendar.Example.Test; s=test; b=abc",
          ),
        )
      ).signingDomains,
    ).toEqual(["Calendar.Example.Test"]);
    expect(
      (
        await parseInvitation(
          withHeaders("DKIM-Signature: d=example.test; b=x"),
        )
      ).signingDomains,
    ).toEqual(["example.test"]);
    await Promise.all(
      [
        "DKIM-Signature: v=1; d=example.test; d=attacker.test; b=x",
        "DKIM-Signature: v=1; D=example.test; d=attacker.test; b=x",
        "DKIM-Signature: v=1; D=example.test; b=x",
        "DKIM-Signature: v=1; d=example.test; l=0; b=x",
        "Authentication-Results: forged; dkim=pass header.d=example.test",
      ].map(async (header) => {
        expect(
          (await parseInvitation(withHeaders(header))).signingDomains,
        ).toEqual([]);
      }),
    );
    expect(
      (
        await parseInvitation(
          withHeaders(
            "DKIM-Signature: v=1; d=example.test; b=x\r\nDKIM-Signature: v=1; d=attacker.test; b=x",
          ),
        )
      ).signingDomains,
    ).toEqual(["example.test", "attacker.test"]);
  });

  it("uses registrable domains for relaxed signing-domain alignment", () => {
    expect(
      alignedSigningDomains("organizer@example.test", ["example.test"]),
    ).toBe(true);
    expect(
      alignedSigningDomains("organizer@example.test", [
        "calendar.example.test",
      ]),
    ).toBe(true);
    expect(
      alignedSigningDomains("organizer@a.example.co.uk", ["b.example.co.uk"]),
    ).toBe(true);
    expect(
      alignedSigningDomains("organizer@example.test", ["attacker.test"]),
    ).toBe(false);
    expect(
      alignedSigningDomains("organizer@example.test", [
        "example.test",
        "attacker.test",
      ]),
    ).toBe(false);
    expect(alignedSigningDomains("organizer@example.test", [])).toBe(false);
    expect(alignedSigningDomains("organizer@co.uk", ["co.uk"])).toBe(false);
    expect(
      alignedSigningDomains("organizer@one.github.io", ["two.github.io"]),
    ).toBe(false);
    expect(
      alignedSigningDomains("organizer@example.test", [".example.test"]),
    ).toBe(false);
  });

  it("reads a Google-style request and recurrence exception without changing its calendar", async () => {
    const result = await parseInvitation(invitation());
    expect(result.method).toBe("REQUEST");
    expect(result.from).toEqual(["organizer@example.test"]);
    expect(result.recipients).toEqual(["alice@example.test"]);
    expect(result.events[0]).toMatchObject({
      uid: "google-example@example.test",
      sequence: 3,
      organizer: { email: "organizer@example.test", name: "Organizer" },
      attendees: [
        {
          email: "alice@example.test",
          name: "Alice",
          partstat: "NEEDS-ACTION",
        },
      ],
      start: "2026-11-02T10:00:00",
      timeZone: "Europe/Lisbon",
      recurrence: ["FREQ=WEEKLY;COUNT=5"],
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(result.events[1]).toMatchObject({
      recurrenceId: "2026-11-09T10:00:00",
      recurrenceIdTimeZone: "Europe/Lisbon",
      start: "2026-11-09T12:00:00",
      attendees: [{ partstat: "NEEDS-ACTION" }],
    });
    expect(result.calendar).toContain("X-GOOGLE-CONFERENCE:");
    expect(result.calendar).toContain("RECURRENCE-ID");
  });

  it("does not trust an ambiguous From field or multiple organizers", async () => {
    const raw = invitation().toString();
    const duplicateFrom = raw.replace(
      "From: Organizer <organizer@example.test>",
      "From: Organizer <organizer@example.test>\r\nFrom: attacker@example.test",
    );
    expect((await parseInvitation(Buffer.from(duplicateFrom))).from).toEqual(
      [],
    );
    const parsed = await parseInvitation(invitation());
    const duplicateOrganizer = parsed.calendar.replace(
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test\r\nORGANIZER:mailto:attacker@example.test",
    );
    await expect(
      parseInvitation(invitation({ calendar: duplicateOrganizer })),
    ).rejects.toThrow("Invalid invitation organizer");
  });

  it("decodes the declared MIME charset and rejects invalid text", async () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:charset",
      "ORGANIZER;CN=André:mailto:organizer@example.test",
      "ATTENDEE:mailto:alice@example.test",
      "SUMMARY:Réunion",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const raw = Buffer.from(
      [
        "From: organizer@example.test",
        "To: alice@example.test",
        "MIME-Version: 1.0",
        "Content-Type: text/calendar; charset=iso-8859-1; method=REQUEST",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(calendar, "latin1").toString("base64"),
      ].join("\r\n"),
    );
    const decoded = await parseInvitation(raw);
    expect(decoded.events[0]).toMatchObject({
      title: "Réunion",
      organizer: { name: "André" },
    });
    await expect(
      parseInvitation(
        Buffer.from(
          raw.toString().replace("charset=iso-8859-1", "charset=utf-8"),
        ),
      ),
    ).rejects.toThrow("encoded data");
  });

  it("recognizes cancellation and rejects mismatched or unsupported methods", async () => {
    expect(
      (await parseInvitation(invitation({ method: "CANCEL" }))).method,
    ).toBe("CANCEL");
    await expect(
      parseInvitation(invitation({ method: "CANCEL", mimeMethod: "REQUEST" })),
    ).rejects.toThrow("Calendar method mismatch");
    await expect(
      parseInvitation(invitation({ method: "REPLY" })),
    ).rejects.toThrow("Unsupported calendar method");
    await expect(
      parseInvitation(Buffer.from("From: a@example.test\r\n\r\nno invite")),
    ).rejects.toThrow("Expected one calendar part");
  });

  it("does not expose unsafe meeting URLs or allow mixed organizers", async () => {
    const unsafe = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:a",
      "ORGANIZER:mailto:o@example.test",
      "ATTENDEE:mailto:alice@example.test",
      "URL:javascript:alert(1)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(
      (await parseInvitation(invitation({ calendar: unsafe }))).events[0]
        ?.meetingUrl,
    ).toBeNull();
    const mixed = unsafe.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\r\nUID:a\r\nORGANIZER:mailto:other@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    await expect(
      parseInvitation(invitation({ calendar: mixed })),
    ).rejects.toThrow("Inconsistent event identity");
  });
});

describe("invitation replies", () => {
  it("retains organizer and occurrence identity and includes only the responding attendee", async () => {
    const { createInvitationReply } =
      await import("../src/adapters/invitations.ts");
    const parsed = await parseInvitation(invitation());
    const reply = createInvitationReply(
      parsed.calendar,
      "alice@example.test",
      "TENTATIVE",
      "2026-11-09T10:00:00",
      new Date("2026-11-02T10:00:00Z"),
    );
    expect(reply).toContain("METHOD:REPLY");
    expect(reply).toContain(
      "ORGANIZER;CN=Organizer:mailto:organizer@example.test",
    );
    expect(reply).toContain("RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000");
    expect(reply).toContain("PARTSTAT=TENTATIVE");
    expect(reply).toContain("DTSTAMP:20261102T100000Z");
    expect(reply).not.toContain("SUMMARY:");
    expect(() =>
      createInvitationReply(
        parsed.calendar,
        "other@example.test",
        "ACCEPTED",
        null,
        new Date(),
      ),
    ).toThrow("Invalid recipient");
  });
});

describe("invitation revisions", () => {
  it("preserves participation and exceptions across a new organizer revision and rejects stale or conflicting data", async () => {
    const { mergeInvitationCalendar } =
      await import("../src/adapters/invitations.ts");
    const original = await parseInvitation(invitation());
    const accepted = mergeInvitationCalendar(
      null,
      original,
      "alice@example.test",
      { participation: "ACCEPTED", recurrenceId: null },
    );
    expect(accepted).toContain("PARTSTAT=ACCEPTED");
    const updatedRaw = original.calendar
      .replaceAll("SEQUENCE:3", "SEQUENCE:4")
      .replace("SUMMARY:Weekly planning", "SUMMARY:Updated planning")
      .replace("CATEGORIES:Planning,Private\r\n", "")
      .replace("EXDATE;TZID=Europe/Lisbon:20261116T100000\r\n", "");
    const updated = await parseInvitation(invitation({ calendar: updatedRaw }));
    const merged = mergeInvitationCalendar(
      accepted,
      updated,
      "alice@example.test",
    );
    expect(merged).toContain("SUMMARY:Updated planning");
    expect(merged).toContain(
      "RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000",
    );
    expect(merged).toContain("PARTSTAT=ACCEPTED");
    expect(merged).toContain("X-GOOGLE-CONFERENCE");
    expect(merged).toContain("CATEGORIES:Planning,Private");
    expect(merged).toContain("EXDATE;TZID=Europe/Lisbon:20261116T100000");
    expect(() =>
      mergeInvitationCalendar(merged, original, "alice@example.test"),
    ).toThrow("Stale invitation");
    const conflicting = {
      ...updated,
      calendar: updated.calendar.replace(
        "Updated planning",
        "Spoofed planning",
      ),
    };
    expect(() =>
      mergeInvitationCalendar(merged, conflicting, "alice@example.test"),
    ).toThrow("Conflicting invitation");
  });
  it("applies the first series response to its existing exceptions", async () => {
    const { mergeInvitationCalendar } =
      await import("../src/adapters/invitations.ts");
    const initial = await parseInvitation(invitation());
    const accepted = mergeInvitationCalendar(
      null,
      initial,
      "alice@example.test",
      { participation: "ACCEPTED", recurrenceId: null },
    );
    const result = await parseInvitation(
      invitation({
        calendar: accepted.replace(
          "VERSION:2.0",
          "VERSION:2.0\r\nMETHOD:REQUEST",
        ),
      }),
    );
    expect(result.events.map((event) => event.attendees[0]?.partstat)).toEqual([
      "ACCEPTED",
      "ACCEPTED",
    ]);
    const tentativeException = mergeInvitationCalendar(
      accepted,
      initial,
      "alice@example.test",
      { participation: "TENTATIVE", recurrenceId: "2026-11-09T10:00:00" },
    );
    const declineSeries = mergeInvitationCalendar(
      tentativeException,
      initial,
      "alice@example.test",
      { participation: "DECLINED", recurrenceId: null },
    );
    const preserved = await parseInvitation(
      invitation({
        calendar: declineSeries.replace(
          "VERSION:2.0",
          "VERSION:2.0\r\nMETHOD:REQUEST",
        ),
      }),
    );
    expect(
      preserved.events.map((event) => event.attendees[0]?.partstat),
    ).toEqual(["DECLINED", "TENTATIVE"]);
  });

  it("inherits the attendee response when a new recurring exception arrives", async () => {
    const { mergeInvitationCalendar } =
      await import("../src/adapters/invitations.ts");
    const initial = await parseInvitation(invitation());
    const withoutException = initial.calendar.replace(
      /BEGIN:VEVENT\r\nUID:google-example@example.test\r\nSEQUENCE:3\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/,
      "",
    );
    const first = { ...initial, calendar: withoutException };
    const accepted = mergeInvitationCalendar(
      null,
      first,
      "alice@example.test",
      { participation: "ACCEPTED", recurrenceId: null },
    );
    const exception = initial.calendar;
    const next = { ...initial, calendar: exception };
    const merged = mergeInvitationCalendar(
      accepted,
      next,
      "alice@example.test",
    );
    const result = await parseInvitation(
      invitation({
        calendar: merged.replace(
          "VERSION:2.0",
          "VERSION:2.0\r\nMETHOD:REQUEST",
        ),
      }),
    );
    expect(result.events[1]?.attendees[0]?.partstat).toBe("ACCEPTED");
  });
});

describe("invitation protocol boundary", () => {
  it("reports invalid invitations and failed calendar lookup as typed failures", async () => {
    const invalid = await invitationProtocol.parseInvitation(
      Buffer.from("not an invitation"),
    );
    expect(invalid.isErr() && invalid.error.kind).toBe("validation");
    const invalidCalendar =
      invitationProtocol.calendarSignature("not a calendar");
    expect(invalidCalendar.isErr() && invalidCalendar.error.kind).toBe(
      "unavailable",
    );
  });
});

describe("same-sequence updates and series cancellation", () => {
  it("uses DTSTAMP to order changed requests while retaining the attendee response", async () => {
    const { mergeInvitationCalendar } =
      await import("../src/adapters/invitations.ts");
    const original = await parseInvitation(invitation());
    const accepted = mergeInvitationCalendar(
      null,
      original,
      "alice@example.test",
      {
        participation: "ACCEPTED",
        recurrenceId: null,
      },
    );
    const newerCalendar = original.calendar
      .replaceAll("DTSTAMP:20261001T100000Z", "DTSTAMP:20261002T100000Z")
      .replace("SUMMARY:Weekly planning", "SUMMARY:Updated planning");
    const newer = await parseInvitation(
      invitation({ calendar: newerCalendar }),
    );
    const merged = mergeInvitationCalendar(
      accepted,
      newer,
      "alice@example.test",
    );
    expect(merged).toContain("SUMMARY:Updated planning");
    expect(merged).toContain("PARTSTAT=ACCEPTED");
    expect(() =>
      mergeInvitationCalendar(merged, original, "alice@example.test"),
    ).toThrow("Stale invitation");
    const laterUnchanged = {
      ...newer,
      calendar: newer.calendar.replaceAll(
        "DTSTAMP:20261002T100000Z",
        "DTSTAMP:20261004T100000Z",
      ),
    };
    const withLaterStamp = mergeInvitationCalendar(
      merged,
      laterUnchanged,
      "alice@example.test",
    );
    const reordered = {
      ...newer,
      calendar: newer.calendar
        .replaceAll("DTSTAMP:20261002T100000Z", "DTSTAMP:20261003T100000Z")
        .replace("Updated planning", "Outdated update"),
    };
    expect(() =>
      mergeInvitationCalendar(withLaterStamp, reordered, "alice@example.test"),
    ).toThrow("Stale invitation");
    const sameTimestamp = {
      ...newer,
      calendar: newer.calendar.replace(
        "Updated planning",
        "Conflicting planning",
      ),
    };
    expect(() =>
      mergeInvitationCalendar(merged, sameTimestamp, "alice@example.test"),
    ).toThrow("Conflicting invitation");
  });

  it("cancels every stored exception when the whole series is canceled", async () => {
    const { mergeInvitationCalendar } =
      await import("../src/adapters/invitations.ts");
    const original = await parseInvitation(invitation());
    const accepted = mergeInvitationCalendar(
      null,
      original,
      "alice@example.test",
      {
        participation: "ACCEPTED",
        recurrenceId: null,
      },
    );
    const master = original.calendar
      .replace(
        /BEGIN:VEVENT\r\nUID:google-example@example.test\r\nSEQUENCE:3\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/,
        "",
      )
      .replace("METHOD:REQUEST", "METHOD:CANCEL")
      .replace("SEQUENCE:3", "SEQUENCE:4")
      .replace("DTSTAMP:20261001T100000Z", "DTSTAMP:20261002T100000Z");
    const cancel = await parseInvitation(
      invitation({ method: "CANCEL", calendar: master }),
    );
    const cancelled = mergeInvitationCalendar(
      accepted,
      cancel,
      "alice@example.test",
    );
    expect(cancelled.match(/STATUS:CANCELLED/g)).toHaveLength(2);
    expect(cancelled.match(/SEQUENCE:4/g)).toHaveLength(2);
    expect(cancelled).toContain(
      "RECURRENCE-ID;TZID=Europe/Lisbon:20261109T100000",
    );
  });
  it("normalizes only redundant canceled exceptions", async () => {
    const { calendarSignature, mergeInvitationCalendar } =
      await import("../src/adapters/invitations.ts");
    const original = await parseInvitation(invitation());
    const accepted = mergeInvitationCalendar(
      null,
      original,
      "alice@example.test",
      { participation: "ACCEPTED", recurrenceId: null },
    );
    const master = original.calendar
      .replace(
        /BEGIN:VEVENT\r\nUID:google-example@example.test\r\nSEQUENCE:3\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/,
        "",
      )
      .replace("METHOD:REQUEST", "METHOD:CANCEL")
      .replace("SEQUENCE:3", "SEQUENCE:4");
    const cancel = await parseInvitation(
      invitation({ method: "CANCEL", calendar: master }),
    );
    const cancelled = mergeInvitationCalendar(
      accepted,
      cancel,
      "alice@example.test",
    );
    const withoutException = cancelled.replace(
      /BEGIN:VEVENT\r\nUID:google-example@example.test\r\nSEQUENCE:4\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/,
      "",
    );
    // The moved exception differs in start time and summary and must be preserved.
    expect(calendarSignature(cancelled)).not.toBe(
      calendarSignature(withoutException),
    );
  });
});

describe("invitation request isolation", () => {
  it("bounds one user's concurrent work without blocking another user", async () => {
    const { createInvitationService } =
      await import("../src/services/invitations.ts");
    const { err } = await import("neverthrow");
    const gate =
      Promise.withResolvers<
        Result<
          { accountId: string; address: string; secret: string },
          { kind: string }
        >
      >();
    const service = createInvitationService({
      origin: "https://example.test",
      protocol: invitationProtocol,
      store: { getForOwner: () => gate.promise },
    });
    const firstActor = {
      id: "first",
      email: "first@example.test",
      role: "user" as const,
    };
    const otherActor = {
      id: "other",
      email: "other@example.test",
      role: "user" as const,
    };
    const first = service.read(firstActor, "default", "a");
    const second = service.read(firstActor, "default", "b");
    const denied = await service.read(firstActor, "default", "c");
    expect(denied.isErr() && denied.error.kind).toBe("rate_limited");
    const other = service.read(otherActor, "default", "d");
    gate.resolve(err({ kind: "forbidden" }));
    for (const result of await Promise.all([first, second, other]))
      expect(result.isErr() && result.error.kind).toBe("forbidden");
    const after = await service.read(firstActor, "default", "e");
    expect(after.isErr() && after.error.kind).toBe("forbidden");
  });
});
