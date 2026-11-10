import {
  contactEmailKey,
  contactHasNativeLayout,
  type ContactContent,
  type Contact,
  type ContactCodec,
  type ContactRecord,
} from "@opensuite/contracts";
import { isDeepStrictEqual } from "node:util";

export type ParsedCard = { contact: ContactContent | null; warnings: string[] };
class ContactImportLimitError extends Error {}
const invalidCard = (): ParsedCard => ({
  contact: null,
  warnings: ["Invalid vCard data"],
});

import { writeContactCard, importedNativeFields } from "./contact-vcard.ts";
import { contactFields, object, parseContactCard } from "./contact-fields.ts";
import { contactEmails, updateContactPatch } from "./contact-patch.ts";
import { prepareContactImport } from "./contact-import-fields.ts";
const parseCard = parseContactCard;

// Only framing is handled here; property parsing, escaping and folding are delegated to ical.js.
export function parseCards(input: string): ParsedCard[] {
  if (Buffer.byteLength(input, "utf8") > 250_000)
    throw new ContactImportLimitError("too large");
  const cards: ParsedCard[] = [];
  const push = (card: ParsedCard) => {
    if (cards.length >= 100)
      throw new ContactImportLimitError("too many cards");
    cards.push(card);
  };
  let frame: string[] | null = null;
  let invalidOutside = false;
  for (const line of input.split(/\r?\n/)) {
    if (/^BEGIN:VCARD[ \t]*$/i.test(line)) {
      if (frame !== null) return [invalidCard()];
      if (invalidOutside) push(invalidCard());
      invalidOutside = false;
      frame = [line];
    } else if (frame !== null && /^END:VCARD[ \t]*$/i.test(line)) {
      frame.push(line);
      push(parseCard(frame.join("\r\n")));
      frame = null;
    } else if (frame !== null) frame.push(line);
    else if (line.trim()) invalidOutside = true;
  }
  if (frame !== null || invalidOutside || cards.length === 0)
    push(invalidCard());
  return cards;
}
export function serializeCards(contacts: readonly ContactContent[]): string {
  return contacts.map(writeContactCard).join("\r\n") + "\r\n";
}

const cardFor = (contact: ContactContent, bookId: string) => ({
  "@type": "Card",
  ...importedNativeFields(contact),
  name: { ...contact.nameDetails, full: contact.name },
  emails: contactEmails(contact),
  addressBookIds: { [bookId]: true },
});

const lossWarnings = (card: ContactRecord) => {
  const extras = Object.keys(card).filter(
    (key) =>
      ![
        "@type",
        "version",
        "id",
        "uid",
        "name",
        "emails",
        "addressBookIds",
        "phones",
        "addresses",
        "organizations",
        "titles",
        "notes",
        "links",
        "nicknames",
        "anniversaries",
        "vCard",
      ].includes(key),
  );
  return extras.length ? [`${card.id}: ${extras.join(", ")} not retained`] : [];
};

const content = (card: ContactRecord): ContactContent => ({
  ...contactFields(card),
  name: card.name?.full ?? "",
  emails: Object.values(card.emails ?? {}).map((email) => email.address),
});
const project = (card: ContactRecord) => ({
  ...content(card),
  id: card.id,
  addressBookIds: Object.entries(card.addressBookIds)
    .filter(([, present]) => present)
    .map(([id]) => id),
});

