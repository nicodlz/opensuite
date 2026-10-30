import process from "node:process";
import { beforeAll, describe, expect, it } from "vitest";
import type { CalendarEvent } from "@opensuite/contracts";
import {
  addDays,
  applyEventChange,
  dateAtMinutes,
  dayDifference,
  dayKey,
  eventEnd,
  eventStart,
  floorMinutes,
  formFromEvent,
  formatEventRange,
  fromAllDay,
  fromInputs,
  hiddenCounts,
  isSpanning,
  layoutColumns,
  matchesSearch,
  moveTo,
  overlapsRange,
  periodTitle,
  rangeDays,
  resizeTo,
  shiftAnchor,
  shiftDays,
  shiftFormStart,
  snapMinutes,
  spanLanes,
  startOfWeek,
  textColorFor,
  timedSegments,
  timingFromForm,
  toAllDay,
  viewRange,
  wallMinutes,
} from "../src/calendar/model.ts";

beforeAll(() => {
  // Europe/Paris leaves summer time on Sunday 25 October 2026 (25 hours) and
  // enters it on Sunday 29 March 2026 (23 hours).
  process.env["TZ"] = "Europe/Paris";
});

function event(
  id: string,
  start: string,
  end: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    seriesId: id,
    calendarId: "personal",
    title: id,
    description: "",
    location: "",
    start,
    end,
    allDay: false,
    timeZone: "Europe/Paris",
    recurrence: "none",
    ...extra,
  };
}

