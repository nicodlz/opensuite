import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import { accessResult } from "./access-result.ts";
import type { ApiContext } from "./context.ts";

const contacts = implement(contract.contacts).$context<ApiContext>();
const access = (context: ApiContext) => {
  if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
  if (context.contacts === undefined)
    throw new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, defined: true });
  return { actor: context.actor, service: context.contacts };
};
const result = accessResult;
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
