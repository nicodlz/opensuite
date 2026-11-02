import type { MailService } from "../services/mail.ts";

export function startScheduledSendJob(
  service: Pick<MailService, "reconcileScheduled">,
  onError: () => void,
  intervalMs = 5_000,
) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = service
      .reconcileScheduled()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
