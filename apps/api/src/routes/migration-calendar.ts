import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import { accessResult } from "./access-result.ts";
import { err, type Result } from "neverthrow";
import type { AccessFailureKind } from "@opensuite/core/services/jmap-access";

async function targetResult<T>(
  promise: Promise<Result<T, { kind: AccessFailureKind | "target_missing" }>>,
) {
  const result = await promise;
  if (result.isOk()) return result.value;
  if (result.error.kind === "target_missing")
    throw new ORPCError("TARGET_NOT_FOUND", { status: 404, defined: true });
  return accessResult(Promise.resolve(err({ kind: result.error.kind })));
}
const route = implement(contract.migrationCalendar).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (!context.actor) throw new ORPCError("UNAUTHORIZED");
  if (!context.calendarImport)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.calendarImport };
};
export const migrationCalendarRouter = route.router({
  preview: route.preview.handler(({ context, input }) => {
    const { actor, service } = access(context);
    if (!context.calendarImportPreviewLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    return targetResult(service.preview(actor, input));
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
      action: "calendar.import.confirm.requested",
    });
    const job = await targetResult(service.confirm(actor, input.jobId));
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.confirm.completed",
    });
    return job;
  }),
  recover: route.recover.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    if (
      input.action === "retarget" &&
      !context.calendarImportPreviewLimit(actor.id)
    )
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    await context.audit?.({
      userId: actor.id,
      action: `calendar.import.recover.${input.action}.requested`,
    });
    const job = await targetResult(service.recover(actor, input.jobId, input));
    await context.audit?.({
      userId: actor.id,
      action: `calendar.import.recover.${input.action}.completed`,
    });
    return job;
  }),
  resume: route.resume.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    if (!context.calendarImportResumeLimit(actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { status: 429, defined: true });
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.resume.requested",
    });
    const job = await targetResult(service.resume(actor, input.jobId));
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.resume.completed",
    });
    return job;
  }),
  delete: route.delete.handler(async ({ context, input }) => {
    const { actor, service } = access(context);
    const result = await accessResult(service.delete(actor, input.jobId));
    await context.audit?.({
      userId: actor.id,
      action: "calendar.import.delete",
    });
    return result;
  }),
});
