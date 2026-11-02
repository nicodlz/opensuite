import { parseLocal } from "./time.ts";

/** Cancelled series have no visible calendar occurrence. */
export function visibleStart(start: string, zone: string, status: unknown) {
  return status === "cancelled" ? undefined : parseLocal(start, zone);
}

/** Stalwart may return a single recurrence rule in addition to the rules array. */
export function normalizeInvitationRules<T>(
  rules: T[] | null,
  rule: T | null | undefined,
) {
  return rules ?? (rule ? [rule] : []);
}
