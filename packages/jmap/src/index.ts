import { err, ok } from "neverthrow";
import { z } from "zod";
import {
  JmapCapability,
  SessionSchema,
  SetErrorSchema,
  Transport,
  setFailure,
  type JmapResult,
  type Session,
  type TransportOptions,
} from "./protocol.ts";

export { JmapCapability } from "./protocol.ts";
export type {
  JmapError,
  JmapResult,
  Session,
  TransportOptions,
} from "./protocol.ts";

const MailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  parentId: z.string().nullable(),
  totalEmails: z.number().default(0),
  unreadEmails: z.number().default(0),
});
const AddressSchema = z.object({
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
});
const EmailSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  threadId: z.string(),
  mailboxIds: z.record(z.string(), z.boolean()),
  keywords: z.record(z.string(), z.boolean()),
  receivedAt: z.string(),
  subject: z.string().nullable(),
  from: z.array(AddressSchema).nullable(),
  to: z.array(AddressSchema).nullable(),
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
const IdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
const GetSchema = <T>(item: z.ZodType<T>) =>
  z.object({
    accountId: z.string(),
    state: z.string(),
    list: z.array(item),
    notFound: z.array(z.string()),
  });
const QuerySchema = z.object({
  accountId: z.string(),
  queryState: z.string(),
  canCalculateChanges: z.boolean(),
  position: z.number(),
  ids: z.array(z.string()),
  total: z.number().optional(),
});
const SetSchema = <T>(created: z.ZodType<T>) =>
  z.object({
    accountId: z.string(),
    created: z.record(z.string(), created).nullable().optional(),
    updated: z.record(z.string(), z.unknown()).nullable().optional(),
    notCreated: z.record(z.string(), SetErrorSchema).nullable().optional(),
    notUpdated: z.record(z.string(), SetErrorSchema).nullable().optional(),
    destroyed: z.array(z.string()).nullable().optional(),
    notDestroyed: z.record(z.string(), SetErrorSchema).nullable().optional(),
  });
const BlobSchema = z.object({
  id: z.string(),
  type: z.string(),
  size: z.number(),
});
const ImportSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  threadId: z.string(),
  size: z.number(),
});
const UploadSchema = z.object({
  accountId: z.string(),
  blobId: z.string(),
  type: z.string(),
  size: z.number(),
});

type Mailbox = z.infer<typeof MailboxSchema>;
type Email = z.infer<typeof EmailSchema>;
type Identity = z.infer<typeof IdentitySchema>;
export type { Mailbox, Email, Identity };

const usingMail = [JmapCapability.core, JmapCapability.mail];
const expand = (template: string, values: Record<string, string>) =>
  template.replace(/\{([^}]+)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? ""),
  );

