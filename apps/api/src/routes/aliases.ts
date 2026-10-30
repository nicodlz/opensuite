import { contract } from "@opensuite/contracts";
import type { AliasService } from "@opensuite/core/services/aliases";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";
import { requireSession } from "./session.ts";

const aliases = implement(contract.aliases).$context<ApiContext>();
const service = (context: ApiContext): AliasService => {
  if (!context.aliases) throw new ORPCError("SERVICE_UNAVAILABLE");
  return context.aliases;
};
const value = async <T>(
  promise: Promise<Result<T, { kind: string }>>,
): Promise<T> => {
  const result = await promise;
  if (result.isOk()) return result.value;
  if (result.error.kind === "limit")
    throw new ORPCError("ALIAS_CAP_REACHED", {
      status: 429,
      defined: true,
      message: "Alias cap reached",
    });
  const code =
    result.error.kind === "invalid"
      ? "BAD_REQUEST"
      : result.error.kind === "not_found"
        ? "NOT_FOUND"
        : result.error.kind === "conflict"
          ? "CONFLICT"
          : result.error.kind === "limit"
            ? "TOO_MANY_REQUESTS"
            : "SERVICE_UNAVAILABLE";
  throw new ORPCError(code);
};
export const aliasesRouter = aliases.router({
  domains: aliases.domains
    .use(requireSession)
    .handler(({ context }) => value(service(context).domains())),
  list: aliases.list
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).list(context.actor.id, input.search)),
    ),
  create: aliases.create
    .use(requireSession)
    .handler(async ({ context, input }) => {
      const instance = service(context);
      const existing = await value(
        instance.findRequest(context.actor.id, input.requestId),
      );
      if (!existing && !context.aliasCreationLimit(context.actor.id))
        throw new ORPCError("TOO_MANY_REQUESTS");
      return value(instance.create(context.actor.id, input));
    }),
  update: aliases.update
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).update(context.actor.id, input.id, input)),
    ),
  enable: aliases.enable
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).transition(context.actor.id, input.id, "enable")),
    ),
  disable: aliases.disable
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).transition(context.actor.id, input.id, "disable")),
    ),
  delete: aliases.delete
    .use(requireSession)
    .handler(async ({ context, input }) => {
      await value(
        service(context).transition(context.actor.id, input.id, "delete"),
      );
      return { deleted: true as const };
    }),
  match: aliases.match
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).match(context.actor.id, input.addresses)),
    ),
  setDefault: aliases.setDefault
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).setDefault(context.actor.id, input.domainId)),
    ),
  getDefault: aliases.getDefault
    .use(requireSession)
    .handler(({ context }) =>
      value(service(context).getDefault(context.actor.id)),
    ),
  createKey: aliases.createKey
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).createKey(context.actor.id, input.name)),
    ),
  listKeys: aliases.listKeys
    .use(requireSession)
    .handler(({ context }) =>
      value(service(context).listKeys(context.actor.id)),
    ),
  revokeKey: aliases.revokeKey
    .use(requireSession)
    .handler(({ context, input }) =>
      value(service(context).revokeKey(context.actor.id, input.id)),
    ),
});
