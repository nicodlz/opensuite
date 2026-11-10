import {
  contactEmailKey,
  contactHasNativeLayout,
  type ContactContent,
  type ContactCodec,
  type ContactRecord,
} from "@opensuite/contracts";

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
