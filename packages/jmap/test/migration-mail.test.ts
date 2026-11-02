import { expect, it } from "vitest";
import { ok } from "neverthrow";
import { z } from "zod";
import {
  createMigrationSnapshot,
  inspectMigrationCandidates,
  JmapClient,
  rememberMigrationImport,
  type MigrationCandidate,
  type Session,
} from "../src/index.ts";

const session: Session = {
  capabilities: {},
  accounts: {},
  primaryAccounts: {},
  username: "owner",
  apiUrl: "https://mail.example.test/jmap",
  uploadUrl: "https://mail.example.test/upload/{accountId}",
  downloadUrl: "https://mail.example.test/download/{accountId}/{blobId}",
  state: "s",
};
const request = z.object({
  methodCalls: z.array(
    z.tuple([
      z.string(),
      z.object({
        accountId: z.string(),
        ids: z.array(z.string()),
        properties: z.array(z.string()),
      }),
      z.string(),
    ]),
  ),
});

it("requests only import-reconciliation metadata and validates the JMAP response", async () => {
  let valid = true;
  const client = new JmapClient("https://mail.example.test", {
    authorization: "fixture",
    fetch: (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Missing call");
      const call = request.parse(JSON.parse(init.body)).methodCalls[0];
      expect(call).toEqual([
        "Email/get",
        {
          accountId: "owner",
          ids: ["one"],
          properties: ["id", "blobId", "size", "messageId", "keywords"],
        },
        "0",
      ]);
      return Promise.resolve(
        Response.json({
          sessionState: "s",
          methodResponses: [
            [
              "Email/get",
              {
                accountId: "owner",
                state: "s",
                notFound: [],
                list: [
                  valid
                    ? {
                        id: "one",
                        blobId: "blob",
                        size: 42,
                        messageId: ["one@example.test"],
                        keywords: {},
                      }
                    : { id: "one" },
                ],
              },
              "0",
            ],
          ],
        }),
      );
    },
  });
  expect((await client.migrationEmails(session, "owner", ["one"])).isOk()).toBe(
    true,
  );
  valid = false;
  expect(
    (await client.migrationEmails(session, "owner", ["one"])).isErr(),
  ).toBe(true);
});

it("guards import and duplicate mapping with the scanned Email state", async () => {
  const requests: unknown[] = [];
  const calls = z.object({
    methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
  });
  let mismatch = false;
  const client = new JmapClient("https://mail.example.test", {
    authorization: "fixture",
    fetch: (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Missing call");
      const call = calls.parse(JSON.parse(init.body)).methodCalls[0];
      if (call === undefined) throw new Error("Missing method");
      requests.push(call);
      const response = mismatch
        ? ["error", { type: "stateMismatch" }, "0"]
        : call[0] === "Email/import"
          ? [
              "Email/import",
              {
                accountId: "owner",
                newState: "s2",
                created: {
                  item: { id: "one", blobId: "blob", threadId: "t", size: 42 },
                },
              },
              "0",
            ]
          : [
              "Email/set",
              { accountId: "owner", newState: "s3", updated: { one: null } },
              "0",
            ];
      return Promise.resolve(
        Response.json({ sessionState: "s", methodResponses: [response] }),
      );
    },
  });
  const imported = await client.migrationImport(
    session,
    "owner",
    { blobId: "blob", mailboxIds: { inbox: true } },
    "s1",
  );
  expect(imported.isErr() ? imported.error : null).toBeNull();
  expect(imported.isOk() && imported.value.newState).toBe("s2");
  const mapped = await client.migrationMap(
    session,
    "owner",
    "one",
    { "mailboxIds/inbox": true },
    "s2",
  );
  expect(mapped.isOk() && mapped.value.newState).toBe("s3");
  expect(requests).toEqual([
    [
      "Email/import",
      {
        accountId: "owner",
        ifInState: "s1",
        emails: { item: { blobId: "blob", mailboxIds: { inbox: true } } },
      },
      "0",
    ],
    [
      "Email/set",
      {
        accountId: "owner",
        ifInState: "s2",
        update: { one: { "mailboxIds/inbox": true } },
      },
      "0",
    ],
  ]);
  mismatch = true;
  const rejected = await client.migrationImport(
    session,
    "owner",
    { blobId: "blob", mailboxIds: { inbox: true } },
    "stale",
  );
  expect(rejected.isErr() && rejected.error).toMatchObject({
    kind: "method",
    type: "stateMismatch",
  });
});

