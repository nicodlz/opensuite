import { JmapClient, type Session } from "@opensuite/jmap";
import { mailImportOutcome } from "@opensuite/db";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  inspectMigrationCandidates,
  messageMetadata,
  splitMbox,
} from "../src/adapters/migration-mail.ts";

const bytes = (value: string) => Buffer.from(value, "latin1");

describe("import job outcomes", () => {
  it("requeues a safe deferral but preserves uncertainty and deliberate stops", () => {
    const job = {
      cancelRequested: false,
      items: [{ status: "failed" }, { status: "pending" }],
    };
    expect(mailImportOutcome(job, true)).toMatchObject({
      status: "queued",
      clearArchive: false,
    });
    expect(mailImportOutcome(job, false).status).toBe("attention");
    expect(
      mailImportOutcome(
        { ...job, items: [...job.items, { status: "uncertain" }] },
        true,
      ).status,
    ).toBe("attention");
    expect(mailImportOutcome({ ...job, cancelRequested: true }, true)).toEqual({
      status: "cancelled",
      clearArchive: true,
    });
  });
});

async function framed(
  archive: Buffer,
  variant: "mboxo" | "mboxrd" = "mboxo",
  maxMessageBytes = 1000,
  maxArchiveBytes = 2000,
) {
  const chunks = Array.from(
    { length: Math.ceil(archive.length / 3) },
    (_, index) => archive.subarray(index * 3, index * 3 + 3),
  );
  const messages: Buffer[] = [];
  for await (const message of splitMbox(Readable.from(chunks), {
    variant,
    maxMessageBytes,
    maxArchiveBytes,
  }))
    messages.push(message);
  return messages;
}

describe("MBOX framing", () => {
  it("preserves a zoned Takeout envelope date with the year after the zone", async () => {
    const raw = bytes("Date: Tue, 02 Jan 2018 01:02:03 +0000\r\n\r\nBody\r\n");
    const withZone = bytes("From sender Sat Jan 13 20:47:36 +0130 2024\r\n");
    const withoutZone = bytes("From sender Sat Jan 13 20:47:36 2024\r\n");
    expect((await messageMetadata(raw, {}, "inbox", withZone)).receivedAt).toBe(
      "2024-01-13T19:17:36Z",
    );
    expect(
      (await messageMetadata(raw, {}, "inbox", withoutZone)).receivedAt,
    ).toBe("2018-01-02T01:02:03Z");
  });
  it("maps Gmail labels and read flags without rewriting MIME bytes", async () => {
    const raw = bytes(
      "X-Gmail-Labels: Sent,Unread,Starred\r\nMessage-ID: <gmail@example.test>\r\n\r\nBody\r\n",
    );
    const result = await messageMetadata(raw, { Sent: "sent" }, "inbox");
    expect(result).toMatchObject({
      messageId: "gmail@example.test",
      mailboxIds: { inbox: true, sent: true },
      keywords: { $flagged: true },
    });
    expect(result.keywords["$seen"]).toBeUndefined();
    const read = await messageMetadata(
      bytes("X-Gmail-Labels:\r\n\r\nBody"),
      {},
      "inbox",
    );
    expect(read.keywords["$seen"]).toBe(true);
  });
  it("preserves mixed line endings, Takeout headers, and a final line without newline", async () => {
    const first = bytes(
      "X-Gmail-Labels: Inbox,Project\r\nMessage-ID: <one@example.test>\n\r\nBody\r\n\r\n",
    );
    const second = bytes("Subject: Second\n\nEnd\xff");
    const archive = Buffer.concat([
      bytes("From sender Sat Jan 1 00:00:00 2022\r\n"),
      first,
      bytes("From other Sat Jan 1 00:00:00 2022\n"),
      second,
    ]);
    expect(await framed(archive)).toEqual([first, second]);
  });
  it("only unquotes From lines in mboxrd and never splits body From without a blank line", async () => {
    const archive = bytes(
      "From sender date\nSubject: test\n\nA\nFrom body\n>From quoted\n>>From nested\n",
    );
    expect(await framed(archive, "mboxo")).toEqual([
      bytes("Subject: test\n\nA\nFrom body\n>From quoted\n>>From nested\n"),
    ]);
    expect(await framed(archive, "mboxrd")).toEqual([
      bytes("Subject: test\n\nA\nFrom body\nFrom quoted\n>From nested\n"),
    ]);
  });
  it("accepts an empty archive and rejects malformed or oversized input", async () => {
    expect(await framed(Buffer.alloc(0))).toEqual([]);
    await expect(framed(bytes("not a mailbox\n"))).rejects.toMatchObject({
      kind: "invalid_archive",
    });
    await expect(
      framed(bytes("From sender\n\n" + "x".repeat(30)), "mboxo", 20),
    ).rejects.toMatchObject({ kind: "message_limit" });
    await expect(
      framed(bytes("From sender\n\nbody"), "mboxo", 100, 8),
    ).rejects.toMatchObject({ kind: "archive_limit" });
    await expect(
      framed(
        bytes(`From sender\n${"\n".repeat(100_001)}`),
        "mboxo",
        200_000,
        200_000,
      ),
    ).rejects.toMatchObject({ kind: "message_limit" });
  });
});

