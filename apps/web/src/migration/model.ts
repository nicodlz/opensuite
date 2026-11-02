import type { CalendarImportJob, MailImportReport } from "@opensuite/contracts";

export type MigrationKind = "mail" | "direct" | "calendar";
export type Phase =
  | "preview"
  | "queued"
  | "running"
  | "cancelling"
  | "paused"
  | "attention"
  | "completed"
  | "cancelled";
export type Tally = {
  total: number;
  imported: number;
  skipped: number;
  uncertain: number;
  failed: number;
  remaining: number;
};
export type Tone = "ok" | "warning" | "error" | "progress";
export type ReportRow = {
  key: string;
  item: string;
  status: string;
  tone: Tone;
  detail: string;
};
/** Report fields shared by archive and direct mail imports. */
type MailReport = Pick<
  MailImportReport,
  "status" | "cancelRequested" | "total" | "messages"
> & { abandonment: { uncertainCount: number } | null };

export const phaseLabels: Record<Phase, string> = {
  preview: "Awaiting confirmation",
  queued: "Queued",
  running: "Importing",
  cancelling: "Cancelling",
  paused: "Paused",
  attention: "Needs attention",
  completed: "Completed",
  cancelled: "Cancelled",
};
export const phaseTones: Record<Phase, Tone> = {
  preview: "progress",
  queued: "progress",
  running: "progress",
  cancelling: "warning",
  paused: "warning",
  attention: "error",
  completed: "ok",
  cancelled: "warning",
};
/** Phases in which the server still changes the job on its own. */
export const activePhase = (phase: Phase) =>
  phase === "queued" || phase === "running" || phase === "cancelling";

export function mailPhase(
  report: Pick<MailReport, "status" | "cancelRequested">,
): Phase {
  if (report.cancelRequested && ["queued", "running"].includes(report.status))
    return "cancelling";
  return report.status;
}
export function mailTally(report: MailReport): Tally {
  const active = activePhase(mailPhase(report));
  const count = (status: string) =>
    report.messages.filter((message) => message.status === status).length;
  const importing = count("importing");
  return {
    total: report.total,
    imported: count("imported"),
    skipped: count("duplicate"),
    uncertain: count("uncertain") + (active ? 0 : importing),
    failed: count("failed"),
    remaining:
      Math.max(report.total - report.messages.length, 0) +
      count("pending") +
      (active ? importing : 0),
  };
}
const mailStatus: Record<string, [string, Tone]> = {
  pending: ["Waiting", "progress"],
  importing: ["Importing", "progress"],
  imported: ["Imported", "ok"],
  duplicate: ["Skipped: already in your mailbox", "ok"],
  failed: ["Failed", "error"],
  uncertain: ["Uncertain", "error"],
};
export function mailRows(report: MailReport): ReportRow[] {
  const active = activePhase(mailPhase(report));
  return report.messages.map((message) => {
    const status =
      message.status === "importing" && !active ? "uncertain" : message.status;
    const [label, tone] = mailStatus[status] ?? ["Unknown", "error"];
    return {
      key: String(message.index),
      item: `Message ${String(message.index + 1)}`,
      status: label,
      tone,
      detail: message.error ?? "",
    };
  });
}

/** Server wording for an event that may have been written before abandonment. */
const inFlight = "may have completed";
export function calendarPhase(job: CalendarImportJob): Phase {
  const tally = calendarTally(job);
  if (job.abandoned) return tally.uncertain > 0 ? "attention" : "cancelled";
  if (!job.confirmed) return "preview";
  if (tally.remaining > 0) return "paused";
  return tally.failed > 0 ? "attention" : "completed";
}
export function calendarTally(job: CalendarImportJob): Tally {
  const items = job.items;
  const count = (test: (item: (typeof items)[number]) => boolean) =>
    items.filter(test).length;
  return {
    total: job.progress.total,
    imported: job.progress.imported,
    skipped: job.progress.duplicate,
    failed: job.progress.failed,
    uncertain: count(
      (item) =>
        item.state === "abandoned" && (item.error ?? "").includes(inFlight),
    ),
    remaining: count(
      (item) => item.state === "pending" || item.state === "processing",
    ),
  };
}
const calendarStatus: Record<string, [string, Tone]> = {
  pending: ["Waiting", "progress"],
  processing: ["Importing", "progress"],
  imported: ["Imported", "ok"],
  duplicate: ["Skipped: already in the calendar", "ok"],
  failed: ["Failed", "error"],
  abandoned: ["Not imported", "warning"],
};
const previewStatus: Record<string, [string, Tone]> = {
  new: ["New event", "ok"],
  update: ["Updates an earlier import", "ok"],
  duplicate: ["Already in the calendar", "ok"],
  conflict: ["Conflict: will not be imported", "error"],
  invalid: ["Invalid: will not be imported", "error"],
};
export function calendarRows(job: CalendarImportJob): ReportRow[] {
  return job.items.map((item) => {
    const uncertain =
      item.state === "abandoned" && (item.error ?? "").includes(inFlight);
    const [label, tone]: [string, Tone] =
      !job.confirmed && !job.abandoned
        ? (previewStatus[item.preview] ?? ["Unknown", "error"])
        : uncertain
          ? ["Uncertain", "error"]
          : (calendarStatus[item.state] ?? ["Unknown", "error"]);
    return {
      key: String(item.index),
      item: `${item.title || "Untitled event"} (${item.file})`,
      status: label,
      tone,
      detail: [item.error, item.previewReason, ...item.issues]
        .filter((part): part is string => Boolean(part))
        .join(" "),
    };
  });
}

