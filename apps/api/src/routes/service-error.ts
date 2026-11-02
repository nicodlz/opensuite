import { ORPCError } from "@orpc/server";

const codes: Record<string, string> = {
  invalid: "BAD_REQUEST",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
};

export function throwServiceError(
  error: { kind: string; message?: string },
  overrides: Readonly<Record<string, string>> = {},
): never {
  const code =
    overrides[error.kind] ?? codes[error.kind] ?? "SERVICE_UNAVAILABLE";
  throw new ORPCError(code, {
    defined: true,
    ...(error.message ? { message: error.message } : {}),
  });
}
