import { describe, expect, it, vi } from "vitest";
import {
  eligibleMessages,
  notificationPayloads,
} from "../src/adapters/mail-notifier.ts";

const now = Date.parse("2026-10-30T12:00:00Z");
const message = (id: string, changes: object = {}) => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: {},
  receivedAt: new Date(now - 1000).toISOString(),
  subject: "Subject",
  from: [{ name: "Sender", email: "sender@example.test" }],
  ...changes,
});
// Poll until the asynchronous worker completes each observable transition.
/* oxlint-disable eslint/no-await-in-loop */
async function waitUntil(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("worker timed out");
}
/* oxlint-enable eslint/no-await-in-loop */
describe("mail notification selection", () => {
  it("accepts only created, unread, fresh inbox messages outside junk, once per id", () => {
    const messages = [
      message("ok"),
      message("ok"),
      message("updated"),
      message("archive", { mailboxIds: { archive: true } }),
      message("junk", { mailboxIds: { inbox: true, junk: true } }),
      message("seen", { keywords: { $seen: true } }),
      message("old", { receivedAt: new Date(now - 901000).toISOString() }),
      message("skew", { receivedAt: new Date(now + 30_000).toISOString() }),
      message("future", { receivedAt: new Date(now + 61_000).toISOString() }),
      message("invalid", { receivedAt: "invalid" }),
    ];
    expect(
      eligibleMessages(
        ["ok", "archive", "junk", "seen", "old", "skew", "future", "invalid"],
        messages,
        "inbox",
        "junk",
        now,
        900000,
      ).map((item) => item.id),
    ).toEqual(["ok", "skew"]);
  });
  it("uses message tags and a same-origin thread link, truncates details, and coalesces above the threshold", () => {
    const items = [
      message("a", {
        subject: "x".repeat(200),
        from: [{ name: "y".repeat(200), email: "a@example.test" }],
        threadId: "a/b?c",
      }),
      message("b"),
      message("c"),
    ];
    const single = notificationPayloads(items.slice(0, 1), 2)[0];
    expect(single).toMatchObject({
      tag: "mail:a",
      url: "/mail?thread=a%2Fb%3Fc&message=a",
      icon: "/icons/mail-192.png",
      title: "y".repeat(100),
      body: "x".repeat(160),
    });
    expect(notificationPayloads(items.slice(0, 2), 2)).toHaveLength(2);
    const burst = notificationPayloads(items, 2);
    expect(burst).toHaveLength(1);
    expect(burst[0]).toMatchObject({ title: "3 new messages", url: "/mail" });
    expect(burst[0]?.tag).toBe(
      notificationPayloads(items.toReversed(), 2)[0]?.tag,
    );
  });
});

