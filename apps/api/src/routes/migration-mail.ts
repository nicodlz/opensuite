import { contract } from "@opensuite/contracts";
import type { MailFailure } from "@opensuite/core/services/mail";
import type { MailMigrationService } from "@opensuite/core/services/migration-mail";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";

const route = implement(contract.migrationMail).$context<ApiContext>();
const unavailable = (): never => {
  throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
};
const access = (context: ApiContext) => {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  return {
    actor: context.actor,
    service: context.migrationMail ?? unavailable(),
  };
};
const result = async <T>(promise: Promise<Result<T, MailFailure>>) => {
  const value = await promise;
  if (value.isOk()) return value.value;
  const failures = {
    forbidden: ["FORBIDDEN", 403],
    not_found: ["NOT_FOUND", 404],
    validation: ["VALIDATION", 400],
    conflict: ["CONFLICT", 409],
    unavailable: ["UPSTREAM_UNAVAILABLE", 503],
    rate_limited: ["TOO_MANY_REQUESTS", 429],
  } satisfies Record<MailFailure["kind"], [string, number]>;
  const [code, status] = failures[value.error.kind];
  throw new ORPCError(code, { status, defined: true });
};
export const migrationMailRouter = route.router({
  list: route.list.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.list(actor, input.accountId));
  }),
  create: route.create.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.create(actor, input));
  }),
  report: route.report.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.report(actor, input.accountId, input.jobId));
  }),
  cancel: route.cancel.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.cancel(actor, input.accountId, input.jobId));
  }),
  resume: route.resume.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.resume(actor, input.accountId, input.jobId));
  }),
});

export function startMailMigrationJob(
  service: MailMigrationService,
  onError: () => void,
) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running !== undefined) return;
    running = service
      .work()
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 10_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
