import { describe, expect, it, vi } from "vitest";
import { ok } from "neverthrow";
import { z } from "zod";
import {
  JmapClient,
  previewCalendarEvent,
  type Session,
} from "../src/index.ts";

const session: Session = {
  capabilities: {},
  accounts: {},
  primaryAccounts: {},
  username: "user",
  apiUrl: "https://mail.example.test/jmap/",
  uploadUrl: "https://mail.example.test/upload/{accountId}",
  downloadUrl: "https://mail.example.test/download/{blobId}",
  state: "a",
};
describe("calendar import writes", () => {
  it("previews a conflicting source even after its imported event was deleted", () => {
    const identity = { source: "original.ics", eventId: "deleted-event" };
    expect(
      previewCalendarEvent({ uid: "u" }, [], identity, "calendar", "other.ics"),
    ).toMatchObject({
      previewState: "conflict",
      previewReason: "UID belongs to a different source",
    });
    expect(
      previewCalendarEvent(
        { uid: "u" },
        [],
        identity,
        "calendar",
        "original.ics",
      ),
    ).toMatchObject({ previewState: "new" });
  });
  it("explicitly disables scheduling for creates and exception updates and passes the state guard", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      const parsed: unknown = JSON.parse(z.string().parse(init?.body));
      const request = z
        .object({
          methodCalls: z.array(
            z.tuple([
              z.string(),
              z.record(z.string(), z.unknown()),
              z.string(),
            ]),
          ),
        })
        .parse(parsed);
      const args = request.methodCalls[0]?.[1];
      const body = args?.["create"]
        ? {
            accountId: "a",
            oldState: "s",
            newState: "t",
            created: { item: { id: "e" } },
          }
        : {
            accountId: "a",
            oldState: "s",
            newState: "t",
            updated: { e: null },
          };
      return Promise.resolve(
        Response.json({
          methodResponses: [["CalendarEvent/set", body, "0"]],
          sessionState: "s",
        }),
      );
    });
    const client = new JmapClient("https://mail.example.test", {
      authorization: "Bearer test",
      fetch: fetcher,
    });
    expect(
      (
        await client.importCalendarEvent(session, "a", { uid: "u" }, "state1")
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await client.importCalendarOverrides(
          session,
          "a",
          "e",
          { "2026-01-02T09:00:00": { title: "Moved" } },
          "state2",
          true,
        )
      ).isOk(),
    ).toBe(true);
    const calls = fetcher.mock.calls.map((call) => {
      const parsed: unknown = JSON.parse(z.string().parse(call[1]?.body));
      return z
        .object({
          methodCalls: z.array(
            z.tuple([
              z.string(),
              z.record(z.string(), z.unknown()),
              z.string(),
            ]),
          ),
        })
        .parse(parsed).methodCalls[0]?.[1];
    });
    expect(calls[1]?.["update"]).toEqual({
      e: { "recurrenceOverrides/2026-01-02T09:00:00": { title: "Moved" } },
    });
    expect(calls).toMatchObject([
      { ifInState: "state1", sendSchedulingMessages: false },
      { ifInState: "state2", sendSchedulingMessages: false },
    ]);
  });
  it("rejects a query/read race and incomplete pages before returning a UID scan", async () => {
    const client = new JmapClient("https://mail.example.test", {
      authorization: "Bearer test",
    });
    const query = {
      accountId: "a",
      queryState: "old",
      canCalculateChanges: true,
      position: 0,
      ids: [],
    };
    const events = {
      accountId: "a",
      state: "after-write",
      list: [],
      notFound: [],
    };
    const page = vi.spyOn(client, "calendarEventPage");
    page.mockResolvedValueOnce(ok({ query, events }));
    page.mockResolvedValueOnce(
      ok({ query: { ...query, queryState: "new" }, events }),
    );
    const raced = await client.scanCalendarUid(session, "a", "u");
    expect(raced.isErr() && raced.error).toMatchObject({
      kind: "method",
      type: "stateMismatch",
    });
    page.mockResolvedValueOnce(
      ok({ query: { ...query, ids: ["missing"] }, events }),
    );
    const incomplete = await client.scanCalendarUid(session, "a", "u");
    expect(incomplete.isErr() && incomplete.error).toMatchObject({
      kind: "method",
      type: "stateMismatch",
    });
  });
});
