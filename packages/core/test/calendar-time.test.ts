import type { EventContent } from "@opensuite/contracts";
import type { CalendarEvent } from "@opensuite/jmap";
import { describe, expect, it } from "vitest";
import {
  createObject,
  expand,
  locate,
  parseDuration,
  seriesIdOf,
  timing,
  toContract,
  toInstant,
  toSeries,
  toWall,
  updatePatch,
  type Series,
} from "../src/services/calendar-time.ts";

const stored = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "ev",
  calendarIds: { cal: true },
  title: "Stand-up",
  description: "",
  locations: null,
  start: "2026-10-14T10:00:00",
  duration: "PT1H",
  timeZone: "Europe/Paris",
  showWithoutTime: false,
  recurrenceRules: null,
  excludedRecurrenceRules: null,
  recurrenceOverrides: null,
  ...overrides,
});
const series = (overrides: Partial<CalendarEvent> = {}): Series => {
  const item = toSeries(stored(overrides), ["cal"]);
  if (item === undefined) throw new Error("Expected a series");
  return item;
};
const at = (iso: string) => Date.parse(iso);
const starts = (item: Series, from: string, to: string) =>
  expand(item, at(from), at(to)).map((occurrence) =>
    new Date(occurrence.start).toISOString(),
  );
const content = (overrides: Partial<EventContent> = {}): EventContent => ({
  calendarId: "cal",
  title: "Stand-up",
  description: "",
  location: "",
  start: "2026-10-14T08:00:00.000Z",
  end: "2026-10-14T09:00:00.000Z",
  allDay: false,
  timeZone: "Europe/Paris",
  recurrence: "none",
  ...overrides,
});
const time = (value: EventContent) => {
  const result = timing(value);
  if (result === undefined) throw new Error("Expected valid timing");
  return result;
};

describe("calendar time zones", () => {
  it("converts Europe/Paris wall time across both DST transitions", () => {
    expect(toInstant(at("2026-10-24T10:00:00Z"), "Europe/Paris")).toBe(
      at("2026-10-24T08:00:00Z"),
    );
    expect(toInstant(at("2026-10-26T10:00:00Z"), "Europe/Paris")).toBe(
      at("2026-10-26T09:00:00Z"),
    );
    // 02:30 happens twice on 25 October: the first occurrence wins.
    expect(toInstant(at("2026-10-25T02:30:00Z"), "Europe/Paris")).toBe(
      at("2026-10-25T00:30:00Z"),
    );
    // 02:30 does not exist on 29 March: the pre-gap offset moves it forward.
    expect(toInstant(at("2026-03-29T02:30:00Z"), "Europe/Paris")).toBe(
      at("2026-03-29T01:30:00Z"),
    );
    expect(toWall(at("2026-03-29T01:30:00Z"), "Europe/Paris")).toBe(
      at("2026-03-29T03:30:00Z"),
    );
  });

  it("keeps a weekly local time through the DST week and uses exact durations", () => {
    const weekly = series({
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "weekly" }],
    });
    expect(
      starts(weekly, "2026-10-19T00:00:00Z", "2026-11-02T00:00:00Z"),
    ).toEqual(["2026-10-21T08:00:00.000Z", "2026-10-28T09:00:00.000Z"]);
    const overnight = series({
      start: "2026-10-24T22:00:00",
      duration: "PT8H",
    });
    const [night] = expand(
      overnight,
      at("2026-10-24T00:00:00Z"),
      at("2026-10-26T00:00:00Z"),
    );
    expect(night && (night.end - night.start) / 3_600_000).toBe(8);
    const nominal = series({ start: "2026-10-24T10:00:00", duration: "P1D" });
    const [day] = expand(
      nominal,
      at("2026-10-24T00:00:00Z"),
      at("2026-10-26T00:00:00Z"),
    );
    // A nominal day ends at the same wall time, 25 hours later.
    expect(day && (day.end - day.start) / 3_600_000).toBe(25);
  });

  it("treats floating and unknown zones as UTC without failing", () => {
    const item = series({ timeZone: null });
    const [first] = expand(
      item,
      at("2026-10-14T00:00:00Z"),
      at("2026-10-15T00:00:00Z"),
    );
    if (first === undefined) throw new Error("Expected occurrence");
    expect(toContract(item, first)).toMatchObject({
      start: "2026-10-14T10:00:00.000Z",
      end: "2026-10-14T11:00:00.000Z",
      timeZone: "UTC",
    });
    expect(series({ timeZone: "Mars/Olympus" }).zone).toBe("UTC");
    expect(toSeries(stored({ start: "not a date" }), ["cal"])).toBeUndefined();
    expect(toSeries(stored({ calendarIds: {} }), ["cal"])).toBeUndefined();
  });
});