describe("mail notifier scheduling", () => {
  it("silently resynchronizes cannotCalculateChanges and coalesces creations across the burst window", async () => {
    const { startMailNotifier } =
      await import("../src/adapters/mail-notifier.ts");
    const { ok } = await import("neverthrow");
    const { z } = await import("zod");
    let state: string | null = "lost";
    let phase = 0;
    let discoveries = 0;
    const payloads: { title: string; tag: string }[] = [];
    const store = {
      users: () => Promise.resolve([{ userId: "user", accountId: "account" }]),
      claim: () =>
        Promise.resolve({ state, token: "token", generation: "generation" }),
      current: () => Promise.resolve(true),
      save: (
        _user: string,
        _generation: string,
        _token: string,
        next: string,
      ) => {
        state = next;
        return Promise.resolve(true);
      },
      release: () => Promise.resolve(),
    };
    const credentials = {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "account",
            address: "user@example.test",
            secret: "secret",
          }),
        ),
    };
    const fetcher: typeof fetch = (_input, init) => {
      if (!init?.body) {
        discoveries++;
        return Promise.resolve(
          Response.json({
            capabilities: {},
            accounts: {},
            primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
            username: "user",
            apiUrl: "http://localhost/api",
            downloadUrl: "http://localhost/download",
            uploadUrl: "http://localhost/upload",
            state: "session",
          }),
        );
      }
      if (typeof init.body !== "string")
        throw new Error("unexpected request body");
      const body = z
        .object({
          methodCalls: z.array(
            z.tuple([
              z.string(),
              z.record(z.string(), z.unknown()),
              z.string(),
            ]),
          ),
        })
        .parse(JSON.parse(init.body));
      const call = body.methodCalls[0];
      if (!call) throw new Error("missing call");
      const [method, args, id] = call;
      let name = method;
      let result: unknown;
      if (method === "Email/changes" && args["sinceState"] === "lost") {
        name = "error";
        result = { type: "cannotCalculateChanges" };
      } else if (method === "Email/changes") {
        const since = args["sinceState"];
        const created =
          phase === 1 && since === "current"
            ? ["a", "updated"]
            : phase === 1 && since === "first"
              ? ["b", "c"]
              : [];
        const next = created.includes("a")
          ? "first"
          : created.includes("b")
            ? "second"
            : since;
        result = {
          accountId: "account",
          oldState: since,
          newState: next,
          hasMoreChanges: false,
          created,
          updated: since === "first" ? ["updated"] : [],
          destroyed: [],
        };
      } else if (method === "Mailbox/get") {
        result = {
          accountId: "account",
          state: "boxes",
          list: [{ id: "inbox", name: "Inbox", role: "inbox", parentId: null }],
          notFound: [],
        };
      } else if (
        method === "Email/get" &&
        Array.isArray(args["ids"]) &&
        args["ids"].length === 0
      ) {
        result = {
          accountId: "account",
          state: "current",
          list: [],
          notFound: [],
        };
      } else if (method === "Email/get") {
        const ids = z.array(z.string()).parse(args["ids"]);
        result = {
          accountId: "account",
          state: "second",
          list: ids.map((emailId) => ({
            id: emailId,
            threadId: `thread-${emailId}`,
            mailboxIds: { inbox: true },
            keywords: {},
            receivedAt: new Date().toISOString(),
            subject: "Subject",
            from: [{ name: "Sender", email: "sender@example.test" }],
          })),
          notFound: [],
        };
      } else throw new Error("unexpected method");
      return Promise.resolve(
        Response.json({
          methodResponses: [[name, result, id]],
          sessionState: "session",
        }),
      );
    };
    const stop = startMailNotifier({
      store,
      mailboxes: credentials,
      origin: "http://localhost",
      dispatcher: {
        notify: (_user, _product, payload) => {
          payloads.push(payload);
          return Promise.resolve();
        },
      },
      options: {
        pollMs: 30,
        refreshMs: 100,
        freshnessMs: 900_000,
        burstMs: 80,
        burstThreshold: 2,
        pushConnections: 0,
      },
      fetch: fetcher,
      log: () => undefined,
    });
    try {
      await waitUntil(() => state === "current");
      expect(payloads).toEqual([]);
      phase = 1;
      await waitUntil(() => payloads.length === 1);
      expect(payloads[0]?.title).toBe("3 new messages");
      expect(payloads[0]?.tag).toMatch(/^mail:burst:/);
      expect(discoveries).toBe(1);
    } finally {
      await stop();
    }
  });
});

it("uses a live stream without periodic polling, then scans on a state event", async () => {
  const { startMailNotifier } =
    await import("../src/adapters/mail-notifier.ts");
  const { ok } = await import("neverthrow");
  const { z } = await import("zod");
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let scans = 0;
  let discoveries = 0;
  const store = {
    users: () => Promise.resolve([{ userId: "user", accountId: "account" }]),
    claim: () =>
      Promise.resolve({
        state: "state",
        token: "token",
        generation: "generation",
      }),
    current: () => Promise.resolve(true),
    save: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  };
  const fetcher: typeof fetch = (input, init) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (target.includes("/events")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          init?.signal?.addEventListener(
            "abort",
            () => {
              controller.close();
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    if (!init?.body) {
      discoveries++;
      return Promise.resolve(
        Response.json({
          capabilities: {},
          accounts: {},
          primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
          username: "user",
          apiUrl: "http://localhost/api",
          eventSourceUrl: "http://localhost/events",
          downloadUrl: "http://localhost/download",
          uploadUrl: "http://localhost/upload",
          state: "session",
        }),
      );
    }
    if (typeof init.body !== "string")
      throw new Error("unexpected request body");
    const parsed = z
      .object({
        methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      })
      .parse(JSON.parse(init.body));
    const call = parsed.methodCalls[0];
    if (!call || call[0] !== "Email/changes")
      throw new Error("unexpected call");
    scans++;
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            "Email/changes",
            {
              accountId: "account",
              oldState: "state",
              newState: "state",
              hasMoreChanges: false,
              created: [],
              updated: [],
              destroyed: [],
            },
            call[2],
          ],
        ],
        sessionState: "session",
      }),
    );
  };
  const stop = startMailNotifier({
    store,
    mailboxes: {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "account",
            address: "user@example.test",
            secret: "secret",
          }),
        ),
    },
    origin: "http://localhost",
    dispatcher: { notify: () => Promise.resolve() },
    options: {
      pollMs: 30,
      refreshMs: 100,
      freshnessMs: 900_000,
      burstMs: 0,
      burstThreshold: 3,
      pushConnections: 1,
    },
    fetch: fetcher,
    log: () => undefined,
  });
  try {
    await waitUntil(() => streamController !== undefined && scans > 0);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    const before = scans;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(scans).toBe(before);
    if (!streamController) throw new Error("stream unavailable");
    streamController.enqueue(
      new TextEncoder().encode(
        'data: {"@type":"StateChange","changed":{"account":{"Email":"next"}}}\n\n',
      ),
    );
    await waitUntil(() => scans > before);
    expect(discoveries).toBe(1);
  } finally {
    await stop();
  }
});

