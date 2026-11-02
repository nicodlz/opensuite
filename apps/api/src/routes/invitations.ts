import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import { accessResult } from "./access-result.ts";
import type { ApiContext } from "./context.ts";

const invitations = implement(contract.invitations).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (!context.actor) throw new ORPCError("UNAUTHORIZED");
  if (!context.invitations)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.invitations };
};
const organizerAccess = (context: ApiContext) => {
  if (!context.actor) throw new ORPCError("UNAUTHORIZED");
  if (!context.organizer)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.organizer };
};
const result = accessResult;
export const invitationsRouter = invitations.router({
  organize: invitations.organize.handler(async ({ context, input }) => {
    const { actor, service } = organizerAccess(context);
    await context.audit?.({
      userId: actor.id,
      action: "invitation.organize.requested",
    });
    const response = await result(service.organize(actor, input));
    await context.audit?.({
      userId: actor.id,
      action: `invitation.organize.${response.state}`,
    });
    return response;
  }),
  organizedStatus: invitations.organizedStatus.handler(({ context, input }) => {
    const { actor, service } = organizerAccess(context);
    return result(service.status(actor, input.accountId, input.eventId));
  }),
  unverifiedReplies: invitations.unverifiedReplies.handler(
    ({ context, input }) => {
      const { actor, service } = organizerAccess(context);
      return result(service.unverified(actor, input.accountId, input.cursor));
    },
  ),
  processReply: invitations.processReply.handler(async ({ context, input }) => {
    const { actor, service } = organizerAccess(context);
    const response = await result(
      service.reply(actor, input.accountId, input.messageId),
    );
    await context.audit?.({
      userId: actor.id,
      action: `invitation.reply.${response.result}`,
    });
    return response;
  }),
  reconcileOrganized: invitations.reconcileOrganized.handler(
    ({ context, input }) => {
      const { actor, service } = organizerAccess(context);
      return result(
        service.reconcile(actor, input.accountId, input.operationId),
      );
    },
  ),
  read: invitations.read.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.read(actor, input.accountId, input.messageId));
  }),
  act: invitations.act.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    await context.audit?.({
      userId: actor.id,
      action: "invitation.action.requested",
    });
    const response = await result(service.act(actor, input));
    await context.audit?.({
      userId: actor.id,
      action: `invitation.action.${response.state}`,
    });
    return response;
  }),
  confirm: invitations.confirm.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    await context.audit?.({
      userId: actor.id,
      action: "invitation.confirm.requested",
    });
    const response = await result(service.confirm(actor, input));
    await context.audit?.({
      userId: actor.id,
      action: `invitation.confirm.${response.state}`,
    });
    return response;
  }),
  reconcile: invitations.reconcile.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.reconcile(actor, input.accountId, input.operationId));
  }),
});
