import type { CalendarEvent } from "@opensuite/jmap";
import { describe, expect, it } from "vitest";
import { planEvent } from "@opensuite/core/services/calendar-reminder-plan";

const event = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "event",
  uid: "meeting",
  calendarIds: { work: true },
  title: "Review",
  description: "",
  locations: { room: { name: "Room 4" } },
  start: "2026-10-24T10:00:00",
  duration: "PT1H",
  timeZone: "Europe/Paris",
  showWithoutTime: false,
  recurrenceRules: null,
  excludedRecurrenceRules: null,
  recurrenceOverrides: null,
  alerts: {
    a: {
      action: "display",
      trigger: {
        "@type": "OffsetTrigger",
        offset: "-PT15M",
        relativeTo: "start",
      },
    },
  },
  ...patch,
});
const plan = (
  item: CalendarEvent,
  from = "2026-10-20T00:00:00Z",
  until = "2026-11-01T00:00:00Z",
) => planEvent(item, ["work"], Date.parse(from), Date.parse(until));
const times = (items: ReturnType<typeof plan>) =>
  items.map((item) => [
    item.occurrenceStart.toISOString(),
    item.triggerAt.toISOString(),
  ]);
const noop = () => {};

describe("calendar reminder planning", () => {
  it("reads relative start, end and absolute triggers", () => {
    const items = plan(
      event({
        alerts: {
          a: {
            action: "display",
            trigger: {
              "@type": "OffsetTrigger",
              offset: "-PT15M",
              relativeTo: "start",
            },
          },
          b: {
            action: "audio",
            trigger: {
              "@type": "OffsetTrigger",
              offset: "PT5M",
              relativeTo: "end",
            },
          },
          c: {
            action: "display",
            trigger: {
              "@type": "AbsoluteTrigger",
              when: "2026-10-24T07:00:00Z",
            },
          },
        },
      }),
    );
    expect(items.map((i) => [i.alarmId, i.triggerAt.toISOString()])).toEqual([
      ["a", "2026-10-24T07:45:00.000Z"],
      ["b", "2026-10-24T09:05:00.000Z"],
      ["c", "2026-10-24T07:00:00.000Z"],
    ]);
  });
  it("expands rules, excluded dates and moved overrides with stable occurrence keys", () => {
    const items = plan(
      event({
        recurrenceRules: [{ frequency: "daily", count: 4 }],
        recurrenceOverrides: {
          "2026-10-25T10:00:00": { excluded: true },
          "2026-10-26T10:00:00": {
            start: "2026-10-26T12:00:00",
            title: "Moved",
          },
        },
      }),
    );
    expect(times(items)).toEqual([
      ["2026-10-24T08:00:00.000Z", "2026-10-24T07:45:00.000Z"],
      ["2026-10-26T11:00:00.000Z", "2026-10-26T10:45:00.000Z"],
      ["2026-10-27T09:00:00.000Z", "2026-10-27T08:45:00.000Z"],
    ]);
    expect(items[1]).toMatchObject({
      occurrenceId: "event~20261026T100000",
      alarmId: "a",
      title: "Moved",
    });
  });
  it("handles all-day events and nominal day offsets across DST", () => {
    expect(
      times(
        plan(
          event({
            showWithoutTime: true,
            timeZone: null,
            start: "2026-10-26T00:00:00",
            duration: "P1D",
          }),
        ),
      ),
    ).toEqual([["2026-10-26T00:00:00.000Z", "2026-10-25T23:45:00.000Z"]]);
    const items = plan(
      event({
        start: "2026-10-25T10:00:00",
        alerts: {
          a: {
            action: "display",
            trigger: { "@type": "OffsetTrigger", offset: "-P1D" },
          },
        },
      }),
    );
    expect(times(items)).toEqual([
      ["2026-10-25T09:00:00.000Z", "2026-10-24T08:00:00.000Z"],
    ]);
  });
  it.each([
    [
      "Europe/Paris",
      "2026-03-30T00:00:00",
      "2026-03-29T22:00:00.000Z",
      "2026-03-28T23:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
    ],
    [
      "America/New_York",
      "2026-03-09T00:00:00",
      "2026-03-09T04:00:00.000Z",
      "2026-03-08T05:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
    ],
  ])(
    "uses %s for all-day reminders across DST",
    (zone, start, occurrence, dayBefore, fifteenHours) => {
      const input = event({
        showWithoutTime: true,
        timeZone: null,
        start,
        duration: "P1D",
        alerts: {
          day: {
            action: "display",
            trigger: { "@type": "OffsetTrigger", offset: "-P1D" },
          },
          apple: {
            action: "audio",
            trigger: { "@type": "OffsetTrigger", offset: "-PT15H" },
          },
        },
      });
      const items = planEvent(
        input,
        ["work"],
        Date.parse("2026-03-01T00:00:00Z"),
        Date.parse("2026-04-01T00:00:00Z"),
        zone,
      );
      expect(
        items.map((item) => [
          item.occurrenceStart.toISOString(),
          item.triggerAt.toISOString(),
        ]),
      ).toEqual([
        [occurrence, dayBefore],
        [occurrence, fifteenHours],
      ]);
    },
  );
  it("uses the user zone for floating timed events", () => {
    const items = planEvent(
      event({ timeZone: null }),
      ["work"],
      Date.parse("2026-10-20T00:00:00Z"),
      Date.parse("2026-11-01T00:00:00Z"),
      "America/New_York",
    );
    expect(times(items)).toEqual([
      ["2026-10-24T14:00:00.000Z", "2026-10-24T13:45:00.000Z"],
    ]);
  });
  it("ignores email, unsupported and already acknowledged alarms", () => {
    const trigger = { "@type": "OffsetTrigger", offset: "-PT15M" };
    const items = plan(
      event({
        alerts: {
          display: { action: "display", trigger },
          audio: { action: "audio", trigger },
          email: { action: "email", trigger },
          unknown: { trigger },
          done: {
            action: "display",
            trigger,
            acknowledged: "2026-10-24T07:46:00Z",
          },
          old: {
            action: "display",
            trigger,
            acknowledged: "2026-10-24T07:00:00Z",
          },
        },
      }),
    );
    expect(items.map((item) => item.alarmId)).toEqual([
      "display",
      "audio",
      "old",
    ]);
  });
  it("applies occurrence-specific alarm patches and fires absolute alarms once", () => {
    const items = plan(
      event({
        recurrenceRules: [{ frequency: "daily", count: 2 }],
        alerts: {
          a: {
            action: "display",
            trigger: { "@type": "OffsetTrigger", offset: "-PT15M" },
          },
          b: {
            action: "display",
            trigger: {
              "@type": "AbsoluteTrigger",
              when: "2026-10-24T07:00:00Z",
            },
          },
        },
        recurrenceOverrides: {
          "2026-10-25T10:00:00": { "alerts/a/trigger/offset": "-PT30M" },
        },
      }),
    );
    expect(items.map((i) => [i.alarmId, i.triggerAt.toISOString()])).toEqual([
      ["a", "2026-10-24T07:45:00.000Z"],
      ["b", "2026-10-24T07:00:00.000Z"],
      ["a", "2026-10-25T08:30:00.000Z"],
    ]);
  });
  it("includes distant occurrences when an override adds a long-offset alarm", () => {
    const items = plan(
      event({
        recurrenceRules: [{ frequency: "daily", count: 10 }],
        recurrenceOverrides: {
          "2026-10-30T10:00:00": {
            "alerts/extra": {
              action: "display",
              trigger: { "@type": "OffsetTrigger", offset: "-P5D" },
            },
          },
        },
      }),
      "2026-10-25T08:00:00Z",
      "2026-10-25T10:00:00Z",
    );
    expect(
      items.find((item) => item.alarmId === "extra")?.triggerAt.toISOString(),
    ).toBe("2026-10-25T09:00:00.000Z");
  });
});

