import { DomainName, SetupEmail } from "@opensuite/contracts";
import { checkArchive, checkCalendarFiles, labelsError } from "./limits.ts";
import { labelMapping, type MappingRow } from "./model.ts";

export type Source = "gmail" | "imap" | "archive" | "calendar";
/** Everything the assistant collects before the import is confirmed. */
export type Draft = {
  source: Source | null;
  archive: File | null;
  variant: "mboxo" | "mboxrd";
  files: File[];
  host: string;
  port: string;
  username: string;
  password: string;
  mailboxId: string;
  mappings: MappingRow[];
  calendarId: string;
};
export const emptyDraft: Draft = {
  source: null,
  archive: null,
  variant: "mboxo",
  files: [],
  host: "",
  port: "993",
  username: "",
  password: "",
  mailboxId: "",
  mappings: [],
  calendarId: "",
};
export const sources: { id: Source; title: string; description: string }[] = [
  {
    id: "gmail",
    title: "Gmail account",
    description:
      "Connect with a Google app password. Mail and mapped labels are copied; your Gmail stays unchanged.",
  },
  {
    id: "imap",
    title: "Other mail server (IMAP)",
    description:
      "Connect to any IMAP server over TLS with your username and an app password.",
  },
  {
    id: "archive",
    title: "Mail archive",
    description:
      "Upload a Google Takeout .mbox file, another MBOX file or a single .eml message.",
  },
  {
    id: "calendar",
    title: "Calendar files",
    description:
      "Upload .ics files exported from Google Calendar, Outlook, Apple Calendar or another app.",
  },
];
/** Host names as the contracts define them; the server refuses IP literals. */
const validHost = (host: string) =>
  DomainName.safeParse(host).success && !/^[\d.]+$/.test(host.trim());
function detailsError(draft: Draft): string | null {
  switch (draft.source) {
    case null:
      return "Choose what to import.";
    case "archive": {
      if (!draft.archive) return "Choose an .mbox or .eml file.";
      const check = checkArchive(draft.archive.name, draft.archive.size);
      return check.ok ? null : check.reason;
    }
    case "calendar":
      return checkCalendarFiles(draft.files);
    case "imap": {
      const port = Number(draft.port);
      if (!validHost(draft.host))
        return "Enter the server’s full host name, such as imap.example.com.";
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return "Enter a port between 1 and 65535.";
      break;
    }
    case "gmail":
      if (!SetupEmail.safeParse(draft.username.trim()).success)
        return "Enter your full Gmail address.";
      break;
  }
  if (!draft.username.trim()) return "Enter your username.";
  if (!draft.password) return "Enter the app password.";
  return null;
}
/** The label mapping of the draft, or why it cannot be sent. */
export function draftLabels(
  draft: Draft,
): { labels: Record<string, string> } | { error: string } {
  const mapping = labelMapping(draft.mappings);
  if ("error" in mapping) return mapping;
  const error = labelsError(
    draft.source === "archive" ? "archive" : "direct",
    mapping.labels,
  );
  return error ? { error } : mapping;
}
/** Why the assistant cannot leave a step yet, or null when it can. */
export function stepError(step: number, draft: Draft): string | null {
  if (step === 0) return draft.source ? null : "Choose what to import.";
  if (step === 1) return detailsError(draft);
  if (draft.source === "calendar")
    return draft.calendarId ? null : "Choose a calendar.";
  if (!draft.mailboxId) return "Choose a destination mailbox.";
  const labels = draftLabels(draft);
  return "error" in labels ? labels.error : null;
}
