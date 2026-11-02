import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

const activeClaim = (id: string, token: string, now: Date) => ({
  where: {
    id,
    claimToken: token,
    claimUntil: { gt: now },
    cancelRequested: false,
    status: "running",
  },
  data: { claimUntil: new Date(now.getTime() + 300_000) },
});

export function mailImportOutcome(
  job: { cancelRequested: boolean; items: { status: string }[] },
  deferred = false,
) {
  const uncertain = job.items.some((item) =>
    ["uncertain", "importing"].includes(item.status),
  );
  const failed = job.items.some((item) => item.status === "failed");
  const pending = job.items.some((item) => item.status === "pending");
  const status = job.cancelRequested
    ? uncertain
      ? "attention"
      : "cancelled"
    : uncertain
      ? "attention"
      : deferred && pending
        ? "queued"
        : failed
          ? "attention"
          : pending
            ? "queued"
            : "completed";
  return {
    status,
    clearArchive:
      status === "completed" || (status === "cancelled" && !uncertain),
  };
}

class MailImportStore {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }
  async list(userId: string, accountId: string) {
    const rows = await this.db.mailImportJob.findMany({
      where: { userId, accountId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, status: true, createdAt: true },
    });
    const status = z.enum([
      "queued",
      "running",
      "completed",
      "cancelled",
      "attention",
    ]);
    return rows.map((row) => ({
      id: row.id,
      status: status.parse(row.status),
      createdAt: row.createdAt.toISOString(),
    }));
  }
  create(input: {
    id: string;
    userId: string;
    accountId: string;
    format: string;
    variant: string;
    mailboxId: string;
    labels: Record<string, string>;
    mailboxNames: Record<string, { name: string; parentId: string | null }>;
    archive: string;
    total: number;
  }) {
    return this.db.$transaction(async (tx) => {
      const job = await tx.mailImportJob.create({ data: input });
      await tx.mailImportItem.createMany({
        data: Array.from({ length: input.total }, (_, index) => ({
          jobId: input.id,
          index,
          marker: `import-${randomUUID()}`,
        })),
      });
      await tx.auditEvent.create({
        data: {
          userId: input.userId,
          action: "mail.import.created",
          detail: { jobId: input.id },
        },
      });
      return job;
    });
  }
  get(userId: string, accountId: string, id: string) {
    return this.db.mailImportJob.findFirst({
      where: { userId, accountId, id },
      include: { items: { orderBy: { index: "asc" } } },
    });
  }
  async cancel(userId: string, accountId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const result = await tx.mailImportJob.updateMany({
        where: {
          userId,
          accountId,
          id,
          status: { in: ["queued", "running", "attention"] },
        },
        data: { cancelRequested: true, status: "queued" },
      });
      if (result.count)
        await tx.auditEvent.create({
          data: {
            userId,
            action: "mail.import.cancel_requested",
            detail: { jobId: id },
          },
        });
      return result;
    });
  }
  async resume(userId: string, accountId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const current = await tx.mailImportJob.findFirst({
        where: { userId, accountId, id },
        select: { cancelRequested: true },
      });
      const changed = await tx.mailImportJob.updateMany({
        where: {
          userId,
          accountId,
          id,
          status: "attention",
          archive: { not: null },
          claimToken: null,
        },
        data: { status: "queued", error: null },
      });
      if (changed.count && current?.cancelRequested === false)
        await tx.mailImportItem.updateMany({
          where: { jobId: id, status: "failed" },
          data: { status: "pending", error: null },
        });
      if (changed.count)
        await tx.auditEvent.create({
          data: {
            userId,
            action: "mail.import.resumed",
            detail: { jobId: id },
          },
        });
      return changed;
    });
  }
  async remap(input: {
    userId: string;
    accountId: string;
    id: string;
    mailboxId: string;
    labels: Record<string, string>;
    mailboxNames: Record<string, { name: string; parentId: string | null }>;
  }) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: {
          id: input.id,
          userId: input.userId,
          accountId: input.accountId,
          status: "attention",
          claimToken: null,
          cancelRequested: false,
          archive: { not: null },
        },
        data: {
          mailboxId: input.mailboxId,
          labels: input.labels,
          mailboxNames: input.mailboxNames,
          status: "queued",
          error: null,
        },
      });
      if (changed.count) {
        await tx.mailImportItem.updateMany({
          where: { jobId: input.id, status: "failed" },
          data: { status: "pending", error: null },
        });
        await tx.auditEvent.create({
          data: {
            userId: input.userId,
            action: "mail.import.remapped",
            detail: { jobId: input.id },
          },
        });
      }
      return changed;
    });
  }
  async abandon(
    userId: string,
    accountId: string,
    id: string,
    expectedUncertain: number,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "MailImportJob" WHERE "id" = ${id} AND "userId" = ${userId} AND "accountId" = ${accountId} FOR UPDATE`;
      const job = await tx.mailImportJob.findFirst({
        where: { id, userId, accountId },
        include: { items: true },
      });
      if (
        job === null ||
        job.status !== "attention" ||
        job.claimToken !== null ||
        job.archive === null
      )
        return false;
      const count = (statuses: string[]) =>
        job.items.filter((item) => statuses.includes(item.status)).length;
      const counts = {
        imported: count(["imported"]),
        uncertain: count(["uncertain", "importing"]),
        failed: count(["failed"]),
        duplicate: count(["duplicate"]),
        pending: count(["pending"]),
      };
      if (counts.uncertain === 0 || counts.uncertain !== expectedUncertain)
        return false;
      await tx.auditEvent.create({
        data: {
          userId,
          action: "mail.import.abandoned",
          detail: { jobId: id, accountId, ...counts },
        },
      });
      await tx.mailImportJob.delete({ where: { id } });
      return true;
    });
  }
  async claim(now: Date) {
    const token = randomUUID();
    const until = new Date(now.getTime() + 300_000);
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "MailImportJob" SET "claimToken" = ${token}, "claimUntil" = ${until}, "status" = 'running', "updatedAt" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "MailImportJob"
        WHERE "status" IN ('queued', 'running') AND ("claimUntil" IS NULL OR "claimUntil" <= ${now})
        ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING "id"`;
    const id = rows[0]?.id;
    if (id === undefined) return null;
    const job = await this.db.mailImportJob.findUnique({
      where: { id },
      include: { items: { orderBy: { index: "asc" } } },
    });
    return job === null ? null : { job, token };
  }
  async beforeImport(id: string, token: string, index: number, now: Date) {
    return this.db.$transaction(async (tx) => {
      const active = await tx.mailImportJob.updateMany(
        activeClaim(id, token, now),
      );
      if (!active.count) return false;
      const item = await tx.mailImportItem.updateMany({
        where: { jobId: id, index, status: "pending" },
        data: { status: "importing", error: null },
      });
      return item.count === 1;
    });
  }
  async beforeMapping(id: string, token: string, now: Date) {
    const result = await this.db.mailImportJob.updateMany(
      activeClaim(id, token, now),
    );
    return result.count === 1;
  }
  async item(
    id: string,
    token: string,
    index: number,
    status: string,
    error: string | null,
    remoteId: string | null,
  ) {
    return this.db.$transaction(async (tx) => {
      const active = await tx.mailImportJob.updateMany({
        where: { id, claimToken: token },
        data: { updatedAt: new Date() },
      });
      if (!active.count) return false;
      await tx.mailImportItem.update({
        where: { jobId_index: { jobId: id, index } },
        data: { status, error, remoteId },
      });
      return true;
    });
  }
  async finish(
    id: string,
    token: string,
    status: string,
    error: string | null,
    clearArchive: boolean,
  ) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.mailImportJob.updateMany({
        where: { id, claimToken: token },
        data: {
          status,
          error,
          claimToken: null,
          claimUntil: null,
          ...(clearArchive ? { archive: null } : {}),
        },
      });
      if (changed.count && status !== "queued") {
        const job = await tx.mailImportJob.findUnique({
          where: { id },
          select: { userId: true },
        });
        if (job !== null)
          await tx.auditEvent.create({
            data: {
              userId: job.userId,
              action: "mail.import.finished",
              detail: { jobId: id, status },
            },
          });
      }
      return changed;
    });
  }
  async defer(id: string, token: string, kind: string) {
    const status = ["unavailable", "rate_limited"].includes(kind)
      ? "queued"
      : "attention";
    await this.finish(id, token, status, "Import worker unavailable", false);
    return true;
  }
  async settle(
    job: { id: string; userId: string; accountId: string },
    token: string,
    deferred: boolean,
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "MailImportJob" WHERE "id" = ${job.id} FOR UPDATE`;
      const current = await tx.mailImportJob.findFirst({
        where: {
          id: job.id,
          userId: job.userId,
          accountId: job.accountId,
          claimToken: token,
        },
        include: { items: true },
      });
      if (current === null) return;
      const outcome = mailImportOutcome(current, deferred);
      await tx.mailImportJob.update({
        where: { id: job.id },
        data: {
          status: outcome.status,
          error: null,
          claimToken: null,
          claimUntil: null,
          ...(outcome.clearArchive ? { archive: null } : {}),
        },
      });
      if (outcome.status !== "queued")
        await tx.auditEvent.create({
          data: {
            userId: job.userId,
            action: "mail.import.finished",
            detail: { jobId: job.id, status: outcome.status },
          },
        });
    });
  }
}

export function createMailImportStore(db: PrismaClient) {
  return new MailImportStore(db);
}
