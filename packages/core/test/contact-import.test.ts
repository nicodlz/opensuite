import { describe, expect, it } from "vitest";
import {
  ContactContentSchema,
  type ContactContent,
  type ContactRecord,
} from "@opensuite/contracts";
import { contactVcardCodec as codec } from "../src/adapters/contacts.ts";
import { planContactImport } from "../src/services/contact-import.ts";

const content = (overrides: Partial<ContactContent> = {}) =>
  ContactContentSchema.parse({
    name: "Marie Import",
    emails: ["marie@example.test"],
    ...overrides,
  });
function stored(
  overrides: Partial<ContactContent> = {},
  id = "legacy",
  books: Record<string, boolean> = { personal: true },
): ContactRecord {
  return {
    id,
    ...codec.create(
      content({ name: "Marie corrigée", uid: `native-${id}`, ...overrides }),
      "personal",
    ),
    addressBookIds: books,
  };
}
const entry = (contact: ContactContent) => ({ contact, warnings: [] });
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const plan = (
  cards: ContactContent[],
  records: ContactRecord[] = [],
  targets?: Record<string, string>,
) => planContactImport(codec, cards.map(entry), records, "personal", targets);
function apply(
  record: ContactRecord,
  patch: Record<string, unknown>,
): ContactRecord {
  const result = structuredClone(record);
  for (const [pointer, value] of Object.entries(patch)) {
    const parts = pointer
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let target: Record<string, unknown> = result;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      if (!isObject(next))
        throw new Error(`Missing test patch object: ${pointer}`);
      target = next;
    }
    const key = parts.at(-1);
    if (!key) throw new Error("Empty test pointer");
    if (value === null) delete target[key];
    else
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return result;
}
const update = (result: ReturnType<typeof plan>, id = "legacy") => {
  const patch = result.update[id];
  if (!patch) throw new Error("Expected enrichment patch");
  return patch;
};