const session: Session = {
  capabilities: {},
  accounts: {},
  primaryAccounts: {},
  username: "alice",
  apiUrl: "https://mail.test/jmap",
  uploadUrl: "https://mail.test/upload/{accountId}",
  downloadUrl: "https://mail.test/download/{accountId}/{blobId}",
  state: "s",
};
const body = Buffer.from("Message-ID: <one@example.test>\r\n\r\nHello\r\n");
const requestSchema = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
});
const querySchema = z.object({
  position: z.number(),
  limit: z.number(),
  filter: z.object({ hasKeyword: z.string() }).optional(),
});
const getSchema = z.object({ ids: z.array(z.string()) });
type Row = {
  id: string;
  messageId: string | null;
  bytes: Buffer;
  marker?: string;
};

function fixture(rows: Row[], options: { changeState?: boolean } = {}) {
  let queries = 0;
  const fetcher: typeof fetch = (target, init) =>
    Promise.resolve().then(() => {
      const url =
        typeof target === "string"
          ? target
          : target instanceof URL
            ? target.href
            : target.url;
      if (url.includes("/download/")) {
        const row = rows.find((item) => url.endsWith(`/${item.id}`));
        return row === undefined
          ? new Response(null, { status: 404 })
          : new Response(Uint8Array.from(row.bytes));
      }
      if (typeof init?.body !== "string") throw new Error("missing body");
      const call = requestSchema.parse(JSON.parse(init.body)).methodCalls[0];
      if (call === undefined) throw new Error("missing call");
      let value: object;
      if (call[0] === "Email/query") {
        const query = querySchema.parse(call[1]);
        const filtered = rows.filter(
          (row) =>
            query.filter === undefined ||
            row.marker === query.filter.hasKeyword,
        );
        queries++;
        value = {
          accountId: "account",
          queryState: options.changeState && queries > 1 ? "changed" : "q",
          canCalculateChanges: false,
          position: query.position,
          ids: filtered
            .slice(query.position, query.position + query.limit)
            .map((row) => row.id),
        };
      } else if (call[0] === "Email/get") {
        const ids = getSchema.parse(call[1]).ids;
        value = {
          accountId: "account",
          state: "s",
          notFound: [],
          list: rows
            .filter((row) => ids.includes(row.id))
            .map((row) => ({
              id: row.id,
              blobId: row.id,
              size: row.bytes.length,
              messageId: row.messageId === null ? null : [row.messageId],
              keywords: row.marker === undefined ? {} : { [row.marker]: true },
            })),
        };
      } else throw new Error("unexpected method");
      return new Response(
        JSON.stringify({
          methodResponses: [[call[0], value, "0"]],
          sessionState: "s",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    });
  const client = new JmapClient("https://mail.test", {
    authorization: "test",
    fetch: fetcher,
  });
  return (
    extra: {
      marker?: string;
      maxCandidates?: number;
      messageId?: string | null;
    } = {},
  ) =>
    inspectMigrationCandidates({
      client,
      session,
      accountId: "account",
      bytes: body,
      messageId:
        extra.messageId === undefined ? "one@example.test" : extra.messageId,
      ...(extra.marker === undefined ? {} : { marker: extra.marker }),
      ...(extra.maxCandidates === undefined
        ? {}
        : { maxCandidates: extra.maxCandidates }),
    });
}

describe("migration candidate inspection", () => {
  it("confirms only a matching Message-ID and original bytes", async () => {
    const inspect = fixture([
      { id: "a", messageId: "one@example.test", bytes: body },
    ]);
    expect(
      (await inspect()).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({
      kind: "match",
      id: "a",
    });
    const collision = fixture([
      {
        id: "a",
        messageId: "one@example.test",
        bytes: Buffer.from("different"),
      },
    ]);
    expect(
      (await collision()).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({ kind: "collision" });
    const changed = Buffer.from(body);
    changed[changed.length - 3] = 0x21;
    const sameSize = fixture([
      { id: "a", messageId: "one@example.test", bytes: changed },
    ]);
    expect(
      (await sameSize()).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({ kind: "collision" });
    const other = fixture([
      { id: "a", messageId: "other@example.test", bytes: body },
    ]);
    expect(
      (await other()).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({ kind: "none" });
    expect(
      (await other({ messageId: null })).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({
      kind: "unresolved",
    });
  });
  it("reconciles a matching marker but never treats its absence as a failed import", async () => {
    const inspect = fixture([
      { id: "a", messageId: null, bytes: body, marker: "import-1" },
    ]);
    expect(
      (await inspect({ marker: "import-1", messageId: null })).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({ kind: "match", id: "a" });
    expect(
      (await inspect({ marker: "missing" })).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({
      kind: "unresolved",
    });
    const multiple = fixture([
      { id: "a", messageId: null, bytes: body, marker: "import-1" },
      { id: "b", messageId: null, bytes: body, marker: "import-1" },
    ]);
    expect(
      (await multiple({ marker: "import-1" })).match(
        (value) => value,
        () => null,
      ),
    ).toEqual({
      kind: "collision",
    });
  });
  it("fails closed if the query changes or exceeds the scan limit", async () => {
    const rows = [
      { id: "a", messageId: "one@example.test", bytes: body },
      { id: "b", messageId: "two@example.test", bytes: body },
    ];
    expect(
      (await fixture(rows, { changeState: true })()).match(
        () => null,
        (error) => error,
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      (await fixture(rows)({ maxCandidates: 1 })).match(
        () => null,
        (error) => error,
      ),
    ).toEqual({ kind: "limit" });
  });
});
