import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "./generated/index.js";
import { createMailImportStore, mailImportOutcome } from "./migration-mail.ts";

class DirectImportStore {
  readonly shared: ReturnType<typeof createMailImportStore>;
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
    this.shared = createMailImportStore(db);
  }
  get(userId: string, accountId: string, id: string) {
    return this.db.mailImportJob.findFirst({
      where: { id, userId, accountId, sourceKind: { not: null } },
      include: { items: { orderBy: { index: "asc" } } },
    });
  }
  async list(userId: string, accountId: string) {
    return this.db.mailImportJob.findMany({
      where: { userId, accountId, sourceKind: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, sourceKind: true, status: true, createdAt: true },
    });
  }
  async create(input: {
    id: string;
    userId: string;
    accountId: string;
    mailboxId: string;
    labels: Record<string, string>;
    mailboxNames: Record<string, { name: string; parentId: string | null }>;
    sourceKind: string;
    sourceDetails: Prisma.InputJsonValue;
    sourceConfig: string;
    sourceExpiresAt: Date;
  }) {
    return this.db.$transaction(async (tx) => {
      await tx.mailImportJob.create({
        data: { ...input, format: "direct", variant: "", total: 0 },
      });
      await tx.auditEvent.create({
        data: {
          userId: input.userId,
          action: "mail.direct_import.created",
          detail: { jobId: input.id, source: input.sourceKind },
        },
      });
    });
  }
  claim(now: Date) {
    return this.shared.claim(now, "direct");
  }
  async inventory(id: string, token: string, refs: Prisma.InputJsonValue[]) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: {
          id,
          claimToken: token,
          claimUntil: { gt: new Date() },
          status: "running",
          cancelRequested: false,
          inventoryReady: false,
        },
        data: { total: refs.length, inventoryReady: true },
      });
      if (!changed.count) return false;
      await tx.mailImportItem.createMany({
        data: refs.map((sourceRef, index) => ({
          jobId: id,
          index,
          sourceRef,
          marker: `import-${randomUUID()}`,
        })),
      });
      return true;
    });
  }
  async raw(id: string, token: string, index: number, encrypted: string) {
    return this.db.$transaction(async (tx) => {
      const active = await tx.mailImportJob.updateMany({
        where: {
          id,
          claimToken: token,
          claimUntil: { gt: new Date() },
          status: "running",
          cancelRequested: false,
        },
        data: { claimUntil: new Date(Date.now() + 300_000) },
      });
      if (!active.count) return false;
      const changed = await tx.mailImportItem.updateMany({
        where: { jobId: id, index, status: "pending", sourceRaw: null },
        data: { sourceRaw: encrypted },
      });
      return changed.count === 1;
    });
  }
  item(
    id: string,
    token: string,
    index: number,
    status: string,
    error: string | null,
    remoteId: string | null,
  ) {
    return this.shared.item(id, token, index, status, error, remoteId, true);
  }
  async settle(
    id: string,
    token: string,
    error: string | null = null,
    deferred = false,
    dropCredential = false,
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "MailImportJob" WHERE "id" = ${id} FOR UPDATE`;
      const job = await tx.mailImportJob.findFirst({
        where: { id, claimToken: token },
        include: { items: true },
      });
      if (!job) return;
      const outcome = mailImportOutcome(job, deferred);
      const status = error
        ? "attention"
        : !job.inventoryReady && !job.cancelRequested
          ? "queued"
          : outcome.status;
      const clear = status === "completed" || status === "cancelled";
      await tx.mailImportJob.update({
        where: { id },
        data: {
          status,
          error,
          claimToken: null,
          claimUntil: null,
          ...((clear && !error) || dropCredential
            ? { sourceConfig: null, sourceExpiresAt: null }
            : {}),
        },
      });
      await tx.mailImportItem.updateMany({
        where: {
          jobId: id,
          ...(clear ? {} : { status: { in: ["imported", "duplicate"] } }),
        },
        data: { sourceRaw: null },
      });
      if (status !== "queued")
        await tx.auditEvent.create({
          data: {
            userId: job.userId,
            action: "mail.direct_import.finished",
            detail: { jobId: id, status },
          },
        });
    });
  }
  async cancel(
    userId: string,
    accountId: string,
    id: string,
    dropCredential: boolean,
  ) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: {
          id,
          userId,
          accountId,
          sourceKind: { not: null },
          status: { in: ["queued", "running", "attention"] },
        },
        data: {
          status: "queued",
          cancelRequested: true,
          ...(dropCredential
            ? { sourceConfig: null, sourceExpiresAt: null }
            : {}),
        },
      });
      if (changed.count)
        await tx.auditEvent.create({
          data: {
            userId,
            action: "mail.direct_import.cancel_requested",
            detail: { jobId: id },
          },
        });
      return changed;
    });
  }
  async clearCredential(
    userId: string,
    accountId: string,
    id: string,
    encrypted: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: {
          id,
          userId,
          accountId,
          sourceKind: "gmail",
          status: "attention",
          claimToken: null,
          sourceConfig: encrypted,
        },
        data: { sourceConfig: null, sourceExpiresAt: null },
      });
      if (changed.count)
        await tx.auditEvent.create({
          data: {
            userId,
            action: "mail.direct_import.token_revoked",
            detail: { jobId: id },
          },
        });
      return changed.count === 1;
    });
  }
  async clearClaimedCredential(id: string, token: string, encrypted: string) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: { id, claimToken: token, sourceConfig: encrypted },
        data: { sourceConfig: null, sourceExpiresAt: null },
      });
      if (changed.count) {
        const job = await tx.mailImportJob.findUnique({
          where: { id },
          select: { userId: true },
        });
        if (job)
          await tx.auditEvent.create({
            data: {
              userId: job.userId,
              action: "mail.direct_import.token_revoked",
              detail: { jobId: id },
            },
          });
      }
      return changed.count === 1;
    });
  }
  async abandon(
    userId: string,
    accountId: string,
    id: string,
    uncertainCount: number,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "MailImportJob" WHERE "id" = ${id} AND "userId" = ${userId} AND "accountId" = ${accountId} FOR UPDATE`;
      const job = await tx.mailImportJob.findFirst({
        where: {
          id,
          userId,
          accountId,
          sourceKind: { not: null },
          status: "attention",
          claimToken: null,
        },
        include: { items: true },
      });
      if (!job || job.sourceConfig !== null) return false;
      const count = job.items.filter((item) =>
        ["importing", "uncertain"].includes(item.status),
      ).length;
      if (!count || count !== uncertainCount) return false;
      await tx.auditEvent.create({
        data: {
          userId,
          action: "mail.direct_import.abandoned",
          detail: { jobId: id, uncertainCount: count },
        },
      });
      await tx.mailImportJob.delete({ where: { id } });
      return true;
    });
  }
  async resume(
    userId: string,
    accountId: string,
    id: string,
    sourceConfig: string | undefined,
  ) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: {
          id,
          userId,
          accountId,
          sourceKind: { not: null },
          status: "attention",
          cancelRequested: false,
          claimToken: null,
        },
        data: {
          status: "queued",
          error: null,
          ...(sourceConfig
            ? {
                sourceConfig,
                sourceExpiresAt: new Date(Date.now() + 24 * 3600_000),
              }
            : {}),
        },
      });
      if (changed.count) {
        await tx.mailImportItem.updateMany({
          where: { jobId: id, status: "failed" },
          data: { status: "pending", error: null },
        });
        await tx.auditEvent.create({
          data: {
            userId,
            action: "mail.direct_import.resumed",
            detail: { jobId: id },
          },
        });
      }
      return changed.count === 1;
    });
  }
  async expire(now: Date) {
    await this.db.mailImportJob.updateMany({
      where: {
        sourceKind: { not: null },
        sourceExpiresAt: { lte: now },
        sourceConfig: { not: null },
        claimToken: null,
      },
      data: {
        sourceConfig: null,
        sourceExpiresAt: null,
        status: "attention",
        error:
          "Source credential expired. Google OAuth grants may require manual revocation; provide a new credential to resume.",
      },
    });
  }
}

export function createDirectImportStore(db: PrismaClient) {
  return new DirectImportStore(db);
}
