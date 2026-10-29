import { contract } from "@opensuite/contracts";
import { implement } from "@orpc/server";
import type { ApiContext } from "./context.ts";

const system = implement(contract.system).$context<ApiContext>();

export const systemRouter = system.router({
  health: system.health.handler(({ context }) => ({
    status: "ok" as const,
    uptimeSeconds: context.uptimeSeconds(),
  })),
  ready: system.ready.handler(async ({ context, errors }) => {
    const { readiness, failures } = await context.readiness.check();
    if (readiness.status === "not_ready") {
      context.log.warn({ failures }, "readiness check failed");
      throw errors.NOT_READY({ data: readiness });
    }
    return readiness;
  }),
});
