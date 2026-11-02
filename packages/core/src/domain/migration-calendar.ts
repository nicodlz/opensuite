import { z } from "zod";
import type { CalendarImportItem } from "@opensuite/contracts";

export type ImportEvent = Record<string, unknown> & {
  id: string;
  calendarIds: Record<string, boolean>;
  recurrenceOverrides?: Record<string, unknown> | null | undefined;
};

export const stable = (v: unknown): string => {
  if (Array.isArray(v)) return JSON.stringify(v.map(stable));
  if (v && typeof v === "object")
    return JSON.stringify(
      Object.entries(v)
        .filter(([key]) => key !== "iCalendar")
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stable(x)]),
    );
  return JSON.stringify(v);
};
export const equivalent = (
  wanted: Record<string, unknown>,
  actual: Record<string, unknown>,
  includeOverrides = true,
) => {
  const keys = [
    "uid",
    "title",
    "description",
    "start",
    "duration",
    "timeZone",
    "showWithoutTime",
    "recurrenceRules",
    "excludedRecurrenceRules",
    "recurrenceRule",
    "recurrenceOverrides",
    "participants",
    "organizerCalendarAddress",
    "alerts",
    "locations",
    "links",
  ];
  return keys.every(
    (key) =>
      (!includeOverrides && key === "recurrenceOverrides") ||
      wanted[key] === null ||
      wanted[key] === undefined ||
      stable(wanted[key]) === stable(actual[key]),
  );
};

export type ImportPreviewState = CalendarImportItem["preview"];
type ImportPlan =
  | { previewState: "conflict"; previewReason: string }
  | { previewState: "new" | "duplicate"; previewReason: null }
  | {
      previewState: "update";
      previewReason: null;
      additions: Record<string, unknown>;
    };
type ImportIdentity = { source: string; eventId: string | null };
const previewConflict = (previewReason: string) => ({
  previewState: "conflict" as const,
  previewReason,
});
export function planCalendarEvent(
  desired: Record<string, unknown>,
  matches: ImportEvent[],
  identity: ImportIdentity | undefined,
  calendarId: string,
  source: string,
): ImportPlan {
  if (!matches.length) {
    if (identity && identity.source !== source)
      return previewConflict("UID belongs to a different source");
    return { previewState: "new", previewReason: null };
  }
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || !match.calendarIds[calendarId])
    return previewConflict("UID exists in another calendar or is ambiguous");
  if (
    !identity ||
    identity.source !== source ||
    (identity.eventId !== null && identity.eventId !== match.id)
  )
    return previewConflict("UID belongs to a different or uncertain source");
  if (!identity.eventId)
    return equivalent(desired, match)
      ? { previewState: "duplicate", previewReason: null }
      : previewConflict("UID belongs to a different or uncertain source");
  if (!equivalent(desired, match, false))
    return previewConflict("Existing series differs from the source");
  return previewOverrides(desired, match);
}

function previewOverrides(
  desired: Record<string, unknown>,
  match: ImportEvent,
): ImportPlan {
  const incoming = z
    .record(z.string(), z.unknown())
    .safeParse(desired["recurrenceOverrides"] ?? {});
  const current = z
    .record(z.string(), z.unknown())
    .safeParse(match.recurrenceOverrides ?? {});
  if (!incoming.success || !current.success)
    return previewConflict("Invalid recurrence overrides");
  const changed = Object.keys(incoming.data).find(
    (key) =>
      key in current.data &&
      stable(incoming.data[key]) !== stable(current.data[key]),
  );
  if (changed)
    return previewConflict(
      `Occurrence conflicts with existing event: ${changed}`,
    );
  const additions = Object.fromEntries(
    Object.entries(incoming.data).filter(([key]) => !(key in current.data)),
  );
  return Object.keys(additions).length
    ? { previewState: "update", previewReason: null, additions }
    : { previewState: "duplicate", previewReason: null };
}
export function previewCalendarEvent(
  desired: Record<string, unknown>,
  matches: ImportEvent[],
  identity: ImportIdentity | undefined,
  calendarId: string,
  source: string,
): { previewState: ImportPreviewState; previewReason: string | null } {
  const { previewState, previewReason } = planCalendarEvent(
    desired,
    matches,
    identity,
    calendarId,
    source,
  );
  return { previewState, previewReason };
}
