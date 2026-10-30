import { describe, expect, it, vi } from "vitest";
import { err, ok } from "neverthrow";
import { z } from "zod";
import { jmapDelivery, type LinkedMailboxes } from "../src/adapters/jmap.ts";

const session = {
  capabilities: {},
  accounts: {},
  primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
  username: "alice",
  apiUrl: "https://public.test/jmap",
  uploadUrl: "https://public.test/upload/{accountId}",
  downloadUrl:
    "https://public.test/download/{accountId}/{blobId}/{name}?type={type}",
  state: "s",
};
const calls = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
});
const importArgs = z.object({
  emails: z.object({
    item: z.object({
      keywords: z.record(z.string(), z.boolean()),
      receivedAt: z.string(),
      blobId: z.string(),
    }),
  }),
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

describe("JMAP ingestion adapter", () => {
  it("shares uploads per account and verifies candidates against original bytes and metadata", async () => {
    const bytes = Buffer.from("Message-ID: <one@example.test>\r\n\r\nbody");
    let downloaded = bytes;
    let uploads = 0;
    let importedKey = "";
    let importedDate = "";
    const fake: typeof fetch = (url, init) =>
      Promise.resolve().then(() => {
        const target =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (target.endsWith("/.well-known/jmap")) return response(session);
        if (target.includes("/upload/")) {
          uploads++;
          return response({
            accountId: "account",
            blobId: "blob",
            type: "message/rfc822",
            size: bytes.length,
          });
        }
        if (target.includes("/download/")) return new Response(downloaded);
        if (typeof init?.body !== "string")
          throw new Error("Missing request body");
        const call = calls.parse(JSON.parse(init.body)).methodCalls[0];
        if (call === undefined) throw new Error("Missing call");
        let value: unknown;
        if (call[0] === "Mailbox/get")
          value = {
            accountId: "account",
            state: "s",
            list: [
              { id: "inbox", name: "Inbox", role: "inbox", parentId: null },
            ],
            notFound: [],
          };
        else if (call[0] === "Email/import") {
          const item = importArgs.parse(call[1]).emails.item;
          importedKey = Object.keys(item.keywords)[0] ?? "";
          importedDate = item.receivedAt;
          value = {
            accountId: "account",
            created: {
              item: {
                id: "email",
                blobId: item.blobId,
                threadId: "thread",
                size: bytes.length,
              },
            },
          };
        } else if (call[0] === "Email/query")
          value = {
            accountId: "account",
            queryState: "q",
            canCalculateChanges: false,
            position: 0,
            ids: ["email"],
          };
        else if (call[0] === "Email/get")
          value = {
            accountId: "account",
            state: "s",
            notFound: [],
            list: [
              {
                id: "email",
                blobId: "blob",
                threadId: "thread",
                mailboxIds: { inbox: true },
                keywords: { [importedKey]: true },
                receivedAt: importedDate,
                subject: null,
                from: null,
                to: null,
                messageId: ["one@example.test"],
                attachments: [],
              },
            ],
          };
        else throw new Error(`Unexpected method: ${call[0]}`);
        return response({
          methodResponses: [[call[0], value, "0"]],
          sessionState: "s",
        });
      });
    vi.stubGlobal("fetch", fake);
    try {
      const destination = {
        origin: "http://internal.test",
        authorization: "Bearer secret",
        quarantineMailbox: "junk",
        rewriteSessionUrls: true,
      };
      const delivery = jmapDelivery([{ ...destination, id: "account" }]);
      const cache = new Map<string, string>();
      const date = "2026-01-02T03:04:05.000Z";
      expect(
        (
          await delivery.import(
            "account",
            bytes,
            false,
            date,
            "key",
            cache,
            () => Promise.resolve(ok(undefined)),
          )
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await delivery.import(
            "account",
            bytes,
            false,
            date,
            "key",
            cache,
            () => Promise.resolve(ok(undefined)),
          )
        ).isOk(),
      ).toBe(true);
      expect(uploads).toBe(1);
      const noJunk = await delivery.reconcile(
        "account",
        bytes,
        true,
        date,
        "key",
      );
      expect(noJunk.isErr() && noJunk.error.message).toBe(
        "Quarantine mailbox missing",
      );
      expect(importedDate).toBe(date);
      expect(
        (await delivery.reconcile("account", bytes, false, date, "key")).isOk(),
      ).toBe(true);
      downloaded = Buffer.from("Message-ID: <one@example.test>\r\n\r\nother");
      expect(
        (
          await delivery.reconcile("account", bytes, false, date, "key")
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await delivery.reconcile(
            "account",
            bytes,
            false,
            "2025-01-02T03:04:05Z",
            "key",
          )
        ).isErr(),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("classifies a refused connection as retryable and a proxy response as uncertain", async () => {
  let mode: "refused" | "proxy" = "refused";
  const fake: typeof fetch = (url, init) => {
    const target =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target.endsWith("/.well-known/jmap"))
      return Promise.resolve(response(session));
    if (target.includes("/upload/"))
      return Promise.resolve(
        response({
          accountId: "account",
          blobId: "blob",
          type: "message/rfc822",
          size: 1,
        }),
      );
    if (typeof init?.body !== "string") throw new Error("Missing request body");
    const call = calls.parse(JSON.parse(init.body)).methodCalls[0];
    if (call?.[0] === "Mailbox/get")
      return Promise.resolve(
        response({
          methodResponses: [
            [
              "Mailbox/get",
              {
                accountId: "account",
                state: "s",
                list: [
                  { id: "inbox", name: "Inbox", role: "inbox", parentId: null },
                ],
                notFound: [],
              },
              "0",
            ],
          ],
          sessionState: "s",
        }),
      );
    if (mode === "refused")
      return Promise.reject(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
      );
    return Promise.resolve(new Response("proxy unavailable", { status: 503 }));
  };
  vi.stubGlobal("fetch", fake);
  try {
    const delivery = jmapDelivery([
      {
        id: "account",
        origin: "http://internal.test",
        authorization: "Bearer secret",
        quarantineMailbox: "junk",
        rewriteSessionUrls: true,
      },
    ]);
    const run = () =>
      delivery.import(
        "account",
        new Uint8Array([1]),
        false,
        "2026-01-02T03:04:05Z",
        "key",
        new Map(),
        () => Promise.resolve(ok(undefined)),
      );
    const refused = await run();
    expect(refused.isErr() && refused.error.ambiguous).toBe(false);
    mode = "proxy";
    const proxy = await run();
    expect(proxy.isErr() && proxy.error.ambiguous).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("JMAP delivery to linked mailboxes", () => {
  const authorizations: string[] = [];
  const fake: typeof fetch = (url, init) =>
    Promise.resolve().then(() => {
      const target =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      if (target.endsWith("/.well-known/jmap")) return response(session);
      if (typeof init?.body !== "string")
        throw new Error("Missing request body");
      const call = calls.parse(JSON.parse(init.body)).methodCalls[0];
      if (call === undefined) throw new Error("Missing call");
      const value =
        call[0] === "Mailbox/get"
          ? {
              accountId: "account",
              state: "s",
              list: [
                { id: "inbox", name: "Inbox", role: "inbox", parentId: null },
                { id: "junk", name: "Junk", role: "junk", parentId: null },
              ],
              notFound: [],
            }
          : {
              accountId: "account",
              queryState: "q",
              canCalculateChanges: false,
              position: 0,
              ids: [],
            };
      return response({
        methodResponses: [[call[0], value, "0"]],
        sessionState: "s",
      });
    });
  const bytes = Buffer.from("Message-ID: <one@example.test>\r\n\r\nbody");
  const date = "2026-01-02T03:04:05.000Z";
  const credential = vi.fn<LinkedMailboxes["credential"]>((accountId) =>
    Promise.resolve(
      accountId === "missing"
        ? err({ kind: "not_found" })
        : accountId === "broken"
          ? err({ kind: "database_error" })
          : ok({ address: "carol@example.test", secret: "app-secret" }),
    ),
  );
  const linked = { origin: "http://internal.test", credential };

  it("reads the stored credential per connection and checks the account", async () => {
    vi.stubGlobal("fetch", fake);
    try {
      authorizations.length = 0;
      credential.mockClear();
      const delivery = jmapDelivery([], linked);
      expect(
        (await delivery.reconcile("account", bytes, true, date, "k")).isOk(),
      ).toBe(true);
      expect(
        (await delivery.reconcile("account", bytes, false, date, "k")).isOk(),
      ).toBe(true);
      expect(credential).toHaveBeenCalledTimes(2);
      expect(authorizations[0]).toBe(
        `Basic ${Buffer.from("carol@example.test:app-secret").toString("base64")}`,
      );
      const other = await delivery.reconcile("other", bytes, false, date, "k");
      expect(other.isErr() && other.error.message).toBe(
        "Destination credential is for another account",
      );
      const missing = await delivery.reconcile(
        "missing",
        bytes,
        false,
        date,
        "k",
      );
      expect(missing.isErr() && missing.error).toEqual({
        message: "Destination is not configured",
      });
      const broken = await delivery.reconcile(
        "broken",
        bytes,
        false,
        date,
        "k",
      );
      expect(broken.isErr() && broken.error).toEqual({
        message: "Destination lookup failed: database_error",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prefers a static destination, never reads the stored credential for it and checks its account", async () => {
    vi.stubGlobal("fetch", fake);
    try {
      authorizations.length = 0;
      credential.mockClear();
      const delivery = jmapDelivery(
        [
          {
            id: "account",
            origin: "http://internal.test",
            authorization: "Basic static",
            quarantineMailbox: "junk",
            rewriteSessionUrls: true,
          },
        ],
        linked,
      );
      expect(
        (await delivery.reconcile("account", bytes, true, date, "k")).isOk(),
      ).toBe(true);
      expect(credential).not.toHaveBeenCalled();
      expect(authorizations[0]).toBe("Basic static");
      const misnamed = jmapDelivery(
        [
          {
            id: "other",
            origin: "http://internal.test",
            authorization: "Basic static",
            quarantineMailbox: "junk",
          },
        ],
        linked,
      );
      const refused = await misnamed.reconcile(
        "other",
        bytes,
        false,
        date,
        "k",
      );
      expect(refused.isErr() && refused.error.message).toBe(
        "Destination credential is for another account",
      );
      expect(credential).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
