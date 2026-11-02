import { createGuards, start } from "@opensuite/core/adapters/scheduled-send";
import type { FastifyInstance } from "fastify";

export { createGuards };

export function register(
  app: FastifyInstance,
  service: { reconcileScheduled(): Promise<void> },
) {
  const stop = start(service, () =>
    app.log.warn("scheduled send reconciliation failed"),
  );
  app.addHook("onClose", stop);
}
