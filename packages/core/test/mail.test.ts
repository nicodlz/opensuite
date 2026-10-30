import { JmapClient } from "@opensuite/jmap";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMailService } from "../src/services/mail.ts";

const noop = () => {};
const actor = {
  id: "alice",
  email: "alice@example.test",
  role: "user",
} satisfies { id: string; email: string; role: "user" };
const origin = "https://mail.example.test";
const requests: { method: string; args: Record<string, unknown> }[] = [];
const mailbox = {
  id: "i",
  name: "Inbox",
  role: "inbox",
  parentId: null,
  totalEmails: 2,
  unreadEmails: 1,
};
const emails = [
  {
    id: "e1",
    blobId: "b1",
    threadId: "t1",
    mailboxIds: { i: true },
    keywords: {},
    receivedAt: "2026-01-01T00:00:00Z",
    subject: "Hello",
    from: [{ name: null, email: "sender@example.test" }],
    to: [{ name: null, email: "alice@example.test" }],
    messageId: ["m1"],
    replyTo: [{ name: null, email: "reply@example.test" }],
    attachments: [
      {
        partId: "img",
        blobId: "inline",
        name: "photo.png",
        type: "image/png",
        size: 3,
        cid: "inline@example.test",
      },
    ],
    textBody: [
      {
        partId: "plain",
        blobId: null,
        name: null,
        type: "text/plain",
        size: 12,
      },
    ],
    htmlBody: [
      {
        partId: "plain",
        blobId: null,
        name: null,
        type: "text/plain",
        size: 12,
      },
    ],
    bodyValues: { plain: { value: "<plain text>" } },
    preview: "Preview",
  },
  {
    id: "e2",
    blobId: "b2",
    threadId: "t1",
    mailboxIds: { i: true },
    keywords: { $seen: true },
    receivedAt: "2026-01-02T00:00:00Z",
    subject: "Re: Hello",
    from: [{ name: null, email: "alice@example.test" }],
    to: [],
    messageId: ["m2"],
    attachments: [],
  },
];
const fetchFake: typeof fetch = (_url, init) => {
  if (init?.method !== "POST")
    return Promise.resolve(
      new Response(
        JSON.stringify({
          capabilities: {},
          accounts: {},
          primaryAccounts: { "urn:ietf:params:jmap:mail": "jmap-account" },
          username: "alice",
          apiUrl: `${origin}/jmap`,
          uploadUrl: `${origin}/upload/{accountId}`,
          downloadUrl: `${origin}/download/{accountId}/{blobId}/{name}?type={type}`,
          state: "s",
        }),
      ),
    );
  const bodyText = typeof init.body === "string" ? init.body : "";
  const body = z
    .object({
      methodCalls: z.array(
        z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
      ),
    })
    .parse(JSON.parse(bodyText));
  if (body.methodCalls.length === 4) {
    for (const [method, args] of body.methodCalls)
      requests.push({ method, args });
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            "Email/query",
            {
              accountId: "jmap-account",
              queryState: "s",
              canCalculateChanges: false,
              position: 2,
              ids: ["e2"],
            },
            "query",
          ],
          [
            "Email/get",
            {
              accountId: "jmap-account",
              state: "s",
              list: [{ id: "e2", threadId: "t1" }],
              notFound: [],
            },
            "selected",
          ],
          [
            "Thread/get",
            {
              accountId: "jmap-account",
              state: "s",
              list: [{ id: "t1", emailIds: ["e1", "e2"] }],
              notFound: [],
            },
            "threads",
          ],
          [
            "Email/get",
            {
              accountId: "jmap-account",
              state: "s",
              list: emails,
              notFound: [],
            },
            "emails",
          ],
        ],
        sessionState: "s",
      }),
    );
  }
  const call = body.methodCalls[0];
  if (call === undefined) throw new Error("Missing call");
  const [method, args] = call;
  requests.push({ method, args });
  let data: object = {};
  if (method === "Mailbox/get")
    data = {
      accountId: "jmap-account",
      state: "s",
      list: [mailbox],
      notFound: [],
    };
  if (method === "Email/query")
    data = {
      accountId: "jmap-account",
      queryState: "s",
      canCalculateChanges: false,
      position: 0,
      ids: ["e2"],
    };
  if (method === "Email/get") {
    const ids = z.array(z.string()).parse(args["ids"]);
    data = {
      accountId: "jmap-account",
      state: "s",
      list: emails.filter((item) => ids.includes(item.id)),
      notFound: [],
    };
  }
  if (method === "Thread/get")
    data = {
      accountId: "jmap-account",
      state: "s",
      list: [{ id: "t1", emailIds: ["e1", "e2"] }],
      notFound: [],
    };
  if (method === "Email/set") {
    if (args["destroy"] !== undefined) {
      data = {
        accountId: "jmap-account",
        destroyed: z.array(z.string()).parse(args["destroy"]),
      };
    } else {
      const update = z.record(z.string(), z.unknown()).parse(args["update"]);
      data = {
        accountId: "jmap-account",
        updated: Object.fromEntries(
          Object.keys(update).map((id) => [id, null]),
        ),
      };
    }
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        methodResponses: [[method, data, "0"]],
        sessionState: "s",
      }),
    ),
  );
};
const service = createMailService({
  origin,
  store: {
    getForOwner: (userId, accountId) =>
      Promise.resolve(
        userId === "alice" && ["default", "owned"].includes(accountId)
          ? ok({ accountId: "owned", address: actor.email, secret: "private" })
          : err({ kind: "not_found" }),
      ),
  },
  client: () =>
    new JmapClient(origin, {
      authorization: "Basic server-only",
      fetch: fetchFake,
    }),
});