describe("calendar ranges", () => {
  it("starts weeks on the requested weekday", () => {
    const friday = new Date(2026, 9, 30, 15);
    expect(dayKey(startOfWeek(friday, 1))).toBe("2026-10-26");
    expect(dayKey(startOfWeek(friday, 0))).toBe("2026-10-25");
    expect(dayKey(startOfWeek(new Date(2026, 10, 1), 1))).toBe("2026-10-26");
    const week = viewRange("week", friday, 1);
    expect(rangeDays(week).map(dayKey)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    const day = viewRange("day", friday, 1);
    expect(dayKey(day.start)).toBe("2026-10-30");
    expect(dayKey(day.end)).toBe("2026-10-31");
  });

  it("builds a six-week month grid", () => {
    const range = viewRange("month", new Date(2026, 9, 14), 1);
    const days = rangeDays(range);
    expect(days).toHaveLength(42);
    expect(dayKey(days[0] ?? range.start)).toBe("2026-09-28");
    expect(dayKey(days[41] ?? range.end)).toBe("2026-11-08");
    // February 2027 starts on a Monday: the grid still has six rows.
    const february = rangeDays(viewRange("month", new Date(2027, 1, 10), 1));
    expect(february).toHaveLength(42);
    expect(dayKey(february[0] ?? new Date())).toBe("2027-02-01");
  });

  it("moves the anchor by view period", () => {
    const anchor = new Date(2026, 0, 31);
    expect(dayKey(shiftAnchor("day", anchor, 1))).toBe("2026-02-01");
    expect(dayKey(shiftAnchor("week", anchor, -1))).toBe("2026-01-24");
    expect(dayKey(shiftAnchor("month", anchor, 1))).toBe("2026-02-01");
    expect(dayKey(shiftAnchor("month", anchor, -2))).toBe("2025-11-01");
  });

  it("formats period titles", () => {
    const anchor = new Date(2026, 9, 30);
    expect(
      periodTitle("month", anchor, viewRange("month", anchor, 1), "en-GB"),
    ).toBe("October 2026");
    expect(
      periodTitle(
        "week",
        anchor,
        viewRange("week", anchor, 1),
        "en-GB",
      ).replace(/\s/gu, " "),
    ).toBe("26 Oct – 1 Nov 2026");
    expect(
      periodTitle("day", anchor, viewRange("day", anchor, 1), "en-GB"),
    ).toMatch(/^Friday,? 30 October 2026$/u);
  });
});

describe("daylight saving time", () => {
  it("keeps local midnights across the October change", () => {
    const week = viewRange("week", new Date(2026, 9, 22), 1);
    const days = rangeDays(week);
    expect(days.map(dayKey)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(days.every((day) => day.getHours() === 0)).toBe(true);
    const sunday = days[6] ?? week.start;
    expect(addDays(sunday, 1).getTime() - sunday.getTime()).toBe(
      25 * 3_600_000,
    );
    expect(week.end.getTime() - week.start.getTime()).toBe(
      (7 * 24 + 1) * 3_600_000,
    );
    expect(dayDifference(week.start, week.end)).toBe(7);
  });

  it("positions events by wall clock on 23- and 25-hour days", () => {
    const autumn = new Date(2026, 9, 25);
    // 09:00 local after the change is 08:00 UTC.
    const morning = event("m", "2026-10-25T08:00:00Z", "2026-10-25T09:30:00Z");
    const [segment] = timedSegments([morning], [autumn]);
    expect(segment?.startMinute).toBe(9 * 60);
    expect(segment?.endMinute).toBe(10 * 60 + 30);
    expect(dateAtMinutes(autumn, 9 * 60).toISOString()).toBe(
      "2026-10-25T08:00:00.000Z",
    );
    const spring = new Date(2026, 2, 29);
    expect(addDays(spring, 1).getTime() - spring.getTime()).toBe(
      23 * 3_600_000,
    );
    expect(dateAtMinutes(spring, 12 * 60).toISOString()).toBe(
      "2026-03-29T10:00:00.000Z",
    );
    expect(wallMinutes(dateAtMinutes(spring, 4 * 60))).toBe(240);
  });

  it("keeps the wall-clock time when moving across the change", () => {
    const friday = event("f", "2026-10-23T07:00:00Z", "2026-10-23T08:00:00Z");
    // 09:00 summer time to 09:00 winter time two days later.
    expect(shiftDays(friday, 3)).toEqual({
      start: "2026-10-26T08:00:00.000Z",
      end: "2026-10-26T09:00:00.000Z",
    });
  });
});

describe("timed layout", () => {
  it("splits events crossing midnight and clips at day edges", () => {
    const days = rangeDays(viewRange("week", new Date(2026, 9, 28), 1));
    const late = event("late", "2026-10-27T21:00:00Z", "2026-10-28T01:00:00Z");
    const segments = timedSegments([late], days);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      day: 1,
      startMinute: 22 * 60,
      endMinute: 1440,
      endsAfter: true,
    });
    expect(segments[1]).toMatchObject({
      day: 2,
      startMinute: 0,
      endMinute: 2 * 60,
      startsBefore: true,
    });
    const long = event("long", "2026-10-27T08:00:00Z", "2026-10-28T09:00:00Z");
    expect(isSpanning(long)).toBe(true);
    expect(timedSegments([long], days)).toEqual([]);
  });

  it("packs overlapping events side by side", () => {
    const items = [
      { id: "a", startMinute: 540, endMinute: 600 },
      { id: "b", startMinute: 570, endMinute: 660 },
      { id: "c", startMinute: 600, endMinute: 630 },
      { id: "d", startMinute: 720, endMinute: 780 },
    ];
    const placed = Object.fromEntries(
      layoutColumns(items).map((item) => [item.id, item]),
    );
    expect(placed["a"]).toMatchObject({ column: 0, columns: 2, span: 1 });
    expect(placed["b"]).toMatchObject({ column: 1, columns: 2, span: 1 });
    // `c` starts when `a` ends, so it reuses the first column.
    expect(placed["c"]).toMatchObject({ column: 0, columns: 2, span: 1 });
    // `d` is its own cluster and takes the full width.
    expect(placed["d"]).toMatchObject({ column: 0, columns: 1, span: 1 });
  });

  it("widens events into free columns", () => {
    const items = [
      { id: "long", startMinute: 0, endMinute: 240 },
      { id: "x", startMinute: 0, endMinute: 60 },
      { id: "y", startMinute: 0, endMinute: 60 },
      { id: "z", startMinute: 120, endMinute: 180 },
    ];
    const placed = Object.fromEntries(
      layoutColumns(items).map((item) => [item.id, item]),
    );
    expect(placed["long"]).toMatchObject({ column: 0, columns: 3 });
    expect(placed["z"]).toMatchObject({ column: 1, columns: 3, span: 2 });
    expect(placed["x"]?.span).toBe(1);
  });

  it("treats short events by their drawn length", () => {
    const items = [
      { id: "a", startMinute: 600, endMinute: 605 },
      { id: "b", startMinute: 610, endMinute: 640 },
    ];
    expect(layoutColumns(items).every((item) => item.columns === 1)).toBe(true);
    expect(layoutColumns(items, 30).every((item) => item.columns === 2)).toBe(
      true,
    );
  });

  it("snaps minutes", () => {
    expect(snapMinutes(52, 15)).toBe(45);
    expect(snapMinutes(53, 15)).toBe(60);
    expect(snapMinutes(-20, 15)).toBe(0);
    expect(snapMinutes(1500, 30)).toBe(1440);
    expect(floorMinutes(599, 30)).toBe(570);
    expect(floorMinutes(1439, 30)).toBe(1410);
  });

  it("moves and resizes timed events", () => {
    const meeting = event("m", "2026-10-28T09:00:00Z", "2026-10-28T10:30:00Z");
    expect(moveTo(meeting, new Date("2026-10-29T13:15:00Z"))).toEqual({
      start: "2026-10-29T13:15:00.000Z",
      end: "2026-10-29T14:45:00.000Z",
    });
    expect(resizeTo(meeting, new Date("2026-10-28T09:05:00Z"))).toEqual({
      start: "2026-10-28T09:00:00.000Z",
      end: "2026-10-28T09:15:00.000Z",
    });
  });
});