describe("calendar mapping", () => {
  it("maps JSCalendar fields to the contract", () => {
    const item = series({
      title: "Planning",
      description: "Agenda",
      locations: { a: { name: "  " }, b: { name: "Room 4" } },
      calendarIds: { other: true, cal: true },
    });
    const [first] = expand(
      item,
      at("2026-10-14T00:00:00Z"),
      at("2026-10-15T00:00:00Z"),
    );
    if (first === undefined) throw new Error("Expected occurrence");
    expect(toContract(item, first)).toEqual({
      id: "ev",
      seriesId: "ev",
      calendarId: "cal",
      title: "Planning",
      description: "Agenda",
      location: "Room 4",
      start: "2026-10-14T08:00:00.000Z",
      end: "2026-10-14T09:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Paris",
      recurrence: "none",
    });
  });

  it("maps all-day events to UTC dates with an exclusive end", () => {
    const item = series({
      showWithoutTime: true,
      timeZone: null,
      start: "2026-10-28T00:00:00",
      duration: "P3D",
    });
    const [occurrence] = expand(
      item,
      at("2026-10-30T00:00:00Z"),
      at("2026-10-31T00:00:00Z"),
    );
    if (occurrence === undefined) throw new Error("Expected occurrence");
    expect(toContract(item, occurrence)).toMatchObject({
      start: "2026-10-28T00:00:00.000Z",
      end: "2026-10-31T00:00:00.000Z",
      allDay: true,
    });
    expect(
      expand(item, at("2026-10-31T00:00:00Z"), at("2026-11-01T00:00:00Z")),
    ).toEqual([]);
    const zero = series({
      showWithoutTime: true,
      start: "2026-10-28T00:00:00",
      duration: "PT0S",
    });
    expect(
      expand(zero, at("2026-10-28T00:00:00Z"), at("2026-10-29T00:00:00Z"))[0]
        ?.end,
    ).toBe(at("2026-10-29T00:00:00Z"));
    expect(
      time(
        content({
          allDay: true,
          start: "2026-10-28T00:00:00.000Z",
          end: "2026-10-31T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ start: "2026-10-28T00:00:00", duration: "P3D" });
  });

  it("parses durations and validates new content", () => {
    expect(parseDuration("P1W2DT3H4M5S")).toEqual({
      days: 9,
      ms: 11_045_000,
    });
    expect(parseDuration("bogus")).toEqual({ days: 0, ms: 0 });
    expect(
      timing(content({ end: "2026-10-14T08:00:00.000Z" })),
    ).toBeUndefined();
    expect(timing(content({ timeZone: "Nowhere/City" }))).toBeUndefined();
    const value = content({
      start: "2026-10-14T08:00:00.000Z",
      end: "2026-10-14T09:30:15.000Z",
      location: "Room 1",
      recurrence: "weekly",
    });
    expect(createObject(value, time(value))).toEqual({
      "@type": "Event",
      calendarIds: { cal: true },
      title: "Stand-up",
      description: "",
      start: "2026-10-14T10:00:00",
      duration: "PT1H30M15S",
      timeZone: "Europe/Paris",
      locations: { main: { "@type": "Location", name: "Room 1" } },
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "weekly" }],
    });
  });
});

describe("recurrence expansion", () => {
  it("honours interval, count and until", () => {
    expect(
      starts(
        series({
          timeZone: "UTC",
          recurrenceRules: [
            {
              "@type": "RecurrenceRule",
              frequency: "daily",
              interval: 2,
              count: 3,
            },
          ],
        }),
        "2026-10-01T00:00:00Z",
        "2026-11-01T00:00:00Z",
      ),
    ).toEqual([
      "2026-10-14T10:00:00.000Z",
      "2026-10-16T10:00:00.000Z",
      "2026-10-18T10:00:00.000Z",
    ]);
    expect(
      starts(
        series({
          timeZone: "UTC",
          recurrenceRules: [
            {
              "@type": "RecurrenceRule",
              frequency: "weekly",
              until: "2026-10-28T10:00:00",
            },
          ],
        }),
        "2026-10-01T00:00:00Z",
        "2026-12-01T00:00:00Z",
      ),
    ).toHaveLength(3);
  });

  it("skips months and years without the start date", () => {
    expect(
      starts(
        series({
          timeZone: "UTC",
          start: "2026-01-31T09:00:00",
          recurrenceRules: [
            { "@type": "RecurrenceRule", frequency: "monthly" },
          ],
        }),
        "2026-01-01T00:00:00Z",
        "2026-06-01T00:00:00Z",
      ),
    ).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
    ]);
    expect(
      starts(
        series({
          timeZone: "UTC",
          start: "2024-02-29T09:00:00",
          recurrenceRules: [
            { "@type": "RecurrenceRule", frequency: "yearly", count: 2 },
          ],
        }),
        "2024-01-01T00:00:00Z",
        "2029-01-01T00:00:00Z",
      ),
    ).toEqual(["2024-02-29T09:00:00.000Z", "2028-02-29T09:00:00.000Z"]);
  });

  it("finds daily occurrences of a long-running series without walking its history", () => {
    const item = series({
      timeZone: "UTC",
      start: "1990-01-01T09:00:00",
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "daily" }],
    });
    expect(
      starts(item, "2026-10-14T00:00:00Z", "2026-10-16T00:00:00Z"),
    ).toEqual(["2026-10-14T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]);
  });

  it("applies overrides and exclusions with round-tripping occurrence ids", () => {
    const item = series({
      timeZone: "UTC",
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "weekly" }],
      excludedRecurrenceRules: [
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          interval: 4,
          count: 1,
        },
      ],
      recurrenceOverrides: {
        "2026-10-21T10:00:00": { excluded: true },
        "2026-10-28T10:00:00": { start: "2026-10-28T15:00:00", title: "Moved" },
      },
    });
    const occurrences = expand(
      item,
      at("2026-10-12T00:00:00Z"),
      at("2026-11-08T00:00:00Z"),
    );
    // 14 Oct is excluded by rule, 21 Oct by override.
    expect(
      occurrences.map((occurrence) => [
        occurrence.id,
        new Date(occurrence.start).toISOString(),
        occurrence.title,
      ]),
    ).toEqual([
      ["ev~20261028T100000", "2026-10-28T15:00:00.000Z", "Moved"],
      ["ev~20261104T100000", "2026-11-04T10:00:00.000Z", "Stand-up"],
    ]);
    expect(seriesIdOf("ev~20261028T100000")).toBe("ev");
    expect(locate(item, "ev~20261028T100000")?.title).toBe("Moved");
    expect(locate(item, "ev~20261021T100000")).toBeUndefined();
    expect(locate(item, "ev~garbage")).toBeUndefined();
    expect(locate(item, "other~20261028T100000")).toBeUndefined();
  });

  it("maps rules it cannot express to the closest value without dropping them", () => {
    const byDay = series({
      recurrenceRules: [
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          byDay: [{ day: "mo" }, { day: "we" }],
        },
      ],
    });
    expect(byDay.recurrence).toBe("weekly");
    const hourly = series({
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "hourly" }],
    });
    expect(hourly.recurrence).toBe("none");
    expect(
      starts(hourly, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"),
    ).toEqual(["2026-10-14T08:00:00.000Z"]);
    expect(
      series({
        recurrenceRules: [
          { "@type": "RecurrenceRule", frequency: "yearly", rscale: "hebrew" },
        ],
      }).recurrence,
    ).toBe("none");
    const current = locate(byDay, "ev~20261014T100000");
    if (current === undefined) throw new Error("Expected occurrence");
    const unchanged = content({ recurrence: "weekly" });
    expect(updatePatch(byDay, current, unchanged, time(unchanged))).toEqual({});
    const renamed = content({ recurrence: "weekly", title: "Renamed" });
    expect(updatePatch(byDay, current, renamed, time(renamed))).toEqual({
      title: "Renamed",
    });
  });
});

