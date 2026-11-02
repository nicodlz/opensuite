import { ORPCError } from "@orpc/client";
import { accountId, portableClient } from "./client.ts";
export function save(bytes: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function errorMessage(status: number, format: "eml" | "mbox" | "ics") {
  if (status === 400)
    return format === "ics"
      ? "The calendar exceeds an export limit. Use a CalDAV client to export it in smaller parts."
      : "The export exceeds a limit or contains invalid data. Try a smaller selection.";
  if (status === 409)
    return "The calendar changed during export. Please try again.";
  if (status === 403) return "Access to this account was denied.";
  if (status === 429)
    return "Too many export requests or another export is running. Please try again shortly.";
  return "Export failed. Please try again.";
}
export async function downloadPortable(
  format: "eml" | "mbox" | "ics",
  ids: string[],
) {
  let result;
  try {
    result = await portableClient.export(
      format === "ics" ? { format, accountId } : { format, accountId, ids },
    );
  } catch (error) {
    return errorMessage(error instanceof ORPCError ? error.status : 0, format);
  }
  if (result.exported > 0 || (format === "ics" && !result.failures.length)) {
    const bytes = Uint8Array.from(atob(result.content), (character) =>
      character.charCodeAt(0),
    );
    save(bytes, result.contentType, result.filename);
  }
  return [
    `Exported ${String(result.exported)} item(s).`,
    ...result.warnings,
    ...result.failures.map((failure) => `${failure.id}: ${failure.reason}`),
  ].join(" ");
}

export const toggleId = (previous: string[], id: string) =>
  previous.includes(id)
    ? previous.filter((item) => item !== id)
    : [...previous, id];
