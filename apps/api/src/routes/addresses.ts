import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";
import { requireSession } from "./session.ts";

const addresses = implement(contract.addresses).$context<ApiContext>();
const service = (context: ApiContext) => {
  if (!context.addresses)
    throw new ORPCError("SERVICE_UNAVAILABLE", { defined: true });
  return context.addresses;
};
async function value<T>(
  promise: PromiseLike<Result<T, { kind: string }>>,
): Promise<T> {
  const result = await promise;
  if (result.isOk()) return result.value;
  const code =
    result.error.kind === "invalid"
      ? "BAD_REQUEST"
      : result.error.kind === "reserved"
        ? "RESERVED"
        : result.error.kind === "not_found"
          ? "NOT_FOUND"
          : result.error.kind === "conflict"
            ? "CONFLICT"
            : result.error.kind === "limit"
              ? "ADDRESS_LIMIT_REACHED"
              : "SERVICE_UNAVAILABLE";
  throw new ORPCError(code, { defined: true });
}
export const addressesRouter = addresses.router({
  list: addresses.list
    .use(requireSession)
    .handler(({ context }) => value(service(context).list(context.actor))),
  domains: addresses.domains
    .use(requireSession)
    .handler(({ context }) => value(service(context).domains())),
  create: addresses.create.use(requireSession).handler(({ context, input }) => {
    if (!context.addressMutationLimit(context.actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { defined: true });
    return value(service(context).create(context.actor, input));
  }),
  remove: addresses.remove.use(requireSession).handler(({ context, input }) => {
    if (!context.addressMutationLimit(context.actor.id))
      throw new ORPCError("TOO_MANY_REQUESTS", { defined: true });
    return value(service(context).remove(context.actor, input.id));
  }),
});
