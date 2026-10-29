import type {
  DraftContent,
  Message,
  ThreadSummary,
} from "@opensuite/contracts";
export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
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
  const prefix = mode === "forward" ? "Fwd: " : "Re: ";
  return {
    ...emptyDraft(),
    to: mode === "forward" ? [] : [message.from],
    cc:
      mode === "all"
        ? [...message.to, ...message.cc].filter(
            (address) =>
              address.email.toLowerCase() !== ownEmail.toLowerCase() &&
              address.email.toLowerCase() !== message.from.email.toLowerCase(),
          )
        : [],
    subject: message.subject.startsWith(prefix)
      ? message.subject
      : prefix + message.subject,
    ...(mode === "forward"
      ? {
          textBody: `\n\n---------- Forwarded message ----------\nFrom: ${message.from.email}\nSubject: ${message.subject}\n\n${message.textBody}`,
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