describe("event updates", () => {
  it("shifts a series by the change made through one occurrence", () => {
    const item = series({
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "weekly" }],
      recurrenceOverrides: { "2026-10-21T10:00:00": { excluded: true } },
    });
    const current = locate(item, "ev~20261028T100000");
    if (current === undefined) throw new Error("Expected occurrence");
    // 28 October is after the DST change: 10:00 Paris is 09:00Z.
    const later = content({
      start: "2026-10-28T10:00:00.000Z",
      end: "2026-10-28T11:30:00.000Z",
      recurrence: "weekly",
    });
    expect(updatePatch(item, current, later, time(later))).toEqual({
      start: "2026-10-14T11:00:00",
      duration: "PT1H30M",
      showWithoutTime: false,
      timeZone: "Europe/Paris",
      recurrenceOverrides: null,
    });
    const none = content({
      start: "2026-10-28T09:00:00.000Z",
      end: "2026-10-28T10:00:00.000Z",
      recurrence: "none",
      calendarId: "work",
      location: "Room 2",
    });
    expect(updatePatch(item, current, none, time(none))).toEqual({
      calendarIds: { work: true },
      locations: { main: { "@type": "Location", name: "Room 2" } },
      recurrenceRules: null,
      excludedRecurrenceRules: null,
      recurrenceOverrides: null,
    });
  });

  it("converts between timed and all-day events", () => {
    const item = series();
    const current = locate(item, "ev");
    if (current === undefined) throw new Error("Expected occurrence");
    const allDay = content({
      allDay: true,
      start: "2026-10-15T00:00:00.000Z",
      end: "2026-10-16T00:00:00.000Z",
    });
    expect(updatePatch(item, current, allDay, time(allDay))).toMatchObject({
      start: "2026-10-15T00:00:00",
      duration: "P1D",
      showWithoutTime: true,
      timeZone: null,
    });
  });
});
