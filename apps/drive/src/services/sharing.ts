import type { DriveCommand, DriveOutput } from "@opensuite/contracts";
import { ORPCError } from "@orpc/server";
import { randomUUID } from "node:crypto";
import type { Entry, PrismaClient } from "../db/generated/index.js";
import type { AccountDirectory } from "../domain/accounts.ts";
import {
  createLinkToken,
  hashLinkToken,
  recoverLinkToken,
} from "../sharing/tokens.ts";
import { invalid, missing } from "./errors.ts";

type SharingCommand = Extract<
  DriveCommand,
  { action: "shares" | "share" | "unshare" | "link" | "unlink" }
>;
const sharingActions = new Set<DriveCommand["action"]>([
  "shares",
  "share",
  "unshare",
  "link",
  "unlink",
]);
export const isSharingCommand = (
  input: DriveCommand,
): input is SharingCommand => sharingActions.has(input.action);

export interface SharingDependencies {
  readonly db: PrismaClient;
  /** The entry `user` reaches with `access`; NOT_FOUND otherwise. */
  readonly get: (
    user: string,
    id: string,
    access?: "read" | "write" | "owner",
    includeTrash?: boolean,
  ) => Promise<Entry>;
  /** A ready file `user` can read; NOT_FOUND otherwise. */
  readonly file: (user: string, id: string) => Promise<Entry>;
  readonly accounts?: AccountDirectory | undefined;
  readonly linkKey?: Buffer | undefined;
}
type Context = SharingDependencies & {
  readonly lookups: Map<string, { count: number; until: number }>;
};

const unavailable = () =>
  new ORPCError("SERVICE_UNAVAILABLE", {
    message: "Account directory unavailable",
  });
const busy = () =>
  new ORPCError("TOO_MANY_REQUESTS", { message: "Too many sharing attempts" });
const shareAccess = (value: string): "read" | "write" =>
  value === "write" ? "write" : "read";

// Resolving an address tells whether an account uses it. Only owners sharing
// an item resolve addresses, and only this many times an hour.
function limitLookup(lookups: Context["lookups"], user: string) {
  const now = Date.now();
  for (const [key, value] of lookups)
    if (value.until <= now) lookups.delete(key);
  const current = lookups.get(user);
  if (current !== undefined) {
    if (current.count >= 60) throw busy();
    current.count++;
  } else {
    if (lookups.size >= 10_000) throw busy();
    lookups.set(user, { count: 1, until: now + 3_600_000 });
  }
}
function directory(context: Context) {
  if (context.accounts === undefined) throw unavailable();
  return context.accounts;
}
// Without shares there is nothing to look up, so links still list when the
// directory is down.
async function addressesOf(context: Context, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>();
  const found = await directory(context).addresses(userIds);
  if (found.isErr()) throw unavailable();
  return found.value;
}

async function listAccess(context: Context, user: string, id: string) {
  const entry = await context.get(user, id, "owner");
  const [shares, links] = await Promise.all([
    context.db.share.findMany({ where: { entryId: entry.id } }),
    context.db.publicLink.findMany({
      where: {
        entryId: entry.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: "asc" },
    }),
  ]);
  const addresses = await addressesOf(
    context,
    shares.map((share) => share.userId),
  );
  return {
    shares: shares
      .map((share) => ({
        id: share.id,
        address: addresses.get(share.userId) ?? null,
        access: shareAccess(share.access),
      }))
      .toSorted(
        (a, b) =>
          Number(a.address === null) - Number(b.address === null) ||
          (a.address ?? "").localeCompare(b.address ?? ""),
      ),
    links: links.map((link) => ({
      id: link.id,
      expiresAt: link.expiresAt.toISOString(),
      token: recoverLinkToken(context.linkKey, link),
    })),
  };
}
async function grant(
  context: Context,
  user: string,
  input: Extract<SharingCommand, { action: "share" }>,
) {
  const entry = await context.get(user, input.id, "owner");
  if (entry.state !== "ready") throw invalid("Invalid share");
  const accounts = directory(context);
  limitLookup(context.lookups, user);
  const resolved = await accounts.resolve(input.address);
  if (resolved.isErr()) throw unavailable();
  const recipient = resolved.value;
  if (recipient === null)
    throw new ORPCError("RECIPIENT_NOT_FOUND", {
      status: 404,
      defined: true,
      message: "No account on this server uses this address",
    });
  if (recipient === entry.ownerId) throw invalid("You already own this item");
  await context.db.share.upsert({
    where: { entryId_userId: { entryId: entry.id, userId: recipient } },
    create: {
      id: randomUUID(),
      entryId: entry.id,
      userId: recipient,
      access: input.access,
    },
    update: { access: input.access },
  });
  return { shared: true as const };
}
async function createLink(
  context: Context,
  user: string,
  id: string,
  at: string,
) {
  const entry = await context.file(user, id);
  if (entry.ownerId !== user) throw missing();
  const expiresAt = new Date(at);
  if (expiresAt.getTime() <= Date.now())
    throw invalid("Expiry must be in the future");
  const linkId = randomUUID();
  const token = createLinkToken(context.linkKey, linkId);
  await context.db.publicLink.create({
    data: {
      id: linkId,
      tokenHash: hashLinkToken(token),
      entryId: entry.id,
      expiresAt,
    },
  });
  return { id: linkId, token, expiresAt: expiresAt.toISOString() };
}

/**
 * Shares with other accounts and public links. Only the owner lists, grants
 * or revokes them, and a share or link ID acts only on its own item.
 */
export function createSharing(dependencies: SharingDependencies) {
  const context: Context = { ...dependencies, lookups: new Map() };
  return async (user: string, input: SharingCommand): Promise<DriveOutput> => {
    switch (input.action) {
      case "shares":
        return listAccess(context, user, input.id);
      case "share":
        return grant(context, user, input);
      case "unshare": {
        const entry = await context.get(user, input.id, "owner");
        await context.db.share.deleteMany({
          where: { id: input.shareId, entryId: entry.id },
        });
        return { revoked: true };
      }
      case "link":
        return createLink(context, user, input.id, input.expiresAt);
      case "unlink": {
        const entry = await context.get(user, input.id, "owner", true);
        await context.db.publicLink.updateMany({
          where: { id: input.linkId, entryId: entry.id },
          data: { revokedAt: new Date() },
        });
        return { revoked: true };
      }
    }
    throw invalid("Unknown action");
  };
}
