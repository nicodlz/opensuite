import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import { accessResult } from "./access-result.ts";
import { createFixedWindow } from "../auth/fixed-window.ts";

const route = implement(contract.migrationCalendar).$context<ApiContext>();
const previewLimit = createFixedWindow();
const access = (context: ApiContext) => {
  if (!context.actor) throw new ORPCError("UNAUTHORIZED");
  if (!context.calendar?.migration)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.calendar.migration };
};
export const migrationCalendarRouter = route.router({
  preview: route.preview.handler(({ context, input }) => {
    const { actor, service } = access(context);
    if (previewLimit.consume(actor.id, 3))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return accessResult(service.preview(actor, input));
  }),
  list: route.list.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return accessResult(service.list(actor, input.accountId));
  }),
  get: route.get.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return accessResult(service.get(actor, input.jobId));
  }),
  confirm: route.confirm.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.confirm",
    });
    return accessResult(service.confirm(actor, input.jobId));
  }),
  recover: route.recover.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    await context.audit?.({
      userId: actor.id,
      action: `calendar.import.recover.${input.action}`,
    });
    return accessResult(service.recover(actor, input.jobId, input));
  }),
  resume: route.resume.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.resume.requested",
    });
    const job = await accessResult(service.resume(actor, input.jobId));
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.resume.completed",
    });
    return job;
  }),
  delete: route.delete.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return accessResult(service.delete(actor, input.jobId));
  }),
});
