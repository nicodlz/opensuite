import ICAL from "ical.js";
import { z } from "zod";
import {
  ContactContentSchema,
  contactEmailKey,
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

const groupedEmailKeys = (
  emails: NonNullable<ContactRecord["emails"]>,
  used: Set<string>,
  normalize: (address: string) => string,
) => {
  const groups = new Map<string, string[]>();
  for (const [key, email] of Object.entries(emails)) {
    if (used.has(key)) continue;
    const address = normalize(email.address);
    const group = groups.get(address) ?? [];
    group.push(key);
    groups.set(address, group);
  }
  return groups;
};
const matchedEmailKeys = (
  emails: NonNullable<ContactRecord["emails"]>,
  addresses: string[],
) => {
  const used = new Set<string>();
  const matched = new Map<number, string>();
  const exact = groupedEmailKeys(emails, used, (address) => address);
  for (const [index, address] of addresses.entries()) {
    const key = exact.get(address)?.shift();
    if (key !== undefined) {
      matched.set(index, key);
      used.add(key);
    }
  }
  const remaining = groupedEmailKeys(emails, used, contactEmailKey);
  const wanted = new Map<string, number>();
  for (const [index, address] of addresses.entries()) {
    if (matched.has(index)) continue;
    const normalized = contactEmailKey(address);
    wanted.set(normalized, (wanted.get(normalized) ?? 0) + 1);
  }
  for (const [index, address] of addresses.entries()) {
    if (matched.has(index)) continue;
    const normalized = contactEmailKey(address);
    const keys = remaining.get(normalized);
    if (
      keys?.length === 1 &&
      wanted.get(normalized) === 1 &&
      keys[0] !== undefined
    )
      matched.set(index, keys[0]);
  }
  return matched;
};

const updatePatch = (card: ContactRecord, contact: ContactContent) => {
  const existing = card.emails ?? {};
  const keys = Object.keys(existing);
  const existingKeys = new Set(keys);
  const matches = matchedEmailKeys(existing, contact.emails);
  const patch: Record<string, unknown> =
    card.name === null || card.name === undefined
      ? { name: { full: contact.name } }
      : { "name/full": contact.name };
  const kept = new Set<string>();
  const added: Record<string, { address: string }> = {};
  for (const [i, address] of contact.emails.entries()) {
    const key = matches.get(i);
    if (key !== undefined) {
      kept.add(key);
      if (existing[key]?.address !== address)
        patch[`emails/${pathKey(key)}/address`] = address;
    } else {
      let generated = `opensuite${String(i)}`;
      while (existingKeys.has(generated) || generated in added)
        generated += "x";
      added[generated] = { address };
    }
  }
  if (keys.length === 0 && Object.keys(added).length) patch["emails"] = added;
  else
    for (const [key, email] of Object.entries(added))
      patch[`emails/${pathKey(key)}`] = email;
  for (const key of keys)
    if (!kept.has(key)) patch[`emails/${pathKey(key)}`] = null;
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

const content = (card: ContactRecord): ContactContent => ({
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

const preview = (parsed: ParsedCard[], stored: ContactRecord[]) => {
  const existing = new Set(
    stored.flatMap((card) =>
      Object.values(card.emails ?? {}).map((e) => contactEmailKey(e.address)),
    ),
  );
  const namesWithoutEmail = new Set(
    stored
      .filter((card) => !Object.keys(card.emails ?? {}).length)
      .map((card) => contactEmailKey(card.name?.full ?? "")),
  );
  return parsed.map((entry, index) => {
    const keys = entry.contact?.emails.map(contactEmailKey) ?? [];
    const duplicate =
      keys.some((key) => existing.has(key)) ||
      new Set(keys).size !== keys.length ||
      (entry.contact !== null &&
        keys.length === 0 &&
        namesWithoutEmail.has(contactEmailKey(entry.contact.name)));
    for (const key of keys) existing.add(key);
    if (entry.contact !== null && keys.length === 0)
      namesWithoutEmail.add(contactEmailKey(entry.contact.name));
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
  patch: updatePatch,
  warnings: lossWarnings,
  preview,
} satisfies ContactCodec;
