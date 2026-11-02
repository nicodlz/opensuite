import { z } from "zod";
import { JmapCapability, SetErrorSchema } from "./protocol.ts";

export const MailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  parentId: z.string().nullable(),
  totalEmails: z.number().default(0),
  unreadEmails: z.number().default(0),
});
export const AddressSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});
const PartSchema = z.object({
  partId: z.string().nullable(),
  blobId: z.string().nullable(),
  name: z.string().nullable(),
  type: z.string(),
  size: z.number(),
  charset: z.string().nullable().optional(),
  cid: z.string().nullable().optional(),
});
export const EmailSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  threadId: z.string(),
  mailboxIds: z.record(z.string(), z.boolean()),
  keywords: z.record(z.string(), z.boolean()),
  receivedAt: z.string(),
  subject: z.string().nullable(),
  from: z.array(AddressSchema).nullable(),
  to: z.array(AddressSchema).nullable(),
  replyTo: z.array(AddressSchema).nullable().default(null),
  messageId: z.array(z.string()).nullable(),
  attachments: z.array(PartSchema),
  cc: z.array(AddressSchema).nullable().default(null),
  bcc: z.array(AddressSchema).nullable().default(null),
  sentAt: z.string().nullable().default(null),
  inReplyTo: z.array(z.string()).nullable().default(null),
  references: z.array(z.string()).nullable().default(null),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
  preview: z.string().default(""),
  hasAttachment: z.boolean().default(false),
  textBody: z.array(PartSchema).default([]),
  htmlBody: z.array(PartSchema).default([]),
  bodyValues: z.record(z.string(), z.object({ value: z.string() })).default({}),
});
export const IdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
export const GetSchema = <T>(item: z.ZodType<T>) =>
  z.object({
    accountId: z.string(),
    state: z.string(),
    list: z.array(item),
    notFound: z.array(z.string()),
  });
export const QuerySchema = z.object({
  accountId: z.string(),
  queryState: z.string(),
  canCalculateChanges: z.boolean(),
  position: z.number(),
  ids: z.array(z.string()),
  total: z.number().optional(),
});
export const SetSchema = <T>(created: z.ZodType<T>) =>
  z.object({
    accountId: z.string(),
    created: z.record(z.string(), created).nullable().optional(),
    updated: z.record(z.string(), z.unknown()).nullable().optional(),
    notCreated: z.record(z.string(), SetErrorSchema).nullable().optional(),
    notUpdated: z.record(z.string(), SetErrorSchema).nullable().optional(),
    destroyed: z.array(z.string()).nullable().optional(),
    notDestroyed: z.record(z.string(), SetErrorSchema).nullable().optional(),
  });
export const BlobSchema = z.object({
  id: z.string(),
  type: z.string(),
  size: z.number(),
});
export const ImportSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  threadId: z.string(),
  size: z.number(),
});
export const UploadSchema = z.object({
  accountId: z.string(),
  blobId: z.string(),
  type: z.string(),
  size: z.number(),
});

// Calendar data is user-editable and may come from other clients; tolerate
// unexpected values instead of failing the whole response.
export const CalendarSchema = z.object({
  id: z.string(),
  name: z.string().catch(""),
  color: z.string().nullable().catch(null),
  isDefault: z.boolean().catch(false),
  sortOrder: z.number().catch(0),
  myRights: z
    .object({ mayWriteAll: z.boolean().catch(true) })
    .nullable()
    .catch(null),
});
const RecurrenceRuleSchema = z.looseObject({
  frequency: z.string(),
  interval: z.number().optional(),
  count: z.number().optional(),
  until: z.string().optional(),
});
export const CalendarEventSchema = z.object({
  id: z.string(),
  uid: z.string().optional(),
  alerts: z.record(z.string(), z.unknown()).nullable().optional(),
  calendarIds: z.record(z.string(), z.boolean()).catch({}),
  title: z.string().catch(""),
  description: z.string().catch(""),
  locations: z
    .record(z.string(), z.looseObject({ name: z.string().nullish() }))
    .nullable()
    .catch(null),
  start: z.string().catch(""),
  duration: z.string().catch("PT0S"),
  timeZone: z.string().nullable().catch(null),
  showWithoutTime: z.boolean().catch(false),
  recurrenceRules: z.array(RecurrenceRuleSchema).nullable().catch(null),
  excludedRecurrenceRules: z.array(RecurrenceRuleSchema).nullable().catch(null),
  recurrenceOverrides: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .nullable()
    .catch(null),
});

export type Mailbox = z.infer<typeof MailboxSchema>;
export type Email = z.infer<typeof EmailSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
export type Calendar = z.infer<typeof CalendarSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

// Thread lists need headers and flags only; bodies load with the conversation.
export const summaryProperties = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "receivedAt",
  "subject",
  "from",
  "to",
  "cc",
  "messageId",
  "sentAt",
  "preview",
  "hasAttachment",
  "attachments",
];
export const emailProperties = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "receivedAt",
  "subject",
  "from",
  "to",
  "replyTo",
  "messageId",
  "attachments",
  "cc",
  "bcc",
  "sentAt",
  "inReplyTo",
  "references",
  "headers",
  "preview",
  "hasAttachment",
  "textBody",
  "htmlBody",
  "bodyValues",
];

export const usingMail = [JmapCapability.core, JmapCapability.mail];
export const usingCalendars = [JmapCapability.core, JmapCapability.calendars];
