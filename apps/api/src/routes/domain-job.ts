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
        const result = await service.recheck(
          { ...target.user, role: "admin" },
          target.id,
          "scheduled",
        );
        if (result.isErr()) warn();
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
