import {
  DirectMigrationInputSchema,
  MAIL_ARCHIVE_LIMIT,
  MAIL_MESSAGE_LIMIT,
  MailImportInputSchema,
  calendarImportLimits,
} from "@opensuite/contracts";
import { formatBytes } from "../drive/model.ts";

/** Sizes are shown with the same binary units as the rest of the app. */
export const formatSize = formatBytes;
/**
 * The API accepts request bodies of at most 1,000,000 bytes. A calendar
 * preview sends every file in one request, so this binds before the
 * per-file limit; the selection must leave room for its JSON encoding.
 */
const requestLimit = 1_000_000;
const calendarSelectionLimit = 900_000;

const { files, bytes, events, jobs } = calendarImportLimits;
export const archiveHint = `Google Takeout: export Mail, download and extract the archive, then choose the .mbox file inside the Mail folder. Up to ${formatSize(MAIL_ARCHIVE_LIMIT)} per import.`;
export const calendarHint = `Choose up to ${String(files)} .ics files of at most ${formatSize(bytes)} each and ${formatSize(calendarSelectionLimit)} together.`;
export const calendarLimits = [
  `Up to ${String(files)} files of at most ${formatSize(bytes)} each and ${formatSize(calendarSelectionLimit)} together, with at most ${String(events)} events per import.`,
  `At most ${String(jobs)} calendar imports are kept, including previews and finished reports; remove finished ones under Migration to start more.`,
];
/** Limits of a direct connection, as enforced by the server. */
export const directLimits = [
  `At most 100 folders and 1,000 messages per migration; each message may be up to ${formatSize(MAIL_MESSAGE_LIMIT)}.`,
  "Only the labels or folders you map are applied; other labels and unsupported flags are not kept.",
  "Messages without a reliable Message-ID cannot be checked for duplicates; uncertain results need your review.",
  "Your administrator must allow the source server; a server that is not allowed fails when the migration connects. The source is opened read-only and nothing is deleted there.",
  "The password is stored encrypted for this migration only and expires after 24 hours.",
];

const extension = (name: string) =>
  /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
export type ArchiveCheck =
  { ok: true; format: "eml" | "mbox" } | { ok: false; reason: string };
/** Checks a mail archive against the import limits before it is uploaded. */
export function checkArchive(name: string, size: number): ArchiveCheck {
  const type = extension(name);
  if (["zip", "tgz", "gz", "tar"].includes(type))
    return {
      ok: false,
      reason:
        "Compressed archives aren’t supported. Extract the .mbox file from your Google Takeout download and choose it.",
    };
  if (type !== "eml" && type !== "mbox")
    return { ok: false, reason: "Choose an .mbox or .eml file." };
  if (size === 0) return { ok: false, reason: "This file is empty." };
  if (size > MAIL_ARCHIVE_LIMIT)
    return {
      ok: false,
      reason: `This file is ${formatSize(size)}; one import accepts at most ${formatSize(MAIL_ARCHIVE_LIMIT)}. Split the archive into smaller files.`,
    };
  return { ok: true, format: type };
}
/** Checks calendar files against the import and request limits. */
export function checkCalendarFiles(
  chosen: readonly { name: string; size: number }[],
): string | null {
  if (!chosen.length) return "Choose at least one .ics file.";
  if (chosen.length > files)
    return `Choose at most ${String(files)} files per import.`;
  for (const file of chosen) {
    if (extension(file.name) !== "ics")
      return `${file.name} isn’t an .ics calendar file.`;
    if (file.size === 0) return `${file.name} is empty.`;
    if (file.size > bytes)
      return `${file.name} is ${formatSize(file.size)}; each file may be at most ${formatSize(bytes)}.`;
  }
  const total = chosen.reduce((sum, file) => sum + file.size, 0);
  if (total > calendarSelectionLimit)
    return `These files are ${formatSize(total)} together; one import accepts at most ${formatSize(calendarSelectionLimit)}. Import them in smaller batches.`;
  return null;
}
/** Whether the API would refuse this request body as too large. */
export const tooLargeForRequest = (input: unknown) =>
  new TextEncoder().encode(JSON.stringify(input)).length > requestLimit;
/** Label names checked against the import contract they are sent with. */
export function labelsError(
  source: "archive" | "direct",
  labels: Record<string, string>,
): string | null {
  const schema =
    source === "archive"
      ? MailImportInputSchema.shape.labels
      : DirectMigrationInputSchema.shape.labels;
  return schema.safeParse(labels).success
    ? null
    : "A label name is too long. Shorten it or leave it out.";
}
