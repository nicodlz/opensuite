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
  cid: z.string().nullable().optional(),
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

// Calendar data is user-editable and may come from other clients; tolerate
// unexpected values instead of failing the whole response.
const CalendarSchema = z.object({
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
const CalendarEventSchema = z.object({
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

type Mailbox = z.infer<typeof MailboxSchema>;
type Email = z.infer<typeof EmailSchema>;
type Identity = z.infer<typeof IdentitySchema>;
type Calendar = z.infer<typeof CalendarSchema>;
type CalendarEvent = z.infer<typeof CalendarEventSchema>;
type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;
export type {
  Mailbox,
  Email,
  Identity,
  Calendar,
  CalendarEvent,
  RecurrenceRule,
};

// Thread lists need headers and flags only; bodies load with the conversation.
const summaryProperties = [
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
const emailProperties = [
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

const usingMail = [JmapCapability.core, JmapCapability.mail];
const usingCalendars = [JmapCapability.core, JmapCapability.calendars];
const expand = (template: string, values: Record<string, string>) =>
  template.replace(/\{([^}]+)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? ""),
  );

/** The authorization value is supplied by the caller; keep user credentials server-side. */
export class JmapClient {
  readonly #transport: Transport;
  readonly #origin: string;
  readonly #rewriteOrigin: string | undefined;
  constructor(origin: string, options: TransportOptions) {
    this.#origin = new URL(origin).origin;
    this.#transport = new Transport(origin, options);
    this.#rewriteOrigin =
      options.rewriteSessionUrlsToOrigin === undefined
        ? undefined
        : new URL(options.rewriteSessionUrlsToOrigin).origin;
    if (
      this.#rewriteOrigin !== undefined &&
      ("window" in globalThis || !("process" in globalThis))
    )
      throw new Error("Session URL rewrite is server-side only");
    if (
      this.#rewriteOrigin !== undefined &&
      this.#rewriteOrigin !== this.#origin
    )
      throw new Error("Session rewrite origin must match the client origin");
  }
  async discover(): Promise<JmapResult<Session>> {
    const result = await this.#transport.json(
      `${this.#origin}/.well-known/jmap`,
      SessionSchema,
    );
    if (result.isErr() || this.#rewriteOrigin === undefined) return result;
    try {
      const rewrite = (value: string) => {
        const url = new URL(value, this.#origin);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("Invalid advertised endpoint");
        return `${this.#origin}${url.pathname}${url.search}`
          .replaceAll("%7B", "{")
          .replaceAll("%7D", "}");
      };
      return ok({
        ...result.value,
        apiUrl: rewrite(result.value.apiUrl),
        ...(result.value.eventSourceUrl === undefined
          ? {}
          : { eventSourceUrl: rewrite(result.value.eventSourceUrl) }),
        uploadUrl: rewrite(result.value.uploadUrl),
        downloadUrl: rewrite(result.value.downloadUrl),
      });
    } catch {
      return err({
        kind: "invalidResponse",
        message: "Invalid advertised endpoint",
      });
    }
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
  emailState(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "Email/get",
      { accountId, ids: [], properties: ["id"] },
      usingMail,
      GetSchema(z.object({ id: z.string() })),
    );
  }
  emailChanges(session: Session, accountId: string, sinceState: string) {
    return this.#transport.call(
      session.apiUrl,
      "Email/changes",
      { accountId, sinceState, maxChanges: 500 },
      usingMail,
      z.object({
        accountId: z.string(),
        oldState: z.string(),
        newState: z.string(),
        hasMoreChanges: z.boolean(),
        created: z.array(z.string()),
        updated: z.array(z.string()),
        destroyed: z.array(z.string()),
      }),
    );
  }
  notificationEmails(
    session: Session,
    accountId: string,
    ids: readonly string[],
  ) {
    return this.#transport.call(
      session.apiUrl,
      "Email/get",
      {
        accountId,
        ids,
        properties: [
          "id",
          "threadId",
          "mailboxIds",
          "keywords",
          "receivedAt",
          "subject",
          "from",
        ],
      },
      usingMail,
      GetSchema(
        z.object({
          id: z.string(),
          threadId: z.string(),
          mailboxIds: z.record(z.string(), z.boolean()),
          keywords: z.record(z.string(), z.boolean()),
          receivedAt: z.string(),
          subject: z.string().nullable(),
          from: z.array(AddressSchema).nullable(),
        }),
      ),
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
        properties: emailProperties,
        fetchAllBodyValues: true,
      },
      usingMail,
      GetSchema(EmailSchema),
    );
  }
  async threadPage(
    session: Session,
    accountId: string,
    options: {
      filter: object;
      sort: readonly object[];
      position: number;
      limit: number;
    },
  ): Promise<
    JmapResult<{
      query: z.infer<typeof QuerySchema>;
      selected: {
        accountId: string;
        state: string;
        list: { id: string; threadId: string }[];
        notFound: string[];
      };
      threads: {
        accountId: string;
        state: string;
        list: { id: string; emailIds: string[] }[];
        notFound: string[];
      };
      emails: {
        accountId: string;
        state: string;
        list: Email[];
        notFound: string[];
      };
    }>
  > {
    const result = await this.#transport.json(
      session.apiUrl,
      z.object({
        methodResponses: z.array(
          z.tuple([z.string(), z.unknown(), z.string()]),
        ),
        sessionState: z.string(),
      }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          using: usingMail,
          methodCalls: [
            [
              "Email/query",
              { accountId, ...options, collapseThreads: true },
              "query",
            ],
            [
              "Email/get",
              {
                accountId,
                "#ids": {
                  resultOf: "query",
                  name: "Email/query",
                  path: "/ids",
                },
                properties: ["id", "threadId"],
              },
              "selected",
            ],
            [
              "Thread/get",
              {
                accountId,
                "#ids": {
                  resultOf: "selected",
                  name: "Email/get",
                  path: "/list/*/threadId",
                },
              },
              "threads",
            ],
            [
              "Email/get",
              {
                accountId,
                "#ids": {
                  resultOf: "threads",
                  name: "Thread/get",
                  path: "/list/*/emailIds/*",
                },
                properties: summaryProperties,
              },
              "emails",
            ],
          ],
        }),
      },
    );
    if (result.isErr()) return err(result.error);
    const calls = result.value.methodResponses;
    const expected = [
      ["Email/query", "query"],
      ["Email/get", "selected"],
      ["Thread/get", "threads"],
      ["Email/get", "emails"],
    ];
    if (calls.length !== expected.length)
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response count",
      });
    for (const [index, call] of calls.entries()) {
      const method = expected[index];
      if (method === undefined || call[2] !== method[1])
        return err({
          kind: "invalidResponse",
          message: "Unexpected method response id",
        });
      if (call[0] === "error") {
        const failure = SetErrorSchema.safeParse(call[1]);
        return failure.success
          ? err({
              kind: "method",
              method: method[0] ?? "unknown",
              ...failure.data,
            })
          : err({ kind: "invalidResponse", message: "Invalid method error" });
      }
      if (call[0] !== method[0])
        return err({
          kind: "invalidResponse",
          message: "Unexpected method response name",
        });
    }
    const query = QuerySchema.safeParse(calls[0]?.[1]);
    const selected = GetSchema(
      z.object({ id: z.string(), threadId: z.string() }),
    ).safeParse(calls[1]?.[1]);
    const threads = GetSchema(
      z.object({ id: z.string(), emailIds: z.array(z.string()) }),
    ).safeParse(calls[2]?.[1]);
    const emails = GetSchema(EmailSchema).safeParse(calls[3]?.[1]);
    if (
      !query.success ||
      !selected.success ||
      !threads.success ||
      !emails.success
    )
      return err({
        kind: "invalidResponse",
        message: "Invalid thread page response",
      });
    return ok({
      query: query.data,
      selected: selected.data,
      threads: threads.data,
      emails: emails.data,
    });
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
      body: new Blob(
        [
          bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : Uint8Array.from(bytes),
        ],
        { type },
      ),
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
  calendars(session: Session, accountId: string) {
    return this.#transport.call(
      session.apiUrl,
      "Calendar/get",
      { accountId },
      usingCalendars,
      GetSchema(CalendarSchema),
    );
  }
  async createCalendar(
    session: Session,
    accountId: string,
    calendar: { name: string; color: string },
    isDefault = false,
  ): Promise<JmapResult<{ id: string }>> {
    // Stalwart rejects `isDefault` as a created property; the default is set
    // with the RFC `onSuccessSetIsDefault` argument instead.
    const method = "Calendar/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      {
        accountId,
        create: { item: calendar },
        ...(isDefault ? { onSuccessSetIsDefault: "#item" } : {}),
      },
      usingCalendars,
      SetSchema(z.object({ id: z.string() })),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const item = result.value.created?.["item"];
    return item === undefined
      ? err({ kind: "invalidResponse", message: "Missing Calendar/set result" })
      : ok(item);
  }
  /** One page of event ids and their full objects, in a single request. */
  async calendarEventPage(
    session: Session,
    accountId: string,
    options: { filter: object; position: number; limit: number },
  ): Promise<
    JmapResult<{
      query: z.infer<typeof QuerySchema>;
      events: { state: string; list: CalendarEvent[]; notFound: string[] };
    }>
  > {
    const result = await this.#transport.json(
      session.apiUrl,
      z.object({
        methodResponses: z.array(
          z.tuple([z.string(), z.unknown(), z.string()]),
        ),
        sessionState: z.string(),
      }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          using: usingCalendars,
          methodCalls: [
            ["CalendarEvent/query", { accountId, ...options }, "query"],
            [
              // Full objects: see `calendarEvents`.
              "CalendarEvent/get",
              {
                accountId,
                "#ids": {
                  resultOf: "query",
                  name: "CalendarEvent/query",
                  path: "/ids",
                },
              },
              "events",
            ],
          ],
        }),
      },
    );
    if (result.isErr()) return err(result.error);
    const calls = result.value.methodResponses;
    const expected = [
      ["CalendarEvent/query", "query"],
      ["CalendarEvent/get", "events"],
    ];
    if (calls.length !== expected.length)
      return err({
        kind: "invalidResponse",
        message: "Unexpected method response count",
      });
    for (const [index, call] of calls.entries()) {
      const method = expected[index];
      if (method === undefined || call[2] !== method[1])
        return err({
          kind: "invalidResponse",
          message: "Unexpected method response id",
        });
      if (call[0] === "error") {
        const failure = SetErrorSchema.safeParse(call[1]);
        return failure.success
          ? err({
              kind: "method",
              method: method[0] ?? "unknown",
              ...failure.data,
            })
          : err({ kind: "invalidResponse", message: "Invalid method error" });
      }
      if (call[0] !== method[0])
        return err({
          kind: "invalidResponse",
          message: "Unexpected method response name",
        });
    }
    const query = QuerySchema.safeParse(calls[0]?.[1]);
    const events = GetSchema(CalendarEventSchema).safeParse(calls[1]?.[1]);
    if (!query.success || !events.success)
      return err({
        kind: "invalidResponse",
        message: "Invalid calendar event page response",
      });
    return ok({ query: query.data, events: events.data });
  }
  calendarEvents(session: Session, accountId: string, ids: readonly string[]) {
    // Stalwart v1.0.1 omits `recurrenceRules` when it is listed in
    // `properties`, so full objects are requested.
    return this.#transport.call(
      session.apiUrl,
      "CalendarEvent/get",
      { accountId, ids },
      usingCalendars,
      GetSchema(CalendarEventSchema),
    );
  }
  async createCalendarEvent(
    session: Session,
    accountId: string,
    event: object,
  ): Promise<JmapResult<{ id: string }>> {
    const method = "CalendarEvent/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, create: { item: event } },
      usingCalendars,
      SetSchema(z.object({ id: z.string() })),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notCreated);
    if (failure !== undefined) return err(failure);
    const item = result.value.created?.["item"];
    return item === undefined
      ? err({
          kind: "invalidResponse",
          message: "Missing CalendarEvent/set result",
        })
      : ok(item);
  }
  async updateCalendarEvent(
    session: Session,
    accountId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<JmapResult<void>> {
    const method = "CalendarEvent/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, update: { [id]: patch } },
      usingCalendars,
      SetSchema(z.unknown()),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notUpdated);
    if (failure !== undefined) return err(failure);
    return result.value.updated !== null &&
      result.value.updated !== undefined &&
      Object.hasOwn(result.value.updated, id)
      ? ok(undefined)
      : err({
          kind: "invalidResponse",
          message: "Missing CalendarEvent/set result",
        });
  }
  async destroyCalendarEvent(
    session: Session,
    accountId: string,
    id: string,
  ): Promise<JmapResult<void>> {
    const method = "CalendarEvent/set";
    const result = await this.#transport.call(
      session.apiUrl,
      method,
      { accountId, destroy: [id] },
      usingCalendars,
      SetSchema(z.unknown()),
    );
    if (result.isErr()) return err(result.error);
    const failure = setFailure(method, result.value.notDestroyed);
    if (failure !== undefined) return err(failure);
    return result.value.destroyed?.includes(id)
      ? ok(undefined)
      : err({
          kind: "invalidResponse",
          message: "Missing CalendarEvent/set result",
        });
  }
}