describe("non-destructive contact import enrichment", () => {
  it("adds a telephone to a historical name/email contact and preserves its identity and edited name", () => {
    const record = stored();
    const incoming = content({
      uid: "old-google-uid",
      phones: { phone: { number: "+33612345678", label: "Mobile" } },
    });
    const result = plan([incoming], [record]);
    expect(result.create).toEqual({});
    expect(result.updatedEntries.get("legacy")).toEqual([0]);
    expect(result.preview[0]).toMatchObject({
      action: "enrich",
      duplicate: true,
      existingId: "legacy",
    });
    const next = codec.content(apply(record, update(result)));
    expect(next.name).toBe("Marie corrigée");
    expect(next.uid).toBe("native-legacy");
    expect(Object.values(next.phones ?? {})).toEqual([
      { number: "+33612345678", label: "Mobile" },
    ]);
    expect(codec.serialize([next])).toContain("+33612345678");
    expect(record).toEqual(stored());
  });

  it("replays the same rich source without any second write or duplicate", () => {
    const record = stored();
    const incoming = content({
      phones: {
        source: { number: "+33 6 12 34 56 78", contexts: { private: true } },
      },
    });
    const first = plan([incoming], [record]);
    const enriched = apply(record, update(first));
    const replay = plan([incoming], [enriched]);
    expect(replay.create).toEqual({});
    expect(replay.update).toEqual({});
    expect(replay.skipped).toBe(1);
    expect(replay.preview[0]?.action).toBe("unchanged");
  });

  it("preserves phone IDs, user labels, extensions and explicit metadata while filling missing metadata", () => {
    const record = stored({
      phones: {
        chosen: {
          number: "+33123456789;ext=12",
          label: "Mon libellé",
          contexts: { work: false },
        },
      },
    });
    const incoming = content({
      phones: {
        p0: {
          number: "+33 (1) 23-45-67-89;ext=12",
          label: "Source",
          contexts: { work: true, private: true },
        },
        p1: { number: "+33123456789;ext=13", label: "Autre poste" },
      },
    });
    const result = plan([incoming], [record]);
    const next = codec.content(apply(record, update(result)));
    expect(next.phones?.["chosen"]).toMatchObject({
      number: "+33123456789;ext=12",
      label: "Mon libellé",
      contexts: { work: false, private: true },
    });
    expect(Object.values(next.phones ?? {})).toHaveLength(2);
    expect(
      Object.values(next.phones ?? {}).some((phone) =>
        phone.number.endsWith("ext=13"),
      ),
    ).toBe(true);
  });

  it("unions two source cards into one creation and records both contributing indices", () => {
    const result = plan([
      content({ phones: { a: { number: "+33111111111" } } }),
      content({ phones: { b: { number: "+33222222222" } } }),
    ]);
    expect(Object.keys(result.create)).toEqual(["item0"]);
    expect(result.createdEntries.get("item0")).toEqual([0, 1]);
    expect(
      codec.content({
        id: "new",
        addressBookIds: { personal: true },
        ...result.create["item0"],
      }).phones,
    ).toEqual({
      a: { number: "+33111111111" },
      import1: { number: "+33222222222" },
    });
  });

  it("unions repeated historical sources into one update and skips non-contributing cards", () => {
    const phone = content({ phones: { p: { number: "+33111111111" } } });
    const result = plan(
      [phone, phone, content({ phones: { p: { number: "+33222222222" } } })],
      [stored()],
    );
    expect(result.updatedEntries.get("legacy")).toEqual([0, 2]);
    expect(result.skipped).toBe(1);
    expect(Object.keys(result.update)).toEqual(["legacy"]);
  });

  it("refuses UID/email collisions and email matches to several contacts", () => {
    const a = stored({ uid: "source-id", emails: ["a@example.test"] }, "a");
    const b = stored({ emails: ["b@example.test"] }, "b");
    const incoming = content({
      uid: "source-id",
      emails: ["b@example.test"],
      phones: { p: { number: "+33111111111" } },
    });
    const collision = plan([incoming], [a, b]);
    expect(collision.failed).toEqual([{ index: 0, reason: "ambiguous_match" }]);
    expect(collision.update).toEqual({});
    const duplicate = plan([content()], [stored({}, "a"), stored({}, "b")]);
    expect(duplicate.preview[0]?.candidateIds).toEqual(["a", "b"]);
  });

  it("requires explicit identity confirmation for old name-only contacts", () => {
    const record = stored({ name: "Sans Email", emails: [] });
    const incoming = content({
      name: " Sans   Email ",
      emails: [],
      phones: { p: { number: "0612345678" } },
    });
    const automatic = plan([incoming], [record]);
    expect(automatic.failed).toEqual([
      { index: 0, reason: "identity_confirmation_required" },
    ]);
    expect(automatic.preview[0]).toMatchObject({
      action: "blocked",
      candidateIds: ["legacy"],
    });
    expect(automatic.create).toEqual({});
    const chosen = plan([incoming], [record], { "0": "legacy" });
    expect(chosen.updatedEntries.get("legacy")).toEqual([0]);
  });

  it("does not deduplicate two different people only because they share a phone number", () => {
    const record = stored({
      name: "Alice",
      emails: [],
      phones: { p: { number: "+33111111111" } },
    });
    const result = plan(
      [
        content({
          name: "Bob",
          emails: [],
          phones: { p: { number: "+33111111111" } },
        }),
      ],
      [record],
    );
    expect(Object.keys(result.create)).toEqual(["item0"]);
    expect(result.update).toEqual({});
  });

  it("refuses outside-book, multi-book and missing explicitly selected targets", () => {
    const incoming = content({ phones: { p: { number: "+33111111111" } } });
    const outside = plan([incoming], [stored({}, "legacy", { other: true })]);
    expect(outside.failed[0]?.reason).toBe("different_address_book");
    const shared = plan(
      [incoming],
      [stored({}, "legacy", { personal: true, shared: true })],
      { "0": "legacy" },
    );
    expect(shared.failed[0]?.reason).toBe("multiple_address_books");
    const missing = plan([incoming], [], { "0": "removed" });
    expect(missing.failed[0]?.reason).toBe("target_not_found");
  });

  it("retains the portable codec's native postal-layout refusal", () => {
    const incoming = content({
      addresses: { a: { components: [{ kind: "separator", value: ";" }] } },
    });
    const result = plan([incoming]);
    expect(result.create).toEqual({});
    expect(result.skipped).toBe(1);
    expect(result.preview[0]?.contact).toBeNull();
  });

  it("preserves conversion parameters for a newly allocated phone ID", () => {
    const parsed = codec.parse(
      "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Marie\r\nEMAIL:marie@example.test\r\nTEL;X-CUSTOM=kept:+33111111111\r\nEND:VCARD\r\n",
    );
    if (!parsed.ok) throw new Error("Expected valid source");
    const result = planContactImport(
      codec,
      parsed.cards,
      [stored()],
      "personal",
    );
    const serialized = codec.serialize([
      codec.content(apply(stored(), update(result))),
    ]);
    expect(serialized).toContain("X-CUSTOM=kept");
  });

  it("refuses targets outside the source batch before creating a duplicate", () => {
    const source = content({ name: "Ancien nom", emails: [] });
    expect(() =>
      plan([source], [stored({ name: "Nom corrigé", emails: [] })], {
        "1": "legacy",
      }),
    ).toThrow("outside the source batch");
  });

  it("never identifies different people by empty or punctuation-only phone values", () => {
    for (const number of ["", ".-() "]) {
      const source = content({
        name: "Même nom",
        emails: ["second@example.test"],
        phones: { source: { number } },
      });
      const existing = stored({
        name: "Même nom",
        emails: ["first@example.test"],
        phones: { user: { number } },
      });
      const result = plan([source], [existing]);
      expect(result.update).toEqual({});
      expect(Object.keys(result.create)).toHaveLength(1);
    }
  });

  it("requires confirmation when phone and name agree but known emails conflict", () => {
    const existing = stored({
      name: "Même nom",
      emails: ["first@example.test"],
      phones: { user: { number: "+33123456789" } },
    });
    const result = plan(
      [
        content({
          name: "Même nom",
          emails: ["second@example.test"],
          phones: { source: { number: "+33123456789" } },
        }),
      ],
      [existing],
    );
    expect(result.create).toEqual({});
    expect(result.update).toEqual({});
    expect(result.failed).toEqual([
      { index: 0, reason: "identity_confirmation_required" },
    ]);
  });

  it("retains incoming NOTE/ORG/TITLE alongside TEL and existing user notes", () => {
    const source = codec.parse(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Nom source\r\nEMAIL:marie@example.test\r\nTEL;TYPE=CELL:+33612345678\r\nNOTE:Note importée\r\nORG:Organisation;Équipe\r\nTITLE:Architecte\r\nEND:VCARD\r\n",
    );
    if (!source.ok) throw new Error("Expected valid source");
    const previous = stored({ notes: { user: { note: "Note utilisateur" } } });
    const result = planContactImport(
      codec,
      source.cards,
      [previous],
      "personal",
    );
    expect(result.failed).toEqual([]);
    const after = apply(previous, update(result));
    const exported = codec.serialize([codec.content(after)]);
    expect(exported).toContain("Note utilisateur");
    expect(exported).toContain("Note importée");
    expect(exported).toContain("Organisation");
    expect(exported).toContain("Architecte");
    expect(exported).toContain("+33612345678");
  });
});
