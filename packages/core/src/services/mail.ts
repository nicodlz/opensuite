import {
  type Draft,
  type DraftContent,
  type MailAction,
  type Mailbox,
  type MailSearch,
  type Message,
  type ThreadSummary,
} from "@opensuite/contracts";
import {
  JmapCapability,
  mailAddresses,
  mailAttachments,
  mailBody,
  mailFilterFor,
  mailboxMemberships,
  type Email,
  type JmapClient,
} from "@opensuite/jmap";
import type { Actor } from "./accounts.ts";
import {
  createScheduledSend,
  draftGuard,
  draftOperations,
  getDraft,
  senderFor,
  type ScheduledAdapters,
} from "./scheduled-send.ts";
import {
  createJmapAccess,
  fail,
  value,
  type AccessFailureKind,
  type MailCredentialStore,
} from "./jmap-access.ts";

type MailConnection = Parameters<typeof senderFor>[0];
export type MailFailureKind = AccessFailureKind;
export type MailFailure = { kind: MailFailureKind };
export type { MailCredentialStore } from "./jmap-access.ts";
export interface ThreadOptions {
  mailboxId: string;
  cursor?: string | undefined;
  limit: number;
  search?: MailSearch | undefined;
  sort: "newest" | "oldest";
}
const date = (timestamp: string) => new Date(timestamp).toISOString();
const customIds = (boxes: Mailbox[]) =>
  new Set(boxes.filter((box) => box.role === "custom").map((box) => box.id));
