import ICAL from "ical.js";
import { z } from "zod";
import {
  ContactAnniversaryDateSchema,
  type ContactContent,
} from "@opensuite/contracts";
import { object, pathKey, postalParts } from "./contact-fields.ts";
import {
  canonicalRawProperties,
  contactPropertyName as propertyName,
  fieldProperties,
  records,
  scalar,
  componentValues,
  parameterDesign,
} from "./contact-patch.ts";
export function importedNativeFields(
  contact: ContactContent,
): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(contact).filter(
      ([key, value]) =>
        value !== undefined &&
        value !== null &&
        (key === "uid" || Object.hasOwn(fieldProperties, key)),
    ),
  );
  if (contact.vCard)
    fields["vCard"] = {
      ...contact.vCard,
      properties: canonicalRawProperties(contact),
    };
  return fields;
}

function parameters(
  entry: Record<string, unknown>,
  name: string,
): Record<string, string | string[]> {
  const kinds = [
    ...Object.entries(object(entry["contexts"]))
      .filter(([, value]) => value === true)
      .map(([key]) => (key === "private" ? "home" : key)),
    ...Object.entries(object(entry["features"]))
      .filter(([, value]) => value === true)
      .map(([key]) => (key === "mobile" ? "cell" : key)),
  ];
  return {
    ...(kinds.length ? { type: kinds } : {}),
    ...(typeof entry["full"] === "string"
      ? { label: entry["full"] }
      : name !== "adr" && typeof entry["label"] === "string"
        ? { label: entry["label"] }
        : {}),
    ...(typeof entry["countryCode"] === "string"
      ? { cc: entry["countryCode"] }
      : {}),
    ...(typeof entry["pref"] === "number"
      ? { pref: String(entry["pref"]) }
      : {}),
  };
}

function convertedParameters(
  metadata: Record<string, unknown>,
  path: string,
  entry: Record<string, unknown>,
) {
  const converted = object(metadata[path] ?? metadata[path.slice(1)]);
  return Object.fromEntries(
    Object.entries(object(converted["parameters"]))
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .filter(([key]) => {
        if (
          key === "type" &&
          (Object.hasOwn(entry, "contexts") || Object.hasOwn(entry, "features"))
        )
          return false;
        return !(
          ["type", "label", "pref"].includes(key) && Object.hasOwn(entry, key)
        );
      }),
  );
}