/**
 * What the server holds of a direct migration's source password. App
 * passwords are dropped as soon as a cancellation is requested; an access
 * token supplied through the API is revoked separately and the job's own
 * message says when that failed.
 */
export function credentialState(
  report: Pick<MailReport, "status" | "cancelRequested" | "abandonment">,
): string {
  if (report.status === "completed" || report.status === "cancelled")
    return "Deleted. The stored password was removed when the migration ended.";
  if (report.abandonment)
    return "Deleted. Only the uncertain messages remain to be checked.";
  if (report.cancelRequested && report.status === "attention")
    return "An app password was deleted when you cancelled. If a message above reports a failed revocation, follow it.";
  if (report.cancelRequested) return "Being deleted while the migration stops.";
  if (report.status === "attention")
    return "Stored encrypted until 24 hours after you entered it. If it has expired or the source refused it, resume with a new app password.";
  return "Stored encrypted for this migration only. It is deleted when the migration ends and expires 24 hours after you entered it.";
}

const plural = (count: number, unit: string) =>
  `${String(count)} ${unit}${count === 1 ? "" : "s"}`;
/**
 * One honest sentence about the outcome. A job that is not complete is never
 * described as successful, whatever share of it succeeded.
 */
export function outcomeSentence(
  phase: Phase,
  tally: Tally,
  unit: "message" | "event",
): string {
  const processed = tally.total - tally.remaining;
  const all = plural(tally.total, unit);
  const imported = String(tally.imported);
  const skipped = tally.skipped
    ? `, ${String(tally.skipped)} skipped as already present`
    : "";
  const sentences: Record<Phase, string> = {
    preview: `Nothing is imported yet. Review the ${all} below and start the import.`,
    queued: `${String(processed)} of ${all} processed so far.`,
    running: `${String(processed)} of ${all} processed so far.`,
    cancelling: `Stopping. ${imported} imported so far; nothing else will be imported.`,
    paused: `Paused after ${String(processed)} of ${all}. Continue to import the rest.`,
    attention: `Not finished: ${imported} of ${all} imported${skipped}. ${String(tally.failed)} failed and ${String(tally.uncertain)} uncertain need your attention.`,
    completed: `All ${all} processed: ${imported} imported${skipped}.`,
    cancelled: `Cancelled: ${imported} of ${all} imported before cancellation. The rest were not imported.`,
  };
  return sentences[phase];
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

export type MappingRow = { id: string; label: string; mailboxId: string };
/**
 * Turns the label rows of the form into the import's mapping; name lengths
 * are checked against the contract separately.
 */
export function labelMapping(
  rows: readonly MappingRow[],
): { labels: Record<string, string> } | { error: string } {
  const labels: Record<string, string> = {};
  for (const row of rows) {
    const label = row.label.trim();
    if (!label && !row.mailboxId) continue;
    if (!label || !row.mailboxId)
      return { error: "Give each mapped label both a name and a mailbox." };
    if (Object.hasOwn(labels, label))
      return { error: `“${label}” is mapped more than once.` };
    labels[label] = row.mailboxId;
  }
  if (Object.keys(labels).length > 100)
    return { error: "Map at most 100 labels." };
  return { labels };
}

/** Spreadsheet applications run cells that start like a formula. */
const csvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};
export function reportCsv(
  heading: readonly [string, string][],
  rows: readonly ReportRow[],
) {
  return [
    ...heading.map((pair) => pair.map(csvCell).join(",")),
    "",
    ["Item", "Status", "Details"].map(csvCell).join(","),
    ...rows.map((row) =>
      [row.item, row.status, row.detail].map(csvCell).join(","),
    ),
  ].join("\r\n");
}

/** FNV-1a, so that the browser storage key does not reveal the address. */
function fingerprint(text: string) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
/** The first-use offer is remembered per account in this browser. */
export const offerKey = (email: string) =>
  `esuno-migration-offer:${fingerprint(email.trim().toLowerCase())}`;
/** Offered only to an account that has no migration at all. */
export const shouldOffer = (jobCounts: readonly (number | undefined)[]) =>
  jobCounts.every((count) => count === 0);
