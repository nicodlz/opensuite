import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "@opensuite/core/services/accounts";
import type { AccessFailureKind } from "@opensuite/core/services/jmap-access";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";
import { accessResult as result } from "./access-result.ts";

const route = implement(contract.migrationMail).$context<ApiContext>();
export function migrationAccess<Service>(
  context: ApiContext,
  service: Service | undefined,
) {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  if (service === undefined)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service };
}
type MigrationJobService<List, Report> = {
  list(
    actor: Actor,
    accountId: string,
  ): Promise<Result<List, { kind: AccessFailureKind }>>;
  report(
    actor: Actor,
    accountId: string,
    id: string,
  ): Promise<Result<Report, { kind: AccessFailureKind }>>;
  cancel(
    actor: Actor,
    accountId: string,
    id: string,
  ): Promise<Result<Report, { kind: AccessFailureKind }>>;
};
export function migrationJobActions<List, Report>(
  context: ApiContext,
  provided: MigrationJobService<List, Report> | undefined,
) {
  const { actor, service } = migrationAccess(context, provided);
  return {
    list: (accountId: string) => result(service.list(actor, accountId)),
    report: (accountId: string, id: string) =>
      result(service.report(actor, accountId, id)),
    cancel: (accountId: string, id: string) =>
      result(service.cancel(actor, accountId, id)),
  };
}
const access = (context: ApiContext) =>
  migrationAccess(context, context.migrationMail);
export const migrationMailRouter = route.router({
  list: route.list.handler(({ context, input }) =>
    migrationJobActions(context, context.migrationMail).list(input.accountId),
  ),
  create: route.create.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.create(actor, input));
  }),
  report: route.report.handler(({ context, input }) =>
    migrationJobActions(context, context.migrationMail).report(
      input.accountId,
      input.jobId,
    ),
  ),
  cancel: route.cancel.handler(({ context, input }) =>
    migrationJobActions(context, context.migrationMail).cancel(
      input.accountId,
      input.jobId,
    ),
  ),
  resume: route.resume.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.resume(actor, input.accountId, input.jobId));
  }),
  remap: route.remap.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(
      service.remap(
        actor,
        input.accountId,
        input.jobId,
        input.mailboxId,
        input.labels,
      ),
    );
  }),
  abandon: route.abandon.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(
      service.abandon(
        actor,
        input.accountId,
        input.jobId,
        input.confirm,
        input.uncertainCount,
      ),
    );
  }),
});

/** Authenticate and rate-limit the large upload before Fastify parses its body. */
export function registerMailImportUpload(
  app: FastifyInstance,
  handler: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply>,
  resolveActor: ((headers: Headers) => Promise<Actor | null>) | undefined,
  actors: WeakMap<FastifyRequest, Actor | null>,
  limits: { consume(key: string, count: number, window: number): unknown },
) {
  app.post(
    "/mail/imports/create",
    {
      bodyLimit: 12_000_000,
      onRequest: async (request, reply) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value))
            for (const part of value) headers.append(name, part);
          else headers.set(name, value);
        }
        const actor = (await resolveActor?.(headers)) ?? null;
        if (actor === null)
          return reply
            .code(401)
            .send({ code: "UNAUTHORIZED", message: "Unauthorized" });
        if (
          limits.consume(`mail-import:${actor.id}`, 5, 60_000) !== undefined ||
          limits.consume("mail-import:global", 30, 60_000) !== undefined
        )
          return reply.code(429).send({
            code: "TOO_MANY_REQUESTS",
            message: "Too many import requests",
          });
        actors.set(request, actor);
        return undefined;
      },
    },
    handler,
  );
}