class CardWriter {
  readonly card = new ICAL.Component("vcard");
  readonly metadata: Record<string, unknown>;
  readonly regeneratedLabels = new Set<string>();
  #groups = 0;
  readonly #usedGroups: Set<string>;
  readonly #groupLabels = new Map<string, string>();
  constructor(contact: ContactContent) {
    this.metadata = object(contact.vCard?.["convertedProperties"]);
    this.#usedGroups = new Set(
      [
        ...Object.values(this.metadata).map(
          (value) => object(object(value)["parameters"])["group"],
        ),
        ...(contact.vCard?.properties ?? []).map(
          (property) => property[1]["group"],
        ),
      ]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase()),
    );
    this.card.addPropertyWithValue("version", "4.0");
    if (contact.uid) this.add("uid", contact.uid, "/uid");
    this.add("fn", contact.name, "/name/full");
    const details = Object.entries(contact.emailDetails ?? {});
    const used = new Set<string>();
    for (const [index, address] of contact.emails.entries()) {
      const found = details.find(
        ([key, entry]) => !used.has(key) && entry.address === address,
      );
      if (found) used.add(found[0]);
      this.add(
        "email",
        address,
        `/emails/${pathKey(found?.[0] ?? `e${String(index)}`)}/address`,
        found?.[1] ?? {},
      );
    }
  }
  add(
    name: string,
    value: unknown,
    path: string,
    entry: Record<string, unknown> = {},
    overrides: Record<string, string> = {},
  ) {
    const params = {
      ...convertedParameters(this.metadata, path, entry),
      ...parameters(entry, name),
      ...overrides,
    };
    const group = this.group(params["group"], entry["label"]);
    delete params["group"];
    const property = new ICAL.Property(name, this.card);
    if (
      typeof value === "string" &&
      /[\r\n]/.test(value) &&
      property.type !== "text"
    )
      property.resetType("text");
    property.setValue(value);
    if (group) property.setParameter("group", group);
    for (const [key, param] of Object.entries(params)) {
      if (
        typeof param === "string" ||
        (Array.isArray(param) &&
          param.every((item) => typeof item === "string"))
      )
        property.setParameter(
          key,
          typeof param === "string"
            ? param.replace(/\r\n|\r/g, "\n")
            : param.map((parameterValue) =>
                parameterValue.replace(/\r\n|\r/g, "\n"),
              ),
        );
    }
    this.card.addProperty(property);
    if (
      group &&
      typeof entry["label"] === "string" &&
      !this.regeneratedLabels.has(group.toLowerCase())
    ) {
      this.regeneratedLabels.add(group.toLowerCase());
      const label = new ICAL.Property("x-ablabel", this.card);
      label.setValue(entry["label"]);
      label.setParameter("group", group);
      this.card.addProperty(label);
    }
  }
  private group(existing: unknown, label: unknown): string | undefined {
    if (typeof existing === "string" && /^[a-z0-9-]+$/i.test(existing)) {
      const key = existing.toLowerCase();
      if (
        typeof label !== "string" ||
        !this.#groupLabels.has(key) ||
        this.#groupLabels.get(key) === label
      ) {
        if (typeof label === "string") this.#groupLabels.set(key, label);
        return existing;
      }
    }
    if (typeof label !== "string") return undefined;
    let generated: string;
    do {
      generated = `esuno${String(this.#groups++)}`;
    } while (this.#usedGroups.has(generated));
    this.#usedGroups.add(generated);
    this.#groupLabels.set(generated, label);
    return generated;
  }
}

