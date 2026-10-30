import { contract } from "@opensuite/contracts";
import { implement, ORPCError } from "@orpc/server";
import { setupRouter } from "./setup.ts";
import { domainsRouter } from "./domains.ts";
import { requireAdmin, requireSession } from "./session.ts";
import type { ApiContext } from "./context.ts";

const account = implement(contract.account).$context<ApiContext>();
const admin = implement(contract.admin).$context<ApiContext>();
export const accountRouter = account.router({
  me: account.me.use(requireSession).handler(({ context }) => {
    return context.actor;
  }),
  mailbox: account.mailbox
    .use(requireSession)
    .handler(async ({ context, input }) => {
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
  setup: setupRouter,
  accounts: {
    list: admin.accounts.list.use(requireAdmin).handler(async ({ context }) => {
      if (context.accounts === undefined)
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      const result = await context.accounts.list(context.actor);
      if (result.isErr()) throw new ORPCError("INTERNAL_SERVER_ERROR");
      return result.value;
    }),
    disable: admin.accounts.disable
      .use(requireAdmin)
      .handler(async ({ context, input }) => {
        if (context.accounts === undefined)
          throw new ORPCError("INTERNAL_SERVER_ERROR");
        const result = await context.accounts.disable(
          context.actor,
          input.userId,
        );
        if (result.isErr()) {
          await context.audit?.({
            userId: context.actor.id,
            action: "admin.account.disable.failure",
          });
          throw new ORPCError(
            result.error.kind === "forbidden"
              ? "FORBIDDEN"
              : "INTERNAL_SERVER_ERROR",
          );
        }
        return { disabled: true };
      }),
  },
});
