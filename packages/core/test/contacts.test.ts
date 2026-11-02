import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  contactVcardCodec,
  parseCards,
  serializeCards,
} from "../src/adapters/contacts.ts";

const testCard = (name: string) =>
  `BEGIN:VCARD\nVERSION:4.0\nFN:${name}\nEMAIL:${name}@example.test\nEND:VCARD\n`;

describe("vCard conversion", () => {
  it("handles escaped names, folded lines and multiple cards while reporting properties it cannot retain", () => {
    const source =
      "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Anne\\,\r\n Example\r\nEMAIL;TYPE=work:anne@example.test\r\nNOTE:Not retained\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Other\r\nEMAIL:other@example.test\r\nEND:VCARD\r\n";
    const parsed = parseCards(source);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      contact: { name: "Anne,Example", emails: ["anne@example.test"] },
      warnings: [
        "Parameters on EMAIL are not retained",
        "Property NOTE is not retained",
      ],
    });
    expect(
      parseCards(
        serializeCards(
          parsed.flatMap((entry) => (entry.contact ? [entry.contact] : [])),
        ),
      ).map((entry) => entry.contact),
    ).toEqual(parsed.map((entry) => entry.contact));
  });
  it("reports malformed and unsupported cards, and rejects excessive input", () => {
    expect(
      parseCards(
        "BEGIN:VCARD\nVERSION:4.0\nFN:Invalid\nEMAIL:nope\nEND:VCARD\n",
      )[0]?.contact,
    ).toBeNull();
    expect(
      parseCards("BEGIN:VCARD\nVERSION:2.1\nFN:Old\nEND:VCARD\n")[0]?.contact,
    ).toBeNull();
    expect(parseCards("not a card")[0]?.contact).toBeNull();
    expect(() => parseCards("x".repeat(250_001))).toThrow("too large");
    expect(() =>
      parseCards("BEGIN:VCARD\nVERSION:4.0\nFN:X\nEND:VCARD\n".repeat(101)),
    ).toThrow("too many cards");
  });
  it("handles large malformed framing without repeatedly scanning the input", () => {
    expect(parseCards("BEGIN:VCARD\n".repeat(20_000))[0]?.contact).toBeNull();
    expect(
      parseCards(`BEGIN:VCARD${"\n".repeat(249_000)}`)[0]?.contact,
    ).toBeNull();
  });
  it("preserves email metadata by address when emails are reordered or removed", () => {
    const card = {
      id: "one",
      addressBookIds: { book: true },
      name: { full: "Example" },
      emails: {
        work: { address: "a@example.test", contexts: { work: true } },
        private: {
          address: "b@example.test",
          contexts: { private: true },
          pref: 1,
        },
      },
    };
    expect(
      contactVcardCodec.patch(card, {
        name: "Example",
        emails: ["b@example.test", "a@example.test"],
      }),
    ).toEqual({ "name/full": "Example" });
    expect(
      contactVcardCodec.patch(card, {
        name: "Example",
        emails: ["b@example.test", "new@example.test"],
      }),
    ).toEqual({
      "name/full": "Example",
      "emails/opensuite1": { address: "new@example.test" },
      "emails/work": null,
    });
  });
  it("projects externally stored contacts without applying create limits", () => {
    const addresses = [
      "ops@localhost",
      ...Array.from({ length: 21 }, (_, i) => `p${String(i)}@example.test`),
    ];
    const card = {
      id: "external",
      addressBookIds: { book: true },
      name: null,
      emails: Object.fromEntries(
        addresses.map((address, i) => [String(i), { address }]),
      ),
    };
    expect(contactVcardCodec.project(card)).toEqual({
      id: "external",
      addressBookIds: ["book"],
      name: "",
      emails: addresses,
    });
    expect(
      contactVcardCodec.patch(card, { name: "New name", emails: addresses }),
    ).toEqual({ name: { full: "New name" } });
    expect(serializeCards([contactVcardCodec.content(card)])).toContain(
      "EMAIL:ops@localhost",
    );
  });
  it("matches exact addresses before case-insensitive fallbacks", () => {
    const card = {
      id: "case",
      addressBookIds: { book: true },
      name: { full: "Example" },
      emails: {
        lower: { address: "person@example.test", label: "lower" },
        upper: { address: "Person@example.test", label: "upper" },
      },
    };
    expect(
      contactVcardCodec.patch(card, {
        name: "Example",
        emails: ["Person@example.test", "person@example.test"],
      }),
    ).toEqual({ "name/full": "Example" });
    expect(
      contactVcardCodec.patch(
        { ...card, emails: { lower: card.emails.lower } },
        {
          name: "Example",
          emails: ["person@EXAMPLE.test"],
        },
      ),
    ).toEqual({
      "name/full": "Example",
      "emails/lower/address": "person@EXAMPLE.test",
    });
  });
});

it("limits concurrent contacts work per actor without blocking another actor", async () => {
  const { createContactsService } = await import("../src/services/contacts.ts");
  const { err } = await import("neverthrow");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createContactsService({
    codec: contactVcardCodec,
    origin: "https://mail.example.test",
    store: {
      getForOwner: async () => {
        await gate;
        return err({ kind: "not_found" });
      },
    },
  });
  const alice = {
    id: "alice",
    email: "alice@example.test",
    role: "user" as const,
  };
  const bob = { id: "bob", email: "bob@example.test", role: "user" as const };
  const first = service.books(alice, "default");
  const second = service.books(alice, "default");
  const third = await service.books(alice, "default");
  expect(third.isErr() && third.error.kind).toBe("rate_limited");
  const other = service.books(bob, "default");
  release();
  const results = await Promise.all([first, second, other]);
  expect(results.map((result) => result.isErr() && result.error.kind)).toEqual([
    "forbidden",
    "forbidden",
    "forbidden",
  ]);
});

