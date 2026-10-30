import { drivePartSize } from "@opensuite/contracts";
import type { DriveCommand, DriveOutput } from "@opensuite/contracts";
import { ORPCError } from "@orpc/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Entry, Prisma } from "../db/generated/index.js";
import { UploadMismatchError, type Storage } from "../adapters/storage.ts";
import { reserveQuota } from "./quota.ts";
import { createLinkToken, hashLinkToken } from "../sharing/tokens.ts";

const missing = () =>
  new ORPCError("NOT_FOUND", { message: "Entry not found" });
const invalid = (message: string) => new ORPCError("BAD_REQUEST", { message });
const visible = (entry: Entry) => ({
  id: entry.id,
  ownerId: entry.ownerId,
  parentId: entry.parentId,
  name: entry.name,
  kind: entry.kind,
  state: entry.state,
  size: Number(entry.size),
  contentType: entry.contentType,
  trashedAt: entry.trashedAt?.toISOString() ?? null,
  createdAt: entry.createdAt.toISOString(),
});

const creatorShare = (user: string, owner: string) =>
  user === owner
    ? {}
    : {
        shares: {
          create: { id: randomUUID(), userId: user, access: "write" },
        },
      };

const destinationOwner = async (
  client: PrismaClient | Prisma.TransactionClient,
  user: string,
  id: string | null,
  expectedOwner?: string,
) => {
  if (id === null) {
    if (expectedOwner !== undefined && expectedOwner !== user) throw missing();
    return user;
  }
  const item = await client.entry.findFirst({
    where: {
      id,
      ...(expectedOwner === undefined ? {} : { ownerId: expectedOwner }),
      kind: "folder",
      state: "ready",
      trashedAt: null,
      OR: [
        { ownerId: user },
        { shares: { some: { userId: user, access: "write" } } },
      ],
    },
  });
  if (item === null) throw missing();
  return item.ownerId;
};
const lockOwner = async (tx: Prisma.TransactionClient, owner: string) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 0))`;
};

export const createDrive = (
  db: PrismaClient,
  storage: Storage,
  quota: number,
) => {
  const get = async (
    user: string,
    id: string,
    access: "read" | "write" | "owner" = "read",
    includeTrash = false,
  ) => {
    const entry = await db.entry.findFirst({
      where: {
        id,
        ...(includeTrash ? {} : { trashedAt: null }),
        OR:
          access === "owner"
            ? [{ ownerId: user }]
            : [
                { ownerId: user },
                {
                  shares: {
                    some: {
                      userId: user,
                      ...(access === "write" ? { access: "write" } : {}),
                    },
                  },
                },
              ],
      },
    });
    if (entry === null) throw missing();
    return entry;
  };
  // Bound both request rate and memory use. The state claim below also prevents
  // concurrent verification of the same upload across service instances.
  const finishAttempts = new Map<string, { count: number; until: number }>();
  const limitFinish = (user: string) => {
    const now = Date.now();
    for (const [key, value] of finishAttempts)
      if (value.until <= now) finishAttempts.delete(key);
    const current = finishAttempts.get(user);
    if (current !== undefined && current.count >= 10)
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: "Too many upload finalizations",
      });
    if (current !== undefined) current.count++;
    else {
      if (finishAttempts.size >= 10_000)
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "Too many upload finalizations",
        });
      finishAttempts.set(user, { count: 1, until: now + 60_000 });
    }
  };
  const file = async (user: string, id: string) => {
    const entry = await get(user, id);
    if (
      entry.kind !== "file" ||
      entry.state !== "ready" ||
      entry.objectKey === null
    )
      throw missing();
    return entry;
  };
  const command = async (
    user: string,
    input: DriveCommand,
  ): Promise<DriveOutput> => {
    switch (input.action) {
      case "list": {
        if (input.parentId !== null)
          await get(
            user,
            input.parentId,
            input.trash ? "owner" : "read",
            input.trash,
          );
        const entries = await db.entry.findMany({
          where: {
            ...(input.parentId === null || input.trash
              ? { ownerId: user }
              : {
                  OR: [
                    { ownerId: user },
                    { shares: { some: { userId: user } } },
                  ],
                }),
            parentId: input.parentId,
            trashedAt: input.trash ? { not: null } : null,
          },
          orderBy: { createdAt: "asc" },
        });
        return { entries: entries.map(visible) };
      }
      case "shared": {
        const entries = await db.entry.findMany({
          where: {
            trashedAt: null,
            state: "ready",
            shares: { some: { userId: user } },
          },
          orderBy: { createdAt: "asc" },
        });
        return { entries: entries.map(visible) };
      }
      case "folder": {
        const owner = await destinationOwner(db, user, input.parentId);
        return db.$transaction(async (tx) => {
          await lockOwner(tx, owner);
          await destinationOwner(tx, user, input.parentId, owner);
          const entry = await tx.entry.create({
            data: {
              id: randomUUID(),
              ownerId: owner,
              parentId: input.parentId,
              name: input.name,
              ...creatorShare(user, owner),
              kind: "folder",
              state: "ready",
            },
          });
          return visible(entry);
        });
      }
      case "upload": {
        if (!input.multipart && input.size > 5_000_000_000)
          throw invalid("Large files require multipart upload");
        const owner = await destinationOwner(db, user, input.parentId);
        const id = randomUUID();
        const uploadState: { id: string | null } = { id: null };
        try {
          const upload = await db.$transaction(
            async (tx) => {
              await lockOwner(tx, owner);
              await destinationOwner(tx, user, input.parentId, owner);
              const totals = z
                .array(z.object({ total: z.bigint() }))
                .parse(
                  await tx.$queryRaw`SELECT COALESCE(SUM("size"), 0)::bigint AS total FROM "Entry" WHERE "ownerId" = ${owner} AND kind = 'file' AND (state NOT IN ('pending', 'failed') OR "expiresAt" IS NULL OR "expiresAt" > clock_timestamp())`,
                );
              if (
                reserveQuota(
                  totals[0]?.total ?? 0n,
                  BigInt(input.size),
                  BigInt(quota),
                ).isErr()
              )
                throw new ORPCError("FORBIDDEN", { message: "Quota exceeded" });
              await tx.entry.create({
                data: {
                  id,
                  ownerId: owner,
                  parentId: input.parentId,
                  name: input.name,
                  ...creatorShare(user, owner),
                  kind: "file",
                  state: "pending",
                  size: BigInt(input.size),
                  checksum: input.checksum,
                  contentType: input.contentType,
                  expiresAt: new Date(
                    Date.now() + (input.multipart ? 86_400_000 : 300_000),
                  ),
                },
              });
              const started = await storage.initiate(
                id,
                input.contentType,
                input.multipart,
                input.size,
              );
              uploadState.id = started.uploadId;
              await tx.entry.update({
                where: { id },
                data: { uploadId: uploadState.id },
              });
              return started;
            },
            { timeout: 30_000 },
          );
          return { id, url: upload.url, expiresIn: 300 };
        } catch (error) {
          if (uploadState.id !== null)
            await storage.remove(id, null, uploadState.id);
          throw error;
        }
      }
      case "part": {
        const entry = await get(user, input.id, "write");
        if (entry.state !== "pending" || entry.uploadId === null)
          throw invalid("No multipart upload");
        if (entry.expiresAt === null || entry.expiresAt <= new Date())
          throw invalid("Upload expired");
        const expiresIn = Math.min(
          300,
          Math.max(
            1,
            Math.floor((entry.expiresAt.getTime() - Date.now()) / 1000),
          ),
        );
        const partSize = drivePartSize(Number(entry.size));
        const remaining =
          Number(entry.size) - (input.partNumber - 1) * partSize;
        if (remaining <= 0) throw invalid("Part exceeds reserved size");
        return {
          url: await storage.part(
            entry.id,
            entry.uploadId,
            input.partNumber,
            Math.min(remaining, partSize),
            expiresIn,
          ),
          expiresIn,
        };
      }
      case "finish": {
        limitFinish(user);
        const entry = await get(user, input.id, "write");
        if (
          entry.state !== "pending" ||
          entry.checksum === null ||
          entry.contentType === null
        )
          throw invalid("Upload is not pending");
        if (entry.expiresAt === null || entry.expiresAt <= new Date())
          throw invalid("Upload expired");
        if ((entry.uploadId === null) !== (input.parts === undefined))
          throw invalid("Invalid multipart parts");
        if (
          input.parts !== undefined &&
          (input.parts.length !==
            Math.ceil(Number(entry.size) / drivePartSize(Number(entry.size))) ||
            input.parts.length === 0 ||
            input.parts.some((p, index) => p.partNumber !== index + 1))
        )
          throw invalid("Parts must be consecutive");
        const claim = await db.$transaction(async (tx) => {
          await lockOwner(tx, entry.ownerId);
          return tx.entry.updateMany({
            where: {
              id: entry.id,
              ownerId: entry.ownerId,
              state: "pending",
              trashedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { state: "verifying" },
          });
        });
        if (claim.count !== 1)
          throw invalid("Upload expired or already being finalized");
        try {
          if (entry.uploadId !== null && input.parts !== undefined) {
            await storage.complete(entry.id, entry.uploadId, input.parts);
            await db.entry.update({
              where: { id: entry.id },
              data: { uploadId: null },
            });
          }
          const contentType = await storage.verifyAndCopy(
            entry.id,
            Number(entry.size),
            entry.checksum,
            entry.contentType,
          );
          const result = await db.entry.update({
            where: { id: entry.id },
            data: {
              state: "ready",
              objectKey: storage.key(entry.id, false),
              contentType,
              uploadId: null,
              expiresAt: null,
            },
          });
          // A failure to remove staging must not roll back an already committed entry.
          await storage.removeStaging(entry.id).catch(() => {});
          return visible(result);
        } catch (error) {
          await db.entry.updateMany({
            where: { id: entry.id, state: "verifying" },
            data: {
              state:
                error instanceof UploadMismatchError ? "failed" : "pending",
            },
          });
          throw error;
        }
      }
      case "download": {
        const entry = await file(user, input.id);
        if (entry.objectKey === null || entry.contentType === null)
          throw missing();
        return {
          url: await storage.download(
            entry.objectKey,
            entry.name,
            entry.contentType,
          ),
          expiresIn: 300,
        };
      }
      case "rename": {
        const entry = await get(user, input.id, "write");
        if (entry.state !== "ready") throw invalid("Entry is not ready");
        return visible(
          await db.entry.update({
            where: { id: entry.id },
            data: { name: input.name },
          }),
        );
      }
      case "move": {
        const original = await get(user, input.id, "write");
        return db.$transaction(async (tx) => {
          await lockOwner(tx, original.ownerId);
          const entry = await tx.entry.findFirst({
            where: {
              id: original.id,
              ownerId: original.ownerId,
              trashedAt: null,
              OR: [
                { ownerId: user },
                { shares: { some: { userId: user, access: "write" } } },
              ],
            },
          });
          if (entry === null) throw missing();
          if (entry.state !== "ready") throw invalid("Entry is not ready");
          if (input.parentId === null && entry.ownerId !== user)
            throw missing();
          if (input.parentId !== null) {
            const destination = await tx.entry.findFirst({
              where: {
                id: input.parentId,
                ownerId: entry.ownerId,
                kind: "folder",
                state: "ready",
                trashedAt: null,
                OR: [
                  { ownerId: user },
                  { shares: { some: { userId: user, access: "write" } } },
                ],
              },
            });
            if (destination === null) throw missing();
          }
          const checkAncestor = async (
            cursor: string | null,
          ): Promise<void> => {
            if (cursor === null) return;
            if (cursor === entry.id)
              throw invalid("Cannot move a folder into itself");
            const ancestor = await tx.entry.findFirst({
              where: { id: cursor, ownerId: entry.ownerId },
            });
            if (ancestor === null) throw missing();
            await checkAncestor(ancestor.parentId);
          };
          await checkAncestor(input.parentId);
          return visible(
            await tx.entry.update({
              where: { id: entry.id },
              data: { parentId: input.parentId },
            }),
          );
        });
      }
      case "trash":
      case "restore":
      case "delete": {
        const original = await get(user, input.id, "owner", true);
        return db.$transaction(
          async (tx) => {
            await lockOwner(tx, original.ownerId);
            const entry = await tx.entry.findFirst({
              where: { id: original.id, ownerId: user },
            });
            if (entry === null) throw missing();
            if (entry.state === "verifying")
              throw invalid("Upload is being finalized");
            if (
              entry.kind === "folder" &&
              (await tx.entry.count({ where: { parentId: entry.id } })) > 0
            )
              throw invalid("Folder must be empty");
            if (input.action === "delete") {
              if (entry.trashedAt === null)
                throw invalid("Trash entry before deleting");
              if (entry.kind === "file")
                await storage.remove(entry.id, entry.objectKey, entry.uploadId);
              await tx.entry.delete({ where: { id: entry.id } });
              return { deleted: true };
            }
            if (input.action === "restore")
              await destinationOwner(tx, user, entry.parentId, user);
            return visible(
              await tx.entry.update({
                where: { id: entry.id },
                data: {
                  trashedAt: input.action === "trash" ? new Date() : null,
                },
              }),
            );
          },
          { timeout: 30_000 },
        );
      }
      case "share": {
        const entry = await get(user, input.id, "owner");
        if (entry.state !== "ready" || entry.ownerId === input.userId)
          throw invalid("Invalid share");
        await db.share.upsert({
          where: {
            entryId_userId: { entryId: entry.id, userId: input.userId },
          },
          create: {
            id: randomUUID(),
            entryId: entry.id,
            userId: input.userId,
            access: input.access,
          },
          update: { access: input.access },
        });
        return { shared: true };
      }
      case "unshare": {
        const entry = await get(user, input.id, "owner");
        await db.share.deleteMany({
          where: { entryId: entry.id, userId: input.userId },
        });
        return { revoked: true };
      }
      case "link": {
        const entry = await file(user, input.id);
        if (entry.ownerId !== user) throw missing();
        const expiresAt = new Date(input.expiresAt);
        if (expiresAt.getTime() <= Date.now())
          throw invalid("Expiry must be in the future");
        const token = createLinkToken();
        const link = await db.publicLink.create({
          data: {
            id: randomUUID(),
            tokenHash: hashLinkToken(token),
            entryId: entry.id,
            expiresAt,
          },
        });
        return { id: link.id, token, expiresAt: expiresAt.toISOString() };
      }
      case "unlink": {
        const entry = await get(user, input.id, "owner", true);
        await db.publicLink.updateMany({
          where: { id: input.linkId, entryId: entry.id },
          data: { revokedAt: new Date() },
        });
        return { revoked: true };
      }
    }
    throw invalid("Unknown action");
  };
  const publicFile = async (token: string) => {
    const link = await db.publicLink.findUnique({
      where: { tokenHash: hashLinkToken(token) },
      include: { entry: true },
    });
    if (
      link === null ||
      link.revokedAt !== null ||
      link.expiresAt <= new Date() ||
      link.entry.trashedAt !== null ||
      link.entry.state !== "ready" ||
      link.entry.kind !== "file" ||
      link.entry.objectKey === null
    )
      throw missing();
    return link.entry;
  };
  const sweepExpired = async () => {
    const expired = await db.entry.findMany({
      where: {
        state: { in: ["pending", "failed"] },
        expiresAt: { lte: new Date() },
      },
      select: { id: true, ownerId: true },
      take: 100,
      orderBy: { expiresAt: "asc" },
    });
    await expired.reduce<Promise<void>>(async (previous, candidate) => {
      await previous;
      await db.$transaction(
        async (tx) => {
          await lockOwner(tx, candidate.ownerId);
          const entry = await tx.entry.findFirst({
            where: {
              id: candidate.id,
              state: { in: ["pending", "failed"] },
              expiresAt: { lte: new Date() },
            },
          });
          if (entry === null) return;
          await storage.remove(entry.id, entry.objectKey, entry.uploadId);
          await tx.entry.delete({ where: { id: entry.id } });
        },
        { timeout: 30_000 },
      );
    }, Promise.resolve());
    return expired.length;
  };
  return { command, file, publicFile, sweepExpired };
};
export type DriveService = ReturnType<typeof createDrive>;
