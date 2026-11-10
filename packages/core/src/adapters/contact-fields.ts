import ICAL from "ical.js";
import {
  ContactContentSchema,
  ContactAnniversaryDateSchema,
} from "@opensuite/contracts";
import type { ContactContent, ContactRecord } from "@opensuite/contracts";

import { object, parameterDesign, richContactFields } from "./contact-patch.ts";
import { hasNativeEmailDetails } from "./contact-import-fields.ts";
export { object, pathKey, richContactFields } from "./contact-patch.ts";

/** Output remains tolerant of contact fields written by other CardDAV clients. */
export function contactFields(card: ContactRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of richContactFields)
    if (card[key] !== undefined && card[key] !== null) fields[key] = card[key];
  if (Object.keys(card.name ?? {}).some((key) => key !== "full"))
    fields["nameDetails"] = card.name;
  if (hasNativeEmailDetails(card)) fields["emailDetails"] = card.emails;
  return fields;
}

const tokens = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(
    String,
  );
export const addressComponentKinds = [
  "postOfficeBox",
  "",
  "",
  "locality",
  "region",
  "postcode",
  "country",
  "room",
  "apartment",
  "floor",
  "number",
  "name",
  "building",
  "block",
  "subdistrict",
  "district",
  "landmark",
  "direction",
];
const legacyAddressKinds = [
  "postOfficeBox",
  "apartment",
  "name",
  "locality",
  "region",
  "postcode",
  "country",
];
type AddressComponent = { kind: string; value: string };
const escapeSeparator = (value: string) =>
  value.replace(/[\\,:=;"]/g, (character) => `\\${character}`);
const decodeSeparator = (value: string) =>
  value.replace(/\\([\\,:=;"])/g, "$1");
export function postalParts(
  components: AddressComponent[],
  defaultSeparator = "",
) {
  const values: string[][] = addressComponentKinds.map(() => []);
  const order = [
    defaultSeparator ? `s,${escapeSeparator(defaultSeparator)}` : "",
  ];
  for (const component of components) {
    if (component.kind === "separator") {
      order.push(`s,${escapeSeparator(component.value)}`);
      continue;
    }
    const position = addressComponentKinds.indexOf(component.kind);
    const slot = values[position];
    if (!slot) throw new Error("Unsupported postal component");
    order.push(
      slot.length
        ? `${String(position)},${String(slot.length)}`
        : String(position),
    );
    slot.push(component.value);
  }
  values[1] = [7, 8, 9, 12].flatMap((index) => values[index] ?? []);
  values[2] = [10, 11, 13, 17, 16, 14, 15].flatMap(
    (index) => values[index] ?? [],
  );
  return {
    parts: values.map((slot) => (slot.length > 1 ? slot : (slot[0] ?? ""))),
    jscomps: order.join(";"),
  };
}
function splitPostalOrder(encoded: string) {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === "\\") index++;
    else if (encoded[index] === ";") {
      parts.push(encoded.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(encoded.slice(start));
  return parts;
}
function orderedPostalParts(parts: unknown[], encoded: string) {
  const [separator, ...order] = splitPostalOrder(encoded);
  if (separator && !separator.startsWith("s,"))
    throw new Error("Invalid postal ordering");
  const components: AddressComponent[] = [];
  for (const entry of order) {
    if (entry.startsWith("s,")) {
      components.push({
        kind: "separator",
        value: decodeSeparator(entry.slice(2)),
      });
      continue;
    }
    if (!/^\d+(?:,\d+)?$/.test(entry))
      throw new Error("Invalid postal ordering");
    const [position = 0, index = 0] = entry.split(",").map(Number);
    const kind = addressComponentKinds[position];
    const value = tokens(parts[position])[index];
    if (!kind || value === undefined)
      throw new Error("Invalid postal ordering");
    components.push({ kind, value });
  }
  return {
    components,
    isOrdered: true,
    defaultSeparator: separator ? decodeSeparator(separator.slice(2)) : "",
  };
}
const phoneFeatures: Record<string, string> = {
  cell: "mobile",
  voice: "voice",
  text: "text",
  video: "video",
  fax: "fax",
  pager: "pager",
  textphone: "textphone",
  "main-number": "main-number",
};
const types = (property: ICAL.Property) =>
  tokens(property.getParameter("type")).map((value) => value.toLowerCase());
function propertyMetadata(
  property: ICAL.Property,
  label: unknown = property.getParameter("label"),
) {
  const labels = types(property).filter(
    (type) => property.name !== "tel" || !(type in phoneFeatures),
  );
  const contexts = Object.fromEntries(
    labels.map((type) => [type === "home" ? "private" : type, true]),
  );
  const pref = Number(property.getParameter("pref"));
  return {
    ...(Object.keys(contexts).length ? { contexts } : {}),
    ...(pref >= 1 && pref <= 100 ? { pref } : {}),
    ...(typeof label === "string" ? { label } : {}),
  };
}
function labelsOf(component: ICAL.Component) {
  const labels = new Map<string, string>();
  for (const property of component.getAllProperties("x-ablabel")) {
    const group: unknown = property.getParameter("group");
    const label: unknown = property.getFirstValue();
    if (typeof group === "string" && typeof label === "string")
      labels.set(group.toLowerCase(), label);
  }
  return labels;
}
const labelOf = (property: ICAL.Property, labels: Map<string, string>) => {
  const group: unknown = property.getParameter("group");
  return typeof group === "string"
    ? labels.get(group.toLowerCase())
    : undefined;
};
class EncodedCardError extends Error {}
/** Parameters use RFC 6868, not the backslash escaping of property text. */
function restoreParameters(component: ICAL.Component, source: string) {
  const lines = source
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^(?:BEGIN|END):/i.test(line));
  const properties = component.getAllProperties();
  if (lines.length !== properties.length)
    throw new Error("Unsupported nested card");
  const version: unknown = component.getFirstPropertyValue("version");
  const design = version === "3.0" ? ICAL.design.vcard3 : ICAL.design.vcard;
  const definitions = object(design.param);
  for (const [index, property] of properties.entries()) {
    const keys = Object.keys(object(property.jCal[1]));
    if (!keys.length) continue;
    const param = parameterDesign(definitions, keys);
    const line = lines[index];
    if (line === undefined) throw new Error("Missing property source");
    const parsed = ICAL.Property.fromString(line, {
      ...design,
      param: { ...definitions, ...param },
    });
    property.jCal[1] = object(parsed.jCal[1]);
  }
}
function prepareCard(source: string) {
  const component = ICAL.Component.fromString(source);
  restoreParameters(component, source);
  for (const property of component.getAllProperties()) {
    const encoding: unknown = property.getParameter("encoding");
    if (encoding !== undefined) throw new EncodedCardError();
    const parts = property.name.split(".");
    const [group, name] = parts;
    if (parts.length === 2 && group !== undefined && name !== undefined) {
      property.setParameter("group", group);
      property.jCal[0] = name;
    }
  }
  const versions = component.getAllProperties("version");
  if (
    component.name !== "vcard" ||
    versions.length !== 1 ||
    component.getAllProperties("fn").length !== 1 ||
    !["3.0", "4.0"].includes(String(versions[0]?.getFirstValue()))
  )
    throw new Error("Invalid card");
  return component;
}
function remember(
  property: ICAL.Property,
  path: string,
  converted: Record<string, unknown>,
) {
  if (Object.keys(object(property.jCal[1])).length)
    converted[path] = { parameters: object(property.jCal[1]) };
}
function phone(
  property: ICAL.Property,
  index: number,
  converted: Record<string, unknown>,
  labels: Map<string, string>,
) {
  remember(property, `/phones/p${String(index)}/number`, converted);
  return [
    `p${String(index)}`,
    {
      number: String(property.getFirstValue()),
      ...propertyMetadata(property, labelOf(property, labels)),
      features: Object.fromEntries(
        types(property)
          .filter((type) => type in phoneFeatures)
          .map((type) => [phoneFeatures[type] ?? type, true] as const),
      ),
    },
  ] as const;
}
function address(
  property: ICAL.Property,
  index: number,
  converted: Record<string, unknown>,
  labels: Map<string, string>,
) {
  remember(property, `/addresses/a${String(index)}/components`, converted);
  const values: unknown = property.getFirstValue();
  const parts = Array.isArray(values) ? values : [values];
  const kinds = parts.length > 7 ? addressComponentKinds : legacyAddressKinds;
  const metadata = propertyMetadata(
    property,
    labelOf(property, labels) ?? null,
  );
  const full: unknown = property.getParameter("label");
  const countryCode = property.getParameter("cc");
  const ordering = property.getParameter("jscomps");
  return [
    `a${String(index)}`,
    {
      ...(typeof ordering === "string"
        ? orderedPostalParts(parts, ordering)
        : {
            components: parts.flatMap((value, i) =>
              value && kinds[i]
                ? tokens(value).map((text) => ({ kind: kinds[i], value: text }))
                : [],
            ),
          }),
      ...metadata,
      ...(typeof full === "string" ? { full } : {}),
      ...(typeof countryCode === "string" ? { countryCode } : {}),
    },
  ] as const;
}
const optionalDatePart = (value: unknown) =>
  typeof value === "number" ? value : undefined;
function retainedProperties(component: ICAL.Component) {
  const version: unknown = component.getFirstPropertyValue("version");
  return component
    .getAllProperties()
    .filter(
      (property) =>
        !["version", "fn", "email", "tel", "adr"].includes(property.name),
    )
    .flatMap((property) => {
      const decorated: unknown = property.getFirstValue();
      if (
        ["bday", "anniversary", "deathdate"].includes(property.name) &&
        decorated instanceof ICAL.VCardTime &&
        !ContactAnniversaryDateSchema.safeParse({
          "@type": "PartialDate",
          year: optionalDatePart(decorated.year),
          month: optionalDatePart(decorated.month),
          day: optionalDatePart(decorated.day),
        }).success
      )
        throw new Error("Invalid vCard date");
      const wire: unknown =
        decorated instanceof ICAL.VCardTime
          ? decorated.toICALString()
          : property.jCal.length === 4
            ? property.jCal[3]
            : property.jCal.slice(3);
      const values =
        version === "3.0" &&
        property.name === "note" &&
        property.type === "text" &&
        property.jCal.length > 4
          ? property.jCal.slice(3)
          : [wire];
      return values.map((value: unknown) => [
        property.name,
        object(property.jCal[1]),
        property.type,
        value,
      ]);
    });
}
/** Parse a bounded vCard with ICAL; canonical phone/address values take precedence. */
export function parseContactCard(source: string): {
  contact: ContactContent | null;
  warnings: string[];
} {
  try {
    const component = prepareCard(source);
    const labels = labelsOf(component);
    const fullName = component.getFirstProperty("fn");
    const uid = component.getFirstProperty("uid");
    const identifier: unknown = uid?.getFirstValue();
    const converted: Record<string, unknown> = {};
    if (fullName) remember(fullName, "/name/full", converted);
    if (uid) remember(uid, "/uid", converted);
    const emails = component.getAllProperties("email");
    const emailDetails = Object.fromEntries(
      emails.map((property, index) => {
        remember(property, `/emails/e${String(index)}/address`, converted);
        return [
          `e${String(index)}`,
          {
            address: String(property.getFirstValue()),
            ...propertyMetadata(property, labelOf(property, labels)),
          },
        ];
      }),
    );
    const phones = Object.fromEntries(
      component
        .getAllProperties("tel")
        .map((property, index) => phone(property, index, converted, labels)),
    );
    const addresses = Object.fromEntries(
      component
        .getAllProperties("adr")
        .map((property, index) => address(property, index, converted, labels)),
    );
    const properties = retainedProperties(component);
    const name: unknown = fullName?.getFirstValue();
    const parsed = ContactContentSchema.safeParse({
      name,
      ...(uid ? { uid: identifier } : {}),
      emails: emails.map((property) => property.getFirstValue()),
      ...(emails.some(
        (property) => Object.keys(object(property.jCal[1])).length,
      )
        ? { emailDetails }
        : {}),
      ...(Object.keys(phones).length ? { phones } : {}),
      ...(Object.keys(addresses).length ? { addresses } : {}),
      ...(properties.length || Object.keys(converted).length
        ? { vCard: { properties, convertedProperties: converted } }
        : {}),
    });
    return parsed.success
      ? { contact: parsed.data, warnings: [] }
      : { contact: null, warnings: ["Invalid or unsupported vCard"] };
  } catch (error) {
    return {
      contact: null,
      warnings: [
        error instanceof EncodedCardError
          ? "Encoded vCard properties are not supported; export as UTF-8 vCard 3.0 or 4.0"
          : "Invalid vCard",
      ],
    };
  }
}
