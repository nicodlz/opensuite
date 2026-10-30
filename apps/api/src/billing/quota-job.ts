import type { PrismaClient } from "@opensuite/db";
import type { StorageMeter } from "./storage.ts";

export function startQuotaJob(
  db: PrismaClient,
  storage: StorageMeter,
  onError: () => void,
) {
  let running: Promise<void> | undefined;
  const work = async () => {
    // Each batch completes before the next to bound concurrency and paginate.
    /* oxlint-disable eslint/no-await-in-loop */
    let cursor: string | undefined;
    do {
      const page = await db.mailboxLink.findMany({
        where: { status: "active" },
        orderBy: { userId: "asc" },
        take: 100,
        ...(cursor === undefined
          ? {}
          : { cursor: { userId: cursor }, skip: 1 }),
        select: { userId: true },
      });
      for (let i = 0; i < page.length; i += 4) {
        await Promise.all(
          page.slice(i, i + 4).map(async ({ userId }) => {
            try {
              await storage.refresh(userId);
            } catch {
              onError();
            }
          }),
        );
      }
      cursor = page.length === 100 ? page.at(-1)?.userId : undefined;
    } while (cursor !== undefined);
    /* oxlint-enable eslint/no-await-in-loop */
  };
  const tick = () => {
    if (running !== undefined) return;
    running = work()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 300_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
