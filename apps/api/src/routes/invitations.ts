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
const result = accessResult;
export const invitationsRouter = invitations.router({
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
