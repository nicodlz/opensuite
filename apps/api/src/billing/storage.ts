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
  const refresh = async (userId: string) => {
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
    const result = await mail.setDiskQuota(link.accountId, quota);
    if (result.isErr()) throw new Error("mail quota unavailable");
  };
  return { mailBytes, driveBytes, measure, refresh };
};
export type StorageMeter = ReturnType<typeof createStorageMeter>;
