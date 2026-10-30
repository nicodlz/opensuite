import { oc } from "@orpc/contract";
import { z } from "zod";

// IDs are opaque JMAP identifiers. A conversation ID corresponds to threadId.
export const IdSchema = z.string().min(1);
export const AddressSchema = z.object({
  name: z.string().optional(),
  email: z.email(),
});
export const MailboxSchema = z.object({
  id: IdSchema,
  name: z.string(),
  role: z.enum([
    "inbox",
    "drafts",
    "sent",
    "archive",
    "trash",
    "junk",
    "custom",
  ]),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export const AttachmentSchema = z.object({
  id: IdSchema,
  blobId: IdSchema,
  name: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative(),
});
export const MessageSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  mailboxIds: z.array(IdSchema),
  from: AddressSchema,
  to: z.array(AddressSchema),
  cc: z.array(AddressSchema),
  bcc: z.array(AddressSchema),
  subject: z.string(),
  sentAt: z.iso.datetime(),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  htmlBody: z.string(),
  textBody: z.string(),
  attachments: z.array(AttachmentSchema),
  unread: z.boolean(),
  starred: z.boolean(),
  labels: z.array(IdSchema),
});
export const ThreadSummarySchema = z.object({
  id: IdSchema,
  subject: z.string(),
  participants: z.array(AddressSchema),
  preview: z.string(),
  updatedAt: z.iso.datetime(),
  messageCount: z.number().int().positive(),
  unread: z.boolean(),
  starred: z.boolean(),
  hasAttachment: z.boolean(),
  mailboxIds: z.array(IdSchema),
  labels: z.array(IdSchema),
});
export const DraftContentSchema = z.object({
  to: z.array(AddressSchema),
  cc: z.array(AddressSchema),
  bcc: z.array(AddressSchema),
  subject: z.string(),
  htmlBody: z.string(),
  textBody: z.string(),
  attachmentBlobIds: z.array(IdSchema),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  threadId: IdSchema.optional(),
});
export const DraftSchema = DraftContentSchema.extend({ id: IdSchema });
export const SearchSchema = z.object({
  query: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  hasAttachment: z.boolean().optional(),
  unread: z.boolean().optional(),
  after: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
});
const AccountSchema = z.object({ accountId: IdSchema });
const ThreadInputSchema = AccountSchema.extend({ threadId: IdSchema });
const DraftInputSchema = AccountSchema.extend({ draftId: IdSchema });
const errors = {
  NOT_FOUND: { status: 404, message: "Mail item not found" },
  FORBIDDEN: { status: 403, message: "Access denied" },
  VALIDATION: { status: 400, message: "Invalid mail data" },
  CONFLICT: { status: 409, message: "Mail item changed" },
  UPSTREAM_UNAVAILABLE: { status: 503, message: "Mail service unavailable" },
};
const procedure = oc.errors(errors);
const ok = z.object({ success: z.literal(true) });

export const mailContract = {
  identity: procedure
    .route({ method: "POST", path: "/mail/identity" })
    .input(AccountSchema)
    .output(z.object({ address: AddressSchema })),
  mailboxes: procedure
    .route({ method: "POST", path: "/mail/mailboxes" })
    .input(AccountSchema)
    .output(z.object({ mailboxes: z.array(MailboxSchema) })),
  threads: procedure
    .route({ method: "POST", path: "/mail/threads" })
    .input(
      AccountSchema.extend({
        mailboxId: IdSchema,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
        search: SearchSchema.optional(),
        sort: z.enum(["newest", "oldest"]).default("newest"),
      }),
    )
    .output(
      z.object({
        threads: z.array(ThreadSummarySchema),
        nextCursor: z.string().nullable(),
      }),
    ),
  thread: procedure
    .route({ method: "POST", path: "/mail/thread" })
    .input(ThreadInputSchema)
    .output(z.object({ id: IdSchema, messages: z.array(MessageSchema) })),
  action: procedure
    .route({ method: "POST", path: "/mail/action" })
    .input(
      ThreadInputSchema.extend({
        messageIds: z.array(IdSchema).optional(),
        action: z.discriminatedUnion("type", [
          z.object({ type: z.literal("read"), value: z.boolean() }),
          z.object({ type: z.literal("star"), value: z.boolean() }),
          z.object({ type: z.literal("move"), mailboxId: IdSchema }),
          z.object({ type: z.literal("archive") }),
          z.object({ type: z.literal("trash") }),
          z.object({ type: z.literal("delete") }),
          z.object({ type: z.literal("labels"), labels: z.array(IdSchema) }),
        ]),
      }),
    )
    .output(ok),
  drafts: procedure
    .route({ method: "POST", path: "/mail/drafts" })
    .input(AccountSchema)
    .output(z.object({ drafts: z.array(DraftSchema) })),
  createDraft: procedure
    .route({ method: "POST", path: "/mail/drafts/create" })
    .input(AccountSchema.extend({ draft: DraftContentSchema }))
    .output(DraftSchema),
  updateDraft: procedure
    .route({ method: "POST", path: "/mail/drafts/update" })
    .input(DraftInputSchema.extend({ draft: DraftContentSchema }))
    .output(DraftSchema),
  deleteDraft: procedure
    .route({ method: "POST", path: "/mail/drafts/delete" })
    .input(DraftInputSchema)
    .output(ok),
  send: procedure
    .route({ method: "POST", path: "/mail/send" })
    .input(DraftInputSchema)
    .output(z.object({ messageId: IdSchema, threadId: IdSchema })),
  upload: procedure
    .route({ method: "POST", path: "/mail/attachments/upload" })
    .input(
      AccountSchema.extend({
        name: z.string().min(1),
        type: z.string(),
        base64: z.base64(),
      }),
    )
    .output(AttachmentSchema),
  download: procedure
    .route({ method: "POST", path: "/mail/attachments/download" })
    .input(AccountSchema.extend({ blobId: IdSchema }))
    .output(z.object({ url: z.url(), expiresAt: z.iso.datetime() })),
};
export type Mailbox = z.infer<typeof MailboxSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type DraftContent = z.infer<typeof DraftContentSchema>;
export type MailSearch = z.infer<typeof SearchSchema>;
export type MailAction =
  | { type: "read"; value: boolean }
  | { type: "star"; value: boolean }
  | { type: "move"; mailboxId: string }
  | { type: "archive" }
  | { type: "trash" }
  | { type: "delete" }
  | { type: "labels"; labels: string[] };
