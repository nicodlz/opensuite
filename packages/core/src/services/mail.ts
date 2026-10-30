import type {
  Draft,
  DraftContent,
  MailAction,
  Mailbox,
  MailSearch,
  Message,
  ThreadSummary,
} from "@opensuite/contracts";
import {
  JmapCapability,
  JmapClient,
  type Email,
  type JmapError,
  type JmapResult,
} from "@opensuite/jmap";
import { err, ok, type Result } from "neverthrow";
import type { Actor } from "./accounts.ts";

export type MailFailureKind =
  "forbidden" | "not_found" | "validation" | "conflict" | "unavailable";
export interface MailFailure {
  kind: MailFailureKind;
}
export interface MailCredentialStore {
  getForOwner(
    userId: string,
    accountId: string,
  ): PromiseLike<
    Result<
      { accountId: string; address: string; secret: string },
      { kind: string }
    >
  >;
}
export interface ThreadOptions {
  mailboxId: string;
  cursor?: string | undefined;
  limit: number;
  search?: MailSearch | undefined;
  sort: "newest" | "oldest";
}
class Failure extends Error {
  readonly kind: MailFailureKind;
  constructor(kind: MailFailureKind) {
    super(kind);
    this.kind = kind;
  }
}
const fail = (kind: MailFailureKind): never => {
  throw new Failure(kind);
};
function value<T>(result: JmapResult<T>): T {
  if (result.isOk()) return result.value;
  const error: JmapError = result.error;
  if (
    (error.kind === "http" || error.kind === "request") &&
    error.status === 404
  )
    return fail("not_found");
  if (
    (error.kind === "http" || error.kind === "request") &&
    error.status === 403
  )
    return fail("forbidden");
  if (
    (error.kind === "set" || error.kind === "method") &&
    ["notFound", "blobNotFound"].includes(error.type)
  )
    return fail("not_found");
  if (
    (error.kind === "set" || error.kind === "method") &&
    [
      "invalidProperties",
      "invalidArguments",
      "invalidEmail",
      "forbiddenFrom",
      "tooLarge",
    ].includes(error.type)
  )
    return fail("validation");
  if (
    (error.kind === "set" || error.kind === "method") &&
    error.type === "stateMismatch"
  )
    return fail("conflict");
  return fail("unavailable");
}
async function run<T>(work: () => Promise<T>): Promise<Result<T, MailFailure>> {
  try {
    return ok(await work());
  } catch (error) {
    return err({ kind: error instanceof Failure ? error.kind : "unavailable" });
  }
}
const address = (item: { name: string | null; email: string }) => ({
  email: item.email,
  ...(item.name ? { name: item.name } : {}),
});
const addresses = (items: Email["from"]) => (items ?? []).map(address);
const body = (email: Email, parts: Email["textBody"], type: string) =>
  parts
    .filter((part) => part.type.toLowerCase() === type)
    .map((part) =>
      part.partId === null ? "" : (email.bodyValues[part.partId]?.value ?? ""),
    )
    .join("\n");
const memberships = (email: Email) =>
  Object.keys(email.mailboxIds).filter((id) => email.mailboxIds[id]);
const attachments = (email: Email) =>
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
const date = (timestamp: string) => new Date(timestamp).toISOString();
const customIds = (boxes: Mailbox[]) =>
  new Set(boxes.filter((box) => box.role === "custom").map((box) => box.id));
