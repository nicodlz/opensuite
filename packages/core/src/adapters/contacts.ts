import ICAL from "ical.js";
import { z } from "zod";
import {
  ContactContentSchema,
  type ContactContent,
  type ContactRecord,
} from "@opensuite/contracts";

export type ParsedCard = { contact: ContactContent | null; warnings: string[] };

const parseCard = (source: string): ParsedCard => {
  try {
    const component = ICAL.Component.fromString(source);
    const versions = component.getAllProperties("version");
    const names = component.getAllProperties("fn");
    const parsed = ContactContentSchema.safeParse({
      name: names[0]?.getFirstValue(),
      emails: component.getAllProperties("email").map((p) => p.getFirstValue()),
    });
    if (
      component.name !== "vcard" ||
      versions.length !== 1 ||
      names.length !== 1 ||
      !["3.0", "4.0"].includes(String(versions[0]?.getFirstValue())) ||
      !parsed.success
    )
      return { contact: null, warnings: ["Invalid or unsupported vCard"] };
    const warnings = new Set<string>();
    for (const property of component.getAllProperties()) {
      if (!["version", "fn", "email"].includes(property.name))
        warnings.add(`Property ${property.name.toUpperCase()} is not retained`);
      if (
        Object.keys(
          z.record(z.string(), z.unknown()).catch({}).parse(property.jCal[1]),
        ).length > 0
      )
        warnings.add(
          `Parameters on ${property.name.toUpperCase()} are not retained`,
        );
    }
    return { contact: parsed.data, warnings: [...warnings] };
  } catch {
    return { contact: null, warnings: ["Invalid vCard"] };
  }
};

// Only framing is handled here; property parsing, escaping and folding are delegated to ical.js.
export function parseCards(input: string): ParsedCard[] {
  if (Buffer.byteLength(input, "utf8") > 250_000) throw new Error("too large");
  const cards: ParsedCard[] = [];
  const pattern = /^BEGIN:VCARD\s*\r?\n[\s\S]*?^END:VCARD\s*$/gim;
  let end = 0;
  for (const match of input.matchAll(pattern)) {
    if (cards.length >= 100) throw new Error("too many cards");
    if (input.slice(end, match.index).trim())
      cards.push({ contact: null, warnings: ["Invalid vCard data"] });
    end = match.index + match[0].length;
    cards.push(parseCard(match[0]));
  }
  if (input.slice(end).trim() || cards.length === 0)
    cards.push({ contact: null, warnings: ["Invalid vCard data"] });
  if (cards.length > 100) throw new Error("too many cards");
  return cards;
}
export function serializeCards(contacts: readonly ContactContent[]): string {
  return (
    contacts
      .map((contact) => {
        const card = new ICAL.Component("vcard");
        card.addPropertyWithValue("version", "4.0");
        card.addPropertyWithValue("fn", contact.name);
        for (const email of contact.emails)
          card.addPropertyWithValue("email", email);
        return card.toString();
      })
      .join("\r\n") + "\r\n"
  );
}

const cardFor = (contact: ContactContent, bookId: string) => ({
  "@type": "Card",
  name: { full: contact.name },
  emails: Object.fromEntries(
    contact.emails.map((address, i) => [`e${String(i)}`, { address }]),
  ),
  addressBookIds: { [bookId]: true },
});

const pathKey = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

const updatePatch = (card: ContactRecord, contact: ContactContent) => {
  const keys = Object.keys(card.emails ?? {});
  const patch: Record<string, unknown> = { "name/full": contact.name };
  if (keys.length === 0 && contact.emails.length > 0)
    patch["emails"] = Object.fromEntries(
      contact.emails.map((address, i) => [
        `opensuite${String(i)}`,
        { address },
      ]),
    );
  for (
    let i = 0;
    keys.length > 0 && i < Math.max(keys.length, contact.emails.length);
    i++
  ) {
    let key = keys[i] ?? `opensuite${String(i)}`;
    while (keys[i] === undefined && keys.includes(key)) key += "x";
    const address = contact.emails[i];
    if (address === undefined) patch[`emails/${pathKey(key)}`] = null;
    else if (keys[i] === undefined)
      patch[`emails/${pathKey(key)}`] = { address };
    else patch[`emails/${pathKey(key)}/address`] = address;
  }
  return patch;
};

const lossWarnings = (card: ContactRecord) => {
  const extras = Object.keys(card).filter(
    (key) =>
      !["@type", "version", "id", "name", "emails", "addressBookIds"].includes(
        key,
      ),
  );
  if (
    Object.keys(card.name ?? {}).some((key) => key !== "full") ||
    Object.values(card.emails ?? {}).some((email) =>
      Object.keys(email).some((key) => key !== "address"),
    )
  )
    extras.push("contact metadata");
  return extras.length ? [`${card.id}: ${extras.join(", ")} not retained`] : [];
};

const content = (card: ContactRecord): ContactContent | null => {
  const parsed = ContactContentSchema.safeParse({
    name: card.name?.full,
    emails: Object.values(card.emails ?? {}).map((email) => email.address),
  });
  return parsed.success ? parsed.data : null;
};
const project = (card: ContactRecord) => {
  const item = content(card);
  return item === null
    ? null
    : {
        ...item,
        id: card.id,
        addressBookIds: Object.entries(card.addressBookIds)
          .filter(([, present]) => present)
          .map(([id]) => id),
      };
};

const emailKey = (email: string) => email.trim().toLowerCase();
const preview = (parsed: ParsedCard[], stored: ContactRecord[]) => {
  const existing = new Set(
    stored.flatMap((card) =>
      Object.values(card.emails ?? {}).map((e) => emailKey(e.address)),
    ),
  );
  const namesWithoutEmail = new Set(
    stored
      .filter((card) => !Object.keys(card.emails ?? {}).length)
      .map((card) => emailKey(card.name?.full ?? "")),
  );
  return parsed.map((entry, index) => {
    const keys = entry.contact?.emails.map(emailKey) ?? [];
    const duplicate =
      keys.some((key) => existing.has(key)) ||
      new Set(keys).size !== keys.length ||
      (entry.contact !== null &&
        keys.length === 0 &&
        namesWithoutEmail.has(emailKey(entry.contact.name)));
    for (const key of keys) existing.add(key);
    if (entry.contact !== null && keys.length === 0)
      namesWithoutEmail.add(emailKey(entry.contact.name));
    return {
      contact: entry.contact,
      warnings: entry.warnings,
      index,
      duplicate,
    };
  });
};

export const contactVcardCodec = {
  content,
  project,
  parse: parseCards,
  serialize: serializeCards,
  create: cardFor,
  patch: updatePatch,
  warnings: lossWarnings,
  preview,
};
