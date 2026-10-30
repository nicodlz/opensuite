import DOMPurify from "dompurify";
import type {
  DraftContent,
  Message,
  ThreadSummary,
} from "@opensuite/contracts";
/** List date: time today, day and month this year, full date otherwise. */
export function formatDate(value: string, now = new Date()) {
  const date = new Date(value);
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : date.getFullYear() === now.getFullYear()
        ? { month: "short", day: "numeric" }
        : { year: "numeric", month: "short", day: "numeric" },
  ).format(date);
}
export function formatFullDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
const emailPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** Split a comma or semicolon separated recipient field. */
export function parseAddresses(value: string) {
  const parts = value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => /<([^>]+)>\s*$/.exec(part)?.[1]?.trim() ?? part);
  return {
    addresses: parts
      .filter((email) => emailPattern.test(email))
      .map((email) => ({ email })),
    invalid: parts.filter((email) => !emailPattern.test(email)),
  };
}
export function initials(value: string) {
  return (
    value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "?"
  );
}
export function emptyDraft(): DraftContent {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    htmlBody: "",
    textBody: "",
    attachmentBlobIds: [],
    references: [],
  };
}
export function replyDraft(
  message: Message,
  mode: "reply" | "all" | "forward",
  ownEmail = "",
): DraftContent {
  const recipients = message.replyTo?.length ? message.replyTo : [message.from];
  const prefix = mode === "forward" ? "Fwd: " : "Re: ";
  return {
    ...emptyDraft(),
    to: mode === "forward" ? [] : recipients,
    cc:
      mode === "all"
        ? [...message.to, ...message.cc].filter(
            (address) =>
              address.email.toLowerCase() !== ownEmail.toLowerCase() &&
              !recipients.some(
                (recipient) =>
                  recipient.email.toLowerCase() === address.email.toLowerCase(),
              ),
          )
        : [],
    subject: message.subject.startsWith(prefix)
      ? message.subject
      : prefix + message.subject,
    ...(mode === "forward"
      ? {
          textBody: `\n\n---------- Forwarded message ----------\nFrom: ${message.from.email}\nSubject: ${message.subject}\n\n${message.textBody || htmlToText(message.htmlBody)}`,
          attachmentBlobIds: message.attachments.map(
            (attachment) => attachment.blobId,
          ),
        }
      : {
          threadId: message.threadId,
          ...(message.messageId ? { inReplyTo: message.messageId } : {}),
          references: [
            ...message.references,
            ...(message.messageId ? [message.messageId] : []),
          ],
        }),
  };
}
export type SelectionAction =
  | { type: "next" | "previous"; threads: ThreadSummary[] }
  | { type: "select"; id: string | null };
export function selectionReducer(
  selected: string | null,
  action: SelectionAction,
): string | null {
  if (action.type === "select") return action.id;
  if (!action.threads.length) return null;
  const index = action.threads.findIndex((thread) => thread.id === selected);
  const next =
    action.type === "next"
      ? Math.min(index + 1, action.threads.length - 1)
      : Math.max(index < 0 ? 0 : index - 1, 0);
  return action.threads[next]?.id ?? null;
}

function htmlToText(html: string) {
  const doc = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    FORBID_TAGS: ["script", "style", "template", "img", "iframe"],
  });
  if (!(doc instanceof Element)) return "";
  for (const element of doc.querySelectorAll("script, style, template"))
    element.remove();
  for (const element of doc.querySelectorAll("br")) element.replaceWith("\n");
  for (const element of doc.querySelectorAll(
    "p, div, li, tr, h1, h2, h3, h4, h5, h6",
  ))
    element.append("\n");
  return doc.textContent.trim();
}