function message(email: Email, boxes: Mailbox[], fallback: string): Message {
  const from = addresses(email.from)[0] ?? { email: fallback };
  const mailboxIds = memberships(email);
  const custom = customIds(boxes);
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds,
    from,
    replyTo: addresses(email.replyTo),
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    subject: email.subject ?? "",
    sentAt: date(email.sentAt ?? email.receivedAt),
    ...(email.messageId?.[0] ? { messageId: email.messageId[0] } : {}),
    ...(email.inReplyTo?.[0] ? { inReplyTo: email.inReplyTo[0] } : {}),
    references: email.references ?? [],
    headers: email.headers,
    htmlBody: body(email, email.htmlBody, "text/html"),
    textBody: body(email, email.textBody, "text/plain"),
    attachments: attachments(email),
    unread: !email.keywords["$seen"],
    starred: Boolean(email.keywords["$flagged"]),
    labels: mailboxIds.filter((id) => custom.has(id)),
  };
}
function draft(email: Email): Draft {
  return {
    id: email.id,
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    subject: email.subject ?? "",
    htmlBody: body(email, email.htmlBody, "text/html"),
    textBody: body(email, email.textBody, "text/plain"),
    attachmentBlobIds: attachments(email).map((part) => part.blobId),
    ...(email.inReplyTo?.[0] ? { inReplyTo: email.inReplyTo[0] } : {}),
    references: email.references ?? [],
    threadId: email.threadId,
  };
}
function summary(
  emails: Email[],
  boxes: Mailbox[],
  fallback: string,
): ThreadSummary {
  const ordered = emails.toSorted((a, b) =>
    a.receivedAt.localeCompare(b.receivedAt),
  );
  const last = ordered.at(-1);
  if (last === undefined) return fail("not_found");
  const mapped = ordered.map((email) => message(email, boxes, fallback));
  const participants = new Map<string, Message["from"]>();
  for (const item of mapped)
    for (const person of [item.from, ...item.to, ...item.cc])
      participants.set(person.email.toLowerCase(), person);
  return {
    id: last.threadId,
    subject: last.subject ?? "",
    participants: [...participants.values()],
    preview: last.preview,
    updatedAt: date(last.receivedAt),
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
const filterFor = (options: ThreadOptions) => {
  const search = options.search;
  return {
    inMailbox: options.mailboxId,
    ...(search?.query ? { text: search.query } : {}),
    ...(search?.from ? { from: search.from } : {}),
    ...(search?.to ? { to: search.to } : {}),
    ...(search?.hasAttachment === undefined
      ? {}
      : { hasAttachment: search.hasAttachment }),
    ...(search?.unread === undefined
      ? {}
      : search.unread
        ? { notKeyword: "$seen" }
        : { hasKeyword: "$seen" }),
    ...(search?.after ? { after: search.after } : {}),
    ...(search?.before ? { before: search.before } : {}),
  };
};

const role = (list: Mailbox[], name: Mailbox["role"]) =>
  list.find((box) => box.role === name)?.id ?? fail("not_found");

/** One instance per server; credentials and client instances never leave this service. */
export function createMailService(dependencies: {
  store: MailCredentialStore;
  origin: string;
  client?: (credential: { address: string; secret: string }) => JmapClient;
}) {
  const uploads = new Map<
    string,
    { name: string; type: string; size: number; owner: string }
  >();
  const connect = async (actor: Actor, accountId: string) => {
    const credential = await dependencies.store.getForOwner(
      actor.id,
      accountId,
    );
    if (credential.isErr())
      return fail(
        credential.error.kind === "not_found" ||
          credential.error.kind === "forbidden"
          ? "forbidden"
          : "unavailable",
      );
    if (accountId !== "default" && credential.value.accountId !== accountId)
      return fail("forbidden");
    const client =
      dependencies.client?.(credential.value) ??
      new JmapClient(dependencies.origin, {
        authorization: `Basic ${Buffer.from(`${credential.value.address}:${credential.value.secret}`).toString("base64")}`,
      });
    const session = value(await client.discover());
    const id = session.primaryAccounts[JmapCapability.mail];
    if (id === undefined) return fail("unavailable");
    return {
      client,
      session,
      id,
      address: credential.value.address,
      owner: actor.id,
    };
  };
  type Connection = Awaited<ReturnType<typeof connect>>;
  const boxes = async (c: Connection): Promise<Mailbox[]> =>
    value(await c.client.mailboxes(c.session, c.id)).list.map((box) => ({
      id: box.id,
      name: box.name,
      role:
        box.role === "inbox" ||
        box.role === "drafts" ||
        box.role === "sent" ||
        box.role === "archive" ||
        box.role === "trash" ||
        box.role === "junk"
          ? box.role
          : "custom",
      total: box.totalEmails,
      unread: box.unreadEmails,
    }));
  const getThread = async (c: Connection, threadId: string) => {
    const thread = value(await c.client.threads(c.session, c.id, [threadId]))
      .list[0];
    if (thread === undefined) return fail("not_found");
    const result = value(
      await c.client.emails(c.session, c.id, thread.emailIds),
    );
    if (result.notFound.length > 0 || result.list.length === 0)
      return fail("conflict");
    return result.list;
  };
  const getDraft = async (c: Connection, id: string, list: Mailbox[]) => {
    const email = value(await c.client.emails(c.session, c.id, [id])).list[0];
    if (
      email === undefined ||
      !email.keywords["$draft"] ||
      !email.mailboxIds[role(list, "drafts")]
    )
      return fail("not_found");
    return email;
  };
  const create = async (
    c: Connection,
    content: DraftContent,
    list: Mailbox[],
    prior?: Email,
  ) => {
    const existing = new Map(
      (prior ? attachments(prior) : []).map((item) => [item.blobId, item]),
    );
    const parts = content.attachmentBlobIds.map((blobId) => {
      const uploaded = uploads.get(`${c.owner}:${blobId}`);
      const item = existing.get(blobId) ?? uploaded;
      return {
        blobId,
        name: item?.name ?? "attachment",
        type: item?.type ?? "application/octet-stream",
      };
    });
    return value(
      await c.client.createEmail(c.session, c.id, {
        mailboxIds: { [role(list, "drafts")]: true },
        keywords: { $draft: true, $seen: true },
        from: [{ email: c.address }],
        to: content.to,
        cc: content.cc,
        bcc: content.bcc,
        subject: content.subject,
        ...(content.inReplyTo ? { inReplyTo: [content.inReplyTo] } : {}),
        ...(content.references.length
          ? { references: content.references }
          : {}),
        bodyValues: {
          text: { value: content.textBody },
          html: { value: content.htmlBody },
        },
        textBody: [{ partId: "text", type: "text/plain" }],
        htmlBody: [{ partId: "html", type: "text/html" }],
        attachments: parts,
      }),
    );
  };
  return {
    identity: (actor: Actor, accountId: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const identities = value(
          await c.client.identities(c.session, c.id),
        ).list;
        const found = identities.find(
          (item) => item.email.toLowerCase() === c.address.toLowerCase(),
        );
        return {
          address: found
            ? {
                email: found.email,
                ...(found.name ? { name: found.name } : {}),
              }
            : { email: c.address },
        };
      }),
    mailboxes: (actor: Actor, accountId: string) =>
      run(async () => ({
        mailboxes: await boxes(await connect(actor, accountId)),
      })),
    threads: (actor: Actor, accountId: string, options: ThreadOptions) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        if (!list.some((box) => box.id === options.mailboxId))
          return fail("not_found");
        if (
          options.cursor !== undefined &&
          !/^(0|[1-9]\d*)$/.test(options.cursor)
        )
          return fail("validation");
        const position = Number(options.cursor ?? 0);
        if (!Number.isSafeInteger(position)) return fail("validation");
        const query = value(
          await c.client.queryEmails(c.session, c.id, {
            filter: filterFor(options),
            sort: [
              {
                property: "receivedAt",
                isAscending: options.sort === "oldest",
              },
            ],
            collapseThreads: true,
            position,
            limit: options.limit + 1,
          }),
        );
        const page = query.ids.slice(0, options.limit);
        if (!page.length) return { threads: [], nextCursor: null };
        const selected = value(
          await c.client.emails(c.session, c.id, page),
        ).list;
        const groups = await Promise.all(
          selected.map((email) => getThread(c, email.threadId)),
        );
        return {
          threads: groups.map((group) => summary(group, list, c.address)),
          nextCursor:
            query.ids.length > options.limit
              ? String(position + options.limit)
              : null,
        };
      }),
    thread: (actor: Actor, accountId: string, threadId: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        const emails = await getThread(c, threadId);
        return {
          id: threadId,
          messages: emails
            .toSorted((a, b) => a.receivedAt.localeCompare(b.receivedAt))
            .map((item) => message(item, list, c.address)),
        };
      }),
    action: (
      actor: Actor,
      accountId: string,
      threadId: string,
      action: MailAction,
      messageIds?: string[],
    ) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        const all = await getThread(c, threadId);
        if (
          messageIds &&
          (messageIds.length === 0 ||
            messageIds.some((id) => !all.some((item) => item.id === id)))
        )
          return fail("not_found");
        if (
          action.type === "move" &&
          !list.some((item) => item.id === action.mailboxId)
        )
          return fail("not_found");
        if (
          action.type === "labels" &&
          action.labels.some((id) => !customIds(list).has(id))
        )
          return fail("validation");
        const targets = messageIds
          ? all.filter((item) => messageIds.includes(item.id))
          : all;
        await Promise.all(
          targets.map(async (email) => {
            if (action.type === "delete") {
              value(await c.client.destroyEmail(c.session, c.id, email.id));
              return;
            }
            let patch: Record<string, unknown>;
            if (action.type === "read" || action.type === "star")
              patch = {
                [`keywords/${action.type === "read" ? "$seen" : "$flagged"}`]:
                  action.value ? true : null,
              };
            else if (action.type === "labels") {
              const custom = customIds(list);
              const ids = [
                ...memberships(email).filter((id) => !custom.has(id)),
                ...action.labels,
              ];
              patch = {
                mailboxIds: Object.fromEntries(ids.map((id) => [id, true])),
              };
            } else {
              const dest =
                action.type === "move"
                  ? action.mailboxId
                  : role(list, action.type === "archive" ? "archive" : "trash");
              const custom = customIds(list);
              const ids = [
                ...memberships(email).filter((id) => custom.has(id)),
                dest,
              ];
              patch = {
                mailboxIds: Object.fromEntries(ids.map((id) => [id, true])),
              };
            }
            value(await c.client.updateEmail(c.session, c.id, email.id, patch));
          }),
        );
        return { success: true } satisfies { success: true };
      }),
    drafts: (actor: Actor, accountId: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        const ids = value(
          await c.client.queryEmails(c.session, c.id, {
            filter: { inMailbox: role(list, "drafts"), hasKeyword: "$draft" },
          }),
        ).ids;
        const emails = value(await c.client.emails(c.session, c.id, ids)).list;
        return { drafts: emails.map(draft) };
      }),
    createDraft: (actor: Actor, accountId: string, content: DraftContent) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        const created = await create(c, content, list);
        return { ...content, id: created.id };
      }),
    updateDraft: (
      actor: Actor,
      accountId: string,
      id: string,
      content: DraftContent,
    ) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        const previous = await getDraft(c, id, list);
        const created = await create(c, content, list, previous);
        value(await c.client.destroyEmail(c.session, c.id, id));
        return { ...content, id: created.id };
      }),
    deleteDraft: (actor: Actor, accountId: string, id: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        await getDraft(c, id, list);
        value(await c.client.destroyEmail(c.session, c.id, id));
        return { success: true } satisfies { success: true };
      }),
    send: (actor: Actor, accountId: string, id: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const list = await boxes(c);
        const email = await getDraft(c, id, list);
        const recipients = [
          ...addresses(email.to),
          ...addresses(email.cc),
          ...addresses(email.bcc),
        ];
        if (!recipients.length) return fail("validation");
        const identity = value(
          await c.client.identities(c.session, c.id),
        ).list.find(
          (item) => item.email.toLowerCase() === c.address.toLowerCase(),
        );
        if (!identity) return fail("unavailable");
        value(
          await c.client.submit(
            c.session,
            c.id,
            id,
            identity.id,
            {
              mailFrom: { email: c.address },
              rcptTo: recipients.map((item) => ({ email: item.email })),
            },
            role(list, "sent"),
          ),
        );
        return { messageId: id, threadId: email.threadId };
      }),
    upload: (
      actor: Actor,
      accountId: string,
      input: { name: string; type: string; base64: string },
    ) =>
      run(async () => {
        const c = await connect(actor, accountId);
        const bytes = Buffer.from(input.base64, "base64");
        const uploaded = value(
          await c.client.upload(
            c.session,
            c.id,
            bytes,
            input.type || "application/octet-stream",
          ),
        );
        uploads.set(`${c.owner}:${uploaded.blobId}`, {
          name: input.name,
          type: uploaded.type,
          size: uploaded.size,
          owner: c.owner,
        });
        return {
          id: uploaded.blobId,
          blobId: uploaded.blobId,
          name: input.name,
          type: uploaded.type,
          size: uploaded.size,
        };
      }),
    download: (actor: Actor, accountId: string, blobId: string) =>
      run(async () => {
        const c = await connect(actor, accountId);
        return value(await c.client.download(c.session, c.id, blobId));
      }),
  };
}
export type MailService = ReturnType<typeof createMailService>;
