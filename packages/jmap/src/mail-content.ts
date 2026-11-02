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

export const mailMapping = {
  mailAddresses,
  mailAttachments,
  mailBody,
  mailDraft,
  mailFilterFor,
  mailboxMemberships,
};