it("does not occupy a work slot while waiting to coalesce a burst", async () => {
  const { startMailNotifier } =
    await import("../src/adapters/mail-notifier.ts");
  const { ok } = await import("neverthrow");
  const { z } = await import("zod");
  const users = Array.from({ length: 9 }, (_, index) => ({
    userId: `user-${index}`,
    accountId: "account",
  }));
  const saved = new Set<string>();
  let notifications = 0;
  const store = {
    users: () => Promise.resolve(users),
    claim: () =>
      Promise.resolve({
        state: "state",
        token: "token",
        generation: "generation",
      }),
    current: () => Promise.resolve(true),
    save: (userId: string) => {
      saved.add(userId);
      return Promise.resolve(true);
    },
    release: () => Promise.resolve(),
  };
  const fetcher: typeof fetch = (_input, init) => {
    if (!init?.body)
      return Promise.resolve(
        Response.json({
          capabilities: {},
          accounts: {},
          primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
          username: "user",
          apiUrl: "http://localhost/api",
          downloadUrl: "http://localhost/download",
          uploadUrl: "http://localhost/upload",
          state: "session",
        }),
      );
    if (typeof init.body !== "string")
      throw new Error("unexpected request body");
    const calls = z
      .object({
        methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      })
      .parse(JSON.parse(init.body)).methodCalls;
    const call = calls[0];
    if (!call || call[0] !== "Email/changes")
      throw new Error("unexpected method");
    const authorization = new Headers(init.headers).get("Authorization");
    const ninth =
      authorization ===
      `Basic ${Buffer.from("user-8@example.test:secret").toString("base64")}`;
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            "Email/changes",
            {
              accountId: "account",
              oldState: "state",
              newState: "state",
              hasMoreChanges: false,
              created: ninth ? [] : ["new"],
              updated: [],
              destroyed: [],
            },
            call[2],
          ],
        ],
        sessionState: "session",
      }),
    );
  };
  const stop = startMailNotifier({
    store,
    mailboxes: {
      getForOwner: (userId) =>
        Promise.resolve(
          ok({
            accountId: "account",
            address: `${userId}@example.test`,
            secret: "secret",
          }),
        ),
    },
    origin: "http://localhost",
    dispatcher: {
      notify: () => {
        notifications++;
        return Promise.resolve();
      },
    },
    options: {
      pollMs: 10_000,
      refreshMs: 10_000,
      freshnessMs: 900_000,
      burstMs: 2_000,
      burstThreshold: 3,
      pushConnections: 0,
    },
    fetch: fetcher,
    log: () => undefined,
  });
  try {
    await waitUntil(() => saved.has("user-8"));
    expect(notifications).toBe(0);
  } finally {
    await stop();
  }
});

it("reconnects an idle stream and polls while it is unavailable", async () => {
  const { startMailNotifier } =
    await import("../src/adapters/mail-notifier.ts");
  const { ok } = await import("neverthrow");
  const { z } = await import("zod");
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  let connections = 0;
  let scans = 0;
  const store = {
    users: () => Promise.resolve([{ userId: "user", accountId: "account" }]),
    claim: () =>
      Promise.resolve({
        state: "state",
        token: "token",
        generation: "generation",
      }),
    current: () => Promise.resolve(true),
    save: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  };
  const fetcher: typeof fetch = (input, init) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (target.includes("/events")) {
      connections++;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  controller.close();
                },
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }
    if (!init?.body)
      return Promise.resolve(
        Response.json({
          capabilities: {},
          accounts: {},
          primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
          username: "user",
          apiUrl: "http://localhost/api",
          eventSourceUrl: "http://localhost/events",
          downloadUrl: "http://localhost/download",
          uploadUrl: "http://localhost/upload",
          state: "session",
        }),
      );
    if (typeof init.body !== "string")
      throw new Error("unexpected request body");
    const call = z
      .object({
        methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      })
      .parse(JSON.parse(init.body)).methodCalls[0];
    if (!call || call[0] !== "Email/changes")
      throw new Error("unexpected call");
    scans++;
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            "Email/changes",
            {
              accountId: "account",
              oldState: "state",
              newState: "state",
              hasMoreChanges: false,
              created: [],
              updated: [],
              destroyed: [],
            },
            call[2],
          ],
        ],
        sessionState: "session",
      }),
    );
  };
  const stop = startMailNotifier({
    store,
    mailboxes: {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "account",
            address: "user@example.test",
            secret: "secret",
          }),
        ),
    },
    origin: "http://localhost",
    dispatcher: { notify: () => Promise.resolve() },
    options: {
      pollMs: 30_000,
      refreshMs: 10_000,
      freshnessMs: 900_000,
      burstMs: 0,
      burstThreshold: 3,
      pushConnections: 1,
    },
    fetch: fetcher,
    log: () => undefined,
  });
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(connections).toBe(1);
    const before = scans;
    await vi.advanceTimersByTimeAsync(89_999);
    expect(connections).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(connections).toBe(2);
    expect(scans).toBeGreaterThan(before);
  } finally {
    await stop();
    random.mockRestore();
    vi.useRealTimers();
  }
});

