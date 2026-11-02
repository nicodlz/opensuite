import type { Email } from "./schemas.ts";

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
