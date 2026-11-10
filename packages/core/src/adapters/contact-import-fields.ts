import {
  ContactAnniversaryDateSchema,
  ContactFieldsSchema,
  contactEmailKey,
  type ContactContent,
  type ContactRecord,
} from "@opensuite/contracts";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

type Property = NonNullable<
  NonNullable<ContactContent["vCard"]>["properties"]
>[number];
type Field =
  | "notes"
  | "organizations"
  | "titles"
  | "links"
  | "nicknames"
  | "anniversaries";
const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).catch({}).parse(value);
const nameOf = (property: Property) =>
  property[0].toLowerCase().split(".").at(-1) ?? "";
const pathKey = (id: string) => id.replaceAll("~", "~0").replaceAll("/", "~1");
const groupOf = (property: Property) => {
  const group = property[1]["group"];
  return typeof group === "string" ? group.toLowerCase() : undefined;
};

function partialDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const full = /^(\d{4})(?:-?(\d{2})(?:-?(\d{2}))?)?$/.exec(value);
  const reduced = /^--(\d{2})(?:-?(\d{2}))?$/.exec(value);
  const day = /^---(\d{2})$/.exec(value);
  const source = full
    ? { year: full[1], month: full[2], day: full[3] }
    : reduced
      ? { month: reduced[1], day: reduced[2] }
      : day
        ? { day: day[1] }
        : undefined;
  const date = source
    ? {
        "@type": "PartialDate",
        ...Object.fromEntries(
          Object.entries(source)
            .filter(([, part]) => part !== undefined)
            .map(([key, part]) => [key, Number(part)]),
        ),
      }
    : { "@type": "Timestamp", utc: value };
  const parsed = ContactAnniversaryDateSchema.safeParse(date);
  return parsed.success ? parsed.data : undefined;
}

function comparable(field: Field, entry: Record<string, unknown>) {
  if (field === "organizations")
    return [
      entry["name"],
      z
        .array(z.object({ name: z.string() }))
        .catch([])
        .parse(entry["units"])
        .map((unit) => unit.name),
    ];
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([key]) =>
        !["@type", "label", "contexts", "features", "pref"].includes(key),
    ),
  );
}

