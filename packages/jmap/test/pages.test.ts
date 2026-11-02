import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { JmapClient, type Session } from "../src/index.ts";

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
const query = {
  accountId: "a",
  queryState: "s",
  canCalculateChanges: true,
  position: 0,
  ids: [],
};
const get = { accountId: "a", state: "s", list: [], notFound: [] };
const options = { filter: {}, position: 0, limit: 10 };

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function setup(methodResponses: unknown[]) {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ methodResponses, sessionState: "s" })),
    ),
  );
  return {
    client: new JmapClient("https://mail.example.test", {
      authorization: "Bearer test",
      fetch: fetcher,
    }),
    fetcher,
  };
}

describe("JMAP paged requests", () => {
  it("returns thread pages and keeps the query-to-thread result references", async () => {
    const { client, fetcher } = setup([
      ["Email/query", query, "query"],
      ["Email/get", get, "selected"],
      ["Thread/get", get, "threads"],
      ["Email/get", get, "emails"],
    ]);
    const result = await client.threadPage(session, "a", {
      ...options,
      sort: [],
    });
    expect(result.isOk()).toBe(true);
    expect(result.isOk() ? result.value.threads.list : null).toEqual([]);
    const body = z
      .object({
        methodCalls: z.array(
          z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
        ),
      })
      .parse(parseJson(z.string().parse(fetcher.mock.calls[0]?.[1]?.body)));
    expect(body.methodCalls[0]?.[1]["collapseThreads"]).toBe(true);
    expect(body.methodCalls[3]?.[1]["#ids"]).toEqual({
      resultOf: "threads",
      name: "Thread/get",
      path: "/list/*/emailIds/*",
    });
  });
  it("maps method errors and rejects wrong response ids in both page types", async () => {
    const thread = setup([
      ["Email/query", query, "query"],
      ["error", { type: "serverFail" }, "selected"],
      ["Thread/get", get, "threads"],
      ["Email/get", get, "emails"],
    ]);
    const failed = await thread.client.threadPage(session, "a", {
      ...options,
      sort: [],
    });
    expect(failed.isErr() && failed.error).toMatchObject({
      kind: "method",
      method: "Email/get",
      type: "serverFail",
    });
    const calendar = setup([
      ["CalendarEvent/query", query, "query"],
      ["CalendarEvent/get", get, "wrong"],
    ]);
    const invalid = await calendar.client.calendarEventPage(
      session,
      "a",
      options,
    );
    expect(invalid.isErr() && invalid.error).toMatchObject({
      kind: "invalidResponse",
      message: "Unexpected method response id",
    });
  });
  it("returns calendar pages with full events", async () => {
    const { client, fetcher } = setup([
      ["CalendarEvent/query", query, "query"],
      ["CalendarEvent/get", get, "events"],
    ]);
    const result = await client.calendarEventPage(session, "a", options);
    expect(result.isOk()).toBe(true);
    expect(result.isOk() ? result.value.events.list : null).toEqual([]);
    const body = z
      .object({
        methodCalls: z.array(
          z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
        ),
      })
      .parse(parseJson(z.string().parse(fetcher.mock.calls[0]?.[1]?.body)));
    expect(body.methodCalls[1]?.[1]["#ids"]).toEqual({
      resultOf: "query",
      name: "CalendarEvent/query",
      path: "/ids",
    });
    expect(body.methodCalls[1]?.[1]).not.toHaveProperty("properties");
  });
});
