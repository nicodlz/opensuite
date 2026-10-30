import { contract } from "@opensuite/contracts";
import type { MailFailure } from "@opensuite/core/services/mail";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";

const mail = implement(contract.mail).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  if (context.mail === undefined)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", {
      status: 503,
      defined: true,
      message: "Mail service unavailable",
    });
  return { actor: context.actor, service: context.mail };
};
const result = async <T>(
  promise: Promise<Result<T, MailFailure>>,
): Promise<T> => {
  const value = await promise;
  if (value.isOk()) return value.value;
  const codes = {
    forbidden: "FORBIDDEN",
    not_found: "NOT_FOUND",
    validation: "VALIDATION",
    conflict: "CONFLICT",
    unavailable: "UPSTREAM_UNAVAILABLE",
    rate_limited: "TOO_MANY_REQUESTS",
  } satisfies Record<MailFailure["kind"], string>;
  const statuses = {
    forbidden: 403,
    not_found: 404,
    validation: 400,
    conflict: 409,
    unavailable: 503,
    rate_limited: 429,
  } satisfies Record<MailFailure["kind"], number>;
  throw new ORPCError(codes[value.error.kind], {
    status: statuses[value.error.kind],
    defined: true,
  });
};
export const mailRouter = mail.router({
  identity: mail.identity.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.identity(actor, input.accountId));
  }),
  mailboxes: mail.mailboxes.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.mailboxes(actor, input.accountId));
  }),
  threads: mail.threads.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.threads(actor, input.accountId, input));
  }),
  thread: mail.thread.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.thread(actor, input.accountId, input.threadId));
  }),
  action: mail.action.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(
      service.action(
        actor,
        input.accountId,
        input.threadId,
        input.action,
        input.messageIds,
      ),
    );
  }),
  drafts: mail.drafts.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.drafts(actor, input.accountId));
  }),
  createDraft: mail.createDraft.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.createDraft(actor, input.accountId, input.draft));
  }),
  updateDraft: mail.updateDraft.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(
      service.updateDraft(actor, input.accountId, input.draftId, input.draft),
    );
  }),
  deleteDraft: mail.deleteDraft.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.deleteDraft(actor, input.accountId, input.draftId));
  }),
  send: mail.send.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.send(actor, input.accountId, input.draftId));
  }),
  upload: mail.upload.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.upload(actor, input.accountId, input));
  }),
  download: mail.download.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    await result(service.download(actor, input.accountId, input.blobId));
    return context.downloads.issue(actor.id, input.accountId, input.blobId);
  }),
});
