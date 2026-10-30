import { z } from "zod";
import type { createDomainStore } from "@opensuite/db";
import type { DomainService } from "@opensuite/core/services/domains";

/** Checks already provisioned domains sequentially; failed attempts are retried next interval. */
export function startDomainJob(
  store: ReturnType<typeof createDomainStore>,
  service: DomainService,
  seconds: unknown,
  warn: () => void,
) {
  const interval = z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .parse(seconds === "" ? 3600 : (seconds ?? 3600));
  const backoff = new Map<string, { failures: number; nextAt: number }>();
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running !== undefined) return;
    running = (async () => {
      const targets = await store.verificationTargets();
      if (targets.isErr()) {
        warn();
        return;
      }
      const check = async (index: number): Promise<void> => {
        const target = targets.value[index];
        if (target === undefined) return;
        const retry = backoff.get(target.id);
        if (retry !== undefined && Date.now() < retry.nextAt)
          return check(index + 1);
        const result = await service.recheck(
          { ...target.user, role: "admin" },
          target.id,
          "scheduled",
        );
        if (result.isErr()) {
          warn();
          const failures = Math.min((retry?.failures ?? 0) + 1, 10);
          const delay = Math.min(interval * 2 ** failures, 86400);
          backoff.set(target.id, {
            failures,
            nextAt: Date.now() + delay * 1000,
          });
        } else backoff.delete(target.id);
        return check(index + 1);
      };
      await check(0);
    })()
      .catch(warn)
      .finally(() => {
        running = undefined;
      });
  }, interval * 1000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
