import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import { requireAdmin } from "./session.ts";
import type { DomainService } from "@opensuite/core/services/domains";
import type { Result } from "neverthrow";

const domains = implement(contract.admin.domains).$context<ApiContext>();
function service(context: ApiContext): DomainService {
  if (context.domains === undefined) throw new ORPCError("SERVICE_UNAVAILABLE");
  return context.domains;
}
function value<T>(result: Result<T, { kind: string }>): T {
  if (result.isErr())
    throw new ORPCError(
      result.error.kind === "forbidden"
        ? "FORBIDDEN"
        : result.error.kind === "invalid"
          ? "BAD_REQUEST"
          : "SERVICE_UNAVAILABLE",
    );
  return result.value;
}
export type { DomainService };
export const domainsRouter = domains.router({
  list: domains.list.use(requireAdmin).handler(async ({ context }) => {
    return value(await service(context).list(context.actor));
  }),
  add: domains.add.use(requireAdmin).handler(async ({ context, input }) => {
    return value(await service(context).add(context.actor, input.name));
  }),
  remove: domains.remove
    .use(requireAdmin)
    .handler(async ({ context, input }) => {
      value(await service(context).remove(context.actor, input.domainId));
      return { removed: true };
    }),
  recheck: domains.recheck
    .use(requireAdmin)
    .handler(async ({ context, input }) => {
      return value(
        await service(context).recheck(context.actor, input.domainId),
      );
    }),
  addAddress: domains.addAddress
    .use(requireAdmin)
    .handler(async ({ context, input }) => {
      return value(await service(context).addAddress(context.actor, input));
    }),
  removeAddress: domains.removeAddress
    .use(requireAdmin)
    .handler(async ({ context, input }) => {
      return value(
        await service(context).removeAddress(
          context.actor,
          input.domainId,
          input.addressId,
        ),
      );
    }),
});