describe("calendar reminder dispatch", () => {
  it("retries a failed delivery and respects privacy at the next attempt", async () => {
    const { createCalendarReminders } =
      await import("@opensuite/core/services/calendar-reminders");
    const reminder = plan(event())[0];
    if (!reminder) throw new Error("Missing reminder");
    let state = "pending";
    let claimed = false;
    let details = false;
    const payloads: { title: string; body?: string }[] = [];
    const job = createCalendarReminders({
      store: {
        users: () => Promise.resolve([]),
        acquire: () => Promise.resolve(null),
        release: () => Promise.resolve(),
        replace: () => Promise.resolve(true),
        skipExpired: () => Promise.resolve(),
        claim: () => {
          if (state !== "pending" || claimed) return Promise.resolve(null);
          claimed = true;
          return Promise.resolve({
            ...reminder,
            id: "id",
            userId: "owner",
            owner: "lease",
          });
        },
        finish: (_id, _owner, result) => {
          state = result;
          claimed = false;
          return Promise.resolve();
        },
        showDetails: () => Promise.resolve(details),
      },
      source: { read: () => Promise.resolve([]) },
      sender: {
        send: (_user, payload) => {
          payloads.push(payload);
          return Promise.resolve(details ? "sent" : "retry");
        },
      },
      now: () => new Date("2026-10-24T07:45:00Z"),
    });
    await job.dispatch();
    expect(state).toBe("retry");
    expect(payloads[0]).toMatchObject({ title: "Upcoming event" });
    expect(payloads[0]?.body).toBeUndefined();
    state = "pending";
    details = true;
    await job.dispatch();
    expect(state).toBe("sent");
    expect(payloads[1]).toMatchObject({ title: "Review" });
    expect(payloads[1]?.body).toContain("Room 4");
  });
});