describe("all-day spans", () => {
  const week = viewRange("week", new Date(2026, 9, 28), 1);

  it("reads all-day dates from UTC midnight", () => {
    const trip = event("trip", "2026-10-27T00:00:00Z", "2026-10-30T00:00:00Z", {
      allDay: true,
    });
    expect(dayKey(eventStart(trip))).toBe("2026-10-27");
    expect(dayKey(eventEnd(trip))).toBe("2026-10-30");
    expect(toAllDay(fromAllDay(trip.start))).toBe("2026-10-27T00:00:00.000Z");
    expect(shiftDays(trip, 2)).toEqual({
      start: "2026-10-29T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
  });

  it("clips spans to the visible range and packs lanes", () => {
    const before = event(
      "before",
      "2026-10-22T00:00:00Z",
      "2026-10-28T00:00:00Z",
      {
        allDay: true,
      },
    );
    const after = event(
      "after",
      "2026-10-31T00:00:00Z",
      "2026-11-04T00:00:00Z",
      {
        allDay: true,
      },
    );
    const single = event(
      "single",
      "2026-10-27T00:00:00Z",
      "2026-10-28T00:00:00Z",
      {
        allDay: true,
      },
    );
    const outside = event(
      "outside",
      "2026-11-02T00:00:00Z",
      "2026-11-03T00:00:00Z",
      {
        allDay: true,
      },
    );
    const { items, lanes } = spanLanes(
      [single, after, before, outside],
      week.start,
      7,
    );
    const byId = Object.fromEntries(items.map((item) => [item.event.id, item]));
    expect(Object.keys(byId).toSorted()).toEqual(["after", "before", "single"]);
    expect(byId["before"]).toMatchObject({
      startColumn: 0,
      endColumn: 2,
      startsBefore: true,
      endsAfter: false,
      lane: 0,
    });
    expect(byId["single"]).toMatchObject({
      startColumn: 1,
      endColumn: 2,
      lane: 1,
    });
    expect(byId["after"]).toMatchObject({
      startColumn: 5,
      endColumn: 7,
      endsAfter: true,
      lane: 0,
    });
    expect(lanes).toBe(2);
    expect(hiddenCounts(items, 7, 1)).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("covers the last partial day of timed spans", () => {
    const conference = event(
      "conference",
      "2026-10-26T08:00:00Z",
      "2026-10-28T12:00:00Z",
    );
    const { items } = spanLanes([conference], week.start, 7);
    expect(items[0]).toMatchObject({ startColumn: 0, endColumn: 3 });
    const midnight = event("m", "2026-10-26T08:00:00Z", "2026-10-27T23:00:00Z");
    expect(spanLanes([midnight], week.start, 7).items[0]?.endColumn).toBe(2);
  });

  it("checks range overlap with exclusive ends", () => {
    const day = viewRange("day", new Date(2026, 9, 28), 1);
    expect(
      overlapsRange(
        event("a", "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", {
          allDay: true,
        }),
        day,
      ),
    ).toBe(true);
    expect(
      overlapsRange(
        event("b", "2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", {
          allDay: true,
        }),
        day,
      ),
    ).toBe(false);
  });
});

describe("event editor", () => {
  it("shows all-day end dates inclusively and saves them exclusively", () => {
    const form = formFromEvent(
      event("trip", "2026-10-27T00:00:00Z", "2026-10-30T00:00:00Z", {
        allDay: true,
      }),
    );
    expect(form.startDate).toBe("2026-10-27");
    expect(form.endDate).toBe("2026-10-29");
    expect(timingFromForm(form)).toEqual({
      start: "2026-10-27T00:00:00.000Z",
      end: "2026-10-30T00:00:00.000Z",
    });
  });

  it("keeps the duration when the start moves and validates the end", () => {
    const form = formFromEvent(
      event("m", "2026-10-28T08:00:00Z", "2026-10-28T09:30:00Z"),
    );
    expect(form.startTime).toBe("09:00");
    const moved = shiftFormStart(form, "2026-10-28", "23:30");
    expect(moved.endDate).toBe("2026-10-29");
    expect(moved.endTime).toBe("01:00");
    expect(timingFromForm({ ...form, endTime: "09:00" })).toEqual({
      error: "End must be after start.",
    });
    expect(fromInputs("2026-02-30", "10:00")).toBeNull();
  });

  it("formats event ranges and searches content", () => {
    const meeting = event(
      "Design review",
      "2026-10-28T09:00:00Z",
      "2026-10-28T10:00:00Z",
      {
        location: "Studio",
      },
    );
    expect(formatEventRange(meeting, "en-GB")).toMatch(
      /^Wednesday,? 28 October · 10:00\s?–\s?11:00$/u,
    );
    expect(matchesSearch(meeting, "studio")).toBe(true);
    expect(matchesSearch(meeting, "budget")).toBe(false);
  });

  it("picks readable text colors", () => {
    expect(textColorFor("#b8ef78")).toBe("#0a0710");
    expect(textColorFor("#5630a8")).toBe("#ffffff");
    expect(textColorFor("#ffffff")).toBe("#0a0710");
    expect(textColorFor("#000000")).toBe("#ffffff");
  });
});

describe("optimistic changes", () => {
  const single = event("lunch", "2026-10-27T11:30:00Z", "2026-10-27T12:30:00Z");
  const first = event(
    "standup~0",
    "2026-10-28T08:30:00Z",
    "2026-10-28T08:45:00Z",
    {
      seriesId: "standup",
      recurrence: "weekly",
    },
  );
  const second = {
    ...first,
    id: "standup~1",
    start: "2026-11-04T08:30:00Z",
    end: "2026-11-04T08:45:00Z",
  };
  const content = ({ id: _id, seriesId: _seriesId, ...rest }: CalendarEvent) =>
    rest;

  it("adds, moves and removes single events", () => {
    const created = applyEventChange([single], {
      type: "create",
      id: "draft-1",
      content: { ...content(single), title: "New" },
    });
    expect(created.map((item) => item.id)).toEqual(["lunch", "draft-1"]);
    const moved = applyEventChange(created, {
      type: "update",
      event: single,
      content: {
        ...content(single),
        start: "2026-10-27T13:00:00.000Z",
        end: "2026-10-27T14:00:00.000Z",
      },
    });
    expect(moved[0]?.start).toBe("2026-10-27T13:00:00.000Z");
    expect(
      applyEventChange(moved, { type: "delete", event: single }),
    ).toHaveLength(1);
  });

  it("shifts and deletes every loaded occurrence of a series", () => {
    const shifted = applyEventChange([single, first, second], {
      type: "update",
      event: first,
      content: {
        ...content(first),
        title: "Stand-up",
        start: "2026-10-28T09:30:00.000Z",
        end: "2026-10-28T10:00:00.000Z",
      },
    });
    expect(shifted[2]).toMatchObject({
      id: "standup~1",
      title: "Stand-up",
      start: "2026-11-04T09:30:00.000Z",
      end: "2026-11-04T10:00:00.000Z",
    });
    expect(
      applyEventChange([single, first, second], {
        type: "delete",
        event: second,
      }),
    ).toEqual([single]);
  });
});
