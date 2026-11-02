import { contract } from "@opensuite/contracts";
import type { MailFailure } from "@opensuite/core/services/mail";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Actor } from "@opensuite/core/services/accounts";
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
