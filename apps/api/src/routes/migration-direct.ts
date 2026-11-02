import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import { migrationAccess, migrationJobActions } from "./migration-mail.ts";
import { accessResult as result } from "./access-result.ts";

const route = implement(contract.migrationDirect).$context<ApiContext>();
const access = (context: ApiContext) =>
  migrationAccess(context, context.migrationDirect);
export const migrationDirectRouter = route.router({
  create: route.create.handler(({ context, input }) => {
    const { actor, service } = access(context);
    if (!context.directImportCreationLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return result(service.create(actor, input));
  }),
  list: route.list.handler(({ context, input }) =>
    migrationJobActions(context, context.migrationDirect).list(input.accountId),
  ),
  report: route.report.handler(({ context, input }) =>
    migrationJobActions(context, context.migrationDirect).report(
      input.accountId,
      input.jobId,
    ),
  ),
  cancel: route.cancel.handler(({ context, input }) =>
    migrationJobActions(context, context.migrationDirect).cancel(
      input.accountId,
      input.jobId,
    ),
  ),
  revoke: route.revoke.handler(({ context, input }) => {
    const { actor, service } = access(context);
    if (!context.directImportMutationLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return result(service.revoke(actor, input.accountId, input.jobId));
  }),
  abandon: route.abandon.handler(({ context, input }) => {
    const { actor, service } = access(context);
    if (!context.directImportMutationLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return result(
      service.abandon(
        actor,
        input.accountId,
        input.jobId,
        input.uncertainCount,
      ),
    );
  }),
  resume: route.resume.handler(({ context, input }) => {
    const { actor, service } = access(context);
    if (!context.directImportMutationLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return result(
      service.resume(actor, input.accountId, input.jobId, input.password),
    );
  }),
});
