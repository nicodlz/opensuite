import {
  contactEmailKey,
  ContactVcardSchema,
  type ContactContent,
  type ContactRecord,
} from "@opensuite/contracts";
import { z } from "zod";
import { rekeyContactEmailMetadata } from "./contact-import-fields.ts";

export const richContactFields = [
  "phones",
  "addresses",
  "organizations",
  "titles",
  "notes",
  "links",
  "nicknames",
  "anniversaries",
  "vCard",
  "uid",
] as const;
export const object = (value: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).catch({}).parse(value);
export const pathKey = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
export const records = (value: unknown) =>
  Object.entries(object(value)).map(
    ([key, entry]) => [key, object(entry)] as const,
  );
export const scalar = (entry: Record<string, unknown>, key: string) =>
  typeof entry[key] === "string" ? entry[key] : "";
export const componentValues = (value: unknown) =>
  z
    .array(z.object({ kind: z.string(), value: z.string() }))
    .catch([])
    .parse(value);
export function parameterDesign(source: unknown, names: string[]) {
  const definitions = object(source);
  return Object.fromEntries(
    names.map((name) => {
      const original = object(definitions[name]);
      return [
        name,
        {
          ...original,
          valueType: "unknown",
          ...(!original["multiValue"] && name !== "group"
            ? { multiValue: ",", multiValueSeparateDQuote: true }
            : {}),
        },
      ];
    }),
  );
}

export const contactPropertyName = (name: string) =>
  name.toLowerCase().split(".").at(-1) ?? name;
export const fieldProperties: Record<string, string[]> = {
  phones: ["tel"],
  addresses: ["adr"],
  organizations: ["org"],
  titles: ["title", "role"],
  notes: ["note"],
  links: ["url"],
  nicknames: ["nickname"],
  anniversaries: ["bday", "anniversary", "deathdate"],
};

function editedLabelGroups(contact: ContactContent, metadata: unknown) {
  const groups = new Set<string>();
  for (const [pointer, converted] of Object.entries(object(metadata))) {
    const [, field, encodedId] = (
      pointer.startsWith("/") ? pointer : `/${pointer}`
    ).split("/");
    if (!field || !encodedId) continue;
    if (field !== "emails" && !Object.hasOwn(fieldProperties, field)) continue;
    const key = field === "emails" ? "emailDetails" : field;
    const desired = object(contact)[key];
    if (desired === undefined) continue;
    const id = encodedId.replace(/~1/g, "/").replace(/~0/g, "~");
    const entry = object(desired)[id];
    if (field === "emails" && entry === undefined) continue;
    const group = object(object(converted)["parameters"])["group"];
    if (
      typeof group === "string" &&
      (entry === undefined || typeof object(entry)["label"] === "string")
    )
      groups.add(group.toLowerCase());
  }
  return groups;
}
function staleLabel(property: unknown, groups: Set<string>) {
  if (
    !Array.isArray(property) ||
    typeof property[0] !== "string" ||
    contactPropertyName(property[0]) !== "x-ablabel"
  )
    return false;
  const group = object(property[1])["group"];
  const name = typeof group === "string" ? group : property[0].split(".")[0];
  return typeof name === "string" && groups.has(name.toLowerCase());
}
export function canonicalRawProperties(
  contact: ContactContent,
  metadata?: unknown,
) {
  const parsed = ContactVcardSchema.parse(contact.vCard ?? {});
  const supplied = object(contact);
  const canonical = new Set(
    Object.entries(fieldProperties)
      .filter(([key]) => supplied[key] !== undefined)
      .flatMap(([, tags]) => tags),
  );
  canonical.add("fn").add("email");
  if (contact.uid !== undefined) canonical.add("uid");
  const groups = editedLabelGroups(
    contact,
    metadata ?? parsed.convertedProperties,
  );
  return (parsed.properties ?? [])
    .filter(
      (property) =>
        !canonical.has(contactPropertyName(property[0])) &&
        !staleLabel(property, groups),
    )
    .map((property) => {
      const separator = property[0].indexOf(".");
      const group = separator < 0 ? "" : property[0].slice(0, separator);
      return [
        contactPropertyName(property[0]),
        {
          ...property[1],
          ...(group && !Object.hasOwn(property[1], "group") ? { group } : {}),
        },
        property[2],
        property[3],
      ] as const;
    });
}

function labelPropertiesPatch(
  card: ContactRecord,
  contact: ContactContent,
  patch: Record<string, unknown>,
) {
  const stored = object(card["vCard"]);
  const properties = stored["properties"];
  if (contact.vCard?.properties !== undefined || !Array.isArray(properties))
    return;
  const groups = new Set([
    ...editedLabelGroups(contact, stored["convertedProperties"]),
    ...editedLabelGroups(contact, contact.vCard?.convertedProperties),
  ]);
  const kept = properties.filter(
    (property: unknown) => !staleLabel(property, groups),
  );
  if (kept.length !== properties.length) patch["vCard/properties"] = kept;
}

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

