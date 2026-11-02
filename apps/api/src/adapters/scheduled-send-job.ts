import {
  createGuards as createCoreGuards,
  start,
} from "@opensuite/core/adapters/scheduled-send";
import type { PrismaClient } from "@opensuite/db";
import type { FastifyInstance } from "fastify";
import { createReleaseAuthorization } from "./scheduled-send-authorization.ts";
import { createScheduledWorker } from "./scheduled-send-worker.ts";

export function createGuards(
  db: PrismaClient,
  deps: Omit<Parameters<typeof createReleaseAuthorization>[0], "db">,
) {
  return {
    ...createCoreGuards(db),
    processRow: createScheduledWorker(
      createReleaseAuthorization({ db, ...deps }),
      deps.domains,
    ),
  };
}
export function register(
  app: FastifyInstance,
  service: { reconcileScheduled(): Promise<void> },
) {
  const stop = start(service, () =>
    app.log.warn("scheduled send reconciliation failed"),
  );
  app.addHook("onClose", stop);
}
