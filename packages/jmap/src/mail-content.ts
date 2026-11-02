import type { Email } from "./schemas.ts";
import { mailFilterFor } from "./mail-filter.ts";

export const mailAddresses = (items: Email["from"]) =>
  (items ?? []).map(({ name, email }) => (name ? { email, name } : { email }));
export const mailboxMemberships = (email: Email) =>
  Object.keys(email.mailboxIds).filter((id) => email.mailboxIds[id]);
export const mailAttachments = (email: Email) =>
  email.attachments.flatMap((part) =>
    part.blobId === null
      ? []
      : [
          {
            id: part.partId ?? part.blobId,
            blobId: part.blobId,
            ...(part.cid ? { cid: part.cid } : {}),
            name: part.name ?? "attachment",
            type: part.type,
            size: part.size,
          },
        ],
  );

export const mailBody = (
  email: Email,
  parts: Email["textBody"],
  type: string,
) =>
  parts
    .filter((part) => part.type.toLowerCase() === type)
    .map((part) =>
      part.partId === null ? "" : (email.bodyValues[part.partId]?.value ?? ""),
    )
    .join("\n");

function mailDraft(email: Email) {
  return {
    id: email.id,
    ...(email.from?.[0]?.email ? { from: email.from[0].email } : {}),
    to: mailAddresses(email.to),
    cc: mailAddresses(email.cc),
    bcc: mailAddresses(email.bcc),
    subject: email.subject ?? "",
    htmlBody: mailBody(email, email.htmlBody, "text/html"),
    textBody: mailBody(email, email.textBody, "text/plain"),
    attachmentBlobIds: mailAttachments(email).map((part) => part.blobId),
    ...(email.inReplyTo?.[0] ? { inReplyTo: email.inReplyTo[0] } : {}),
    references: email.references ?? [],
    threadId: email.threadId,
  };
}

function mailMessage(
  email: Email,
  boxes: { id: string; role: string }[],
  fallback: string,
) {
  const from = mailAddresses(email.from)[0] ?? { email: fallback };
  const mailboxIds = mailboxMemberships(email);
  const custom = new Set(
    boxes.filter((box) => box.role === "custom").map((box) => box.id),
  );
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds,
    from,
    replyTo: mailAddresses(email.replyTo),
    to: mailAddresses(email.to),
    cc: mailAddresses(email.cc),
    bcc: mailAddresses(email.bcc),
    subject: email.subject ?? "",
    sentAt: new Date(email.sentAt ?? email.receivedAt).toISOString(),
    ...(email.messageId?.[0] ? { messageId: email.messageId[0] } : {}),
    ...(email.inReplyTo?.[0] ? { inReplyTo: email.inReplyTo[0] } : {}),
    references: email.references ?? [],
    headers: email.headers,
    htmlBody: mailBody(email, email.htmlBody, "text/html"),
    textBody: mailBody(email, email.textBody, "text/plain"),
    attachments: mailAttachments(email),
    unread: !email.keywords["$seen"],
    starred: Boolean(email.keywords["$flagged"]),
    labels: mailboxIds.filter((id) => custom.has(id)),
  };
}

function mailSummary(
  emails: Email[],
  boxes: { id: string; role: string }[],
  fallback: string,
) {
  const ordered = emails.toSorted((a, b) =>
    a.receivedAt.localeCompare(b.receivedAt),
  );
  const last = ordered.at(-1);
  if (!last) return undefined;
  const mapped = ordered.map((email) => mailMessage(email, boxes, fallback));
  const participants = new Map<
    string,
    ReturnType<typeof mailMessage>["from"]
  >();
  for (const item of mapped)
    for (const person of [item.from, ...item.to, ...item.cc])
      participants.set(person.email.toLowerCase(), person);
  return {
    id: last.threadId,
    subject: last.subject ?? "",
    participants: [...participants.values()],
    preview: last.preview,
    updatedAt: new Date(last.receivedAt).toISOString(),
    messageCount: emails.length,
    unread: mapped.some((item) => item.unread),
    starred: mapped.some((item) => item.starred),
    hasAttachment: emails.some(
      (item) => item.hasAttachment || item.attachments.length > 0,
    ),
    mailboxIds: [...new Set(mapped.flatMap((item) => item.mailboxIds))],
    labels: [...new Set(mapped.flatMap((item) => item.labels))],
  };
}

export const mailMapping = {
  mailAddresses,
  mailAttachments,
  mailBody,
  mailDraft,
  mailFilterFor,
  mailMessage,
  mailSummary,
  mailboxMemberships,
};
