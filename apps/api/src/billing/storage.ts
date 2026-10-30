import type { PrismaClient } from "@opensuite/db";
import type { StalwartAdmin } from "@opensuite/jmap/admin";
import { z } from "zod";
import type { Entitlements } from "./entitlements.ts";

const DriveUsage = z.object({
  driveBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const createStorageMeter = (
  db: PrismaClient,
  entitlements: Entitlements,
  mail: StalwartAdmin,
  driveOrigin: string,
  token: string | undefined,
) => {
  const mailBytes = async (userId: string) => {
    const link = await db.mailboxLink.findUnique({
      where: { userId },
      select: { accountId: true, status: true },
    });
    if (link === null || link.status !== "active")
      throw new Error("mail usage unavailable");
    const usage = await mail.diskUsage(link.accountId);
    if (usage.isErr()) throw new Error("mail usage unavailable");
    return usage.value;
  };
  const driveBytes = async (userId: string) => {
    if (token === undefined) throw new Error("Drive usage unavailable");
    const response = await fetch(
      new URL(`/internal/usage/${encodeURIComponent(userId)}`, driveOrigin),
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Drive usage unavailable");
    return DriveUsage.parse(await response.json()).driveBytes;
  };
  const measure = async (userId: string) => {
    const [drive, mailbox] = await Promise.allSettled([
      driveBytes(userId),
      mailBytes(userId),
    ]);
    const driveUsed = drive.status === "fulfilled" ? drive.value : 0;
    const mailUsed = mailbox.status === "fulfilled" ? mailbox.value : 0;
    if (!Number.isSafeInteger(driveUsed + mailUsed))
      throw new Error("storage usage overflow");
    return {
      driveBytes: driveUsed,
      mailBytes: mailUsed,
      usedBytes: driveUsed + mailUsed,
      measured: drive.status === "fulfilled" && mailbox.status === "fulfilled",
    };
  };
  const lastQuota = new Map<string, { value: number | null; at: number }>();
  const refreshOne = async (userId: string) => {
    const [entitlement, link] = await Promise.all([
      entitlements.get(userId),
      db.mailboxLink.findUnique({
        where: { userId },
        select: { accountId: true, status: true },
      }),
    ]);
    if (link === null || link.status !== "active")
      throw new Error("mailbox unavailable");
    // A zero Stalwart quota means unlimited; use one byte for a blocked account.
    const quota =
      entitlement.quotaBytes === null
        ? null
        : entitlement.quotaBytes === 0
          ? 1
          : Math.max(1, entitlement.quotaBytes - (await driveBytes(userId)));
    const previous = lastQuota.get(link.accountId);
    if (
      previous &&
      previous.value === quota &&
      Date.now() - previous.at < 300_000
    )
      return;
    const result = await mail.setDiskQuota(link.accountId, quota);
    if (result.isErr()) throw new Error("mail quota unavailable");
    if (lastQuota.size >= 1000) lastQuota.clear();
    lastQuota.set(link.accountId, { value: quota, at: Date.now() });
  };
  const jobs = new Map<
    string,
    {
      dirty: boolean;
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  >();
  const queue: string[] = [];
  let running = 0;
  const drain = () => {
    while (running < 4 && queue.length > 0) {
      const userId = queue.shift();
      if (userId === undefined) break;
      const job = jobs.get(userId);
      if (job === undefined) continue;
      running++;
      void (async () => {
        try {
          do {
            job.dirty = false;
            // Coalesce requests while preserving their final state.
            // oxlint-disable-next-line eslint/no-await-in-loop
            await refreshOne(userId);
            // Calls may set dirty while refreshOne awaits I/O.
            // oxlint-disable-next-line typescript/no-unnecessary-condition
          } while (job.dirty);
          job.resolve();
        } catch (error) {
          job.reject(error);
        } finally {
          jobs.delete(userId);
          running--;
          drain();
        }
      })();
    }
  };
  const refresh = (userId: string): Promise<void> => {
    const existing = jobs.get(userId);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    if (jobs.size >= 256)
      return Promise.reject(new Error("quota refresh queue full"));
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    jobs.set(userId, { dirty: false, promise, resolve, reject });
    queue.push(userId);
    drain();
    return promise;
  };
  return { mailBytes, driveBytes, measure, refresh };
};
export type StorageMeter = ReturnType<typeof createStorageMeter>;