it("indexes only requested Message-IDs while scanning a mailbox larger than 10,000 messages", async () => {
  const rows: MigrationCandidate[] = Array.from(
    { length: 10_101 },
    (_, index) => ({
      id: `email-${index}`,
      blobId: `blob-${index}`,
      size: index + 1,
      messageId: [
        index === 10_000
          ? "target@example.test"
          : `other-${index}@example.test`,
      ],
      keywords: {},
    }),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  let queries = 0;
  const client: Pick<
    JmapClient,
    "emailState" | "queryEmails" | "migrationEmails"
  > = {
    emailState: () =>
      Promise.resolve(
        ok({ accountId: "owner", state: "s", list: [], notFound: [] }),
      ),
    queryEmails: (_session, _account, options) => {
      expect(options?.filter).toBeUndefined();
      expect(options?.calculateTotal).toBe(true);
      queries++;
      const position = options?.position ?? 0;
      const limit = options?.limit ?? 0;
      return Promise.resolve(
        ok({
          accountId: "owner",
          queryState: "q",
          canCalculateChanges: false,
          position,
          ids: rows.slice(position, position + limit).map((row) => row.id),
          total: rows.length,
        }),
      );
    },
    migrationEmails: (_session, _account, ids) =>
      Promise.resolve(
        ok({
          accountId: "owner",
          state: "s",
          notFound: [],
          list: ids.flatMap((id) => {
            const item = byId.get(id);
            return item === undefined ? [] : [item];
          }),
        }),
      ),
  };
  const result = await createMigrationSnapshot({
    client,
    session,
    accountId: "owner",
    messageIds: ["target@example.test", "absent@example.test"],
    keepAlive: () => Promise.resolve(true),
  });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) throw new Error("Snapshot failed");
  expect(result.value.state).toBe("s");
  expect([...result.value.candidates.keys()]).toEqual([
    "target@example.test",
    "absent@example.test",
  ]);
  expect(result.value.candidates.get("absent@example.test")).toEqual([]);
  expect(result.value.candidates.get("target@example.test")?.[0]?.id).toBe(
    "email-10000",
  );
  expect(queries).toBe(102);
});

it("does not infer absence from an unindexed Message-ID or a mismatched imported message", async () => {
  const client = new JmapClient("https://mail.example.test", {
    authorization: "fixture",
    fetch: () => {
      throw new Error("Unexpected network request");
    },
  });
  const snapshot = { state: "s", candidates: new Map() };
  const inspected = await inspectMigrationCandidates({
    client,
    session,
    accountId: "owner",
    bytes: new Uint8Array([1]),
    messageId: "missing@example.test",
    snapshot,
  });
  expect(
    inspected.match(
      () => null,
      (error) => error,
    ),
  ).toEqual({ kind: "unavailable" });
  const wrongMessage = {
    migrationEmails: () =>
      Promise.resolve(
        ok({
          accountId: "owner",
          state: "s",
          notFound: [],
          list: [
            {
              id: "new",
              blobId: "blob",
              size: 1,
              messageId: ["other@example.test"],
              keywords: {},
            },
          ],
        }),
      ),
  };
  snapshot.candidates.set("missing@example.test", []);
  expect(
    await rememberMigrationImport({
      client: wrongMessage,
      session,
      accountId: "owner",
      snapshot,
      id: "new",
      messageId: "missing@example.test",
    }),
  ).toBe(false);
  expect(snapshot.candidates.get("missing@example.test")).toEqual([]);
});

it("fails closed when the destination changes, exceeds the scan limit, or loses the worker lease", async () => {
  let changed = false;
  let queries = 0;
  const candidate: MigrationCandidate = {
    id: "one",
    blobId: "blob",
    size: 42,
    messageId: ["target@example.test"],
    keywords: {},
  };
  const client: Pick<
    JmapClient,
    "emailState" | "queryEmails" | "migrationEmails"
  > = {
    emailState: () =>
      Promise.resolve(
        ok({ accountId: "owner", state: "s1", list: [], notFound: [] }),
      ),
    queryEmails: () => {
      queries++;
      return Promise.resolve(
        ok({
          accountId: "owner",
          queryState: "q",
          canCalculateChanges: false,
          position: 0,
          ids: ["one"],
          total: 1,
        }),
      );
    },
    migrationEmails: () =>
      Promise.resolve(
        ok({
          accountId: "owner",
          state: changed ? "s2" : "s1",
          list: [candidate],
          notFound: [],
        }),
      ),
  };
  const input = {
    client,
    session,
    accountId: "owner",
    messageIds: ["target@example.test"],
    keepAlive: () => Promise.resolve(true),
  };
  changed = true;
  expect(
    (await createMigrationSnapshot(input)).match(
      () => null,
      (error) => error,
    ),
  ).toEqual({
    kind: "unavailable",
  });
  changed = false;
  const overLimit = {
    ...client,
    queryEmails: () =>
      Promise.resolve(
        ok({
          accountId: "owner",
          queryState: "q",
          canCalculateChanges: false,
          position: 0,
          ids: ["one"],
          total: 2,
        }),
      ),
  };
  expect(
    (
      await createMigrationSnapshot({ ...input, client: overLimit, maxScan: 1 })
    ).match(
      () => null,
      (error) => error,
    ),
  ).toEqual({ kind: "limit" });
  const before = queries;
  expect(
    (
      await createMigrationSnapshot({
        ...input,
        keepAlive: () => Promise.resolve(false),
      })
    ).match(
      () => null,
      (error) => error,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(queries).toBe(before);
});
