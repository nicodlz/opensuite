import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { EventContent } from "@opensuite/contracts";
import { JmapClient } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { ok, type Result } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCalendarService } from "../src/services/calendar.ts";

const run = promisify(execFile);
const project = `opensuite-calendar-${randomBytes(6).toString("hex")}`;
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
const password = "cobalt-rocket-forest-9381!";
const actor = {
  id: "owner",
  email: "alice@example.test",
  role: "user",
} satisfies { id: string; email: string; role: "user" };
let base = "";
let service: ReturnType<typeof createCalendarService>;
const pause = async () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });
const ready = async (attempts: number): Promise<void> => {
  try {
    if ((await fetch(`${base}/healthz/ready`)).ok) return;
  } catch {
    /* starting */
  }
  if (!attempts) throw new Error("Stalwart did not start");
  await pause();
  return ready(attempts - 1);
};
const unwrap = <T>(result: Result<T, { kind: string }>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(JSON.stringify(error));
    },
  );
// This direct-listener fixture advertises the container hostname; map the
// advertised endpoint paths to the published port.
const localFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const requestUrl = input instanceof Request ? input.url : input.toString();
  if (
    init?.method !== "POST" &&
    (requestUrl.endsWith("/.well-known/jmap") ||
      requestUrl.endsWith("/jmap/session")) &&
    response.ok
  ) {
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null)
      throw new Error("Bad session");
    const endpoints = Object.fromEntries(
      ["apiUrl", "uploadUrl", "downloadUrl"].map((key) => {
        const entry: unknown = Object.getOwnPropertyDescriptor(
          data,
          key,
        )?.value;
        if (typeof entry !== "string") throw new Error("Missing session URL");
        const original = new URL(entry);
        return [
          key,
          `${base}${original.pathname}${original.search}`
            .replaceAll("%7B", "{")
            .replaceAll("%7D", "}"),
        ];
      }),
    );
    return Response.json({ ...data, ...endpoints });
  }
  return response;
};
beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    if (!port) throw new Error("Missing port");
    base = `http://127.0.0.1:${port}`;
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = unwrap(await admin.createDomain("example.test"));
    const alice = unwrap(
      await admin.createAccount("alice", domain.id, password),
    );
    service = createCalendarService({
      origin: base,
      store: {
        getForOwner: (userId, accountId) =>
          Promise.resolve(
            ok({
              accountId:
                userId === actor.id && accountId === "default"
                  ? alice.id
                  : "different",
              address: actor.email,
              secret: password,
            }),
          ),
      },
      client: (credential) =>
        new JmapClient(base, {
          authorization: `Basic ${Buffer.from(`${credential.address}:${credential.secret}`).toString("base64")}`,
          fetch: localFetch,
        }),
    });
  } catch (error) {
    process.stderr.write(`Calendar test setup failed: ${String(error)}\n`);
    await compose("down", "--volumes", "--remove-orphans").catch(
      () => undefined,
    );
    throw error;
  }
}, 120_000);
afterAll(async () => {
  await compose("down", "--volumes", "--remove-orphans");
}, 60_000);

