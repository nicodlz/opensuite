import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { AccessFailureKind } from "@opensuite/core/services/jmap-access";
import type { ApiContext } from "./context.ts";

const invitations = implement(contract.invitations).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (!context.actor) throw new ORPCError("UNAUTHORIZED");
  if (!context.invitations)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.invitations };
};
const result = async <T>(
  promise: Promise<Result<T, { kind: AccessFailureKind }>>,
): Promise<T> => {
  const value = await promise;
  if (value.isOk()) return value.value;
  const codes = {
    forbidden: ["FORBIDDEN", 403],
    not_found: ["NOT_FOUND", 404],
    validation: ["VALIDATION", 400],
    conflict: ["CONFLICT", 409],
    unavailable: ["UPSTREAM_UNAVAILABLE", 503],
    rate_limited: ["TOO_MANY_REQUESTS", 429],
  } as const;
  const [code, status] = codes[value.error.kind];
  throw new ORPCError(code, { status, defined: true });
};
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