function writeAddresses(
  writer: CardWriter,
  contact: ContactContent,
  rawNames: Set<unknown>,
) {
  for (const [id, address] of records(contact.addresses))
    if (!rawNames.has("adr")) {
      const components = componentValues(address["components"]);
      const { parts, jscomps } = postalParts(
        components,
        scalar(address, "defaultSeparator"),
      );
      if (!parts.some(Boolean) && typeof address["full"] === "string")
        parts[11] = parts[2] = address["full"];
      writer.add(
        "adr",
        parts,
        `/addresses/${pathKey(id)}/components`,
        address,
        components.length ? { jscomps } : {},
      );
    }
}
function writeTextFields(
  writer: CardWriter,
  contact: ContactContent,
  rawNames: Set<unknown>,
) {
  for (const [id, organization] of records(contact.organizations))
    if (!rawNames.has("org")) {
      const units = z
        .array(z.object({ name: z.string() }))
        .catch([])
        .parse(organization["units"]);
      writer.add(
        "org",
        [scalar(organization, "name"), ...units.map((unit) => unit.name)],
        `/organizations/${pathKey(id)}/name`,
        organization,
      );
    }
  for (const [id, title] of records(contact.titles)) {
    const tag = title["kind"] === "role" ? "role" : "title";
    if (!rawNames.has(tag))
      writer.add(
        tag,
        scalar(title, "name"),
        `/titles/${pathKey(id)}/name`,
        title,
      );
  }
  for (const [field, tag, valueKey] of [
    ["notes", "note", "note"],
    ["links", "url", "uri"],
    ["nicknames", "nickname", "name"],
  ] as const)
    for (const [id, entry] of records(contact[field]))
      if (!rawNames.has(tag))
        writer.add(
          tag,
          scalar(entry, valueKey),
          `/${field}/${pathKey(id)}/${valueKey}`,
          entry,
        );
  const names = componentValues(contact.nameDetails?.["components"]);
  if (names.length && !rawNames.has("n"))
    writer.add(
      "n",
      [
        "surname",
        "given",
        "given2",
        "title",
        "credential",
        "surname2",
        "generation",
      ].map((kind) =>
        names
          .filter((part) => part.kind === kind)
          .map((part) => part.value)
          .join(" "),
      ),
      "/name/components",
    );
}
function partialDate(date: {
  year?: number | undefined;
  month?: number | undefined;
  day?: number | undefined;
}) {
  if (
    date.year !== undefined &&
    date.month !== undefined &&
    date.day === undefined
  )
    return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}`;
  if (
    date.year === undefined &&
    date.month === undefined &&
    date.day !== undefined
  )
    return `---${String(date.day).padStart(2, "0")}`;
  return [
    date.year === undefined ? "--" : String(date.year).padStart(4, "0"),
    date.month === undefined ? "" : String(date.month).padStart(2, "0"),
    date.day === undefined ? "" : String(date.day).padStart(2, "0"),
  ].join("");
}
function writeDates(
  writer: CardWriter,
  contact: ContactContent,
  rawNames: Set<unknown>,
) {
  for (const [id, anniversary] of records(contact.anniversaries)) {
    const tag =
      anniversary["kind"] === "birth"
        ? "bday"
        : anniversary["kind"] === "death"
          ? "deathdate"
          : "anniversary";
    if (rawNames.has(tag)) continue;
    const date = ContactAnniversaryDateSchema.parse(anniversary["date"]);
    const value = date["@type"] === "Timestamp" ? date.utc : partialDate(date);
    writer.add(tag, value, `/anniversaries/${pathKey(id)}/date`, anniversary);
  }
}
function writeRawProperties(
  writer: CardWriter,
  rawProperties: ReturnType<typeof canonicalRawProperties>,
) {
  for (const raw of rawProperties) {
    if (
      ["begin", "end", "version", "fn", "email"].includes(propertyName(raw[0]))
    )
      continue;
    const escapeUnknown = (value: unknown): unknown =>
      typeof value === "string"
        ? value.replace(/\r\n|\r|\n/g, "\\n")
        : Array.isArray(value)
          ? value.map(escapeUnknown)
          : value;
    const rawParameters = object(raw[1]);
    const group = rawParameters["group"];
    const labelGroup =
      typeof group === "string"
        ? group
        : raw[0].includes(".")
          ? raw[0].split(".")[0]
          : undefined;
    if (
      propertyName(raw[0]) === "x-ablabel" &&
      labelGroup &&
      writer.regeneratedLabels.has(labelGroup.toLowerCase())
    )
      continue;
    if (labelGroup) rawParameters["group"] = labelGroup;
    const name = propertyName(raw[0]);
    const value = raw[2] === "unknown" ? escapeUnknown(raw[3]) : raw[3];
    const values: unknown[] =
      Array.isArray(value) && ["categories", "nickname"].includes(name)
        ? value
        : [value];
    const property = new ICAL.Property(
      [name, rawParameters, raw[2], ...values],
      writer.card,
    );
    writer.card.addProperty(property);
  }
}
export function writeContactCard(contact: ContactContent): string {
  const writer = new CardWriter(contact);
  const rawProperties = canonicalRawProperties(contact);
  const rawNames = new Set(
    rawProperties.map((property) => propertyName(property[0])),
  );
  for (const [id, phone] of records(contact.phones))
    if (!rawNames.has("tel"))
      writer.add(
        "tel",
        scalar(phone, "number"),
        `/phones/${pathKey(id)}/number`,
        phone,
      );
  writeAddresses(writer, contact, rawNames);
  writeTextFields(writer, contact, rawNames);
  writeDates(writer, contact, rawNames);
  writeRawProperties(writer, rawProperties);
  const arrays = writer.card.getAllProperties().flatMap((property) =>
    Object.entries(object(property.jCal[1]))
      .filter(([, value]) => Array.isArray(value))
      .map(([name]) => name),
  );
  return ICAL.stringify.component(writer.card.jCal, {
    ...ICAL.design.vcard,
    param: {
      ...object(ICAL.design.vcard.param),
      ...parameterDesign(ICAL.design.vcard.param, arrays),
    },
  });
}