function message(email: Email, boxes: Mailbox[], fallback: string): Message {
  const from = mailAddresses(email.from)[0] ?? { email: fallback };
  const mailboxIds = mailboxMemberships(email);
  const custom = customIds(boxes);
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
    sentAt: date(email.sentAt ?? email.receivedAt),
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
function draft(email: Email): Draft {
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
const role = (list: Mailbox[], name: Mailbox["role"]) =>
  list.find((box) => box.role === name)?.id ?? fail("not_found");
async function applyAction(
  c: MailConnection,
  email: Email,
  action: MailAction,
  list: Mailbox[],
) {
  if (action.type === "delete") {
    value(await c.client.destroyEmail(c.session, c.id, email.id));
    return;
  }
  let patch: Record<string, unknown>;
  if (action.type === "read" || action.type === "star") {
    patch = {
      [`keywords/${action.type === "read" ? "$seen" : "$flagged"}`]:
        action.value ? true : null,
    };
  } else {
    const custom = customIds(list);
    const retained = mailboxMemberships(email).filter((id) =>
      action.type === "labels" ? !custom.has(id) : custom.has(id),
    );
    const additions =
      action.type === "labels"
        ? action.labels
        : [
            action.type === "move"
              ? action.mailboxId
              : role(list, action.type === "archive" ? "archive" : "trash"),
          ];
    patch = {
      mailboxIds: Object.fromEntries(
        [...retained, ...additions].map((id) => [id, true]),
      ),
    };
  }
  value(await c.client.updateEmail(c.session, c.id, email.id, patch));
}
type DraftAccess = Omit<Parameters<typeof draftOperations>[0], "guard">;
function draftRecovery(
  deps: DraftAccess & {
    store: ScheduledAdapters["scheduledStore"];
    create: (
      c: MailConnection,
      content: DraftContent,
      boxes: Mailbox[],
      prior: Email,
    ) => Promise<{ id: string; threadId: string }>;
  },
) {
  return (actor: Actor, accountId: string, id: string) =>
    deps.run(async () => {
      const c = await deps.connect(actor, accountId);
      if (!deps.store) return fail("unavailable");
      if ((await deps.store.guardStatus(actor.id, c.id, id)) !== "unknown")
        return fail("conflict");
      const list = await deps.boxes(c);
      const original = await getDraft(c, id, list);
      const content = draft(original);
      const created = await deps.create(c, content, list, original);
      return {
        draft: { ...content, id: created.id, threadId: created.threadId },
        state: "unknown" as const,
        originalMayStillSend: true as const,
      };
    });
}
/** One instance per server; credentials and client instances never leave this service. */
export function createMailService(dependencies: {
  store: MailCredentialStore;
  origin: string;
  client?: (credential: { address: string; secret: string }) => JmapClient;
  now?: () => number;
  canSendAs?: (userId: string, address: string) => Promise<string | null>;
  beforeAliasSend?: (userId: string, aliasId: string) => Promise<boolean>;
  scheduledStore?: ScheduledAdapters["scheduledStore"];
  guardDraft?: ScheduledAdapters["guardDraft"];
  findSubmission?: ScheduledAdapters["findSubmission"];
  delaySeconds?: ScheduledAdapters["delaySeconds"];
  submit?: ScheduledAdapters["submit"];
  reserve?: ScheduledAdapters["reserve"];
  sweep?: ScheduledAdapters["sweep"];
}) {
  const { run, connect: open, now } = createJmapAccess(dependencies);
  const uploads = new Map<
    string,
    { name: string; type: string; size: number; expires: number }
  >();
  const connect = (actor: Actor, accountId: string) =>
    open(actor, accountId, JmapCapability.mail);
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
  const create = async (
    c: Connection,
    content: DraftContent,
    list: Mailbox[],
    prior?: Email,
  ) => {
    const existing = new Map(
      (prior ? mailAttachments(prior) : []).map((item) => [item.blobId, item]),
    );
    const parts = content.attachmentBlobIds.map((blobId) => {
      const key = `${c.owner}:${blobId}`;
      const uploaded = uploads.get(key);
      if (uploaded !== undefined && uploaded.expires <= now())
        uploads.delete(key);
      const item =
        existing.get(blobId) ??
        (uploaded !== undefined && uploaded.expires > now()
          ? uploaded
          : undefined);
      return {
        blobId,
        name: item?.name ?? "attachment",
        type: item?.type ?? "application/octet-stream",
      };
    });
    const from = content.from?.toLowerCase() ?? c.address.toLowerCase();
    if (
      from !== c.address.toLowerCase() &&
      !(await dependencies.canSendAs?.(c.owner, from))
    )
      return fail("forbidden");
    if (from !== c.address.toLowerCase()) {
      const identities = value(await c.client.identities(c.session, c.id)).list;
      if (!identities.some((identity) => identity.email.toLowerCase() === from))
        return fail("validation");
    }
    return value(
      await c.client.createEmail(c.session, c.id, {
        mailboxIds: { [role(list, "drafts")]: true },
        keywords: { $draft: true, $seen: true },
        from: [{ email: from }],
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
  const store = dependencies.scheduledStore;
  const scheduled = createScheduledSend({
    store,
    connect,
    boxes,
    now,
    run,
    sender: (c, email) => senderFor(c, email, dependencies),
    delaySeconds: dependencies.delaySeconds ?? (() => fail("unavailable")),
    submit:
      dependencies.submit ?? (() => Promise.reject(new Error("unavailable"))),
    reserve:
      dependencies.reserve ?? (() => Promise.reject(new Error("unavailable"))),
    sweep:
      dependencies.sweep ?? (() => Promise.reject(new Error("unavailable"))),
    findSubmission:
      dependencies.findSubmission ?? (() => Promise.resolve(undefined)),
  });
  const guard = draftGuard(store, dependencies.guardDraft);
  const withDraft = draftOperations({ connect, run, boxes, guard });
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
        const pageResult = value(
          await c.client.threadPage(c.session, c.id, {
            filter: mailFilterFor(options),
            sort: [
              {
                property: "receivedAt",
                isAscending: options.sort === "oldest",
              },
            ],
            position,
            limit: options.limit + 1,
          }),
        );
        const page = pageResult.query.ids.slice(0, options.limit);
        if (
          pageResult.selected.notFound.length ||
          pageResult.threads.notFound.length ||
          pageResult.emails.notFound.length
        )
          return fail("conflict");
        const selected = new Map(
          pageResult.selected.list.map((email) => [email.id, email.threadId]),
        );
        const threads = new Map(
          pageResult.threads.list.map((thread) => [thread.id, thread]),
        );
        const emails = new Map(
          pageResult.emails.list.map((email) => [email.id, email]),
        );
        const groups = page.map((id) => {
          const threadId = selected.get(id);
          const thread =
            threadId === undefined ? undefined : threads.get(threadId);
          if (thread === undefined || thread.emailIds.length === 0)
            return fail("conflict");
          return thread.emailIds.map(
            (emailId) => emails.get(emailId) ?? fail("conflict"),
          );
        });
        return {
          threads: groups.map((group) => summary(group, list, c.address)),
          nextCursor:
            pageResult.query.ids.length > options.limit
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
        return guard(
          c,
          targets
            .filter(
              (item) =>
                item.keywords["$draft"] &&
                !["read", "star", "labels"].includes(action.type),
            )
            .map((item) => item.id),
          async (beginWrite) => {
            await beginWrite(action.type === "delete" ? "destroy" : "mutation");
            await targets.reduce<Promise<void>>(
              (previous, email) =>
                previous.then(() => applyAction(c, email, action, list)),
              Promise.resolve(),
            );
            return { success: true } satisfies { success: true };
          },
        );
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
      withDraft(actor, accountId, id, async (c, list, previous, beginWrite) => {
        const created = await create(c, content, list, previous);
        await beginWrite("destroy");
        const removed = await c.client.destroyEmail(c.session, c.id, id);
        if (store) value(removed);
        return { ...content, id: created.id };
      }),
    deleteDraft: (actor: Actor, accountId: string, id: string) =>
      withDraft(actor, accountId, id, async (c, _list, _email, beginWrite) => {
        await beginWrite("destroy");
        value(await c.client.destroyEmail(c.session, c.id, id));
        return { success: true } satisfies { success: true };
      }),
    recoverDraftCopy: draftRecovery({ connect, run, boxes, store, create }),
    send: (actor: Actor, accountId: string, id: string) =>
      withDraft(actor, accountId, id, async (c, list, email, beginWrite) => {
        const { from, identityId, recipients } = await senderFor(
          c,
          email,
          dependencies,
        );
        const requestId = await beginWrite("send");
        value(
          await c.client.submit(
            c.session,
            c.id,
            id,
            identityId,
            { mailFrom: { email: from }, rcptTo: recipients },
            role(list, "sent"),
            { requestId, uncertainFollowup: true },
          ),
        );
        return { messageId: id, threadId: email.threadId };
      }),
    ...scheduled,
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
        for (const [key, entry] of uploads)
          if (entry.expires <= now()) uploads.delete(key);
        if (uploads.size >= 1000) {
          const oldest = uploads.keys().next().value;
          if (oldest !== undefined) uploads.delete(oldest);
        }
        uploads.set(`${c.owner}:${uploaded.blobId}`, {
          name: input.name,
          type: uploaded.type,
          size: uploaded.size,
          expires: now() + 3_600_000,
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
