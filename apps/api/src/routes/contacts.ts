import { contract } from "@opensuite/contracts";
import type { ContactsFailure } from "@opensuite/core/services/contacts";
import { implement, ORPCError } from "@orpc/server";
import type { Result } from "neverthrow";
import type { ApiContext } from "./context.ts";

const contacts = implement(contract.contacts).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  if (context.contacts === undefined)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.contacts };
};
const failureCodes = {
  forbidden: ["FORBIDDEN", 403],
  not_found: ["NOT_FOUND", 404],
  validation: ["VALIDATION", 400],
  conflict: ["CONFLICT", 409],
  unavailable: ["UPSTREAM_UNAVAILABLE", 503],
  rate_limited: ["TOO_MANY_REQUESTS", 429],
} satisfies Record<ContactsFailure["kind"], [string, number]>;
const result = async <T>(
  promise: Promise<Result<T, ContactsFailure>>,
): Promise<T> => {
  const outcome = await promise;
  if (outcome.isErr()) {
    const [code, status] = failureCodes[outcome.error.kind];
    throw new ORPCError(code, { status, defined: true });
  }
  return outcome.value;
};
export const contactsRouter = contacts.router({
  books: contacts.books.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.books(actor, input.accountId));
  }),
  list: contacts.list.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.list(actor, input.accountId, input));
  }),
  create: contacts.create.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.create(actor, input.accountId, input));
  }),
  update: contacts.update.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.update(actor, input.accountId, input));
  }),
  delete: contacts.delete.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.delete(actor, input.accountId, input));
  }),
  previewImport: contacts.previewImport.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.previewImport(actor, input.accountId, input));
  }),
  import: contacts.import.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.import(actor, input.accountId, input));
  }),
  export: contacts.export.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.export(actor, input.accountId, input));
  }),
  suggest: contacts.suggest.handler(({ context, input }) => {
    const { actor, service } = access(context);
    return result(service.suggest(actor, input.accountId, input));
  }),
});
