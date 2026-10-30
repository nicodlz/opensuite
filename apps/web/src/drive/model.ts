import type { DriveOutput } from "@opensuite/contracts";

export type DriveEntry = Extract<DriveOutput, { kind: string }>;
export const PART_SIZE = 5 * 1024 * 1024;
const previewTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
export function canPreview(entry: DriveEntry) {
  return (
    entry.kind === "file" &&
    entry.state === "ready" &&
    entry.contentType !== null &&
    previewTypes.has(entry.contentType)
  );
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
export function validName(value: string) {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !value
      .split("")
      .some((char) => char.charCodeAt(0) < 32 || char === "/" || char === "\\")
  );
}
export function sortEntries(entries: DriveEntry[]) {
  return entries.toSorted(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") ||
      a.name.localeCompare(b.name),
  );
}
export function contentType(file: File) {
  return /^[\w.+-]+\/[\w.+-]+$/.test(file.type)
    ? file.type
    : "application/octet-stream";
}