describe("calendar service with Stalwart", () => {
  it("creates calendars and timed, all-day and recurring events, and queries a DST range", async () => {
    expect(
      (await service.calendars(actor, "other")).match(
        () => "allowed",
        (error) => error.kind,
      ),
    ).toBe("forbidden");
    const initial = unwrap(await service.calendars(actor, "default")).calendars;
    expect(initial.filter((item) => item.isDefault)).toHaveLength(1);
    const work = unwrap(
      await service.createCalendar(actor, "default", {
        name: "Work",
        color: "#1F9D8B",
      }),
    );
    expect(
      unwrap(await service.calendars(actor, "default")).calendars,
    ).toContainEqual({ ...work, color: "#1f9d8b", isDefault: false });
    const content = (overrides: Partial<EventContent>): EventContent => ({
      calendarId: work.id,
      title: "Review",
      description: "Quarterly numbers",
      location: "Room 4",
      start: "2026-10-23T12:00:00.000Z",
      end: "2026-10-23T13:30:00.000Z",
      allDay: false,
      timeZone: "Europe/Paris",
      recurrence: "none",
      ...overrides,
    });
    const timed = unwrap(
      await service.createEvent(actor, "default", content({})),
    );
    expect(timed).toMatchObject({
      id: timed.seriesId,
      start: "2026-10-23T12:00:00.000Z",
      end: "2026-10-23T13:30:00.000Z",
      location: "Room 4",
      timeZone: "Europe/Paris",
    });
    const weekly = unwrap(
      await service.createEvent(
        actor,
        "default",
        content({
          title: "Stand-up",
          location: "",
          start: "2026-10-14T08:00:00.000Z",
          end: "2026-10-14T08:15:00.000Z",
          recurrence: "weekly",
        }),
      ),
    );
    const allDay = unwrap(
      await service.createEvent(
        actor,
        "default",
        content({
          calendarId: initial[0]?.id ?? "",
          title: "Conference",
          start: "2026-10-26T00:00:00.000Z",
          end: "2026-10-29T00:00:00.000Z",
          allDay: true,
          timeZone: "UTC",
        }),
      ),
    );
    const range = {
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-11-02T00:00:00.000Z",
    };
    const listed = unwrap(await service.events(actor, "default", range)).events;
    expect(
      listed.map((item) => [item.title, item.start, item.end, item.allDay]),
    ).toEqual([
      [
        "Stand-up",
        "2026-10-21T08:00:00.000Z",
        "2026-10-21T08:15:00.000Z",
        false,
      ],
      ["Review", "2026-10-23T12:00:00.000Z", "2026-10-23T13:30:00.000Z", false],
      [
        "Conference",
        "2026-10-26T00:00:00.000Z",
        "2026-10-29T00:00:00.000Z",
        true,
      ],
      // After the switch to winter time 10:00 Paris is 09:00 UTC.
      [
        "Stand-up",
        "2026-10-28T09:00:00.000Z",
        "2026-10-28T09:15:00.000Z",
        false,
      ],
    ]);
    expect(
      unwrap(
        await service.events(actor, "default", {
          ...range,
          calendarIds: [work.id],
        }),
      ).events.map((item) => item.title),
    ).toEqual(["Stand-up", "Review", "Stand-up"]);

    const moved = unwrap(
      await service.updateEvent(actor, "default", timed.id, {
        ...content({}),
        title: "Review (moved)",
        start: "2026-10-23T14:00:00.000Z",
        end: "2026-10-23T15:00:00.000Z",
      }),
    );
    expect(moved).toMatchObject({
      title: "Review (moved)",
      start: "2026-10-23T14:00:00.000Z",
      end: "2026-10-23T15:00:00.000Z",
      location: "Room 4",
    });
    const occurrence = listed[3];
    if (occurrence === undefined) throw new Error("Missing occurrence");
    expect(occurrence.seriesId).toBe(weekly.seriesId);
    unwrap(
      await service.updateEvent(actor, "default", occurrence.id, {
        ...occurrence,
        start: "2026-10-28T09:30:00.000Z",
        end: "2026-10-28T10:00:00.000Z",
      }),
    );
    const shifted = unwrap(await service.events(actor, "default", range))
      .events.filter((item) => item.seriesId === weekly.seriesId)
      .map((item) => [item.start, item.end, item.recurrence]);
    expect(shifted).toEqual([
      ["2026-10-21T08:30:00.000Z", "2026-10-21T09:00:00.000Z", "weekly"],
      ["2026-10-28T09:30:00.000Z", "2026-10-28T10:00:00.000Z", "weekly"],
    ]);

    const deleted = await Promise.all(
      [timed.id, occurrence.id, allDay.id].map((id) =>
        service.deleteEvent(actor, "default", id),
      ),
    );
    expect(deleted.map(unwrap)).toEqual([
      { success: true },
      { success: true },
      { success: true },
    ]);
    expect(
      unwrap(await service.events(actor, "default", range)).events,
    ).toEqual([]);
    expect(
      (await service.deleteEvent(actor, "default", timed.id)).match(
        () => "deleted",
        (error) => error.kind,
      ),
    ).toBe("not_found");
  });
});
