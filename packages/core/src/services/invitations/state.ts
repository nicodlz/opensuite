import type { Result } from "neverthrow";
import type {
  InvitationProtocolFailure,
  Participation,
} from "../../domain/invitations/types.ts";
import { fail } from "../jmap-access.ts";
import { createHash } from "node:crypto";

export type { InvitationAction } from "@opensuite/contracts";
import type { InvitationAction } from "@opensuite/contracts";
export const participation = (
  action: InvitationAction["action"],
): Participation | undefined => {
  if (action === "accept") return "ACCEPTED";
  if (action === "tentative") return "TENTATIVE";
  if (action === "decline") return "DECLINED";
  return undefined;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export const status = (operation: {
  id: string;
  phase: string;
  series: { eventId: string | null };
}) => ({
  operationId: operation.id,
  state:
    operation.phase === "sent"
      ? ("sent" as const)
      : operation.phase === "applied"
        ? ("applied" as const)
        : operation.phase === "rejected"
          ? ("failed" as const)
          : ("pending" as const),
  eventId: operation.series.eventId,
});

export function protocolValue<T>(
  result: Result<T, InvitationProtocolFailure>,
): T {
  return result.isOk() ? result.value : fail(result.error.kind);
}
