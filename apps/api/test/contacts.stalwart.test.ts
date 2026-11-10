import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createReadinessService } from "@opensuite/core";
import { contactVcardCodec } from "@opensuite/core/adapters/contacts";
import { createContactsService } from "@opensuite/core/services/contacts";
import { JmapCapability, JmapClient, type JmapResult } from "@opensuite/jmap";
import { StalwartAdmin } from "@opensuite/jmap/admin";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContactBookPrivacySchema,
  ContactContentSchema,
  ContactSchema,
} from "@opensuite/contracts";
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
        privacy: ContactBookPrivacySchema,
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

async function changeBookSharing(
  bookId: string,
  shareWith: Record<string, object>,
) {
  const session = value(await alice.discover());
  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`alice@example.test:${aliceSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      using: [JmapCapability.core, JmapCapability.contacts],
      methodCalls: [
        [
          "AddressBook/set",
          { accountId: aliceId, update: { [bookId]: { shareWith } } },
          "privacy",
        ],
      ],
    }),
  });
  expect(response.status).toBe(200);
  const result = z
    .object({
      methodResponses: z.array(
        z.tuple([
          z.string(),
          z.object({ updated: z.record(z.string(), z.unknown()) }),
          z.string(),
        ]),
      ),
    })
    .parse(await response.json());
  expect(result.methodResponses[0]?.[0]).toBe("AddressBook/set");
  expect(
    Object.hasOwn(result.methodResponses[0]?.[1].updated ?? {}, bookId),
  ).toBe(true);
}

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
  it("reports native sharing changes as observations without ever enabling Bcc", async () => {
    const book = read(await post("alice", "books", {}), booksSchema).books[0];
    if (!book) throw new Error("Missing test address book");
    const bob = new JmapClient(base, {
      authorization: `Basic ${Buffer.from(`bob@example.test:${bobSecret}`).toString("base64")}`,
      rewriteSessionUrlsToOrigin: base,
    });
    const session = value(await bob.discover());
    const sharee = session.primaryAccounts[JmapCapability.contacts];
    if (!sharee) throw new Error("Missing test sharee");
    try {
      await changeBookSharing(book.id, {
        [sharee]: {
          mayRead: true,
          mayWrite: false,
          mayDelete: false,
          mayShare: false,
        },
      });
      const shared = read(
        await post("alice", "books", {}),
        booksSchema,
      ).books.find((item) => item.id === book.id);
      expect(shared?.privacy).toMatchObject({
        status: "shared",
        assurance: "observed",
        bccEligible: false,
      });
      expect(shared?.privacy.state).not.toBe(book.privacy.state);
    } finally {
      await changeBookSharing(book.id, {});
    }
    const restored = read(
      await post("alice", "books", {}),
      booksSchema,
    ).books.find((item) => item.id === book.id);
    expect(restored?.privacy).toMatchObject({
      status: "private",
      assurance: "observed",
      bccEligible: false,
    });
  });
  it("retains useful contact fields through API, CardDAV edits and vCard export", async () => {
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const initial = read(await post("alice", "list", {}), listSchema);
    const created = await post("alice", "create", {
      bookId,
      state: initial.state,
      contact: {
        name: "Marie Dupont",
        emails: ["fidelity@example.test"],
        phones: {
          mobile: {
            number: "+33612345678",
            contexts: { private: true },
            features: { mobile: true },
            label: "Personnel",
          },
        },
        addresses: {
          home: {
            components: [
              { kind: "number", value: "12" },
              { kind: "name", value: "rue de l’Église" },
              { kind: "separator", value: "/" },
              { kind: "floor", value: "4" },
              { kind: "apartment", value: "B" },
              { kind: "locality", value: "Paris" },
              { kind: "postcode", value: "75001" },
              { kind: "country", value: "France" },
            ],
            contexts: { private: true },
            defaultSeparator: " ",
            isOrdered: true,
            full: "12 rue de l’Église, Paris",
            label: "Domicile",
            countryCode: "FR",
          },
        },
        notes: { note: { note: "Note initiale" } },
        organizations: {
          company: { name: "Esuno", units: [{ name: "Architecture" }] },
        },
        links: { web: { uri: "https://example.test/profile" } },
        anniversaries: {
          birth: {
            kind: "birth",
            date: { "@type": "PartialDate", year: 1990, month: 4, day: 3 },
          },
        },
        vCard: {
          properties: [
            [
              "x-custom",
              { "x-parameter": "kept", "x-list": ["one,two", "three"] },
              "unknown",
              "Valeur privée",
            ],
          ],
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const id = read(created, z.object({ id: z.string() })).id;
    const current = read(await post("alice", "list", {}), listSchema);
    const contact = current.contacts.find((card) => card.id === id);
    expect(
      Object.values(contact?.phones ?? {}).map((phone) => phone.number),
    ).toContain("+33612345678");
    expect(JSON.stringify(contact?.addresses)).toContain("rue de l’Église");
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state: current.state,
          contact: { name: "Marie", emails: ["fidelity@example.test"] },
        })
      ).statusCode,
    ).toBe(200);

    const metadataState = read(
      await post("alice", "list", {}),
      listSchema,
    ).state;
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state: metadataState,
          contact: {
            name: "Marie",
            emails: ["fidelity@example.test"],
            vCard: {
              convertedProperties: {
                uid: { parameters: { "x-updated": "kept" } },
              },
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    // Use the declared core dependency to exercise the actual CardDAV transport.
    type Card = { url: string; data?: string; etag?: string };
    type Dav = {
      login(): Promise<void>;
      fetchAddressBooks(): Promise<{ url: string }[]>;
      fetchVCards(input: { addressBook: { url: string } }): Promise<Card[]>;
      updateVCard(input: { vCard: Card }): Promise<Response>;
    };
    type Constructor = new (options: {
      serverUrl: string;
      credentials: { username: string; password: string };
      authMethod: "Basic";
      defaultAccountType: "carddav";
    }) => Dav;
    const { DAVClient } = z
      .object({
        DAVClient: z.custom<Constructor>(
          (entry) => typeof entry === "function",
        ),
      })
      .parse(
        createRequire(
          new URL("../../../packages/core/package.json", import.meta.url),
        )("tsdav"),
      );
    const dav = new DAVClient({
      serverUrl: base,
      credentials: { username: "alice@example.test", password: aliceSecret },
      authMethod: "Basic",
      defaultAccountType: "carddav",
    });
    await dav.login();
    const cards = (
      await Promise.all(
        (await dav.fetchAddressBooks()).map((addressBook) =>
          dav.fetchVCards({ addressBook }),
        ),
      )
    ).flat();
    const stored = cards.find((card) =>
      card.data?.includes("fidelity@example.test"),
    );
    expect(stored?.data).toContain("+33612345678");
    if (!stored?.data) throw new Error("CardDAV card missing");
    const changed = await dav.updateVCard({
      vCard: {
        ...stored,
        data: stored.data
          .replace("+33612345678", "+33687654321")
          .replace("Note initiale", "Note CardDAV"),
      },
    });
    expect(changed.ok).toBe(true);
    const after = read(
      await post("alice", "list", {}),
      listSchema,
    ).contacts.find((card) => card.id === id);
    expect(
      Object.values(after?.phones ?? {}).map((phone) => phone.number),
    ).toContain("+33687654321");
    const exported = read(
      await post("alice", "export", { ids: [id] }),
      exportSchema,
    );
    expect(exported.vcard).toContain("+33687654321");
    expect(exported.vcard).toContain("Note CardDAV");
    expect(exported.vcard).toContain("Paris");
    expect(exported.vcard).toContain("Architecture");
    expect(exported.vcard).toContain("https://example.test/profile");
    expect(exported.vcard).toMatch(/BDAY.*1990/);
    expect(exported.vcard.toLowerCase()).toContain("x-custom");
    expect(exported.vcard).toContain("Valeur privée");
    expect(exported.vcard).toContain('X-LIST="one,two","three"');
    const bobState = read(await post("bob", "list", {}), listSchema).state;
    const bobBook =
      read(await post("bob", "books", {}), booksSchema).books[0]?.id ?? "";
    const roundTrip = await post("bob", "import", {
      bookId: bobBook,
      state: bobState,
      vcard: exported.vcard,
    });
    expect(roundTrip.statusCode).toBe(200);
    expect(roundTrip.json()).toMatchObject({ imported: 1 });
    const bobContacts = read(await post("bob", "list", {}), listSchema);
    const copied = bobContacts.contacts.find((card) =>
      card.emails.includes("fidelity@example.test"),
    );
    expect(
      Object.values(copied?.phones ?? {}).map((phone) => phone.number),
    ).toContain("+33687654321");
    expect(Object.values(copied?.phones ?? {})).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Personnel" })]),
    );
    const copiedAddress = Object.values(copied?.addresses ?? {})[0];
    expect(copiedAddress).toMatchObject({
      full: "12 rue de l’Église, Paris",
      defaultSeparator: " ",
      label: "Domicile",
    });
    expect(copiedAddress?.components).toEqual(
      expect.arrayContaining([
        { kind: "number", value: "12" },
        { kind: "floor", value: "4" },
        { kind: "apartment", value: "B" },
        { kind: "separator", value: "/" },
      ]),
    );
    expect(String(copiedAddress?.["countryCode"]).toUpperCase()).toBe("FR");
    expect(Object.values(copied?.anniversaries ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "birth",
          date: { "@type": "PartialDate", year: 1990, month: 4, day: 3 },
        }),
      ]),
    );
    expect(JSON.stringify(copied?.addresses)).toContain("Paris");
    expect(
      (
        await post("bob", "delete", {
          contactId: copied?.id ?? "",
          state: bobContacts.state,
        })
      ).statusCode,
    ).toBe(200);
    const latest = read(await post("alice", "list", {}), listSchema);
    expect(
      (await post("alice", "delete", { contactId: id, state: latest.state }))
        .statusCode,
    ).toBe(200);
  });
  it("preserves year-month birthdays and canonical labels through native storage and import", async () => {
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const state = read(await post("alice", "list", {}), listSchema).state;
    const created = await post("alice", "create", {
      bookId,
      state,
      contact: {
        name: "Month precision",
        emails: ["month-precision@example.test"],
        uid: "urn:uuid:00000000-0000-4000-8000-000000000004",
        phones: { p: { number: "+33123456789", label: "Fresh label" } },
        anniversaries: {
          birth: {
            kind: "birth",
            date: { "@type": "PartialDate", year: 1990, month: 4, day: 3 },
          },
        },
        vCard: {
          properties: [
            ["uid", {}, "text", "stale-uid"],
            ["x-ablabel", { group: "item1" }, "text", "STALE-LABEL"],
          ],
          convertedProperties: {
            "/phones/p/number": { parameters: { group: "item1" } },
          },
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const id = read(created, z.object({ id: z.string() })).id;
    const beforeDateEdit = read(await post("alice", "list", {}), listSchema);
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state: beforeDateEdit.state,
          contact: {
            name: "Month precision",
            emails: ["month-precision@example.test"],
            anniversaries: {
              birth: {
                kind: "birth",
                date: { "@type": "PartialDate", year: 1990, month: 4 },
              },
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    const saved = read(
      await post("alice", "list", {}),
      listSchema,
    ).contacts.find((c) => c.id === id);
    expect(Object.values(saved?.phones ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Fresh label" }),
      ]),
    );
    const compatible = ContactContentSchema.safeParse(saved);
    if (!compatible.success) throw new Error(compatible.error.message);
    expect(saved?.uid).toBe("urn:uuid:00000000-0000-4000-8000-000000000004");
    const exportResponse = await post("alice", "export", { ids: [id] });
    expect(exportResponse.statusCode).toBe(200);
    const exported = read(exportResponse, exportSchema).vcard;
    expect(exported).toContain("BDAY:1990-04");
    expect(exported).not.toContain("stale-uid");
    expect(exported).not.toContain("STALE-LABEL");
    const bobState = read(await post("bob", "list", {}), listSchema).state;
    const bobBook =
      read(await post("bob", "books", {}), booksSchema).books[0]?.id ?? "";
    const imported = await post("bob", "import", {
      bookId: bobBook,
      state: bobState,
      vcard: exported,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ imported: 1 });
    const copied = read(await post("bob", "list", {}), listSchema);
    const contact = copied.contacts.find((c) =>
      c.emails.includes("month-precision@example.test"),
    );
    expect(contact?.uid).toBe(saved?.uid);
    expect(Object.values(contact?.anniversaries ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: { "@type": "PartialDate", year: 1990, month: 4 },
        }),
      ]),
    );
    expect(
      (
        await post("bob", "delete", {
          contactId: contact?.id ?? "",
          state: copied.state,
        })
      ).statusCode,
    ).toBe(200);
    const latest = read(await post("alice", "list", {}), listSchema);
    expect(
      (await post("alice", "delete", { contactId: id, state: latest.state }))
        .statusCode,
    ).toBe(200);
  });

  it("blocks unsupported native postal separators before mutations and reports skipped imports", async () => {
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const initial = read(await post("alice", "list", {}), listSchema);
    expect(
      (
        await post("alice", "create", {
          bookId,
          state: initial.state,
          contact: {
            name: "Unsafe group",
            emails: [],
            vCard: {
              properties: [
                ["x-custom", { group: "item1\nEND:VCARD" }, "text", "value"],
              ],
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    const contact = ContactContentSchema.parse({
      name: "Layout guard",
      emails: ["layout-guard@example.test"],
      addresses: {
        a: {
          defaultSeparator: ";",
          components: [
            { kind: "number", value: "12" },
            { kind: "name", value: "Street" },
          ],
        },
      },
    });
    expect(
      (await post("alice", "create", { bookId, state: initial.state, contact }))
        .statusCode,
    ).toBe(400);
    expect(read(await post("alice", "list", {}), listSchema).state).toBe(
      initial.state,
    );
    const created = await post("alice", "create", {
      bookId,
      state: initial.state,
      contact: { name: "Before", emails: contact.emails },
    });
    expect(created.statusCode).toBe(200);
    const id = read(created, z.object({ id: z.string() })).id;
    const current = read(await post("alice", "list", {}), listSchema);
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state: current.state,
          contact,
        })
      ).statusCode,
    ).toBe(400);
    const vcard = contactVcardCodec.serialize([contact]);
    const preview = read(
      await post("alice", "import/preview", { vcard }),
      previewSchema,
    ).entries;
    expect(preview[0]).toMatchObject({
      contact: null,
      warnings: [expect.stringContaining("import blocked")],
    });
    const imported = await post("alice", "import", {
      bookId,
      state: current.state,
      vcard,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual({ imported: 0, skipped: 1 });
    const latest = read(await post("alice", "list", {}), listSchema);
    expect(latest.state).toBe(current.state);
    expect(latest.contacts.find((c) => c.id === id)?.name).toBe("Before");
    expect(
      (await post("alice", "delete", { contactId: id, state: latest.state }))
        .statusCode,
    ).toBe(200);
  });

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
      privacy: {
        status: "private",
        assurance: "observed",
        sharingAllowed: true,
        bccEligible: false,
      },
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
    await expect
      .poll(
        async () =>
          read(
            await post("alice", "list", { query: "ada", limit: 1 }),
            listSchema,
          ).contacts,
        { timeout: 5000 },
      )
      .toMatchObject([
        {
          id,
          name: "Ada",
          emails: ["ada@example.test", "second@example.test"],
        },
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
      { warnings: [] },
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
  it("keeps per-email metadata with its address through reorder and removal", async () => {
    const session = value(await alice.discover());
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const created = value(
      await alice.contacts.setContact(session, aliceId, {
        create: {
          item: {
            "@type": "Card",
            name: { full: "Metadata" },
            addressBookIds: { [bookId]: true },
            emails: {
              work: { address: "work@example.test", contexts: { work: true } },
              home: {
                address: "home@example.test",
                contexts: { private: true },
                pref: 1,
              },
            },
          },
        },
      }),
    );
    const id = created.created?.["item"]?.id ?? "";
    expect(id).not.toBe("");
    const state = read(await post("alice", "list", {}), listSchema).state;
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state,
          contact: {
            name: "Metadata",
            emails: ["home@example.test", "work@example.test"],
          },
        })
      ).statusCode,
    ).toBe(200);
    const reordered = value(
      await alice.contacts.contactCards(session, aliceId, [id]),
    ).list[0];
    expect(Object.values(reordered?.emails ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: "work@example.test",
          contexts: { work: true },
        }),
        expect.objectContaining({
          address: "home@example.test",
          contexts: { private: true },
          pref: 1,
        }),
      ]),
    );
    const nextState = read(await post("alice", "list", {}), listSchema).state;
    expect(
      (
        await post("alice", "update", {
          contactId: id,
          state: nextState,
          contact: { name: "Metadata", emails: ["home@example.test"] },
        })
      ).statusCode,
    ).toBe(200);
    const remaining = value(
      await alice.contacts.contactCards(session, aliceId, [id]),
    ).list[0];
    expect(Object.values(remaining?.emails ?? {})).toEqual([
      expect.objectContaining({
        address: "home@example.test",
        contexts: { private: true },
        pref: 1,
      }),
    ]);
    const finalState = read(await post("alice", "list", {}), listSchema).state;
    expect(
      (await post("alice", "delete", { contactId: id, state: finalState }))
        .statusCode,
    ).toBe(200);
  });
  it("lists, suggests and exports contacts written by other clients with non-TLD and many email addresses", async () => {
    const session = value(await alice.discover());
    const bookId =
      read(await post("alice", "books", {}), booksSchema).books[0]?.id ?? "";
    const addresses = [
      "ops@localhost",
      ...Array.from(
        { length: 21 },
        (_, i) => `external${String(i)}@example.test`,
      ),
    ];
    const created = value(
      await alice.contacts.setContact(session, aliceId, {
        create: {
          item: {
            "@type": "Card",
            name: { full: "External Ops" },
            addressBookIds: { [bookId]: true },
            emails: Object.fromEntries(
              addresses.map((address, i) => [`e${String(i)}`, { address }]),
            ),
          },
        },
      }),
    );
    const id = created.created?.["item"]?.id ?? "";
    expect(id).not.toBe("");
    const listed = await post("alice", "list", {});
    expect(listed.statusCode).toBe(200);
    const card = read(listed, listSchema).contacts.find(
      (item) => item.id === id,
    );
    expect(card?.emails).toHaveLength(addresses.length);
    expect(card?.emails).toContain("ops@localhost");
    const suggestions = read(
      await post("alice", "suggest", { query: "External Ops", limit: 30 }),
      suggestionSchema,
    );
    expect(suggestions.suggestions).toContainEqual({
      name: "External Ops",
      email: "ops@localhost",
      source: "contact",
    });
    const exported = await post("alice", "export", { ids: [id, id] });
    expect(exported.statusCode).toBe(200);
    const vcard = read(exported, exportSchema).vcard;
    expect(vcard).toContain("EMAIL:ops@localhost");
    const preview = read(
      await post("bob", "import/preview", { vcard }),
      previewSchema,
    );
    expect(preview.entries[0]?.contact?.emails).toHaveLength(addresses.length);
    const state = read(await post("alice", "list", {}), listSchema).state;
    expect(
      (await post("alice", "delete", { contactId: id, state })).statusCode,
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
      warnings: [],
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
  it("reports large malformed vCard framing without blocking the HTTP service", async () => {
    const responses = await Promise.all(
      [
        "BEGIN:VCARD\n".repeat(20_000),
        `BEGIN:VCARD${"\n".repeat(249_000)}`,
      ].map((vcard) => post("alice", "import/preview", { vcard })),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(read(response, previewSchema).entries[0]?.contact).toBeNull();
    }
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