describe("mail service", () => {
  it("maps only matching body types, inline IDs and Reply-To", async () => {
    const result = await service.thread(actor, "default", "t1");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("Expected thread");
    expect(result.value.messages[0]).toMatchObject({
      htmlBody: "",
      textBody: "<plain text>",
      replyTo: [{ email: "reply@example.test" }],
      attachments: [{ cid: "inline@example.test", blobId: "inline" }],
    });
    expect(
      requests.findLast((request) => request.method === "Email/get")?.args[
        "properties"
      ],
    ).toContain("replyTo");
  });

  it("scopes access to the session owner and never uses a client for another account", async () => {
    requests.length = 0;
    expect(
      (await service.mailboxes({ ...actor, id: "bob" }, "owned")).match(
        () => {
          throw new Error("Expected failure");
        },
        (error) => error,
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      (await service.mailboxes(actor, "other")).match(
        () => {
          throw new Error("Expected failure");
        },
        (error) => error,
      ),
    ).toEqual({ kind: "forbidden" });
    expect(requests).toHaveLength(0);
    expect(
      (await service.mailboxes(actor, "default")).match(
        (value) => value,
        (error) => {
          throw new Error(JSON.stringify(error));
        },
      ).mailboxes[0],
    ).toMatchObject({ total: 2, unread: 1 });
  });
  it("passes filters and pagination to JMAP and aggregates full conversations", async () => {
    requests.length = 0;
    const result = (
      await service.threads(actor, "default", {
        mailboxId: "i",
        limit: 10,
        cursor: "2",
        sort: "newest",
        search: { unread: true, query: "hello" },
      })
    ).match(
      (value) => value,
      (error) => {
        throw new Error(JSON.stringify(error));
      },
    );
    expect(requests.map((request) => request.method)).toEqual([
      "Mailbox/get",
      "Email/query",
      "Email/get",
      "Thread/get",
      "Email/get",
    ]);
    expect(requests[3]?.args["#ids"]).toEqual({
      resultOf: "selected",
      name: "Email/get",
      path: "/list/*/threadId",
    });
    expect(requests[4]?.args["#ids"]).toEqual({
      resultOf: "threads",
      name: "Thread/get",
      path: "/list/*/emailIds/*",
    });
    expect(result.threads[0]).toMatchObject({
      id: "t1",
      messageCount: 2,
      unread: true,
      subject: "Re: Hello",
    });
    expect(
      requests.find((request) => request.method === "Email/query")?.args,
    ).toMatchObject({
      position: 2,
      collapseThreads: true,
      filter: { inMailbox: "i", text: "hello", notKeyword: "$seen" },
    });
    expect(
      (
        await service.threads(actor, "default", {
          mailboxId: "i",
          limit: 10,
          cursor: "-1",
          sort: "newest",
        })
      ).match(
        () => {
          throw new Error("Expected failure");
        },
        (error) => error,
      ),
    ).toEqual({ kind: "validation" });
  });
  it("rejects message IDs from outside the thread and patches only the intended keyword", async () => {
    requests.length = 0;
    expect(
      (
        await service.action(
          actor,
          "default",
          "t1",
          { type: "star", value: true },
          ["other"],
        )
      ).match(
        () => {
          throw new Error("Expected failure");
        },
        (error) => error,
      ),
    ).toEqual({ kind: "not_found" });
    expect(requests.some((request) => request.method === "Email/set")).toBe(
      false,
    );
    expect(
      (
        await service.action(
          actor,
          "default",
          "t1",
          { type: "read", value: false },
          ["e1"],
        )
      ).isOk(),
    ).toBe(true);
    expect(
      requests.find((request) => request.method === "Email/set")?.args,
    ).toMatchObject({ update: { e1: { "keywords/$seen": null } } });
  });
  it("destroys only the requested messages in the owned thread", async () => {
    requests.length = 0;
    expect(
      (
        await service.action(actor, "default", "t1", { type: "delete" }, ["e1"])
      ).isOk(),
    ).toBe(true);
    expect(
      requests.find((request) => request.method === "Email/set")?.args,
    ).toMatchObject({ destroy: ["e1"] });
  });
});

it("coalesces discovery and refreshes it after expiration or credential rotation", async () => {
  let now = 0;
  let secret = "first";
  let discoveries = 0;
  const cached = createMailService({
    origin,
    now: () => now,
    store: {
      getForOwner: () =>
        Promise.resolve(
          ok({ accountId: "owned", address: actor.email, secret }),
        ),
    },
    client: () =>
      new JmapClient(origin, {
        authorization: "secret",
        fetch: (input, init) => {
          if (init?.method !== "POST") discoveries += 1;
          return fetchFake(input, init);
        },
      }),
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => cached.mailboxes(actor, "default")),
  );
  expect(results.every((result) => result.isOk())).toBe(true);
  expect(discoveries).toBe(1);
  now += 30_001;
  expect((await cached.mailboxes(actor, "default")).isOk()).toBe(true);
  expect(discoveries).toBe(2);
  secret = "rotated";
  expect((await cached.mailboxes(actor, "default")).isOk()).toBe(true);
  expect(discoveries).toBe(3);
});

it("bounds concurrent JMAP work across requests", async () => {
  let active = 0;
  let max = 0;
  let release = noop;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstEight = noop;
  const started = new Promise<void>((resolve) => {
    firstEight = resolve;
  });
  const bounded = createMailService({
    origin,
    store: {
      getForOwner: () =>
        Promise.resolve(
          ok({ accountId: "owned", address: actor.email, secret: "secret" }),
        ),
    },
    client: () =>
      new JmapClient(origin, {
        authorization: "secret",
        fetch: async (input, init) => {
          if (init?.method === "POST") {
            active += 1;
            max = Math.max(max, active);
            if (active === 8) firstEight();
            await gate;
            active -= 1;
          }
          return fetchFake(input, init);
        },
      }),
  });
  const pending = Array.from({ length: 20 }, () =>
    bounded.mailboxes(actor, "default"),
  );
  await started;
  expect(max).toBe(8);
  release();
  expect((await Promise.all(pending)).every((result) => result.isOk())).toBe(
    true,
  );
  expect(max).toBe(8);
});

it("expires and bounds uploaded metadata and returns the new draft when removal fails", async () => {
  let now = 0;
  let nextBlob = 0;
  let lastAttachments: unknown;
  const simulatedFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes("/upload/")) {
      nextBlob += 1;
      return Promise.resolve(
        Response.json({
          accountId: "jmap-account",
          blobId: `blob${nextBlob}`,
          type: "text/plain",
          size: 1,
        }),
      );
    }
    if (init?.method !== "POST") return fetchFake(input, init);
    const payload = z
      .object({
        methodCalls: z.array(
          z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
        ),
      })
      .parse(JSON.parse(typeof init.body === "string" ? init.body : ""));
    const call = payload.methodCalls[0];
    if (call === undefined) throw new Error("Missing call");
    const [method, args, id] = call;
    let data: object;
    if (method === "Mailbox/get")
      data = {
        accountId: "jmap-account",
        state: "s",
        list: [{ ...mailbox, id: "d", role: "drafts" }],
        notFound: [],
      };
    else if (method === "Email/get")
      data = {
        accountId: "jmap-account",
        state: "s",
        list: [
          {
            ...emails[0],
            id: "old",
            mailboxIds: { d: true },
            keywords: { $draft: true },
          },
        ],
        notFound: [],
      };
    else if (args["create"] !== undefined) {
      const item = z
        .object({ item: z.object({ attachments: z.unknown() }) })
        .parse(args["create"]).item;
      lastAttachments = item.attachments;
      data = {
        accountId: "jmap-account",
        created: { item: { id: "new", threadId: "t1" } },
      };
    } else
      data = {
        accountId: "jmap-account",
        notDestroyed: { old: { type: "serverFail" } },
      };
    return Promise.resolve(
      Response.json({
        methodResponses: [[method, data, id]],
        sessionState: "s",
      }),
    );
  };
  const draftService = createMailService({
    origin,
    now: () => now,
    store: {
      getForOwner: () =>
        Promise.resolve(
          ok({ accountId: "owned", address: actor.email, secret: "secret" }),
        ),
    },
    client: () =>
      new JmapClient(origin, {
        authorization: "secret",
        fetch: simulatedFetch,
      }),
  });
  const upload = () =>
    draftService.upload(actor, "default", {
      name: "real.txt",
      type: "text/plain",
      base64: "YQ==",
    });
  await Array.from({ length: 1001 }).reduce<Promise<void>>(
    (previous) =>
      previous.then(async () => {
        expect((await upload()).isOk()).toBe(true);
        return undefined;
      }),
    Promise.resolve(),
  );
  const content = {
    to: [],
    cc: [],
    bcc: [],
    subject: "draft",
    htmlBody: "",
    textBody: "",
    references: [],
    attachmentBlobIds: ["blob1", "blob1001"],
  };
  expect(
    (await draftService.createDraft(actor, "default", content)).isOk(),
  ).toBe(true);
  expect(lastAttachments).toEqual([
    { blobId: "blob1", name: "attachment", type: "application/octet-stream" },
    { blobId: "blob1001", name: "real.txt", type: "text/plain" },
  ]);
  now += 3_600_001;
  const updated = await draftService.updateDraft(
    actor,
    "default",
    "old",
    content,
  );
  expect(updated.isOk() && updated.value.id).toBe("new");
  expect(lastAttachments).toEqual([
    { blobId: "blob1", name: "attachment", type: "application/octet-stream" },
    {
      blobId: "blob1001",
      name: "attachment",
      type: "application/octet-stream",
    },
  ]);
}, 30_000);
