import {
  mailContract,
  type Draft,
  type Message,
  type ThreadSummary,
} from "@opensuite/contracts";
import { ORPCError } from "@orpc/client";
import { createRouterClient, implement } from "@orpc/server";

// Synthetic mailbox data lives only in the development bundle.
const fixtureMarker = "OPENMAIL_SYNTHETIC_FIXTURE_ONLY";
const account = { name: "You", email: "you@example.test" };
const initial: Message[] = [
  {
    id: "m1",
    threadId: "t1",
    mailboxIds: ["inbox"],
    from: { name: "Maya Chen", email: "maya@example.test" },
    to: [account],
    cc: [],
    bcc: [],
    subject: "A little update for Friday",
    sentAt: "2026-10-28T10:30:00.000Z",
    messageId: "<m1@example.test>",
    references: [],
    headers: [],
    htmlBody:
      '<p>Hi there,</p><p>Here’s the latest update. I thought you might like a look before Friday.</p><p>Let me know what you think!</p><p>Maya</p><img src="https://images.example.test/update.png" alt="Project update"><img src="cid:photo@example.test" alt="Inline photo">',
    textBody: "Hi there, Here’s the latest update. Let me know what you think!",
    attachments: [
      {
        id: "inline",
        blobId: "inline",
        cid: "photo@example.test",
        name: "photo.png",
        type: "image/png",
        size: 68,
      },
    ],
    unread: true,
    starred: false,
    labels: ["work"],
  },
  {
    id: "m2",
    threadId: "t2",
    mailboxIds: ["inbox"],
    from: { name: "Alex Rivera", email: "alex@example.test" },
    replyTo: [{ email: "replies@example.test" }],
    to: [account],
    cc: [],
    bcc: [],
    subject: "Weekend plans",
    sentAt: "2026-10-27T15:00:00.000Z",
    messageId: "<m2@example.test>",
    references: [],
    headers: [],
    htmlBody: "<p>Are you free to catch up this weekend?</p>",
    textBody: "",
    attachments: [],
    unread: false,
    starred: true,
    labels: [],
  },
  {
    id: "m3",
    threadId: "t3",
    mailboxIds: ["inbox"],
    from: { name: "Studio Notes", email: "notes@example.test" },
    to: [account],
    cc: [],
    bcc: [],
    subject: "Ideas worth keeping",
    sentAt: "2026-10-25T08:00:00.000Z",
    references: [],
    headers: [],
    htmlBody: "",
    textBody: "Plain text with <b>literal markup</b>\nand a second line.",
    attachments: [],
    unread: false,
    starred: false,
    labels: [],
  },
];
const messages = structuredClone(initial);
let drafts: Draft[] = [];
const blobs = new Map<string, { name: string; type: string; base64: string }>([
  [
    "inline",
    {
      name: "photo.png",
      type: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
    },
  ],
]);
const folders = [
  { id: "inbox", name: "Inbox", role: "inbox" },
  { id: "drafts", name: "Drafts", role: "drafts" },
  { id: "sent", name: "Sent", role: "sent" },
  { id: "archive", name: "Archive", role: "archive" },
  { id: "trash", name: "Trash", role: "trash" },
  { id: "work", name: "Work", role: "custom" },
] satisfies {
  id: string;
  name: string;
  role: "inbox" | "drafts" | "sent" | "archive" | "trash" | "custom";
}[];
const api = implement(mailContract);
function summaries(): ThreadSummary[] {
  return Array.from(new Set(messages.map((message) => message.threadId))).map(
    (id) => {
      const group = messages.filter((message) => message.threadId === id);
      const last = group.at(-1);
      if (!last) throw new Error("Empty thread");
      return {
        id,
        subject: last.subject,
        participants: group.map((message) => message.from),
        preview: last.textBody,
        updatedAt: last.sentAt,
        messageCount: group.length,
        unread: group.some((message) => message.unread),
        starred: group.some((message) => message.starred),
        hasAttachment: group.some((message) => message.attachments.length > 0),
        mailboxIds: [
          ...new Set(group.flatMap((message) => message.mailboxIds)),
        ],
        labels: [...new Set(group.flatMap((message) => message.labels))],
      };
    },
  );
}
const router = api.router({
  identity: api.identity.handler(() => ({ address: account })),
  mailboxes: api.mailboxes.handler(() => ({
    mailboxes: folders.map((folder) => {
      const group = summaries().filter((thread) =>
        folder.id === "work"
          ? thread.labels.includes("work")
          : thread.mailboxIds.includes(folder.id),
      );
      return Object.assign({}, folder, {
        total: folder.id === "drafts" ? drafts.length : group.length,
        unread: group.filter((thread) => thread.unread).length,
      });
    }),
  })),
  threads: api.threads.handler(({ input, errors }) => {
    if (sessionStorage.getItem("mail-fixture-unauthorized") === "1")
      throw new ORPCError("UNAUTHORIZED", { status: 401 });
    if (sessionStorage.getItem("mail-fixture-fail-list") === "1")
      throw errors.UPSTREAM_UNAVAILABLE();
    const search = input.search;
    const filtered = summaries()
      .filter((thread) => {
        const group = messages.filter(
          (message) => message.threadId === thread.id,
        );
        const query = search?.query?.toLowerCase();
        return (
          (input.mailboxId === "work"
            ? thread.labels.includes("work")
            : thread.mailboxIds.includes(input.mailboxId)) &&
          (!query ||
            group.some((message) =>
              `${message.subject} ${message.textBody} ${message.from.email} ${message.from.name ?? ""}`
                .toLowerCase()
                .includes(query),
            )) &&
          (!search?.from ||
            group.some((message) =>
              message.from.email
                .toLowerCase()
                .includes(search.from?.toLowerCase() ?? ""),
            )) &&
          (!search?.to ||
            group.some((message) =>
              message.to.some((address) =>
                address.email
                  .toLowerCase()
                  .includes(search.to?.toLowerCase() ?? ""),
              ),
            )) &&
          (search?.hasAttachment === undefined ||
            thread.hasAttachment === search.hasAttachment) &&
          (search?.unread === undefined || thread.unread === search.unread) &&
          (!search?.after || thread.updatedAt >= search.after) &&
          (!search?.before || thread.updatedAt <= search.before)
        );
      })
      .toSorted((a, b) =>
        input.sort === "newest"
          ? b.updatedAt.localeCompare(a.updatedAt)
          : a.updatedAt.localeCompare(b.updatedAt),
      );
    const offset = Number(input.cursor ?? 0);
    const page = filtered.slice(offset, offset + input.limit);
    return {
      threads: page,
      nextCursor:
        offset + input.limit < filtered.length
          ? String(offset + input.limit)
          : null,
    };
  }),
  thread: api.thread.handler(({ input, errors }) => {
    const group = messages.filter(
      (message) => message.threadId === input.threadId,
    );
    if (!group.length) throw errors.NOT_FOUND();
    return { id: input.threadId, messages: group };
  }),
  action: api.action.handler(({ input, errors }) => {
    if (sessionStorage.getItem("mail-fixture-fail-action") === "1")
      throw errors.UPSTREAM_UNAVAILABLE();
    const group = messages.filter(
      (message) =>
        message.threadId === input.threadId &&
        (!input.messageIds || input.messageIds.includes(message.id)),
    );
    if (!group.length) throw errors.NOT_FOUND();
    if (input.action.type === "delete") {
      const ids = new Set(group.map((message) => message.id));
      const remaining = messages.filter((message) => !ids.has(message.id));
      messages.splice(0, messages.length, ...remaining);
      return { success: true };
    }
    for (const message of group) {
      const action = input.action;
      switch (action.type) {
        case "read":
          message.unread = !action.value;
          break;
        case "star":
          message.starred = action.value;
          break;
        case "move":
          message.mailboxIds = [action.mailboxId];
          break;
        case "archive":
          message.mailboxIds = ["archive"];
          break;
        case "trash":
          message.mailboxIds = ["trash"];
          break;
        case "labels":
          message.labels = action.labels;
          break;
      }
    }
    return { success: true };
  }),
  drafts: api.drafts.handler(() => ({ drafts })),
  createDraft: api.createDraft.handler(({ input }) => {
    const draft = { ...input.draft, id: crypto.randomUUID() };
    drafts.push(draft);
    return draft;
  }),
  updateDraft: api.updateDraft.handler(({ input, errors }) => {
    const index = drafts.findIndex((draft) => draft.id === input.draftId);
    if (index < 0) throw errors.NOT_FOUND();
    const draft = { ...input.draft, id: input.draftId };
    drafts[index] = draft;
    return draft;
  }),
  deleteDraft: api.deleteDraft.handler(({ input, errors }) => {
    if (!drafts.some((draft) => draft.id === input.draftId))
      throw errors.NOT_FOUND();
    drafts = drafts.filter((draft) => draft.id !== input.draftId);
    return { success: true };
  }),
  send: api.send.handler(({ input, errors }) => {
    const draft = drafts.find((item) => item.id === input.draftId);
    if (!draft) throw errors.NOT_FOUND();
    if (!draft.to.length) throw errors.VALIDATION();
    const id = crypto.randomUUID();
    const threadId = draft.threadId ?? crypto.randomUUID();
    messages.push({
      id,
      threadId,
      mailboxIds: ["sent"],
      from: account,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      sentAt: new Date().toISOString(),
      messageId: `<${id}@example.test>`,
      references: draft.references,
      headers: [],
      htmlBody: draft.htmlBody,
      textBody: draft.textBody,
      attachments: draft.attachmentBlobIds.map((blobId) => {
        const blob = blobs.get(blobId);
        return {
          id: blobId,
          blobId,
          name: blob?.name ?? "attachment",
          type: blob?.type ?? "application/octet-stream",
          size: blob ? atob(blob.base64).length : 0,
        };
      }),
      unread: false,
      starred: false,
      labels: [],
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
    });
    drafts = drafts.filter((item) => item.id !== draft.id);
    return { messageId: id, threadId };
  }),
  upload: api.upload.handler(({ input }) => {
    const blobId = crypto.randomUUID();
    blobs.set(blobId, {
      name: input.name,
      type: input.type,
      base64: input.base64,
    });
    return {
      id: blobId,
      blobId,
      name: input.name,
      type: input.type,
      size: atob(input.base64).length,
    };
  }),
  download: api.download.handler(({ input, errors }) => {
    const blob = blobs.get(input.blobId);
    if (!blob) throw errors.NOT_FOUND();
    return {
      url: URL.createObjectURL(
        new Blob(
          [Uint8Array.from(atob(blob.base64), (char) => char.charCodeAt(0))],
          { type: "application/octet-stream" },
        ),
      ),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }),
});
export const fakeMailClient = createRouterClient(router);
export { fixtureMarker };
