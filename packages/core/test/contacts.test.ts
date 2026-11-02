import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  contactVcardCodec,
  parseCards,
  serializeCards,
} from "../src/adapters/contacts.ts";

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
