import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import {
  ContactContentSchema,
  ContactAnniversaryDateSchema,
  contactHasNativeLayout,
} from "@opensuite/contracts";
import {
  contactVcardCodec,
  parseCards,
  serializeCards,
} from "../src/adapters/contacts.ts";

const card = (properties: string) =>
  `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Élodie\r\n${properties}\r\nEND:VCARD\r\n`;

describe("contact fidelity and backward compatibility", () => {
  it("round-trips escaped postal separators locally and blocks unsupported native persistence", () => {
    const contact = ContactContentSchema.parse({
      name: "X",
      emails: [],
      addresses: {
        home: {
          defaultSeparator: "\\;",
          components: [
            { kind: "number", value: "12" },
            { kind: "separator", value: ";" },
            { kind: "name", value: "Rue" },
          ],
        },
      },
    });
    const parsed = parseCards(serializeCards([contact]));
    expect(parsed[0]?.contact?.addresses?.["a0"]).toMatchObject({
      defaultSeparator: "\\;",
      components: contact.addresses?.["home"]?.components,
    });
    expect(contactHasNativeLayout(contact)).toBe(false);
    expect(contactVcardCodec.preview(parsed, [])[0]).toMatchObject({
      contact: null,
      warnings: [expect.stringContaining("import blocked")],
    });
  });

  it("emits only the canonical UID and removes grouped stale canonical properties", () => {
    const contact = ContactContentSchema.parse({
      name: "Fresh",
      emails: ["fresh@example.test"],
      uid: "new-uid",
      phones: { p: { number: "+33123456789" } },
      vCard: {
        properties: [
          ["uid", {}, "text", "old-uid"],
          ["item.uid", {}, "text", "other-uid"],
          ["item.fn", {}, "text", "Stale"],
          ["item.email", {}, "text", "stale@example.test"],
          ["item.tel", {}, "text", "+33999999999"],
        ],
      },
    });
    const text = serializeCards([contact]);
    expect(text.match(/^(?:[a-z0-9-]+\.)?UID:/gim)).toHaveLength(1);
    expect(text).toContain("new-uid");
    expect(text).not.toContain("old-uid");
    expect(text).not.toContain("Stale");
    expect(text).not.toContain("stale@example.test");
    expect(text).not.toContain("+33999999999");
    expect(contactVcardCodec.create(contact, "book")).toMatchObject({
      uid: "new-uid",
      vCard: { properties: [] },
    });
  });

  it("replaces an imported Apple label without retaining the old group label", () => {
    const parsed = parseCards(
      serializeCards([
        {
          name: "X",
          emails: [],
          phones: { p: { number: "+33123456789", label: "Old" } },
        },
      ]),
    )[0]?.contact;
    if (!parsed?.phones?.["p0"]) throw new Error("Missing imported phone");
    parsed.phones["p0"].label = "New";
    const changed = serializeCards([parsed]);
    expect(changed).not.toContain("Old");
    expect(changed.match(/^[a-z0-9-]+\.X-ABLABEL:/gim)).toHaveLength(1);
    const again = parseCards(changed)[0]?.contact;
    if (!again) throw new Error("Missing contact after label change");
    expect(
      serializeCards([again]).match(/^[a-z0-9-]+\.X-ABLABEL:/gim),
    ).toHaveLength(1);
  });

  it("cleans stale grouped labels on native creation and patches without discarding unrelated metadata", () => {
    const vCard = {
      properties: [
        ["x-ablabel", { group: "item1" }, "text", "Old"],
        ["x-custom", {}, "text", "Keep"],
      ],
      convertedProperties: {
        "/phones/p/number": { parameters: { group: "item1" } },
      },
    };
    const desired = ContactContentSchema.parse({
      name: "X",
      emails: [],
      phones: { p: { number: "123", label: "New" } },
      vCard,
    });
    expect(contactVcardCodec.create(desired, "book")).toMatchObject({
      phones: { p: { label: "New" } },
      vCard: { properties: [["x-custom", {}, "text", "Keep"]] },
    });
    const stored = {
      id: "c",
      addressBookIds: { book: true },
      name: { full: "X" },
      emails: {},
      phones: { p: { number: "123", label: "Old" } },
      vCard,
    };
    const { vCard: omitted, ...withoutMetadata } = desired;
    expect(omitted).toBeDefined();
    expect(contactVcardCodec.patch(stored, withoutMetadata)).toMatchObject({
      "phones/p/label": "New",
      "vCard/properties": [["x-custom", {}, "text", "Keep"]],
    });
    expect(
      contactVcardCodec.patch(stored, {
        ...desired,
        vCard: { properties: desired.vCard?.properties },
      }),
    ).toMatchObject({
      "vCard/properties": [["x-custom", {}, "text", "Keep"]],
    });
    expect(
      contactVcardCodec.patch(stored, { name: "X", emails: [] }),
    ).not.toHaveProperty("vCard/properties");
    expect(
      contactVcardCodec.patch(stored, {
        name: "X",
        emails: [],
        vCard: {
          convertedProperties: {
            "/phones/p/number": { parameters: { "x-custom": "new" } },
          },
        },
      }),
    ).not.toHaveProperty("vCard/properties");
    expect(
      contactVcardCodec.patch(stored, {
        ...withoutMetadata,
        vCard: {
          convertedProperties: {
            "/phones/p/number": { parameters: { group: "item2" } },
          },
        },
      }),
    ).toMatchObject({ "vCard/properties": [["x-custom", {}, "text", "Keep"]] });
  });

  it.each([
    [
      { "@type": "PartialDate", year: 1990, month: 4, day: 3 },
      { "@type": "PartialDate", year: 1990, month: 4 },
    ],
    [
      { "@type": "Timestamp", utc: "1990-04-03T00:00:00Z" },
      { "@type": "PartialDate", month: 4, day: 3 },
    ],
    [
      { "@type": "PartialDate", month: 4, day: 3 },
      { "@type": "Timestamp", utc: "1990-04-03T00:00:00Z" },
    ],
  ])(
    "replaces an anniversary date atomically from %j to %j",
    (oldDate, newDate) => {
      const stored = {
        id: "c",
        addressBookIds: { book: true },
        name: { full: "X" },
        emails: {},
        anniversaries: {
          b: { kind: "birth", date: oldDate, "x-entry": "keep" },
        },
      };
      const desired = ContactContentSchema.parse({
        name: "X",
        emails: [],
        anniversaries: { b: { kind: "birth", date: newDate } },
      });
      const patch = contactVcardCodec.patch(stored, desired);
      expect(patch["anniversaries/b/date"]).toEqual(newDate);
      expect(
        Object.keys(patch).some(
          (key) =>
            key.startsWith("anniversaries/b/date/") || key.endsWith("x-entry"),
        ),
      ).toBe(false);
    },
  );

  it.each(["TEXT", "TeXt", "UNKNOWN", "UnKnOwN"])(
    "escapes frame markers in raw %s values",
    (type) => {
      const contact = ContactContentSchema.parse({
        name: "X",
        emails: [],
        vCard: {
          properties: [
            [
              "x-custom",
              {},
              type,
              "data\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Injected",
            ],
          ],
        },
      });
      const serialized = serializeCards([contact]);
      expect(serialized.match(/^BEGIN:VCARD$/gm)).toHaveLength(1);
      expect(serialized.match(/^END:VCARD$/gm)).toHaveLength(1);
      expect(parseCards(serialized)).toHaveLength(1);
    },
  );

  it.each([null, 12, true, ["one", "two"], [["nested"]]])(
    "rejects unsupported custom text shape %j",
    (value) => {
      expect(
        ContactContentSchema.safeParse({
          name: "X",
          emails: [],
          vCard: { properties: [["x-custom", {}, "TEXT", value]] },
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["ITEM1.N", [["Dupont", "Martin"], "Élodie", "", "", ""]],
    ["ITEM1.ORG", ["Esuno", "Architecture"]],
    ["ITEM1.GENDER", ["", "description"]],
    ["ITEM1.CLIENTPIDMAP", ["1", "urn:uuid:test"]],
    ["ITEM1.CATEGORIES", ["One", "Two"]],
    ["ITEM1.NICKNAME", ["Ally", "Alice"]],
  ])("round-trips grouped structured or multivalue text %s", (name, value) => {
    const contact = ContactContentSchema.parse({
      name: "X",
      emails: [],
      vCard: { properties: [[name, {}, "TEXT", value]] },
    });
    expect(contactVcardCodec.create(contact, "book")).toMatchObject({
      vCard: {
        properties: [
          [
            name.toLowerCase().split(".").at(-1),
            { group: "ITEM1" },
            "text",
            value,
          ],
        ],
      },
    });
    const parsed = parseCards(serializeCards([contact]))[0]?.contact;
    const bare = name.toLowerCase().split(".").at(-1);
    expect(
      parsed?.vCard?.properties?.find((property) => property[0] === bare)?.[3],
    ).toEqual(value);
  });

  it("retains Apple labels separately from postal LABEL display text", () => {
    const contact = ContactContentSchema.parse({
      name: "X",
      emails: [],
      addresses: {
        home: {
          full: "12 rue, Paris",
          label: "Personnel",
          components: [
            { kind: "number", value: "12" },
            { kind: "name", value: "rue" },
            { kind: "locality", value: "Paris" },
          ],
        },
      },
    });
    const parsed = parseCards(serializeCards([contact]))[0]?.contact;
    expect(parsed?.addresses?.["a0"]).toMatchObject({
      full: "12 rue, Paris",
      label: "Personnel",
    });
    const phone = parseCards(
      card("item1.TEL:123\r\nitem1.X-ABLABEL:Portable"),
    )[0]?.contact;
    expect(phone?.phones?.["p0"]?.label).toBe("Portable");
  });

  it("keeps parameter lists and comma-containing list members without global design mutation", () => {
    const design = JSON.stringify(ICAL.design.vcard.param);
    const contact = ContactContentSchema.parse({
      name: "X",
      emails: ["a@example.test"],
      emailDetails: { e: { address: "a@example.test" } },
      vCard: {
        convertedProperties: {
          "/emails/e/address": {
            parameters: { "X-LIST": ["one,two", "three"] },
          },
        },
      },
    });
    const parsed = parseCards(serializeCards([contact]))[0]?.contact;
    expect(
      parsed?.vCard?.convertedProperties?.["/emails/e0/address"]?.parameters?.[
        "x-list"
      ],
    ).toEqual(["one,two", "three"]);
    expect(JSON.stringify(ICAL.design.vcard.param)).toBe(design);
  });

  it("converts vCard 3 multivalue notes into separate vCard 4 text properties", () => {
    const contact = parseCards(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nNOTE:one,two\r\nEND:VCARD\r\n",
    )[0]?.contact;
    if (!contact) throw new Error("Missing legacy notes");
    const serialized = serializeCards([contact]);
    expect(serialized.match(/^NOTE:/gm)).toHaveLength(2);
    expect(serialized).toContain("NOTE:one");
    expect(serialized).toContain("NOTE:two");
  });

  it("separates conflicting labels that previously shared one vCard group", () => {
    const contact = ContactContentSchema.parse({
      name: "X",
      emails: ["a@example.test"],
      emailDetails: { e: { address: "a@example.test", label: "Old" } },
      phones: { p: { number: "123", label: "New" } },
      vCard: {
        convertedProperties: {
          "/emails/e/address": { parameters: { group: "item1" } },
          "/phones/p/number": { parameters: { group: "item1" } },
        },
      },
    });
    const serialized = serializeCards([contact]);
    const labels = serialized.match(/^[a-z0-9-]+\.X-ABLABEL:.*$/gim) ?? [];
    expect(labels).toHaveLength(2);
    expect(new Set(labels.map((line) => line.split(".")[0])).size).toBe(2);
    const parsed = parseCards(serialized)[0]?.contact;
    expect(parsed?.emailDetails?.["e0"]?.label).toBe("Old");
    expect(parsed?.phones?.["p0"]?.label).toBe("New");
  });

  it("preserves literal backslashes in vCard parameter values", () => {
    const source = card("EMAIL;X-PARAM=left\\right:a@example.test");
    const contact = parseCards(source)[0]?.contact;
    if (!contact) throw new Error("Missing parsed contact");
    expect(
      contact.vCard?.convertedProperties?.["/emails/e0/address"]?.parameters?.[
        "x-param"
      ],
    ).toBe("left\\right");
    expect(serializeCards([contact])).toContain("X-PARAM=left\\right");
  });

  it("preserves native conversion pointers without a leading slash and imported UIDs", () => {
    const contact = ContactContentSchema.parse({
      name: "X",
      emails: [],
      phones: { "a/b~c": { number: "123" } },
      vCard: {
        convertedProperties: {
          "phones/a~1b~0c/number": { parameters: { "x-native": "kept" } },
        },
      },
    });
    expect(serializeCards([contact])).toContain("X-NATIVE=kept");
    const imported = parseCards(
      card("UID:urn:uuid:00000000-0000-4000-8000-000000000004"),
    )[0]?.contact;
    expect(imported?.uid).toBe("urn:uuid:00000000-0000-4000-8000-000000000004");
    if (!imported) throw new Error("Missing UID contact");
    expect(contactVcardCodec.create(imported, "book")).toMatchObject({
      uid: imported.uid,
      vCard: { properties: [] },
    });
  });

  it.each(["", "item1\nEND:VCARD", "item1.BAD", "item 1", ["item1"]])(
    "rejects unsafe native group identifiers %j",
    (group) => {
      for (const vCard of [
        { properties: [["x-custom", { group }, "text", "value"]] },
        {
          convertedProperties: {
            "/phones/p/number": { parameters: { GROUP: group } },
          },
        },
      ])
        expect(
          ContactContentSchema.safeParse({ name: "X", emails: [], vCard })
            .success,
        ).toBe(false);
    },
  );

  it.each([
    {
      field: "phones",
      entry: { number: "+33123456789" },
      path: "/phones/a~1b~0c/number",
    },
    {
      field: "emailDetails",
      entry: { address: "friend@example.test" },
      path: "/emails/a~1b~0c/address",
    },
    {
      field: "addresses",
      entry: { components: [{ kind: "locality", value: "Paris" }] },
      path: "/addresses/a~1b~0c/components",
    },
    {
      field: "organizations",
      entry: { name: "Work" },
      path: "/organizations/a~1b~0c/name",
    },
    {
      field: "titles",
      entry: { name: "Engineer", kind: "title" },
      path: "/titles/a~1b~0c/name",
    },
    { field: "notes", entry: { note: "Note" }, path: "/notes/a~1b~0c/note" },
    {
      field: "links",
      entry: { uri: "https://example.test" },
      path: "/links/a~1b~0c/uri",
    },
    {
      field: "nicknames",
      entry: { name: "Nickname" },
      path: "/nicknames/a~1b~0c/name",
    },
    {
      field: "anniversaries",
      entry: {
        kind: "birth",
        date: { "@type": "PartialDate", year: 1990, month: 4 },
      },
      path: "/anniversaries/a~1b~0c/date",
    },
  ])(
    "preserves metadata at an escaped $field property pointer",
    ({ field, entry, path }) => {
      const contact = ContactContentSchema.parse({
        name: "X",
        emails: field === "emailDetails" ? ["friend@example.test"] : [],
        [field]: { "a/b~c": entry },
        vCard: {
          convertedProperties: {
            [path]: { parameters: { "x-kept": "preserved" } },
          },
        },
      });
      expect(serializeCards([contact]).toLowerCase()).toContain(
        "x-kept=preserved",
      );
    },
  );

  it("retains a year-month birthday without silently reducing it to a year", () => {
    const text = serializeCards([
      {
        name: "X",
        emails: [],
        anniversaries: {
          birth: {
            kind: "birth",
            date: { "@type": "PartialDate", year: 1990, month: 4 },
          },
        },
      },
    ]);
    expect(text).toContain("BDAY:1990-04");
    expect(parseCards(text)[0]?.contact?.vCard?.properties).toContainEqual([
      "bday",
      {},
      "date-and-or-time",
      "1990-04",
    ]);
    expect(parseCards(card("BDAY:19900431"))[0]?.contact).toBeNull();
  });

  it.each([
    [{ year: 1990, month: 2, day: 29 }, false],
    [{ year: 2000, month: 2, day: 29 }, true],
    [{ year: 4, month: 2, day: 29 }, true],
    [{ month: 2, day: 29 }, true],
    [{ month: 2, day: 30 }, false],
    [{ month: 4, day: 31 }, false],
    [{ day: 31 }, true],
  ])("validates partial-date calendar bounds for %j", (date, valid) => {
    expect(
      ContactAnniversaryDateSchema.safeParse({
        "@type": "PartialDate",
        ...date,
      }).success,
    ).toBe(valid);
  });
  it("retains all emails when supplied metadata IDs collide with generated IDs", () => {
    const created = contactVcardCodec.create(
      {
        name: "X",
        emails: ["a@example.test", "b@example.test"],
        emailDetails: { e1: { address: "a@example.test", label: "Bureau" } },
      },
      "book",
    );
    expect(created).toMatchObject({
      emails: {
        e1: { address: "a@example.test", label: "Bureau" },
        e1x: { address: "b@example.test" },
      },
    });
  });
  it("legacy edits leave rich CardDAV fields untouched, while explicit metadata changes use escaped patches", () => {
    const stored = {
      id: "c",
      addressBookIds: { b: true },
      name: { full: "X" },
      phones: { p: { number: "+33123456789" } },
      emails: {
        "a/b~c": {
          address: "a@example.test",
          label: "Ancien",
          contexts: { work: true },
          "x-private": "kept",
        },
      },
    };
    expect(
      contactVcardCodec.patch(stored, {
        name: "New",
        emails: ["a@example.test"],
      }),
    ).toEqual({ "name/full": "New" });
    const patch = contactVcardCodec.patch(stored, {
      name: "New",
      emails: ["a@example.test"],
      emailDetails: {
        e: {
          address: "a@example.test",
          label: "Personnel",
          contexts: { private: true },
        },
      },
    });
    expect(patch).toMatchObject({
      "emails/a~1b~0c/label": "Personnel",
      "emails/a~1b~0c/contexts": { private: true },
    });
    expect(
      Object.keys(patch).some(
        (key) => key.includes("x-private") || key.startsWith("phones"),
      ),
    ).toBe(false);
    expect(
      contactVcardCodec.patch(stored, {
        name: "X",
        emails: ["a@example.test"],
        phones: null,
      }),
    ).toMatchObject({ phones: null });
  });
  it("canonical phone edits override imported source values and preserve custom parameters", () => {
    const contact = parseCards(
      card("TEL;TYPE=home,cell;X-CUSTOM=kept:+33123456789"),
    )[0]?.contact;
    expect(contact?.phones?.["p0"]?.number).toBe("+33123456789");
    if (!contact?.phones?.["p0"]) throw new Error("Missing phone");
    contact.phones["p0"].number = "+33987654321";
    const text = serializeCards([contact]);
    expect(text).toContain("+33987654321");
    expect(text).not.toContain("+33123456789");
    expect(text.toLowerCase()).toContain("x-custom=kept");
  });
  it("retains structured street number, building, floor and apartment", () => {
    const text = serializeCards([
      {
        name: "X",
        emails: [],
        addresses: {
          home: {
            components: [
              { kind: "number", value: "12" },
              { kind: "name", value: "rue de l’Église" },
              { kind: "floor", value: "4" },
              { kind: "apartment", value: "B" },
              { kind: "building", value: "Tour" },
              { kind: "locality", value: "Paris" },
            ],
          },
        },
      },
    ]);
    const copied = parseCards(text)[0]?.contact;
    expect(copied?.addresses?.["a0"]?.components).toEqual(
      expect.arrayContaining([
        { kind: "number", value: "12" },
        { kind: "name", value: "rue de l’Église" },
        { kind: "floor", value: "4" },
        { kind: "building", value: "Tour" },
        { kind: "apartment", value: "B" },
      ]),
    );
  });
  it("keeps FN language, grouped email parameters, dates and unknown properties", () => {
    const source = card(
      "item1.EMAIL;TYPE=work;X-EXTRA=value:a@example.test\r\nBDAY:19900403\r\nX-CUSTOM:one\\ntwo",
    ).replace("FN:Élodie", "FN;LANGUAGE=fr:Élodie");
    const contact = parseCards(source)[0]?.contact;
    if (!contact) throw new Error("Invalid contact");
    const text = serializeCards([contact]);
    expect(text.toLowerCase()).toContain("fn;language=fr:élodie");
    expect(text.toLowerCase()).toContain("item1.email");
    expect(text.toLowerCase()).toContain("x-extra=value");
    expect(text).toContain("BDAY:19900403");
    expect(parseCards(text)[0]?.contact?.emails).toEqual(["a@example.test"]);
    expect(text).toContain("one\\ntwo");
  });
  it("refuses unsupported transfer encodings instead of corrupting names", () => {
    const parsed = parseCards(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Andr=C3=A9\r\nEND:VCARD",
    )[0];
    expect(parsed?.contact).toBeNull();
    expect(parsed?.warnings.join(" ")).toContain("Encoded");
  });
  it("rejects property and parameter injection; unknown text values are escaped", () => {
    for (const raw of [
      ["x-one\r\nEND:VCARD\r\nBEGIN:VCARD", {}, "text", "x"],
      ["x-one", { "x-p\r\nFN": "x" }, "text", "x"],
      ["x-one", {}, "uri", "https://example.test/\r\nFN:Injected"],
    ])
      expect(
        ContactContentSchema.safeParse({
          name: "X",
          emails: [],
          vCard: { properties: [raw] },
        }).success,
      ).toBe(false);
    const text = serializeCards([
      {
        name: "X",
        emails: [],
        vCard: {
          properties: [
            ["x-one", {}, "unknown", "value\r\nEND:VCARD\r\nBEGIN:VCARD"],
          ],
        },
      },
    ]);
    expect(text.match(/^BEGIN:VCARD$/gm)).toHaveLength(1);
  });
  it("does not conflate namesakes with different phone numbers", () => {
    const parsed = parseCards(
      card("TEL:+33123456789") + card("TEL:+33987654321"),
    );
    expect(
      contactVcardCodec.preview(parsed, []).map((item) => item.duplicate),
    ).toEqual([false, false]);
    const first = parsed[0];
    if (!first) throw new Error("Missing parsed contact");
    expect(
      contactVcardCodec
        .preview([...parsed, first], [])
        .map((item) => item.duplicate),
    ).toEqual([false, false, true]);
  });

  it("does not drop different people sharing a household or office phone number", () => {
    const parsed = ["Alice", "Bob", " ALICE "].map((name) => ({
      contact: ContactContentSchema.parse({
        name,
        emails: [],
        phones: { p: { number: "+33123456789" } },
      }),
      warnings: [],
    }));
    expect(
      contactVcardCodec.preview(parsed, []).map((entry) => entry.duplicate),
    ).toEqual([false, false, true]);
    const stored = [
      {
        id: "alice",
        addressBookIds: { b: true },
        name: { full: "Alice" },
        phones: { p: { number: "+33 1 23 45 67 89" } },
      },
    ];
    expect(
      contactVcardCodec.preview(parsed, stored).map((entry) => entry.duplicate),
    ).toEqual([true, false, true]);
  });
  it("keeps distinct metadata on repeated email values within one contact", () => {
    const parsed = parseCards(
      card("EMAIL;TYPE=work:a@example.test\r\nEMAIL;TYPE=home:a@example.test"),
    );
    expect(contactVcardCodec.preview(parsed, [])[0]?.duplicate).toBe(false);
    const contact = parsed[0]?.contact;
    if (!contact) throw new Error("Invalid contact");
    const text = serializeCards([contact]).toLowerCase();
    expect(text).toContain("type=work");
    expect(text).toContain("type=home");
    expect(parseCards(text)[0]?.contact?.emails).toHaveLength(2);
  });
  it("keeps postal component order, literal separators, full address and country code", () => {
    const components = [
      { kind: "number", value: "12" },
      { kind: "name", value: "rue Exemple" },
      { kind: "separator", value: "/" },
      { kind: "floor", value: "4" },
    ];
    const text = serializeCards([
      {
        name: "X",
        emails: [],
        addresses: {
          a: {
            components,
            defaultSeparator: " ",
            isOrdered: true,
            full: "12 rue Exemple / étage 4",
            countryCode: "FR",
          },
        },
      },
    ]);
    const copied = parseCards(text)[0]?.contact?.addresses?.["a0"];
    expect(copied).toMatchObject({
      components,
      full: "12 rue Exemple / étage 4",
      countryCode: "FR",
      defaultSeparator: " ",
    });
    expect(text.replace(/\r\n[ \t]/g, "")).toContain("12,rue Exemple");
  });
  it("keeps a birthday with only a day without inventing a month", () => {
    const text = serializeCards([
      {
        name: "X",
        emails: [],
        anniversaries: {
          b: { kind: "birth", date: { "@type": "PartialDate", day: 3 } },
        },
      },
    ]);
    expect(text).toContain("BDAY:---03");
    expect(parseCards(text)[0]?.contact).not.toBeNull();
  });
});
