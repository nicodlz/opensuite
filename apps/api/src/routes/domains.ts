import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import type { ApiContext } from "./context.ts";
import type { DomainService } from "@opensuite/core/services/domains";
import type { Result } from "neverthrow";

const domains = implement(contract.admin.domains).$context<ApiContext>();
function authorize(context: ApiContext) {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  if (context.actor.role !== "admin") throw new ORPCError("FORBIDDEN");
  if (context.domains === undefined) throw new ORPCError("SERVICE_UNAVAILABLE");
  return { actor: context.actor, service: context.domains };
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
  list: domains.list.handler(async ({ context }) => {
    const { actor, service } = authorize(context);
    return value(await service.list(actor));
  }),
  add: domains.add.handler(async ({ context, input }) => {
    const { actor, service } = authorize(context);
    return value(await service.add(actor, input.name));
  }),
  remove: domains.remove.handler(async ({ context, input }) => {
    const { actor, service } = authorize(context);
    value(await service.remove(actor, input.domainId));
    return { removed: true };
  }),
  recheck: domains.recheck.handler(async ({ context, input }) => {
    const { actor, service } = authorize(context);
    return value(await service.recheck(actor, input.domainId));
  }),
  addAddress: domains.addAddress.handler(async ({ context, input }) => {
    const { actor, service } = authorize(context);
    return value(await service.addAddress(actor, input));
  }),
  removeAddress: domains.removeAddress.handler(async ({ context, input }) => {
    const { actor, service } = authorize(context);
    return value(
      await service.removeAddress(actor, input.domainId, input.addressId),
    );
  }),
});
