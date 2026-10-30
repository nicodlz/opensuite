import { createReadinessService } from "@opensuite/core";
import type {
  CalendarFailureKind,
  CalendarService,
} from "@opensuite/core/services/calendar";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.ts";

const calendar = {
  id: "cal",
  name: "Work",
  color: "#1f9d8b",
  isDefault: true,
};
const event = {
  calendarId: "cal",
  title: "Planning",
  description: "",
  location: "",
  start: "2026-10-14T08:00:00.000Z",
  end: "2026-10-14T09:00:00.000Z",
  allDay: false,
  timeZone: "Europe/Paris",
  recurrence: "none" as const,
};
const calls: { method: string; actor: string; accountId: string }[] = [];
const failing = (kind: CalendarFailureKind) => err({ kind });
// The service owns account resolution; this stub records how the router calls it.
const service: CalendarService = {
  calendars: (actor, accountId) => {
    calls.push({ method: "calendars", actor: actor.id, accountId });
    return Promise.resolve(
      accountId === "default"
        ? ok({ calendars: [calendar] })
        : failing("forbidden"),
    );
  },
  createCalendar: (_actor, _accountId, input) =>
    Promise.resolve(ok({ ...calendar, ...input, id: "new", isDefault: false })),
  events: (_actor, _accountId, range) =>
    Promise.resolve(
      range.calendarIds?.includes("missing")
        ? failing("not_found")
        : ok({ events: [{ ...event, id: "e~1", seriesId: "e" }] }),
    ),
  createEvent: (_actor, _accountId, content) =>
    Promise.resolve(
      content.title === "conflict"
        ? failing("conflict")
        : ok({ ...content, id: "e", seriesId: "e" }),
    ),
  updateEvent: (_actor, _accountId, eventId, content) =>
    Promise.resolve(
      eventId === "gone"
        ? failing("not_found")
        : ok({ ...content, id: eventId, seriesId: "e" }),
    ),
  deleteEvent: () => Promise.resolve(failing("unavailable")),
};
const now = () => performance.now();
const start = (calendarService?: CalendarService) =>
  buildServer({
    config: { logLevel: "silent" },
    monotonicMs: now,
    readiness: createReadinessService({
      probes: [],
      timeoutMs: 500,
      now: () => new Date(),
      monotonicMs: now,
    }),
    ...(calendarService === undefined ? {} : { calendar: calendarService }),
    identity: {
      publicOrigin: "https://suite.example.test",
      handler: () => Promise.resolve(new Response()),
      actor: (headers) => {
        const id = headers.get("cookie");
        return Promise.resolve(
          id === "owner"
            ? { id, email: `${id}@example.test`, role: "user" }
            : null,
        );
      },
    },
  });
const headers = { origin: "https://suite.example.test", cookie: "owner" };

describe("calendar API", () => {
  it("requires a session and a same-origin request before calling the service", async () => {
    const app = await start(service);
    try {
      calls.length = 0;
      const payload = { accountId: "default" };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/calendar/calendars",
            headers: { origin: headers.origin },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/calendar/calendars",
            headers: { ...headers, origin: "https://evil.example.test" },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(calls).toHaveLength(0);
      const response = await app.inject({
        method: "POST",
        url: "/calendar/calendars",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ calendars: [calendar] });
      expect(calls).toEqual([
        { method: "calendars", actor: "owner", accountId: "default" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("maps service failures and contract validation to HTTP errors", async () => {
    const app = await start(service);
    const post = (url: string, payload: object) =>
      app.inject({ method: "POST", url, headers, payload });
    try {
      expect(
        (await post("/calendar/calendars", { accountId: "other" })).json(),
      ).toMatchObject({ code: "FORBIDDEN", status: 403 });
      const missing = await post("/calendar/events", {
        accountId: "default",
        start: "2026-10-12T00:00:00Z",
        end: "2026-10-19T00:00:00Z",
        calendarIds: ["missing"],
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });
      expect(
        (
          await post("/calendar/events/create", {
            accountId: "default",
            event: { ...event, title: "conflict" },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post("/calendar/events/create", {
            accountId: "default",
            event: { ...event, start: "tomorrow" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await post("/calendar/calendars/create", {
            accountId: "default",
            name: "Home",
            color: "blue",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await post("/calendar/events/update", {
            accountId: "default",
            eventId: "gone",
            event,
          })
        ).statusCode,
      ).toBe(404);
      const unavailable = await post("/calendar/events/delete", {
        accountId: "default",
        eventId: "e",
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
      const listed = await post("/calendar/events", {
        accountId: "default",
        start: "2026-10-12T00:00:00Z",
        end: "2026-10-19T00:00:00Z",
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ events: [{ id: "e~1" }] });
    } finally {
      await app.close();
    }
  });

  it("answers 503 when the calendar service is not configured", async () => {
    const app = await start();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/calendar/calendars",
        headers,
        payload: { accountId: "default" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        message: "Calendar service unavailable",
      });
    } finally {
      await app.close();
    }
  });
});
