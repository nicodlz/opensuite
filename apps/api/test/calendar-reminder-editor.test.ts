import type { CalendarEvent } from "@opensuite/jmap";
import type { EventContent } from "@opensuite/contracts";
import { describe, expect, it } from "vitest";
import {
  createObject,
  locate,
  timing,
  toSeries,
  updatePatch,
} from "@opensuite/core/services/calendar-time";
import { reminderOf } from "@opensuite/core/services/calendar-reminder-edit";

const content: EventContent = {
  calendarId: "cal",
  title: "Meeting",
  description: "",
  location: "",
  start: "2026-10-24T08:00:00.000Z",
  end: "2026-10-24T09:00:00.000Z",
  allDay: false,
  timeZone: "Europe/Paris",
  recurrence: "none",
};
const event: CalendarEvent = {
  id: "event",
  calendarIds: { cal: true },
  title: "Meeting",
  description: "",
  locations: null,
  start: "2026-10-24T10:00:00",
  duration: "PT1H",
  timeZone: "Europe/Paris",
  showWithoutTime: false,
  recurrenceRules: null,
  excludedRecurrenceRules: null,
  recurrenceOverrides: null,
};
const withTime = (input: EventContent) => {
  const time = timing(input);
  if (!time) throw new Error("Invalid test time");
  return time;
};

describe("calendar reminder editor", () => {
  it("retains a client-provided alarm id when changing its offset", () => {
    const series = toSeries(
      {
        ...event,
        alerts: {
          "client-alarm": {
            action: "display",
            trigger: { "@type": "OffsetTrigger", offset: "-PT10M" },
          },
        },
      },
      ["cal"],
    );
    if (!series) throw new Error("Missing series");
    const current = locate(series, series.id);
    if (!current) throw new Error("Missing occurrence");
    expect(
      updatePatch(
        series,
        current,
        { ...content, reminder: "5m" },
        withTime(content),
      ),
    ).toMatchObject({
      alerts: { "client-alarm": { trigger: { offset: "-PT5M" } } },
    });
  });
  it.each([
    ["at-time", "PT0S"],
    ["5m", "-PT5M"],
    ["10m", "-PT10M"],
    ["15m", "-PT15M"],
    ["30m", "-PT30M"],
    ["1h", "-PT1H"],
    ["1d", "-P1D"],
  ] as const)(
    "writes %s as a start-relative display alert",
    (reminder, offset) => {
      const input = { ...content, reminder };
      const created = createObject(input, withTime(input));
      expect(created.alerts).toEqual({
        reminder: {
          "@type": "Alert",
          action: "display",
          trigger: { "@type": "OffsetTrigger", offset, relativeTo: "start" },
        },
      });
      expect(reminderOf(created.alerts)).toBe(reminder);
    },
  );
  it("preserves custom and multiple alarms on unrelated edits", () => {
    const alerts = {
      first: {
        action: "display",
        trigger: { "@type": "AbsoluteTrigger", when: "2026-10-24T07:00:00Z" },
      },
      second: {
        action: "display",
        trigger: { "@type": "OffsetTrigger", offset: "-PT5M" },
      },
    };
    const series = toSeries({ ...event, alerts }, ["cal"]);
    if (!series) throw new Error("Missing series");
    const current = locate(series, series.id);
    if (!current) throw new Error("Missing occurrence");
    expect(series.reminder).toBe("custom");
    expect(
      updatePatch(
        series,
        current,
        { ...content, title: "Changed", reminder: "custom" },
        withTime(content),
      ),
    ).toEqual({ title: "Changed" });
    expect(
      updatePatch(
        series,
        current,
        { ...content, reminder: "none" },
        withTime(content),
      ),
    ).toEqual({ alerts: null });
  });
  it("replaces occurrence-specific alarm overrides only when the reminder is changed", () => {
    const series = toSeries(
      {
        ...event,
        recurrenceRules: [{ frequency: "daily" }],
        recurrenceOverrides: {
          "2026-10-25T10:00:00": {
            title: "Exception",
            "alerts/a": { action: "display" },
          },
        },
      },
      ["cal"],
    );
    if (!series) throw new Error("Missing series");
    const current = locate(series, "event~20261025T100000");
    if (!current) throw new Error("Missing occurrence");
    const input: EventContent = {
      ...content,
      start: new Date(current.start).toISOString(),
      end: new Date(current.end).toISOString(),
      recurrence: "daily",
      reminder: "5m",
    };
    expect(updatePatch(series, current, input, withTime(input))).toMatchObject({
      recurrenceOverrides: { "2026-10-25T10:00:00": { title: "Exception" } },
      alerts: { a: { trigger: { offset: "-PT5M" } } },
    });
  });
});