/** The authorization value is supplied by the caller; keep user credentials server-side. */
export class JmapClient {
  readonly #transport: Transport;
  readonly #origin: string;
  constructor(origin: string, options: TransportOptions) {
    this.#origin = new URL(origin).origin;
    this.#transport = new Transport(origin, options);
  }
  discover(): Promise<JmapResult<Session>> {
    return this.#transport.json(
      `${this.#origin}/.well-known/jmap`,
      SessionSchema,
    );
  }
  mailboxes(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "Mailbox/get",
      {
        accountId,
        properties: [
          "id",
          "name",
          "role",
          "parentId",
          "totalEmails",
          "unreadEmails",
        ],
      },
      usingMail,
      GetSchema(MailboxSchema),
    );
  }
  queryEmails(
    session: Session,
    accountId: string,
    options: {
      filter?: object;
      sort?: readonly object[];
      position?: number;
      limit?: number;
      collapseThreads?: boolean;
      calculateTotal?: boolean;
    } = {},
  ) {
    return this.#transport.call(
      session.apiUrl,
      "Email/query",
      { accountId, ...options },
      usingMail,
      QuerySchema,
    );
  }
  emails(session: Session, accountId: string, ids: readonly string[]) {
    return this.#transport.call(
      session.apiUrl,
      "Email/get",
      {
        accountId,
        ids,
        properties: [
          "id",
          "blobId",
          "threadId",
          "mailboxIds",
          "keywords",
          "receivedAt",
          "subject",
          "from",
          "to",
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
        ],
        fetchAllBodyValues: true,
      },
      usingMail,
      GetSchema(EmailSchema),
    );
  }
  threads(session: Session, accountId: string, ids: readonly string[]) {
    return this.#transport.call(
      session.apiUrl,
      "Thread/get",
      { accountId, ids },
      usingMail,
      GetSchema(z.object({ id: z.string(), emailIds: z.array(z.string()) })),
    );
  }
  async createEmail(
    session: Session,
    accountId: string,
    email: object,
  ): Promise<JmapResult<{ id: string; threadId: string }>> {
    const method = "Email/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, create: { item: email } },
      usingMail,
      SetSchema(z.object({ id: z.string(), threadId: z.string() })),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const item = result.value.created?.["item"];
    return item === undefined
      ? err({ kind: "invalidResponse", message: "Missing Email/set result" })
      : ok(item);
  }
  async destroyEmail(
    session: Session,
    accountId: string,
    id: string,
  ): Promise<JmapResult<void>> {
    const method = "Email/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, destroy: [id] },
      usingMail,
      SetSchema(z.unknown()),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notDestroyed);
    if (failure !== undefined) return err(failure);
    return result.value.destroyed?.includes(id)
      ? ok(undefined)
      : err({ kind: "invalidResponse", message: "Missing Email/set result" });
  }
  identities(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "Identity/get",
      { accountId, properties: ["id", "name", "email"] },
      [JmapCapability.core, JmapCapability.submission],
      GetSchema(IdentitySchema),
    );
  }
  async uploadBlob(
    session: Session,
    accountId: string,
    data: string,
    type = "application/octet-stream",
  ): Promise<JmapResult<z.infer<typeof BlobSchema>>> {
    const method = "Blob/upload";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        create: { item: { data: [{ "data:asBase64": data }], type } },
      },
      [JmapCapability.core, JmapCapability.blob],
      SetSchema(BlobSchema),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const item = result.value.created?.["item"];
    return item === undefined
      ? err({ kind: "invalidResponse", message: "Missing Blob/upload result" })
      : ok(item);
  }
  async upload(
    session: Session,
    accountId: string,
    bytes: Uint8Array,
    type = "message/rfc822",
  ) {
    const url = expand(session.uploadUrl, { accountId });
    return this.#transport.json(url, UploadSchema, {
      method: "POST",
      headers: { "Content-Type": type },
      body: new Blob([Uint8Array.from(bytes)], { type }),
    });
  }
  async download(
    session: Session,
    accountId: string,
    blobId: string,
    name = "blob",
    type = "application/octet-stream",
  ): Promise<JmapResult<Uint8Array>> {
    const url = expand(session.downloadUrl, { accountId, blobId, name, type });
    const response = await this.#transport.request(url);
    if (response.isErr()) return err(response.error);
    try {
      return ok(new Uint8Array(await response.value.arrayBuffer()));
    } catch (cause) {
      return err({ kind: "network", message: String(cause) });
    }
  }
  async importEmail(
    session: Session,
    accountId: string,
    input: {
      blobId: string;
      mailboxIds: Record<string, boolean>;
      keywords?: Record<string, boolean>;
      receivedAt?: string;
    },
  ): Promise<JmapResult<z.infer<typeof ImportSchema>>> {
    const method = "Email/import";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, emails: { item: input } },
      usingMail,
      SetSchema(ImportSchema),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const item = result.value.created?.["item"];
    return item === undefined
      ? err({ kind: "invalidResponse", message: "Missing Email/import result" })
      : ok(item);
  }
  async updateEmail(
    session: Session,
    accountId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<JmapResult<void>> {
    const method = "Email/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, update: { [id]: patch } },
      usingMail,
      SetSchema(z.unknown()),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notUpdated);
    if (failure !== undefined) return err(failure);
    return result.value.updated !== null &&
      result.value.updated !== undefined &&
      Object.hasOwn(result.value.updated, id)
      ? ok(undefined)
      : err({ kind: "invalidResponse", message: "Missing Email/set result" });
  }
  async submit(
    session: Session,
    accountId: string,
    emailId: string,
    identityId: string,
    envelope?: { mailFrom: { email: string }; rcptTo: { email: string }[] },
    sentMailboxId?: string,
  ): Promise<JmapResult<{ id: string }>> {
    const method = "EmailSubmission/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        ...(sentMailboxId === undefined
          ? {}
          : {
              onSuccessUpdateEmail: {
                "#item": {
                  mailboxIds: { [sentMailboxId]: true },
                  "keywords/$draft": null,
                  "keywords/$seen": true,
                },
              },
            }),
        create: {
          item: {
            emailId,
            identityId,
            ...(envelope === undefined ? {} : { envelope }),
          },
        },
      },
      [JmapCapability.core, JmapCapability.mail, JmapCapability.submission],
      SetSchema(z.object({ id: z.string() })),
      sentMailboxId === undefined ? undefined : "Email/set",
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const item = result.value.created?.["item"];
    return item === undefined
      ? err({
          kind: "invalidResponse",
          message: "Missing EmailSubmission/set result",
        })
      : ok(item);
  }
}
