import type {
  ContactCodec,
  ContactContent,
  ContactRecord,
} from "@opensuite/contracts";
import { z } from "zod";
export type ContactImportPlan = {
  create: Record<string, object>;
  update: Record<string, Record<string, unknown>>;
  createdEntries: Map<string, number[]>;
  updatedEntries: Map<string, number[]>;
  skipped: number;
  failed: { index: number; reason: string }[];
  preview: ReturnType<ContactCodec["preview"]>;
};

type ImportWriteResult = {
  created?: Record<string, { id: string }> | null | undefined;
  updated?: Record<string, unknown> | null | undefined;
  notCreated?: Record<string, { type: string }> | null | undefined;
  notUpdated?: Record<string, { type: string }> | null | undefined;
};
export const emptyImportPlan = (): ContactImportPlan => ({
  create: {},
  update: {},
  createdEntries: new Map(),
  updatedEntries: new Map(),
  skipped: 0,
  failed: [],
  preview: [],
});
export const exportContactCards = (
  codec: ContactCodec,
  cards: ContactRecord[],
) => ({
  vcard: codec.serialize(cards.map((card) => codec.content(card))),
  warnings: cards.flatMap((card) => codec.warnings(card)),
});
export function importSummary(
  plan: ContactImportPlan,
  result: ImportWriteResult,
) {
  const failed = [...plan.failed];
  let imported = 0,
    updated = 0,
    merged = 0;
  const count = (groups: Map<string, number[]>, kind: "create" | "update") => {
    for (const [key, indices] of groups) {
      const success =
        kind === "create"
          ? Boolean(result.created?.[key]?.id)
          : Object.hasOwn(result.updated ?? {}, key);
      if (success) {
        if (kind === "create") imported++;
        else updated++;
        merged += Math.max(0, indices.length - 1);
      } else {
        const reason =
          (kind === "create"
            ? result.notCreated?.[key]
            : result.notUpdated?.[key]
          )?.type ?? "unknown";
        for (const index of indices) failed.push({ index, reason });
      }
    }
  };
  count(plan.createdEntries, "create");
  count(plan.updatedEntries, "update");
  return {
    imported,
    skipped: plan.skipped,
    ...(updated ? { updated } : {}),
    ...(merged ? { merged } : {}),
    ...(failed.length ? { failed } : {}),
  };
}

export function previewImportEntry(
  entry: Extract<
    ReturnType<ContactCodec["parse"]>,
    { ok: true }
  >["cards"][number],
  index: number,
  action: NonNullable<ReturnType<ContactCodec["preview"]>[number]["action"]>,
  extra: Partial<ReturnType<ContactCodec["preview"]>[number]> = {},
): ReturnType<ContactCodec["preview"]>[number] {
  return {
    ...entry,
    index,
    duplicate: action === "enrich" || action === "unchanged",
    action,
    ...extra,
  };
}

export function blockImportEntry(
  plan: ContactImportPlan,
  entry: Parameters<typeof previewImportEntry>[0],
  index: number,
  resolution: {
    reason?: string;
    candidates?: { original?: { id: string } }[];
  },
) {
  const reason = resolution.reason ?? "ambiguous_match";
  const candidateIds = resolution.candidates
    ?.flatMap((entity) => (entity.original ? [entity.original.id] : []))
    .slice(0, 100);
  plan.failed.push({ index, reason });
  plan.preview.push(
    previewImportEntry(entry, index, "blocked", {
      reason,
      ...(candidateIds?.length ? { candidateIds } : {}),
    }),
  );
}

export function importMutation(plan: ContactImportPlan, state: string) {
  const create = Object.keys(plan.create).length ? plan.create : undefined;
  const update = Object.keys(plan.update).length ? plan.update : undefined;
  return create || update
    ? {
        ifInState: state,
        ...(create ? { create } : {}),
        ...(update ? { update } : {}),
      }
    : null;
}

const object = (value: unknown) =>
  z.record(z.string(), z.unknown()).catch({}).parse(value);
const escapePath = (value: string) =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
// These parameters already live in canonical fields. Reattaching them to a
// matching entry would turn native metadata normalization into a repeated write.
const canonicalParameters = new Set([
  "type",
  "label",
  "pref",
  "cc",
  "jscomps",
  "group",
]);
export function copyImportParameters(
  target: Record<string, unknown>,
  incoming: ContactContent,
  field: string,
  from: string,
  to: string,
  existing = false,
) {
  const nativeField = field === "emailDetails" ? "emails" : field;
  const prefix = `/${nativeField}/${escapePath(from)}`;
  for (const [path, source] of Object.entries(
    incoming.vCard?.convertedProperties ?? {},
  )) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) continue;
    const destination = `/${nativeField}/${escapePath(to)}${normalized.slice(prefix.length)}`;
    const key = Object.hasOwn(target, destination.slice(1))
      ? destination.slice(1)
      : destination;
    const additional = Object.fromEntries(
      Object.entries(source.parameters ?? {}).filter(
        ([name]) => !existing || !canonicalParameters.has(name.toLowerCase()),
      ),
    );
    if (existing && !Object.keys(additional).length) continue;
    const previous = object(target[key]);
    Object.defineProperty(target, key, {
      value: {
        ...(existing ? {} : source),
        ...previous,
        parameters: { ...additional, ...object(previous["parameters"]) },
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}
