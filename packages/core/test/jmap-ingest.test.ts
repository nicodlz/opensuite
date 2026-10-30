import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { jmapDelivery } from "../src/adapters/jmap.ts";

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
      const delivery = jmapDelivery([
        { ...destination, id: "one" },
        { ...destination, id: "two" },
      ]);
      const cache = new Map<string, string>();
      const date = "2026-01-02T03:04:05.000Z";
      expect(
        (await delivery.import("one", bytes, false, date, "key", cache)).isOk(),
      ).toBe(true);
      expect(
        (await delivery.import("two", bytes, false, date, "key", cache)).isOk(),
      ).toBe(true);
      expect(uploads).toBe(1);
      expect(importedDate).toBe(date);
      expect(
        (await delivery.reconcile("one", bytes, false, date, "key")).isOk(),
      ).toBe(true);
      downloaded = Buffer.from("Message-ID: <one@example.test>\r\n\r\nother");
      expect(
        (await delivery.reconcile("one", bytes, false, date, "key")).isErr(),
      ).toBe(true);
      expect(
        (
          await delivery.reconcile(
            "one",
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
