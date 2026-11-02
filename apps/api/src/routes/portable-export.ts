import { contract, type PortableExportInput } from "@opensuite/contracts";
import type { PortableExportService } from "@opensuite/core/services/portable-export";
import type { Actor } from "@opensuite/core/services/accounts";
import { implement, ORPCError } from "@orpc/server";
import { err } from "neverthrow";
import { createFixedWindow } from "../auth/fixed-window.ts";
import { accessResult } from "./access-result.ts";
import type { ApiContext } from "./context.ts";

export function createPortableExportAccess(service: PortableExportService) {
  const active = new Set<string>();
  const windows = createFixedWindow();
  return {
    async run(actor: Actor, input: PortableExportInput) {
      if (
        active.has(actor.id) ||
        active.size >= 8 ||
        windows.consume(actor.id, 5, 60_000) !== undefined
      )
        return err({ kind: "rate_limited" as const });
      active.add(actor.id);
      try {
        return await service.export(actor, input);
      } finally {
        active.delete(actor.id);
      }
    },
  };
}
export type PortableExportAccess = ReturnType<
  typeof createPortableExportAccess
>;
declare module "./server-dependencies.ts" {
  interface ServerDependencies {
    readonly portableExport?: PortableExportAccess | undefined;
  }
}
const portable = implement(contract.portableExport).$context<ApiContext>();
export const portableExportRouter = portable.router({
  export: portable.export.handler(({ context, input }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    if (!context.portableExport)
      throw new ORPCError("UPSTREAM_UNAVAILABLE", {
        status: 503,
        defined: true,
      });
    return accessResult(context.portableExport.run(context.actor, input));
  }),
});
