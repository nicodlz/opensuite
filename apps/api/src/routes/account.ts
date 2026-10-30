import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import { domainsRouter } from "./domains.ts";
import type { ApiContext } from "./context.ts";

const account = implement(contract.account).$context<ApiContext>();
const admin = implement(contract.admin).$context<ApiContext>();
export const accountRouter = account.router({
  me: account.me.handler(({ context }) => {
    if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
    return context.actor;
  }),
  mailbox: account.mailbox.handler(async ({ context, input }) => {
    if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
    if (context.accounts === undefined)
      throw new ORPCError("INTERNAL_SERVER_ERROR");
    const result = await context.accounts.mailbox(
      context.actor,
      input.accountId,
    );
    if (result.isErr())
      throw new ORPCError(
        result.error.kind === "forbidden"
          ? "FORBIDDEN"
          : "INTERNAL_SERVER_ERROR",
      );
    return result.value;
  }),
});
export const adminRouter = admin.router({
  domains: domainsRouter,
  accounts: {
    list: admin.accounts.list.handler(async ({ context }) => {
      if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
      if (context.actor.role !== "admin") throw new ORPCError("FORBIDDEN");
      if (context.accounts === undefined)
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      const result = await context.accounts.list(context.actor);
      if (result.isErr()) throw new ORPCError("INTERNAL_SERVER_ERROR");
      return result.value;
    }),
    disable: admin.accounts.disable.handler(async ({ context, input }) => {
      if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
      if (context.actor.role !== "admin") throw new ORPCError("FORBIDDEN");
      if (context.accounts === undefined)
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      const result = await context.accounts.disable(
        context.actor,
        input.userId,
      );
      if (result.isErr())
        throw new ORPCError(
          result.error.kind === "forbidden"
            ? "FORBIDDEN"
            : "INTERNAL_SERVER_ERROR",
        );
      return { disabled: true };
    }),
  },
});
