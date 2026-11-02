import type { AccessFailureKind } from "@opensuite/core/services/jmap-access";
import { ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";

// Public error codes for failures of services built on per-user JMAP access.
const failureCodes = {
  forbidden: ["FORBIDDEN", 403],
  not_found: ["NOT_FOUND", 404],
  validation: ["VALIDATION", 400],
  conflict: ["CONFLICT", 409],
  unavailable: ["UPSTREAM_UNAVAILABLE", 503],
  rate_limited: ["TOO_MANY_REQUESTS", 429],
} as const satisfies Record<AccessFailureKind, readonly [string, number]>;

export async function accessResult<T>(
  promise: Promise<Result<T, { kind: AccessFailureKind }>>,
): Promise<T> {
  const outcome = await promise;
  if (outcome.isOk()) return outcome.value;
  const [code, status] = failureCodes[outcome.error.kind];
  throw new ORPCError(code, { status, defined: true });
}
