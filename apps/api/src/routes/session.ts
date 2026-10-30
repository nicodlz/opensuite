import { ORPCError, os } from "@orpc/server";
import type { ApiContext } from "./context.ts";

/** Use on every procedure that requires a live, provisioned account. */
export const requireSession = os
  .$context<ApiContext>()
  .middleware(({ context, next }) => {
    if (context.actor === null) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { actor: context.actor } });
  });
export const requireAdmin = os
  .$context<ApiContext>()
  .middleware(async ({ context, next }) => {
    if (context.actor === null || context.actor.role !== "admin") {
      await context.audit?.({
        userId: context.actor?.id ?? null,
        action: "admin.access_denied",
      });
      throw new ORPCError(
        context.actor === null ? "UNAUTHORIZED" : "FORBIDDEN",
      );
    }
    return next({ context: { actor: context.actor } });
  });