it("reports a partially accepted import rather than hiding created contacts", async () => {
  const { createContactsService } = await import("../src/services/contacts.ts");
  const { JmapClient, JmapCapability } = await import("@opensuite/jmap");
  const { ok } = await import("neverthrow");
  const origin = "https://mail.example.test";
  let sets = 0;
  const fake: typeof fetch = (_url, init) => {
    if (init?.method !== "POST")
      return Promise.resolve(
        Response.json({
          capabilities: { [JmapCapability.contacts]: {} },
          accounts: {
            a: {
              name: "Alice",
              isPersonal: true,
              isReadOnly: false,
              accountCapabilities: { [JmapCapability.contacts]: {} },
            },
          },
          primaryAccounts: { [JmapCapability.contacts]: "a" },
          username: "alice",
          apiUrl: `${origin}/jmap`,
          downloadUrl: `${origin}/download`,
          uploadUrl: `${origin}/upload`,
          state: "s",
        }),
      );
    const data = z
      .object({
        methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      })
      .parse(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
    const method = data.methodCalls[0]?.[0];
    const replies: Record<string, object> = {
      "AddressBook/get": {
        accountId: "a",
        state: "books",
        list: [
          {
            id: "book",
            name: "Book",
            isDefault: true,
            myRights: { mayRead: true, mayWrite: true, mayDelete: true },
          },
        ],
        notFound: [],
      },
      "ContactCard/query": {
        accountId: "a",
        queryState: "q",
        canCalculateChanges: false,
        position: 0,
        ids: [],
      },
      "ContactCard/get": { accountId: "a", state: "s", list: [], notFound: [] },
      "ContactCard/set": {
        accountId: "a",
        newState: "next",
        created: { item0: { id: "created" } },
        notCreated: { item1: { type: "invalidProperties" } },
      },
    };
    if (method === "ContactCard/set") sets++;
    return Promise.resolve(
      Response.json({
        methodResponses: [[method, replies[method ?? ""], "0"]],
        sessionState: "s",
      }),
    );
  };
  const service = createContactsService({
    codec: contactVcardCodec,
    origin,
    store: {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "a",
            address: "alice@example.test",
            secret: "secret",
          }),
        ),
    },
    client: () =>
      new JmapClient(origin, { authorization: "test", fetch: fake }),
  });
  const result = await service.import(
    { id: "alice", email: "alice@example.test", role: "user" },
    "default",
    { bookId: "book", state: "s", vcard: testCard("one") + testCard("two") },
  );
  expect(result.isOk()).toBe(true);
  expect(result.isOk() ? result.value : undefined).toEqual({
    imported: 1,
    skipped: 0,
    failed: [{ index: 1, reason: "invalidProperties" }],
  });
  expect(sets).toBe(1);
});

it("does not synthesize recent recipients when the sent-mail source fails", async () => {
  const { createContactsService } = await import("../src/services/contacts.ts");
  const { JmapClient, JmapCapability } = await import("@opensuite/jmap");
  const { ok } = await import("neverthrow");
  const origin = "https://mail.example.test";
  const fake: typeof fetch = (_url, init) => {
    if (init?.method !== "POST")
      return Promise.resolve(
        Response.json({
          capabilities: { [JmapCapability.contacts]: {} },
          accounts: {
            a: {
              name: "Alice",
              isPersonal: true,
              isReadOnly: false,
              accountCapabilities: { [JmapCapability.contacts]: {} },
            },
          },
          primaryAccounts: {
            [JmapCapability.contacts]: "a",
            [JmapCapability.mail]: "a",
          },
          username: "alice",
          apiUrl: `${origin}/jmap`,
          downloadUrl: `${origin}/download`,
          uploadUrl: `${origin}/upload`,
          state: "s",
        }),
      );
    const data = z
      .object({
        methodCalls: z.array(z.tuple([z.string(), z.unknown(), z.string()])),
      })
      .parse(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
    const method = data.methodCalls[0]?.[0];
    if (method === "Mailbox/get")
      return Promise.resolve(new Response("offline", { status: 503 }));
    return Promise.resolve(
      Response.json({
        methodResponses: [
          [
            method,
            {
              accountId: "a",
              queryState: "s",
              canCalculateChanges: false,
              position: 0,
              ids: [],
            },
            "0",
          ],
        ],
        sessionState: "s",
      }),
    );
  };
  const service = createContactsService({
    codec: contactVcardCodec,
    origin,
    store: {
      getForOwner: () =>
        Promise.resolve(
          ok({
            accountId: "a",
            address: "alice@example.test",
            secret: "secret",
          }),
        ),
    },
    client: () =>
      new JmapClient(origin, { authorization: "test", fetch: fake }),
  });
  const result = await service.suggest(
    { id: "alice", email: "alice@example.test", role: "user" },
    "default",
    { query: "a", limit: 10 },
  );
  expect(result.isErr() && result.error.kind).toBe("unavailable");
});
