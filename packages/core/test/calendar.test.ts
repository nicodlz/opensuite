import type { EventContent } from "@opensuite/contracts";
import { JmapClient } from "@opensuite/jmap";
import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCalendarService } from "../src/services/calendar.ts";

const origin = "https://mail.example.test";
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user",
} satisfies { id: string; email: string; role: "user" };
type Item = Record<string, unknown> & { id: string };
const Records = z.record(z.string(), z.record(z.string(), z.unknown()));
const Ids = z.array(z.string());
const Call = z.tuple([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.string(),
]);
type Call = z.infer<typeof Call>;
const Body = z.object({ methodCalls: z.array(Call) });

/** A small in-memory JMAP Calendars server with the Stalwart behaviour we rely on. */
function fakeServer() {
  const calendars = new Map<string, Item>();
  const events = new Map<string, Item>();
  const requests: { method: string; args: Record<string, unknown> }[] = [];
  let next = 0;
  const handle = (
    [method, args, id]: Call,
    previous: Map<string, unknown>,
  ): Call => {
    requests.push({ method, args });
    const records = (key: string) => Records.parse(args[key] ?? {});
    const ids = () => {
      const reference = z
        .object({ resultOf: z.string() })
        .optional()
        .parse(args["#ids"]);
      return reference === undefined
        ? (Ids.nullish().parse(args["ids"]) ?? [])
        : z.object({ ids: Ids }).parse(previous.get(reference.resultOf)).ids;
    };
    if (method === "Calendar/get")
      return [
        method,
        {
          accountId: "jmap",
          state: "s",
          list: [...calendars.values()],
          notFound: [],
        },
        id,
      ];
    if (method === "Calendar/set") {
      const created: Record<string, { id: string }> = {};
      for (const [key, value] of Object.entries(records("create"))) {
        next += 1;
        const item = { ...value, id: `c${next}`, isDefault: false };
        if (args["onSuccessSetIsDefault"] === `#${key}`) {
          for (const calendar of calendars.values())
            calendar["isDefault"] = false;
          item.isDefault = true;
        }
        calendars.set(item.id, item);
        created[key] = { id: item.id };
      }
      return [method, { accountId: "jmap", created }, id];
    }
    if (method === "CalendarEvent/query") {
      const all = [...events.keys()].toSorted();
      const position = Number(args["position"] ?? 0);
      const limit = Number(args["limit"] ?? all.length);
      return [
        method,
        {
          accountId: "jmap",
          queryState: "q",
          canCalculateChanges: false,
          position,
          ids: all.slice(position, position + limit),
        },
        id,
      ];
    }
    if (method === "CalendarEvent/get") {
      const wanted = ids();
      return [
        method,
        {
          accountId: "jmap",
          state: "s",
          list: wanted.flatMap((key) => events.get(key) ?? []),
          notFound: wanted.filter((key) => !events.has(key)),
        },
        id,
      ];
    }
    if (method === "CalendarEvent/set") {
      const result: Record<string, unknown> = { accountId: "jmap" };
      for (const [key, value] of Object.entries(records("create"))) {
        next += 1;
        events.set(`e${next}`, { ...value, id: `e${next}` });
        result["created"] = { [key]: { id: `e${next}` } };
      }
      for (const [key, patch] of Object.entries(records("update"))) {
        const item = events.get(key);
        if (item === undefined) {
          result["notUpdated"] = { [key]: { type: "notFound" } };
          continue;
        }
        for (const [property, value] of Object.entries(patch))
          if (value === null) delete item[property];
          else item[property] = value;
        result["updated"] = { [key]: null };
      }
      for (const key of Ids.parse(args["destroy"] ?? []))
        if (events.delete(key)) result["destroyed"] = [key];
        else result["notDestroyed"] = { [key]: { type: "notFound" } };
      return [method, result, id];
    }
    return ["error", { type: "unknownMethod" }, id];
  };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (init?.method !== "POST")
      return Response.json({
        capabilities: {},
        accounts: {},
        primaryAccounts: { "urn:ietf:params:jmap:calendars": "jmap" },
        username: actor.email,
        apiUrl: `${origin}/jmap`,
        uploadUrl: `${origin}/upload/{accountId}`,
        downloadUrl: `${origin}/download/{accountId}/{blobId}/{name}`,
        state: "s",
      });
    const body = Body.parse(await new Response(init.body).json());
    const previous = new Map<string, unknown>();
    const methodResponses = body.methodCalls.map((call) => {
      const response = handle(call, previous);
      previous.set(response[2], response[1]);
      return response;
    });
    return Response.json({ methodResponses, sessionState: "s" });
  };
  return { calendars, events, requests, fetch };
}
const setup = () => {
  const server = fakeServer();
  const service = createCalendarService({
    origin,
    store: {
      getForOwner: (userId, accountId) =>
        Promise.resolve(
          userId === "alice" && ["default", "owned"].includes(accountId)
            ? ok({ accountId: "owned", address: actor.email, secret: "s" })
            : err({ kind: "not_found" }),
        ),
    },
    client: () =>
      new JmapClient(origin, { authorization: "Basic x", fetch: server.fetch }),
  });
  return { server, service };
};
const unwrap = <T>(result: Result<T, { kind: string }>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(JSON.stringify(error));
    },
  );