it("lets only one of two notifier instances process a leased mailbox", async () => {
  const { startMailNotifier } =
    await import("../src/adapters/mail-notifier.ts");
  const { ok } = await import("neverthrow");
  const { z } = await import("zod");
  let leased = false;
  let state = "old";
  let lostClaims = 0;
  let delivered = 0;
  const store = {
    users: () => Promise.resolve([{ userId: "user", accountId: "account" }]),
    claim: () => {
      if (leased) {
        lostClaims++;
        return Promise.resolve(null);
      }
      leased = true;
      return Promise.resolve({
        state,
        token: "token",
        generation: "generation",
      });
    },
    current: () => Promise.resolve(leased),
    save: (
      _user: string,
      _generation: string,
      _token: string,
      next: string,
    ) => {
      state = next;
      return Promise.resolve(true);
    },
    release: () => {
      leased = false;
      return Promise.resolve();
    },
  };
  const fetcher: typeof fetch = (_input, init) => {
    if (!init?.body)
      return Promise.resolve(
        Response.json({
          capabilities: {},
          accounts: {},
          primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
          username: "user",
          apiUrl: "http://localhost/api",
          downloadUrl: "http://localhost/download",
          uploadUrl: "http://localhost/upload",
          state: "session",
        }),
      );
    if (typeof init.body !== "string")
      throw new Error("unexpected request body");
    const call = z
      .object({
        methodCalls: z.array(
          z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
        ),
      })
      .parse(JSON.parse(init.body)).methodCalls[0];
    if (!call) throw new Error("missing method");
    const [method, args, id] = call;
    let result: unknown;
    if (method === "Email/changes")
      result = {
        accountId: "account",
        oldState: args["sinceState"],
        newState: "new",
        hasMoreChanges: false,
        created: args["sinceState"] === "old" ? ["message"] : [],
        updated: [],
        destroyed: [],
      };
    else if (method === "Mailbox/get")
      result = {
        accountId: "account",
        state: "boxes",
        list: [{ id: "inbox", name: "Inbox", role: "inbox", parentId: null }],
        notFound: [],
      };
    else if (method === "Email/get")
      result = {
        accountId: "account",
        state: "new",
        list: [
          {
            id: "message",
            threadId: "thread",
            mailboxIds: { inbox: true },
            keywords: {},
            receivedAt: new Date().toISOString(),
            subject: "Subject",
            from: [{ name: "Sender", email: "sender@example.test" }],
          },
        ],
        notFound: [],
      };
    else throw new Error("unexpected method");
    return Promise.resolve(
      Response.json({
        methodResponses: [[method, result, id]],
        sessionState: "session",
      }),
    );
  };
  const dependencies = {
    store,
    mailboxes: {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "account",
            address: "user@example.test",
            secret: "secret",
          }),
        ),
    },
    origin: "http://localhost",
    dispatcher: {
      notify: () => {
        delivered++;
        return Promise.resolve();
      },
    },
    options: {
      pollMs: 30,
      refreshMs: 100,
      freshnessMs: 900_000,
      burstMs: 100,
      burstThreshold: 3,
      pushConnections: 0,
    },
    fetch: fetcher,
    log: () => undefined,
  };
  const stopA = startMailNotifier(dependencies);
  const stopB = startMailNotifier(dependencies);
  try {
    await waitUntil(() => state === "new");
    expect(lostClaims).toBe(1);
    expect(delivered).toBe(1);
  } finally {
    await Promise.all([stopA(), stopB()]);
  }
});
