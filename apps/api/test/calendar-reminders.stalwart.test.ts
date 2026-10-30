/* oxlint-disable typescript/require-await */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { JmapClient } from "@opensuite/jmap";
import { createCalendarReminderSource } from "@opensuite/core/services/calendar-reminder-plan";
import { createCalendarReminders } from "@opensuite/core/services/calendar-reminders";
import type { PlannedCalendarReminder } from "@opensuite/db";
import type { CalendarReminderStore } from "@opensuite/core/services/calendar-reminders";
import type { NotificationPayload } from "@opensuite/core/services/notifications";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { ok, type Result } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCalendarService } from "@opensuite/core/services/calendar";

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

describe("CalDAV alarm interoperability", () => {
  it("reads an event and its alarm through JMAP", async () => {
    const calendars = unwrap(
      await service.calendars(actor, "default"),
    ).calendars;
    expect(calendars.length).toBeGreaterThan(0);
    const auth = `Basic ${Buffer.from(`${actor.email}:${password}`).toString("base64")}`;
    const response = await fetch(
      `${base}/dav/cal/${encodeURIComponent(actor.email)}/default/reminder.ics`,
      {
        method: "PUT",
        headers: {
          Authorization: auth,
          "Content-Type": "text/calendar; charset=utf-8",
        },
        body: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//Esuno//Test//EN",
          "BEGIN:VEVENT",
          "UID:reminder-integration",
          "DTSTAMP:20261020T000000Z",
          "DTSTART:20261024T100000Z",
          "DTEND:20261024T110000Z",
          "SUMMARY:Live reminder",
          "LOCATION:Room 4",
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          "DESCRIPTION:Reminder",
          "TRIGGER:-PT1M",
          "END:VALARM",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
      },
    );
    expect(response.status).toBe(201);
    const client = new JmapClient(base, {
      authorization: auth,
      fetch: localFetch,
    });
    const session = unwrap(await client.discover());
    const id = session.primaryAccounts["urn:ietf:params:jmap:calendars"] ?? "";
    const page = unwrap(
      await client.calendarEventPage(session, id, {
        filter: {},
        position: 0,
        limit: 500,
      }),
    );
    expect(page.events.list[0]?.alerts).toBeDefined();
    const originalAlarmId = Object.keys(page.events.list[0]?.alerts ?? {})[0];
    expect(originalAlarmId).toBeDefined();
    const source = createCalendarReminderSource({
      origin: base,
      store: {
        getForOwner: () =>
          Promise.resolve(
            ok({
              accountId: "fixture",
              address: actor.email,
              secret: password,
            }),
          ),
      },
      client: () => client,
    });
    const planned = await source.read(
      actor,
      new Date("2026-10-24T09:58:00Z"),
      new Date("2026-10-24T10:01:00Z"),
    );
    expect(planned).toMatchObject([
      {
        uid: "reminder-integration",
        title: "Live reminder",
        location: "Room 4",
        triggerAt: new Date("2026-10-24T09:59:00Z"),
      },
    ]);
    let pending: PlannedCalendarReminder | undefined;
    let sent = false;
    let claimed = false;
    const store: CalendarReminderStore = {
      users: async () => [actor],
      acquire: async () => "lease",
      release: async () => {},
      replace: async (
        _id: string,
        _owner: string,
        _now: Date,
        _grace: Date,
        rows: PlannedCalendarReminder[],
      ) => {
        if (!sent) pending = rows[0];
        return true;
      },
      skipExpired: async () => {},
      claim: async () => {
        if (pending === undefined || sent || claimed) return null;
        claimed = true;
        return { ...pending, id: "job", userId: actor.id, owner: "worker" };
      },
      finish: async (_id: string, _owner: string, state: string) => {
        sent = state === "sent";
        claimed = false;
      },
      showDetails: async () => true,
    };
    const send = vi.fn<
      (
        user: string,
        payload: NotificationPayload,
        ttl: number,
      ) => Promise<"sent">
    >(
      async (_user: string, _payload: NotificationPayload, _ttl: number) =>
        "sent" as const,
    );
    const job = createCalendarReminders({
      store,
      source,
      sender: { send },
      now: () => new Date("2026-10-24T09:59:00Z"),
    });
    await job.plan();
    await job.dispatch();
    await job.plan();
    await job.dispatch();
    expect(send).toHaveBeenCalledTimes(1);
    const [user, payload, ttl] = send.mock.calls[0] ?? [];
    expect(user).toBe("owner");
    expect(payload?.title).toBe("Live reminder");
    expect(payload?.body).toContain("Room 4");
    expect(payload?.tag).toMatch(/^cal:[a-f0-9]{64}$/);
    expect(payload?.icon).toBe("/icons/calendar-192.png");
    expect(payload?.url).toContain("/calendar?event=");
    expect(ttl).toBe(60);
    const events = unwrap(
      await service.events(actor, "default", {
        start: "2026-10-24T00:00:00Z",
        end: "2026-10-25T00:00:00Z",
      }),
    ).events;
    const original = events[0];
    if (!original) throw new Error("Missing event");
    expect(original.reminder).toBe("custom");
    const updated = unwrap(
      await service.updateEvent(actor, "default", original.id, {
        ...original,
        reminder: "5m",
      }),
    );
    expect(updated.reminder).toBe("5m");
    const updatedPage = unwrap(
      await client.calendarEventPage(session, id, {
        filter: {},
        position: 0,
        limit: 500,
      }),
    );
    expect(Object.keys(updatedPage.events.list[0]?.alerts ?? {})).toEqual([
      originalAlarmId,
    ]);
    const ics = await fetch(
      `${base}/dav/cal/${encodeURIComponent(actor.email)}/default/reminder.ics`,
      { headers: { Authorization: auth } },
    );
    const text = await ics.text();
    expect(ics.status).toBe(200);
    expect(text).toContain("BEGIN:VALARM");
    expect(text).toContain("TRIGGER;RELATED=START:-PT5M");
  });
});