const failure = <T>(result: Result<T, { kind: string }>) =>
  result.match(
    () => {
      throw new Error("Expected failure");
    },
    (error) => error.kind,
  );
const event = (overrides: Partial<EventContent> = {}): EventContent => ({
  calendarId: "work",
  title: "Stand-up",
  description: "",
  location: "",
  start: "2026-10-14T08:00:00.000Z",
  end: "2026-10-14T08:30:00.000Z",
  allDay: false,
  timeZone: "Europe/Paris",
  recurrence: "none",
  ...overrides,
});

describe("calendar service", () => {
  it("creates one default calendar for concurrent first loads and normalizes colors", async () => {
    const { server, service } = setup();
    const [first, second] = await Promise.all([
      service.calendars(actor, "default"),
      service.calendars(actor, "default"),
    ]);
    expect(unwrap(first).calendars).toEqual([
      { id: "c1", name: "Calendar", color: "#7c5cff", isDefault: true },
    ]);
    expect(unwrap(second).calendars).toHaveLength(1);
    server.calendars.set("c9", {
      id: "c9",
      name: "Imported",
      color: "#ABC",
      sortOrder: 2,
    });
    server.calendars.set("c8", {
      id: "c8",
      name: "Legacy",
      color: "teal",
      sortOrder: 1,
    });
    expect(unwrap(await service.calendars(actor, "default")).calendars).toEqual(
      [
        { id: "c1", name: "Calendar", color: "#7c5cff", isDefault: true },
        { id: "c8", name: "Legacy", color: "#1f9d8b", isDefault: false },
        { id: "c9", name: "Imported", color: "#aabbcc", isDefault: false },
      ],
    );
  });

  it("scopes access to the session owner before any JMAP request", async () => {
    const { server, service } = setup();
    expect(
      failure(await service.calendars({ ...actor, id: "bob" }, "default")),
    ).toBe("forbidden");
    expect(
      failure(
        await service.events(actor, "other", {
          start: "2026-10-12T00:00:00Z",
          end: "2026-10-19T00:00:00Z",
        }),
      ),
    ).toBe("forbidden");
    expect(server.requests).toHaveLength(0);
  });

  it("validates ranges, timing and calendar ownership", async () => {
    const { server, service } = setup();
    server.calendars.set("work", { id: "work", name: "Work", color: null });
    server.calendars.set("shared", {
      id: "shared",
      name: "Shared",
      myRights: { mayWriteAll: false },
    });
    const range = {
      start: "2026-10-12T00:00:00Z",
      end: "2026-10-12T00:00:00Z",
    };
    expect(failure(await service.events(actor, "default", range))).toBe(
      "validation",
    );
    expect(
      failure(
        await service.events(actor, "default", {
          start: "2026-01-01T00:00:00Z",
          end: "2027-06-01T00:00:00Z",
        }),
      ),
    ).toBe("validation");
    expect(
      failure(
        await service.events(actor, "default", {
          start: "2026-10-12T00:00:00Z",
          end: "2026-10-19T00:00:00Z",
          calendarIds: ["missing"],
        }),
      ),
    ).toBe("not_found");
    expect(
      failure(
        await service.createEvent(
          actor,
          "default",
          event({ end: "2026-10-14T07:00:00.000Z" }),
        ),
      ),
    ).toBe("validation");
    expect(
      failure(
        await service.createEvent(
          actor,
          "default",
          event({ timeZone: "Not/AZone" }),
        ),
      ),
    ).toBe("validation");
    expect(
      failure(
        await service.createEvent(
          actor,
          "default",
          event({ calendarId: "elsewhere" }),
        ),
      ),
    ).toBe("not_found");
    expect(
      failure(
        await service.createEvent(
          actor,
          "default",
          event({ calendarId: "shared" }),
        ),
      ),
    ).toBe("forbidden");
    expect(server.events.size).toBe(0);
    expect(
      failure(await service.deleteEvent(actor, "default", "missing")),
    ).toBe("not_found");
  });

  it("creates, expands, updates through an occurrence and deletes a series", async () => {
    const { server, service } = setup();
    server.calendars.set("work", { id: "work", name: "Work", color: null });
    server.calendars.set("home", { id: "home", name: "Home", color: null });
    const created = unwrap(
      await service.createEvent(
        actor,
        "default",
        event({ recurrence: "weekly", location: "Room 1" }),
      ),
    );
    expect(created).toMatchObject({
      id: `${created.seriesId}~20261014T100000`,
      start: "2026-10-14T08:00:00.000Z",
      end: "2026-10-14T08:30:00.000Z",
      recurrence: "weekly",
      location: "Room 1",
    });
    expect(server.events.get(created.seriesId)).toMatchObject({
      start: "2026-10-14T10:00:00",
      duration: "PT30M",
      timeZone: "Europe/Paris",
    });
    const range = {
      start: "2026-10-19T00:00:00.000Z",
      end: "2026-11-02T00:00:00.000Z",
    };
    const writes = server.requests.length;
    const listed = unwrap(await service.events(actor, "default", range)).events;
    expect(listed.map((item) => item.start)).toEqual([
      "2026-10-21T08:00:00.000Z",
      "2026-10-28T09:00:00.000Z",
    ]);
    expect(
      server.requests
        .slice(writes)
        .some((request) => request.method === "CalendarEvent/set"),
    ).toBe(false);
    expect(
      server.requests.find(
        (request) => request.method === "CalendarEvent/query",
      )?.args,
    ).toMatchObject({
      filter: { before: "2026-11-02T00:00:00Z" },
      position: 0,
      limit: 500,
    });
    expect(
      unwrap(
        await service.events(actor, "default", {
          ...range,
          calendarIds: ["home"],
        }),
      ).events,
    ).toEqual([]);
    const occurrence = listed[1];
    if (occurrence === undefined) throw new Error("Expected occurrence");
    const updated = unwrap(
      await service.updateEvent(actor, "default", occurrence.id, {
        ...occurrence,
        title: "Sync",
        start: "2026-10-28T10:00:00.000Z",
        end: "2026-10-28T11:00:00.000Z",
      }),
    );
    expect(updated).toMatchObject({
      seriesId: created.seriesId,
      title: "Sync",
      start: "2026-10-14T09:00:00.000Z",
      end: "2026-10-14T10:00:00.000Z",
    });
    expect(
      failure(
        await service.updateEvent(
          actor,
          "default",
          `${created.seriesId}~nonsense`,
          occurrence,
        ),
      ),
    ).toBe("not_found");
    expect(
      unwrap(await service.deleteEvent(actor, "default", occurrence.id)),
    ).toEqual({ success: true });
    expect(server.events.size).toBe(0);
  });

  it("reads every page of candidate events", async () => {
    const { server, service } = setup();
    server.calendars.set("work", { id: "work", name: "Work" });
    for (let index = 0; index < 501; index += 1)
      server.events.set(`e${String(index).padStart(4, "0")}`, {
        id: `e${String(index).padStart(4, "0")}`,
        calendarIds: { work: true },
        title: `Event ${index}`,
        start: "2026-10-14T10:00:00",
        duration: "PT1H",
        timeZone: "UTC",
      });
    const listed = unwrap(
      await service.events(actor, "default", {
        start: "2026-10-14T00:00:00Z",
        end: "2026-10-15T00:00:00Z",
      }),
    ).events;
    expect(listed).toHaveLength(501);
    expect(
      server.requests
        .filter((request) => request.method === "CalendarEvent/query")
        .map((request) => request.args["position"]),
    ).toEqual([0, 500]);
  });
});
