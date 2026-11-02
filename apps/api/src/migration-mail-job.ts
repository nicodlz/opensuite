import { migrationMailTools } from "@opensuite/core/adapters/migration-mail";
import {
  createMailMigrationService,
  type MailMigrationService,
} from "@opensuite/core/services/migration-mail";
import type { createMailboxStore, PrismaClient } from "@opensuite/db";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

type MailboxStore = Extract<
  ReturnType<typeof createMailboxStore>,
  { value: unknown }
>["value"];

export function createMailImport(
  db: PrismaClient,
  config: { mailboxKey: string; stalwartOrigin: string },
  mailboxes: MailboxStore,
) {
  return createMailMigrationService({
    tools: migrationMailTools,
    db,
    key: config.mailboxKey,
    store: {
      getForOwner: async (userId, accountId) =>
        mailboxes.getForOwner(userId, accountId),
    },
    origin: config.stalwartOrigin,
  });
}

export function startMailImport(
  service: Pick<MailMigrationService, "work">,
  log: Pick<FastifyBaseLogger, "warn">,
) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running !== undefined) return;
    running = service
      .work()
      .then(() => undefined)
      .catch(() => log.warn("mail import worker failed"))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 10_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}

export function registerMailImport(
  app: FastifyInstance,
  service: Pick<MailMigrationService, "work">,
) {
  const stop = startMailImport(service, app.log);
  app.addHook("onClose", stop);
}