const projectedMaps = [
  "phones",
  "addresses",
  "organizations",
  "titles",
  "notes",
  "links",
  "nicknames",
  "anniversaries",
  "emailDetails",
] as const;
const defaultConversionNames: Record<string, string[]> = {
  phones: ["tel"],
  addresses: ["adr"],
  organizations: ["org"],
  titles: ["title", "role"],
  notes: ["note"],
  links: ["url"],
  nicknames: ["nickname"],
  anniversaries: ["bday", "anniversary", "deathdate"],
  emails: ["email"],
};
const projectionObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const projectedPhoneTypes: Record<string, string> = {
  cell: "mobile",
  fax: "fax",
  "main-number": "main-number",
  pager: "pager",
  text: "text",
  textphone: "textphone",
  video: "video",
  voice: "voice",
};
function representedType(
  field: string,
  entry: Record<string, unknown>,
  value: unknown,
) {
  const types = Array.isArray(value) ? value : [value];
  return types.every((type) => {
    if (typeof type !== "string") return false;
    const key = type.toLowerCase();
    const feature = field === "phones" ? projectedPhoneTypes[key] : undefined;
    return feature
      ? object(entry["features"])[feature] === true
      : object(entry["contexts"])[
          key === "home" ? "private" : key === "cell" ? "mobile" : key
        ] === true;
  });
}
function projectConversion(contact: Contact, pointer: string, value: unknown) {
  const metadata = object(value);
  const [field = "", encodedId = ""] = pointer.replace(/^\//, "").split("/");
  if (!Object.hasOwn(defaultConversionNames, field)) return undefined;
  const id = encodedId.replaceAll("~1", "/").replaceAll("~0", "~");
  const entry = object(
    object(object(contact)[field === "emails" ? "emailDetails" : field])[id],
  );
  const parameters = { ...object(metadata["parameters"]) };
  if (Object.hasOwn(parameters, "type")) {
    if (!representedType(field, entry, parameters["type"])) return undefined;
    delete parameters["type"];
  }
  if (
    Object.keys(parameters).some(
      (key) =>
        !key.startsWith("x-") &&
        key !== "group" &&
        !(key === "language" && field === "notes"),
    )
  )
    return undefined;
  if (
    Object.keys(parameters).some((key) => typeof parameters[key] !== "string")
  )
    return undefined;
  const name = metadata["name"];
  if (
    name !== undefined &&
    (typeof name !== "string" ||
      !defaultConversionNames[field]?.includes(name.toLowerCase()))
  )
    return undefined;
  return Object.keys(parameters).length ? { parameters } : null;
}
/** Model only established native normalizations; unknown conversions must not enable client opt-in. */
function trimEmptyProjectionMaps(result: Contact) {
  for (const field of projectedMaps)
    for (const entry of Object.values(object(result[field]))) {
      if (!projectionObject(entry)) continue;
      for (const key of ["contexts", "features"])
        if (
          projectionObject(entry[key]) &&
          Object.keys(entry[key]).length === 0
        )
          delete entry[key];
      if (
        field === "organizations" &&
        Array.isArray(entry["units"]) &&
        !entry["units"].length
      )
        delete entry["units"];
    }
}
function projectConversionMetadata(result: Contact, original: Contact) {
  if (result.vCard) {
    const metadata = new Map<string, unknown>();
    const previous = object(original.vCard?.["convertedProperties"]);
    for (const [pointer, value] of Object.entries(
      object(result.vCard["convertedProperties"]),
    )) {
      const projected = isDeepStrictEqual(previous[pointer], value)
        ? value
        : projectConversion(result, pointer, value);
      if (projected === undefined) return false;
      if (projected !== null)
        metadata.set(pointer.replace(/^\//, ""), projected);
    }
    if (metadata.size)
      result.vCard["convertedProperties"] = Object.fromEntries(metadata);
    else delete result.vCard["convertedProperties"];
    if (
      Array.isArray(result.vCard["properties"]) &&
      !result.vCard["properties"].length
    )
      delete result.vCard["properties"];
    if (!Object.keys(result.vCard).length) delete result.vCard;
  }
  return true;
}
function canonicalContactProjection(
  contact: Contact,
  original: Contact,
): Contact | undefined {
  const result = structuredClone(contact);
  trimEmptyProjectionMaps(result);
  if (!projectConversionMetadata(result, original)) return undefined;
  return result;
}
function projectImport(card: ContactRecord, original: ContactRecord) {
  if (!isDeepStrictEqual(card["addresses"], original["addresses"]))
    return undefined;
  const titles = Object.values(object(card["titles"])).map(object);
  if (
    Object.keys(object(card["organizations"])).length &&
    titles.some((title) => title["kind"] === "role" && !title["organizationId"])
  )
    return undefined;
  return canonicalContactProjection(project(card), project(original));
}

const phoneKey = (name: string, number: string) => {
  const normalized = name.trim().replace(/\s+/g, " ").toLowerCase();
  const digits = number.replace(/\D/g, "");
  return normalized && digits.length >= 7
    ? JSON.stringify([normalized, digits])
    : "";
};

const preview = (parsed: ParsedCard[], stored: ContactRecord[]) => {
  const existing = new Set(
    stored.flatMap((card) =>
      Object.values(card.emails ?? {}).map((e) => contactEmailKey(e.address)),
    ),
  );
  const existingPhones = new Set(
    stored
      .flatMap((card) =>
        Object.values(object(card["phones"]))
          .map(object)
          .map((phone) =>
            phoneKey(
              card.name?.full ?? "",
              typeof phone["number"] === "string" ? phone["number"] : "",
            ),
          ),
      )
      .filter(Boolean),
  );
  return parsed.map((entry, index) => {
    if (entry.contact && !contactHasNativeLayout(entry.contact))
      return {
        index,
        contact: null,
        duplicate: false,
        warnings: [
          ...entry.warnings,
          "This server cannot preserve a literal semicolon in postal separators; import blocked",
        ],
      };
    const keys = entry.contact?.emails.map(contactEmailKey) ?? [];
    const duplicate =
      keys.some((key) => existing.has(key)) ||
      Object.values(entry.contact?.phones ?? {}).some((phone) => {
        const key = phoneKey(entry.contact?.name ?? "", phone.number);
        return existingPhones.has(key);
      });
    for (const key of keys) existing.add(key);
    for (const phone of Object.values(entry.contact?.phones ?? {})) {
      const key = phoneKey(entry.contact?.name ?? "", phone.number);
      if (key) existingPhones.add(key);
    }
    return {
      contact: entry.contact,
      warnings: entry.warnings,
      index,
      duplicate,
    };
  });
};

export const contactVcardCodec = {
  capabilities: { phones: true, addresses: true, importEnrichment: true },
  prepareImport: prepareContactImport,
  content,
  project,
  projectImport,
  parse: (input: string) => {
    try {
      return { ok: true, cards: parseCards(input) };
    } catch (error) {
      if (error instanceof ContactImportLimitError)
        return { ok: false, reason: "limit" };
      throw error;
    }
  },
  serialize: serializeCards,
  create: cardFor,
  patch: updateContactPatch,
  warnings: lossWarnings,
  preview,
} satisfies ContactCodec;
