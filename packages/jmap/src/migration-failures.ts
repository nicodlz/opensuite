import type { JmapError } from "./protocol.ts";

export function migrationResponseStatus(error: JmapError) {
  return error.kind === "http" || error.kind === "request"
    ? error.status
    : undefined;
}

/** Uploading a blob cannot deliver mail, so its rejected requests are safe to retry. */
export function migrationUploadFailure(error: JmapError, quotaMessage: string) {
  const status = migrationResponseStatus(error);
  if (
    status === 507 ||
    (error.kind === "request" && error.type === "overQuota")
  )
    return { kind: "failed" as const, error: quotaMessage, proceed: false };
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 423, 425, 429].includes(status)
  )
    return {
      kind: "failed" as const,
      error:
        status === 413
          ? "Message exceeds the server upload limit"
          : "Message upload rejected by the server",
      proceed: status !== 401 && status !== 403,
    };
  return { kind: "retry" as const, proceed: false as const };
}
