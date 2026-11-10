import { isDeepStrictEqual } from "node:util";
import {
  blockImportEntry,
  copyImportParameters,
  emptyImportPlan,
  previewImportEntry,
  type ContactImportPlan,
} from "./contact-import-result.ts";
import {
  contactEmailKey,
  type ContactCodec,
  type ContactContent,
  type ContactRecord,
} from "@opensuite/contracts";
import { z } from "zod";

type Parsed = Extract<ReturnType<ContactCodec["parse"]>, { ok: true }>["cards"];
type Entity = {
  key: string;
  original?: ContactRecord;
  content: ContactContent;
  books: string[];
  indices: number[];
};
const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).catch({}).parse(value);
const nameKey = (value: string) =>
  value.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
const phoneKey = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/^tel:/i, "")
        .replace(/[\s().-]/g, "")
        .toLowerCase()
    : "";
const importIdentityTags = new Set([
  "version",
  "fn",
  "n",
  "uid",
  "email",
  "x-ablabel",
]);
const entries = (value: unknown) => Object.entries(object(value));
function missing(existing: unknown, incoming: unknown): unknown {
  if (existing === undefined || existing === null)
    return incoming !== null &&
      typeof incoming === "object" &&
      !Object.keys(incoming).length
      ? existing
      : incoming;
  if (
    Array.isArray(existing) ||
    Array.isArray(incoming) ||
    typeof existing !== "object" ||
    incoming === null ||
    typeof incoming !== "object"
  )
    return existing;
  const result = new Map(entries(existing));
  for (const [key, value] of entries(incoming)) {
    const merged = missing(result.get(key), value);
    if (merged !== undefined) result.set(key, merged);
  }
  return Object.fromEntries(result);
}
const mapFields = [
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
function identity(field: string, value: unknown): unknown {
  const row = object(value);
  if (field === "phones") return phoneKey(row["number"]);
  if (field === "emailDetails")
    return typeof row["address"] === "string"
      ? contactEmailKey(row["address"])
      : "";
  return Object.fromEntries(
    entries(row).filter(
      ([key]) => !["label", "contexts", "features", "pref"].includes(key),
    ),
  );
}
function mergeMap(
  field: (typeof mapFields)[number],
  existing: ContactContent,
  incoming: ContactContent,
  metadata: Record<string, unknown>,
) {
  const result = new Map(entries(existing[field]));
  for (const [sourceId, value] of entries(incoming[field])) {
    const key = identity(field, value);
    const found = [...result].find(([, current]) =>
      isDeepStrictEqual(identity(field, current), key),
    );
    if (found) {
      result.set(found[0], missing(found[1], value));
      copyImportParameters(metadata, incoming, field, sourceId, found[0], true);
    } else {
      let id = `import${String(result.size)}`;
      while (result.has(id)) id += "x";
      result.set(id, value);
      copyImportParameters(metadata, incoming, field, sourceId, id);
    }
  }
  return Object.fromEntries(result);
}
/** Fill absent values; explicit existing values, labels, IDs and names remain authoritative. */
function enrich(
  existing: ContactContent,
  incoming: ContactContent,
): ContactContent {
  const metadata = { ...existing.vCard?.convertedProperties };
  const maps = Object.fromEntries(
    mapFields
      .filter(
        (field) => incoming[field] !== undefined && incoming[field] !== null,
      )
      .map((field) => [field, mergeMap(field, existing, incoming, metadata)]),
  );
  const seen = new Set(existing.emails.map(contactEmailKey));
  const emails = [...existing.emails];
  for (const email of incoming.emails)
    if (!seen.has(contactEmailKey(email))) {
      emails.push(email);
      seen.add(contactEmailKey(email));
    }
  const properties = combinedProperties(existing, incoming);
  const vCard =
    existing.vCard || properties.length || Object.keys(metadata).length
      ? {
          ...existing.vCard,
          ...(properties.length || existing.vCard?.properties !== undefined
            ? { properties }
            : {}),
          ...(Object.keys(metadata).length
            ? { convertedProperties: metadata }
            : {}),
        }
      : undefined;
  return {
    ...existing,
    ...maps,
    name: existing.name || incoming.name,
    emails,
    ...(vCard ? { vCard } : {}),
  };
}
function combinedProperties(
  existing: ContactContent,
  incoming: ContactContent,
) {
  const result = [...(existing.vCard?.properties ?? [])];
  for (const property of incoming.vCard?.properties ?? [])
    if (
      !importIdentityTags.has(property[0].toLowerCase()) &&
      !result.some((current) => isDeepStrictEqual(current, property))
    )
      result.push(property);
  return result;
}
function hasPhone(entity: Entity, incoming: ContactContent) {
  if (nameKey(entity.content.name) !== nameKey(incoming.name)) return false;
  const phones = new Set(
    Object.values(entity.content.phones ?? {})
      .map((phone) => phoneKey(phone.number))
      .filter((key) => /\d/.test(key)),
  );
  return Object.values(incoming.phones ?? {}).some(
    (phone) =>
      /\d/.test(phoneKey(phone.number)) && phones.has(phoneKey(phone.number)),
  );
}
function matches(pool: Entity[], incoming: ContactContent) {
  const emails = new Set(incoming.emails.map(contactEmailKey));
  const candidates = pool.filter(
    (entity) =>
      (incoming.uid !== undefined && incoming.uid === entity.content.uid) ||
      entity.content.emails.some((email) => emails.has(contactEmailKey(email))),
  );
  return candidates.length
    ? candidates
    : pool.filter((entity) => hasPhone(entity, incoming));
}
function nameCandidates(pool: Entity[], incoming: ContactContent) {
  return pool.filter(
    (entity) =>
      entity.original &&
      !entity.content.emails.length &&
      !Object.keys(entity.content.phones ?? {}).length &&
      nameKey(entity.content.name) === nameKey(incoming.name),
  );
}
type Resolution = { entity?: Entity; reason?: string; candidates?: Entity[] };
function resolve(
  pool: Entity[],
  incoming: ContactContent,
  target: string | undefined,
  bookId: string,
): Resolution {
  if (target !== undefined) {
    const entity = pool.find((row) => row.original?.id === target);
    return entity ? scope(entity, bookId) : { reason: "target_not_found" };
  }
  const found = matches(pool, incoming);
  if (found.length > 1) return { reason: "ambiguous_match", candidates: found };
  if (found[0]) {
    const existing = found[0].content;
    const sameUid = incoming.uid !== undefined && incoming.uid === existing.uid;
    const emails = new Set(existing.emails.map(contactEmailKey));
    if (
      !sameUid &&
      incoming.emails.length &&
      existing.emails.length &&
      !incoming.emails.some((email) => emails.has(contactEmailKey(email)))
    )
      return { reason: "identity_confirmation_required", candidates: found };
    return scope(found[0], bookId);
  }
  const names = nameCandidates(pool, incoming);
  return names.length
    ? { reason: "identity_confirmation_required", candidates: names }
    : {};
}
function scope(entity: Entity, bookId: string): Resolution {
  if (!entity.books.includes(bookId))
    return { reason: "different_address_book", candidates: [entity] };
  if (entity.books.length !== 1)
    return { reason: "multiple_address_books", candidates: [entity] };
  return { entity };
}
const prepareEntry = (codec: ContactCodec, contact: ContactContent) =>
  codec.prepareImport?.(contact) ?? { contact, unsupported: [] };
function enrichmentBase(
  codec: ContactCodec,
  entity: Entity,
  incoming: ContactContent,
) {
  const previous = prepareEntry(codec, entity.content).contact;
  const nativeEmails = entity.original?.emails;
  return incoming.emailDetails && nativeEmails
    ? {
        ...previous,
        emailDetails: { ...nativeEmails, ...previous.emailDetails },
      }
    : previous;
}
function processEntry(
  codec: ContactCodec,
  plan: ContactImportPlan,
  pool: Entity[],
  entry: Parsed[number],
  index: number,
  bookId: string,
  target?: string,
  enrichExisting = true,
) {
  if (!entry.contact) {
    plan.skipped++;
    plan.preview.push(previewImportEntry(entry, index, "blocked"));
    return;
  }
  const resolution = resolve(pool, entry.contact, target, bookId);
  if (resolution.reason) {
    blockImportEntry(plan, entry, index, resolution);
    return;
  }
  let entity = resolution.entity;
  if (!entity) {
    entity = {
      key: `item${String(pool.filter((row) => !row.original).length)}`,
      content: entry.contact,
      books: [bookId],
      indices: [index],
    };
    pool.push(entity);
    plan.preview.push(previewImportEntry(entry, index, "create"));
    return;
  }
  if (entity.original && !enrichExisting) {
    plan.skipped++;
    plan.preview.push(
      previewImportEntry(entry, index, "unchanged", {
        existingId: entity.original.id,
        reason: "enrichment_not_requested",
      }),
    );
    return;
  }
  const prepared = prepareEntry(codec, entry.contact);
  if (prepared.unsupported.length) {
    blockImportEntry(
      plan,
      {
        ...entry,
        warnings: [
          ...entry.warnings,
          `Unsupported enrichment fields: ${prepared.unsupported.join(", ")}`,
        ],
      },
      index,
      { reason: "unsupported_fields", candidates: [entity] },
    );
    return;
  }
  const base = enrichmentBase(codec, entity, prepared.contact);
  const next = enrich(base, prepared.contact);
  const existingId = entity.original?.id;
  const changed = !isDeepStrictEqual(next, base);
  plan.preview.push(
    previewImportEntry(
      entry,
      index,
      changed ? "enrich" : "unchanged",
      existingId ? { existingId } : {},
    ),
  );
  if (!changed) {
    plan.skipped++;
    return;
  }
  entity.content = next;
  entity.indices.push(index);
}
export const importTargetsValid = (
  count: number,
  targets: Record<string, string> = {},
) =>
  Object.keys(targets).every(
    (key) => /^(?:0|[1-9]\d?)$/.test(key) && Number(key) < count,
  );

export function planContactImport(
  codec: ContactCodec,
  parsed: Parsed,
  stored: ContactRecord[],
  bookId: string,
  targets: Record<string, string> = {},
  enrichExisting = true,
): ContactImportPlan {
  if (!importTargetsValid(parsed.length, targets))
    throw new RangeError("Import target is outside the source batch");
  const plan = emptyImportPlan();
  const pool: Entity[] = stored.map((card) => ({
    key: card.id,
    original: card,
    content: codec.content(card),
    books: Object.keys(card.addressBookIds).filter(
      (id) => card.addressBookIds[id],
    ),
    indices: [],
  }));
  const checked = codec.preview(parsed, stored);
  parsed.forEach((entry, index) => {
    const reviewed = checked[index];
    if (!reviewed) {
      blockImportEntry(plan, entry, index, { reason: "preview_unavailable" });
      return;
    }
    processEntry(
      codec,
      plan,
      pool,
      reviewed,
      index,
      bookId,
      targets[String(index)],
      enrichExisting,
    );
  });
  const create = new Map<string, object>(),
    update = new Map<string, Record<string, unknown>>();
  for (const entity of pool) {
    if (!entity.indices.length) continue;
    if (entity.original) {
      update.set(
        entity.original.id,
        codec.patch(entity.original, entity.content),
      );
      plan.updatedEntries.set(entity.original.id, entity.indices);
    } else {
      create.set(entity.key, codec.create(entity.content, bookId));
      plan.createdEntries.set(entity.key, entity.indices);
    }
  }
  plan.create = Object.fromEntries(create);
  plan.update = Object.fromEntries(update);
  return plan;
}