function newEmail(contact: ContactContent, address: string) {
  const details = Object.values(contact.emailDetails ?? {}).find(
    (email) => email.address === address,
  );
  return { ...details, address };
}

export const updateContactPatch = (
  card: ContactRecord,
  contact: ContactContent,
) => {
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
  const nativeEmails = new Map<string, string>();
  for (const [i, address] of contact.emails.entries()) {
    const key = matches.get(i);
    if (key !== undefined) {
      kept.add(key);
      nativeEmails.set(key, address);
      if (existing[key]?.address !== address)
        patch[`emails/${pathKey(key)}/address`] = address;
    } else {
      let generated = `opensuite${String(i)}`;
      while (existingKeys.has(generated) || generated in added)
        generated += "x";
      added[generated] = newEmail(contact, address);
      nativeEmails.set(generated, address);
    }
  }
  if (keys.length === 0 && Object.keys(added).length) patch["emails"] = added;
  else
    for (const [key, email] of Object.entries(added))
      patch[`emails/${pathKey(key)}`] = email;
  for (const key of keys)
    if (!kept.has(key)) patch[`emails/${pathKey(key)}`] = null;
  return {
    ...patch,
    ...contactFieldsPatch(
      card,
      rekeyContactEmailMetadata(contact, nativeEmails),
    ),
  };
};

function mergePatch(
  existing: unknown,
  desired: unknown,
  path: string,
  result: Record<string, unknown>,
) {
  if (
    /\/(?:contexts|features)$/.test(path) ||
    /^anniversaries\/[^/]+\/date$/.test(path)
  ) {
    result[path] = desired;
    return;
  }
  if (
    desired === null ||
    typeof desired !== "object" ||
    Array.isArray(desired)
  ) {
    result[path] = desired;
    return;
  }
  if (
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    result[path] = desired;
    return;
  }
  for (const [key, value] of Object.entries(object(desired)))
    mergePatch(object(existing)[key], value, `${path}/${pathKey(key)}`, result);
}

function groupPatch(
  card: ContactRecord,
  key: (typeof richContactFields)[number],
  desired: unknown,
  patch: Record<string, unknown>,
) {
  if (desired === undefined) return;
  if (key === "vCard" || key === "uid") {
    mergePatch(card[key], desired, key, patch);
    return;
  }
  if (desired === null || !card[key]) {
    patch[key] = desired;
    return;
  }
  const existing = object(card[key]);
  const wanted = object(desired);
  for (const id of Object.keys(existing))
    if (!Object.hasOwn(wanted, id)) patch[`${key}/${pathKey(id)}`] = null;
  for (const [id, entry] of Object.entries(wanted))
    mergePatch(existing[id], entry, `${key}/${pathKey(id)}`, patch);
}
function emailDetailsPatch(
  card: ContactRecord,
  contact: ContactContent,
  patch: Record<string, unknown>,
) {
  const usedEmails = new Set<string>();
  for (const [key, details] of Object.entries(contact.emailDetails ?? {})) {
    const match =
      card.emails?.[key]?.address === details.address
        ? ([key, card.emails[key]] as const)
        : Object.entries(card.emails ?? {}).find(
            ([id, email]) =>
              !usedEmails.has(id) && email.address === details.address,
          );
    if (match) {
      usedEmails.add(match[0]);
      mergePatch(match[1], details, `emails/${pathKey(match[0])}`, patch);
    }
  }
}
/** Explicit groups replace their membership; matching IDs retain unknown metadata. */
export function contactFieldsPatch(
  card: ContactRecord,
  contact: ContactContent,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of richContactFields)
    groupPatch(
      card,
      key,
      key === "vCard" && contact.vCard && contact.vCard.properties !== undefined
        ? {
            ...contact.vCard,
            properties: canonicalRawProperties(
              contact,
              contact.vCard.convertedProperties ??
                object(card["vCard"])["convertedProperties"],
            ),
          }
        : contact[key],
      patch,
    );
  labelPropertiesPatch(card, contact, patch);
  if (contact.nameDetails)
    for (const [key, entry] of Object.entries(contact.nameDetails))
      if (key !== "full")
        mergePatch(card.name?.[key], entry, `name/${pathKey(key)}`, patch);
  emailDetailsPatch(card, contact, patch);
  return patch;
}

export function contactEmails(
  contact: ContactContent,
): Record<string, { address: string } & Record<string, unknown>> {
  const details = Object.entries(contact.emailDetails ?? {});
  const reserved = new Set(details.map(([key]) => key));
  const result: Record<string, { address: string } & Record<string, unknown>> =
    {};
  for (const [index, address] of contact.emails.entries()) {
    const found = details.find(
      ([key, email]) =>
        !Object.hasOwn(result, key) && email.address === address,
    );
    let key = found?.[0] ?? `e${String(index)}`;
    if (!found)
      while (reserved.has(key) || Object.hasOwn(result, key)) key += "x";
    result[key] = { ...found?.[1], address };
  }
  return result;
}
