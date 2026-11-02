import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { createReadinessService } from "@opensuite/core";
import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import { createContactsService } from "@opensuite/core/services/contacts";
import { JmapCapability, JmapClient, type JmapResult } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ContactContentSchema, ContactSchema } from "@opensuite/contracts";
import { buildServer } from "../src/server.ts";

const run = promisify(execFile);
const project = `contacts-${(process.env["OPENSUITE_RUN_ID"] ?? randomBytes(6).toString("hex")).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${randomBytes(3).toString("hex")}`;
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
const value = <T>(result: JmapResult<T>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
let base: string;
let alice: JmapClient;
let aliceId: string;
let aliceAccount: string;
let bobAccount: string;
let aliceSecret: string;
let bobSecret: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let closeApp = async () => {};
const origin = "https://suite.example.test";
const now = () => performance.now();
const read = <T>(response: { body: string }, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(response.body));
const booksSchema = z.object({
  books: z
    .array(
      z.object({
        id: z.string(),
        mayRead: z.boolean(),
        mayWrite: z.boolean(),
        mayDelete: z.boolean(),
      }),
    )
    .min(1),
});
const listSchema = z.object({
  state: z.string(),
  contacts: z.array(ContactSchema),
});
const previewSchema = z.object({
  entries: z.array(
    z.object({
      contact: ContactContentSchema.nullable(),
      duplicate: z.boolean(),
      warnings: z.array(z.string()),
    }),
  ),
});
const exportSchema = z.object({ vcard: z.string() });
const suggestionSchema = z.object({
  suggestions: z.array(
    z.object({ name: z.string(), email: z.string(), source: z.string() }),
  ),
});
const headers = (user: string) => ({ origin, cookie: user });
const post = (user: string, path: string, payload: object) =>
  app.inject({
    method: "POST",
    url: `/contacts/${path}`,
    headers: headers(user),
    payload: { accountId: "default", ...payload },
  });

beforeAll(async () => {
  try {
    await compose("up", "-d");
    const port = (await compose("port", "stalwart", "8080"))
      .trim()
      .split(":")
      .at(-1);
    base = `http://127.0.0.1:${port}`;
    const ready = async (remaining: number): Promise<void> => {
      try {
        if ((await fetch(`${base}/healthz/ready`)).ok) return;
      } catch {
        /* starting */
      }
      if (!remaining) throw new Error("Stalwart unavailable");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await ready(remaining - 1);
    };
    await ready(120);
    const admin = new StalwartAdmin(base, {
      username: "admin",
      password: "integration-password",
    });
    const domain = value(await admin.createDomain("example.test"));
    aliceAccount = value(
      await admin.createAccount("alice", domain.id, "unused-primary-password"),
    ).id;
    bobAccount = value(
      await admin.createAccount("bob", domain.id, "unused-primary-password"),
    ).id;
    aliceSecret = value(await admin.createAppPassword(aliceAccount)).secret;
    bobSecret = value(await admin.createAppPassword(bobAccount)).secret;
    const client = (user: string, secret: string) =>
      new JmapClient(base, {
        authorization: `Basic ${Buffer.from(`${user}@example.test:${secret}`).toString("base64")}`,
        rewriteSessionUrlsToOrigin: base,
      });
    alice = client("alice", aliceSecret);
    const session = value(await alice.discover());
    aliceId = session.primaryAccounts[JmapCapability.contacts] ?? "";
    const contacts = createContactsService({
      codec: contactVcardCodec,
      origin: base,
      store: {
        getForOwner: (userId, accountId) =>
          Promise.resolve(
            (accountId === "default" ||
              accountId === (userId === "alice" ? aliceAccount : bobAccount)) &&
              ["alice", "bob"].includes(userId)
              ? ok({
                  accountId: userId === "alice" ? aliceAccount : bobAccount,
                  address: `${userId}@example.test`,
                  secret: userId === "alice" ? aliceSecret : bobSecret,
                })
              : err({ kind: "not_found" }),
          ),
      },
    });
    app = await buildServer({
      config: { logLevel: "silent" },
      monotonicMs: now,
      readiness: createReadinessService({
        probes: [],
        timeoutMs: 500,
        now: () => new Date(),
        monotonicMs: now,
      }),
      contacts,
      identity: {
        publicOrigin: origin,
        handler: () => Promise.resolve(new Response()),
        actor: (h) => {
          const id = h.get("cookie");
          return Promise.resolve(
            id === "alice" || id === "bob"
              ? { id, email: `${id}@example.test`, role: "user" }
              : null,
          );
        },
      },
    });
    closeApp = () => app.close();
  } catch (error) {
    await compose("down", "-v", "--remove-orphans");
    throw error;
  }
}, 180_000);
afterAll(async () => {
  await closeApp();
  await compose("down", "-v", "--remove-orphans");
}, 180_000);

describe("pinned Stalwart Contacts with an inherited-permission app password", () => {
  it("discovers JMAP Contacts and supports CRUD, search, conflicts and account isolation through HTTP", async () => {
    // v1.0.1 advertises Contacts and accepts AddressBook/get and ContactCard query/get/set for a provisioned user.
    const session = value(await alice.discover());
    expect(session.capabilities).toHaveProperty(JmapCapability.contacts);
    expect(session.accounts[aliceId]?.accountCapabilities).toHaveProperty(
      JmapCapability.contacts,
    );
    expect((await post("", "books", {})).statusCode).toBe(401);
    const books = read(await post("alice", "books", {}), booksSchema).books;
    expect(books[0]).toMatchObject({
      mayRead: true,
      mayWrite: true,
      mayDelete: true,
    });
    const bookId = books[0]?.id ?? "";
    const initial = read(await post("alice", "list", {}), listSchema);
    const created = await post("alice", "create", {
      bookId,
      state: initial.state,
      contact: {
        name: "Ada",
        emails: ["ada@example.test", "second@example.test"],
      },
    });
    expect(created.statusCode).toBe(200);
    const id = read(created, z.object({ id: z.string() })).id;
    expect(
      (
        await post("alice", "create", {
          bookId,
          state: initial.state,
          contact: { name: "Stale", emails: [] },
        })
      ).statusCode,
    ).toBe(409);
    const list = read(
      await post("alice", "list", { query: "ada", limit: 1 }),
      listSchema,
    );
    expect(list.contacts).toMatchObject([
      { id, name: "Ada", emails: ["ada@example.test", "second@example.test"] },
    ]);
    expect(
      read(await post("bob", "list", { query: "ada" }), listSchema).contacts,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/contacts/list",
          headers: headers("bob"),
          payload: { accountId: aliceAccount },
        })
      ).statusCode,
    ).toBe(403);
    const extra = value(
      await alice.contacts.setContact(session, aliceId, {
        update: { [id]: { notes: { n: { note: "Keep this" } } } },
      }),
    );
    expect(extra.updated).toHaveProperty(id);
    const latest = read(await post("alice", "list", {}), listSchema);
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state: latest.state,
          contact: { name: "Ada Lovelace", emails: ["updated@example.test"] },
        })
      ).statusCode,
    ).toBe(200);
    const raw = value(await alice.contacts.contactCards(session, aliceId, [id]))
      .list[0];
    expect(raw?.["notes"]).toEqual({ n: { note: "Keep this" } });
    expect((await post("alice", "export", { ids: [id] })).json()).toMatchObject(
      { warnings: [expect.stringContaining("notes")] },
    );
    const updated = read(await post("alice", "list", {}), listSchema);
    expect(
      (await post("alice", "delete", { contactId: id, state: updated.state }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post("alice", "delete", { contactId: id, state: updated.state }))
        .statusCode,
    ).toBe(404);
  });
  it("adds email to a contact that had none", async () => {
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const initial = read(await post("alice", "list", {}), listSchema);
    const created = await post("alice", "create", {
      bookId,
      state: initial.state,
      contact: { name: "No email", emails: [] },
    });
    expect(created.statusCode).toBe(200);
    const id = read(created, z.object({ id: z.string() })).id;
    const state = read(await post("alice", "list", {}), listSchema).state;
    const updated = await post("alice", "update", {
      contactId: id,
      state,
      contact: { name: "No email", emails: ["added@example.test"] },
    });
    expect(updated.statusCode).toBe(200);
    const current = read(await post("alice", "list", {}), listSchema);
    expect(current.contacts.find((card) => card.id === id)?.emails).toEqual([
      "added@example.test",
    ]);
    expect(
      (await post("alice", "delete", { contactId: id, state: current.state }))
        .statusCode,
    ).toBe(200);
  });
  it("previews and imports multiple vCards, reports loss and duplicates, and exports a round trip", async () => {
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const state = read(await post("alice", "list", {}), listSchema).state;
    const vcard =
      "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:One\\, Person\r\nEMAIL:one@example.test\r\nNOTE:private note\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Duplicate\r\nEMAIL:one@example.test\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Broken\r\nEMAIL:not-an-email\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Two\r\nEMAIL:two@example.test\r\nEND:VCARD\r\n";
    const preview = read(
      await post("alice", "import/preview", { vcard }),
      previewSchema,
    ).entries;
    expect(preview).toHaveLength(4);
    expect(preview[0]).toMatchObject({
      contact: { name: "One, Person" },
      warnings: [expect.stringContaining("NOTE")],
    });
    expect(preview[1]?.duplicate).toBe(true);
    expect(preview[2]?.contact).toBeNull();
    const imported = await post("alice", "import", { bookId, state, vcard });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual({ imported: 2, skipped: 2 });
    const list = read(await post("alice", "list", {}), listSchema);
    const exported = read(
      await post("alice", "export", { ids: list.contacts.map((c) => c.id) }),
      exportSchema,
    );
    const again = read(
      await post("bob", "import/preview", { vcard: exported.vcard }),
      previewSchema,
    ).entries;
    expect(
      again
        .map((e) => e.contact?.name)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["One, Person", "Two"]);
  });
  it("uses only the owner's sent recipients, including Bcc, and deduplicates contacts", async () => {
    const session = value(await alice.discover());
    const sent = value(await alice.mailboxes(session, aliceId)).list.find(
      (b) => b.role === "sent",
    );
    expect(sent).toBeDefined();
    const raw = Buffer.from(
      "From: alice@example.test\r\nTo: one@example.test\r\nCc: Recent <recent@example.test>\r\nBcc: Secret <secret@example.test>\r\nSubject: Sent\r\nDate: Wed, 01 Jan 2025 00:00:00 +0000\r\n\r\nHello\r\n",
    );
    const blob = value(await alice.upload(session, aliceId, raw));
    value(
      await alice.importEmail(session, aliceId, {
        blobId: blob.blobId,
        mailboxIds: { [sent?.id ?? ""]: true },
      }),
    );
    expect(
      read(
        await post("alice", "suggest", { query: "example.test", limit: 20 }),
        suggestionSchema,
      ).suggestions,
    ).toEqual(
      expect.arrayContaining([
        { name: "One, Person", email: "one@example.test", source: "contact" },
        { name: "Secret", email: "secret@example.test", source: "recent" },
      ]),
    );
    expect(
      read(
        await post("bob", "suggest", { query: "secret", limit: 10 }),
        suggestionSchema,
      ).suggestions,
    ).toEqual([]);
  });
});