describe("calendar reminder load handling", () => {
  it("dispatches a due job while a calendar scan is still running", async () => {
    const { createCalendarReminders } =
      await import("@opensuite/core/services/calendar-reminders");
    const sample = plan(event())[0];
    if (!sample) throw new Error("Missing reminder");
    let releaseScan: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let claimed = false;
    let sent = 0;
    const job = createCalendarReminders({
      store: {
        users: () =>
          Promise.resolve([{ id: "owner", email: "user@example.test" }]),
        acquire: () => Promise.resolve("lease"),
        release: () => Promise.resolve(),
        replace: () => Promise.resolve(true),
        skipExpired: () => Promise.resolve(),
        claim: () => {
          if (claimed) return Promise.resolve(null);
          claimed = true;
          return Promise.resolve({
            ...sample,
            id: "due",
            userId: "owner",
            owner: "worker",
          });
        },
        finish: () => {
          sent++;
          return Promise.resolve();
        },
        showDetails: () => Promise.resolve(false),
      },
      source: {
        read: async () => {
          await gate;
          return [];
        },
      },
      sender: { send: () => Promise.resolve("sent") },
      now: () => new Date("2026-10-24T07:45:00Z"),
    });
    const planning = job.plan();
    await job.dispatch();
    expect(sent).toBe(1);
    releaseScan();
    await planning;
  });
  it("drains more than 100 due jobs with bounded concurrent sends and opaque tags", async () => {
    const { createCalendarReminders } =
      await import("@opensuite/core/services/calendar-reminders");
    const sample = plan(event())[0];
    if (!sample) throw new Error("Missing reminder");
    let remaining = 250;
    let active = 0;
    let maximum = 0;
    let sent = 0;
    const job = createCalendarReminders({
      store: {
        users: () => Promise.resolve([]),
        acquire: () => Promise.resolve(null),
        release: () => Promise.resolve(),
        replace: () => Promise.resolve(true),
        skipExpired: () => Promise.resolve(),
        claim: () =>
          Promise.resolve(
            remaining-- > 0
              ? {
                  ...sample,
                  id: String(remaining),
                  userId: "owner",
                  owner: "lease",
                }
              : null,
          ),
        finish: () => {
          sent++;
          return Promise.resolve();
        },
        showDetails: () => Promise.resolve(false),
      },
      source: { read: () => Promise.resolve([]) },
      sender: {
        send: async (_user, payload) => {
          active++;
          maximum = Math.max(maximum, active);
          expect(payload.tag).toMatch(/^cal:[a-f0-9]{64}$/);
          expect(payload.tag).not.toContain("meeting");
          await Promise.resolve();
          active--;
          return "sent";
        },
      },
      now: () => new Date("2026-10-24T07:45:00Z"),
    });
    await job.dispatch();
    expect(sent).toBe(250);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });
  it("bounds calendar scans and aggregates upstream failures", async () => {
    const { createCalendarReminders } =
      await import("@opensuite/core/services/calendar-reminders");
    let active = 0;
    let maximum = 0;
    let warnings = 0;
    const job = createCalendarReminders({
      store: {
        users: () =>
          Promise.resolve(
            Array.from({ length: 12 }, (_, id) => ({
              id: String(id),
              email: "user@example.test",
            })),
          ),
        acquire: () => Promise.resolve("lease"),
        release: () => Promise.resolve(),
        replace: () => Promise.resolve(true),
        skipExpired: () => Promise.resolve(),
        claim: () => Promise.resolve(null),
        finish: () => Promise.resolve(),
        showDetails: () => Promise.resolve(false),
      },
      source: {
        read: async () => {
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active--;
          throw new Error("unavailable");
        },
      },
      sender: { send: () => Promise.resolve("sent") },
      onError: () => {
        warnings++;
      },
    });
    await job.plan();
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(warnings).toBe(1);
  });
});
