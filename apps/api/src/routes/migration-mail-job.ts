import type { MailMigrationService } from "@opensuite/core/services/migration-mail";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

function startMailImport(
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