class ImportFields {
  readonly contact: ContactContent;
  readonly unsupported = new Set<string>();
  readonly #metadata: NonNullable<
    NonNullable<ContactContent["vCard"]>["convertedProperties"]
  >;
  readonly #labels = new Map<string, string>();
  readonly #retained: Property[] = [];
  constructor(contact: ContactContent) {
    this.contact = { ...contact };
    this.#metadata = { ...contact.vCard?.convertedProperties };
    for (const property of contact.vCard?.properties ?? []) {
      const group = groupOf(property);
      if (
        nameOf(property) === "x-ablabel" &&
        group &&
        typeof property[3] === "string"
      )
        this.#labels.set(group, property[3]);
    }
  }
  private put(
    field: Field,
    value: Record<string, unknown>,
    property: Property,
    valueKey: string,
  ) {
    const current = object(this.contact[field]);
    const match = Object.entries(current).find(([, item]) =>
      isDeepStrictEqual(
        comparable(field, object(item)),
        comparable(field, value),
      ),
    );
    if (match) {
      const pointer = `/${field}/${pathKey(match[0])}/${valueKey}`;
      const metadata =
        this.#metadata[pointer] ?? this.#metadata[pointer.slice(1)];
      return isDeepStrictEqual(metadata?.parameters ?? {}, property[1])
        ? match[0]
        : undefined;
    }
    let id = `vcard${String(Object.keys(current).length)}`;
    while (Object.hasOwn(current, id)) id += "x";
    const label = this.#labels.get(groupOf(property) ?? "");
    const validated = ContactFieldsSchema.safeParse({
      [field]: {
        [id]: { ...value, ...(label === undefined ? {} : { label }) },
      },
    });
    if (!validated.success) return undefined;
    const entries = validated.data[field];
    Object.defineProperty(this.contact, field, {
      value: { ...current, ...entries },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    this.#metadata[`/${field}/${pathKey(id)}/${valueKey}`] = {
      name: nameOf(property),
      parameters: { ...property[1] },
    };
    return id;
  }
  private organization(property: Property) {
    const values = Array.isArray(property[3]) ? property[3] : [property[3]];
    if (!values.every((value) => typeof value === "string")) return false;
    const [name, ...units] = values;
    const id = this.put(
      "organizations",
      {
        name: name ?? "",
        ...(units.length
          ? { units: units.map((unitName) => ({ name: unitName })) }
          : {}),
      },
      property,
      "name",
    );
    return id !== undefined;
  }
  private text(property: Property) {
    const tag = nameOf(property);
    if (tag === "nickname") {
      const values = Array.isArray(property[3]) ? property[3] : [property[3]];
      if (!values.every((value) => typeof value === "string")) return false;
      return values.every(
        (name) =>
          this.put("nicknames", { name }, property, "name") !== undefined,
      );
    }
    if (typeof property[3] !== "string") return false;
    const value = property[3];
    if (tag === "note")
      return this.put("notes", { note: value }, property, "note") !== undefined;
    if (tag === "url")
      return this.put("links", { uri: value }, property, "uri") !== undefined;
    if (tag !== "title" && tag !== "role") return false;
    return (
      this.put("titles", { name: value, kind: tag }, property, "name") !==
      undefined
    );
  }
  private date(property: Property) {
    const date = partialDate(property[3]);
    if (!date) return false;
    const tag = nameOf(property);
    const kind =
      tag === "bday" ? "birth" : tag === "deathdate" ? "death" : "anniversary";
    return (
      this.put("anniversaries", { kind, date }, property, "date") !== undefined
    );
  }
  private convert(property: Property) {
    const name = nameOf(property);
    if (name === "org") return this.organization(property);
    if (["note", "url", "nickname", "title", "role"].includes(name))
      return this.text(property);
    if (["bday", "anniversary", "deathdate"].includes(name))
      return this.date(property);
    return false;
  }
  run() {
    const properties = [...(this.contact.vCard?.properties ?? [])];
    const ordered = [
      ...properties.filter((property) => nameOf(property) === "org"),
      ...properties.filter((property) => nameOf(property) !== "org"),
    ];
    for (const property of ordered) {
      if (this.convert(property)) continue;
      const name = nameOf(property);
      this.#retained.push(property);
      if (
        !["n", "fn", "uid", "email", "version", "prodid", "rev"].includes(
          name,
        ) &&
        !name.startsWith("x-")
      )
        this.unsupported.add(name);
    }
    if (this.contact.vCard || Object.keys(this.#metadata).length)
      this.contact.vCard = {
        ...this.contact.vCard,
        ...(this.contact.vCard?.properties === undefined
          ? {}
          : { properties: this.#retained }),
        ...(Object.keys(this.#metadata).length
          ? { convertedProperties: this.#metadata }
          : {}),
      };
    return { contact: this.contact, unsupported: [...this.unsupported] };
  }
}

/** Materializes validated ICAL properties for an additive import; never fetches media URIs. */
export const prepareContactImport = (contact: ContactContent) =>
  new ImportFields(contact).run();

type ConversionMetadata = NonNullable<
  NonNullable<ContactContent["vCard"]>["convertedProperties"]
>;
export const hasNativeEmailDetails = (card: ContactRecord) =>
  Object.values(card.emails ?? {}).some((email) =>
    Object.keys(email).some((key) => key !== "address"),
  ) ||
  Object.keys(object(object(card["vCard"])["convertedProperties"])).some(
    (pointer) => /^\/?emails\//.test(pointer),
  );
function nativeEmailId(
  source: string,
  address: string,
  emails: ReadonlyMap<string, string>,
) {
  const normalized = contactEmailKey(address);
  const current = emails.get(source);
  if (current !== undefined && contactEmailKey(current) === normalized)
    return source;
  const matches = [...emails].filter(
    ([, value]) => contactEmailKey(value) === normalized,
  );
  return matches.length === 1 ? matches[0]?.[0] : undefined;
}
function emailMetadataPath(
  pointer: string,
  contact: ContactContent,
  nativeEmails: ReadonlyMap<string, string>,
  original: ConversionMetadata,
) {
  const normalized = pointer.startsWith("/") ? pointer : `/${pointer}`;
  const [, field, encodedId, ...suffix] = normalized.split("/");
  if (field !== "emails" || encodedId === undefined) return pointer;
  const sourceId = encodedId.replaceAll("~1", "/").replaceAll("~0", "~");
  const details = contact.emailDetails?.[sourceId];
  if (!details) return pointer;
  const target = nativeEmailId(sourceId, details.address, nativeEmails);
  if (target === undefined) return pointer;
  const canonical = `/emails/${pathKey(target)}/${suffix.join("/")}`;
  if (Object.hasOwn(original, canonical)) return canonical;
  if (Object.hasOwn(original, canonical.slice(1))) return canonical.slice(1);
  return pointer.startsWith("/") ? canonical : canonical.slice(1);
}
/** Keep conversion pointers aligned with the IDs actually retained/allocated by the email patch. */
export function rekeyContactEmailMetadata(
  contact: ContactContent,
  nativeEmails: ReadonlyMap<string, string>,
): ContactContent {
  const original = contact.vCard?.convertedProperties;
  if (!original || !contact.emailDetails) return contact;
  const remapped = new Map<string, ConversionMetadata[string]>();
  for (const [pointer, metadata] of Object.entries(original)) {
    const destination = emailMetadataPath(
      pointer,
      contact,
      nativeEmails,
      original,
    );
    const retained = original[destination] ?? remapped.get(destination);
    remapped.set(destination, {
      ...metadata,
      ...retained,
      ...(metadata.parameters || retained?.parameters
        ? { parameters: { ...metadata.parameters, ...retained?.parameters } }
        : {}),
    });
  }
  return {
    ...contact,
    vCard: {
      ...contact.vCard,
      convertedProperties: Object.fromEntries(remapped),
    },
  };
}
