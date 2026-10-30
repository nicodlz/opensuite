import type { DriveCommand, DriveOutput } from "@opensuite/contracts";
import { ORPCError } from "@orpc/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Entry } from "../db/generated/index.js";
import type { Storage } from "../adapters/storage.ts";
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
  const parent = async (user: string, id: string | null, owner: string) => {
    if (id === null) return;
    const item = await get(user, id, "owner");
    if (
      item.ownerId !== owner ||
      item.kind !== "folder" ||
      item.state !== "ready"
    )
      throw missing();
  };
  const writableOwner = async (user: string, id: string | null) => {
    if (id === null) return user;
    const item = await get(user, id, "write");
    if (item.kind !== "folder" || item.state !== "ready") throw missing();
    return item.ownerId;
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
        const owner = await writableOwner(user, input.parentId);
        const entry = await db.entry.create({
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
      }
      case "upload": {
        const owner = await writableOwner(user, input.parentId);
        const id = randomUUID();
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 0))`;
          const totals = z
            .array(z.object({ total: z.bigint() }))
            .parse(
              await tx.$queryRaw`SELECT COALESCE(SUM("size"), 0)::bigint AS total FROM "Entry" WHERE "ownerId" = ${owner} AND kind = 'file'`,
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
              expiresAt: new Date(Date.now() + 300_000),
            },
          });
        });
        try {
          const upload = await storage.initiate(
            id,
            input.contentType,
            input.multipart,
            input.size,
          );
          await db.entry.update({
            where: { id },
            data: { uploadId: upload.uploadId },
          });
          return { id, url: upload.url, expiresIn: 300 };
        } catch (error) {
          await db.entry.delete({ where: { id } });
          throw error;
        }
      }
      case "part": {
        const entry = await get(user, input.id, "write");
        if (entry.state !== "pending" || entry.uploadId === null)
          throw invalid("No multipart upload");
        const partSize = 5 * 1024 * 1024;
        const remaining =
          Number(entry.size) - (input.partNumber - 1) * partSize;
        if (remaining <= 0) throw invalid("Part exceeds reserved size");
        return {
          url: await storage.part(
            entry.id,
            entry.uploadId,
            input.partNumber,
            Math.min(remaining, partSize),
          ),
          expiresIn: 300,
        };
      }
      case "finish": {
        const entry = await get(user, input.id, "write");
        if (
          entry.state !== "pending" ||
          entry.checksum === null ||
          entry.contentType === null
        )
          throw invalid("Upload is not pending");
        if ((entry.uploadId === null) !== (input.parts === undefined))
          throw invalid("Invalid multipart parts");
        if (
          input.parts !== undefined &&
          (input.parts.length !==
            Math.ceil(Number(entry.size) / (5 * 1024 * 1024)) ||
            input.parts.length === 0 ||
            input.parts.some((p, index) => p.partNumber !== index + 1))
        )
          throw invalid("Parts must be consecutive");
        const claim = await db.entry.updateMany({
          where: {
            id: entry.id,
            ownerId: entry.ownerId,
            state: "pending",
            trashedAt: null,
          },
          data: { state: "verifying" },
        });
        if (claim.count !== 1) throw invalid("Upload already being finalized");
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
          return visible(result);
        } catch (error) {
          await db.entry.updateMany({
            where: { id: entry.id, state: "verifying" },
            data: { state: "pending" },
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
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${original.ownerId}, 0))`;
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
      case "restore": {
        const entry = await get(user, input.id, "owner", true);
        if (entry.state === "verifying")
          throw invalid("Upload is being finalized");
        if (
          entry.kind === "folder" &&
          (await db.entry.count({ where: { parentId: entry.id } })) > 0
        )
          throw invalid("Folder must be empty");
        if (input.action === "restore")
          await parent(user, entry.parentId, user);
        return visible(
          await db.entry.update({
            where: { id: entry.id },
            data: { trashedAt: input.action === "trash" ? new Date() : null },
          }),
        );
      }
      case "delete": {
        const entry = await get(user, input.id, "owner", true);
        if (entry.trashedAt === null || entry.state === "verifying")
          throw invalid("Trash entry before deleting");
        if (
          entry.kind === "folder" &&
          (await db.entry.count({ where: { parentId: entry.id } })) > 0
        )
          throw invalid("Folder must be empty");
        if (entry.kind === "file")
          await storage.remove(entry.id, entry.objectKey, entry.uploadId);
        await db.entry.delete({ where: { id: entry.id } });
        return { deleted: true };
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
  return { command, file, publicFile };
};
export type DriveService = ReturnType<typeof createDrive>;
