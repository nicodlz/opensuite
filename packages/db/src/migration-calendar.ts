import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/index.js";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  recoverCalendarImport,
  type ImportPreview,
} from "./migration-calendar-recovery.ts";

type ImportBox = {
  encrypt(value: unknown, context: unknown): Result<string, { kind: string }>;
  decrypt(value: unknown, context: unknown): Result<string, { kind: string }>;
};

type StoredJob = Prisma.CalendarImportJobGetPayload<{
  include: { items: true };
}>;
function protectedValue(
  box: ImportBox,
  value: string,
  userId: string,
  id: string,
) {
  const result = box.encrypt(value, { userId, id });
  if (result.isErr()) throw new Error("Unable to protect calendar import");
  return result.value;
}
function openValue(box: ImportBox, value: string, userId: string, id: string) {
  const result = box.decrypt(value, { userId, id });
  if (result.isErr()) throw new Error("Unable to read calendar import");
  return result.value;
}
function openJob(
  box: ImportBox,
  userId: string,
  job: StoredJob,
  withEvent: boolean,
) {
  return {
    ...job,
    items: job.items.map((item) => ({
      ...item,
      title: z
        .string()
        .parse(
          JSON.parse(openValue(box, item.title, userId, `${item.id}:title`)),
        ),
      event:
        withEvent && item.event !== null
          ? openValue(box, item.event, userId, `${item.id}:event`)
          : item.event,
    })),
  };
}

export interface CalendarImportRow {
  file: string;
  sourceId: string;
  uid: string | null;
  title: string;
  source: string;
  event: string | null;
  issues: string;
  previewState: "new" | "update" | "duplicate" | "conflict" | "invalid";
  previewReason: string | null;
  state: "pending" | "failed";
  error: string | null;
}

function createJob(
  db: PrismaClient,
  userId: string,
  accountId: string,
  calendarId: string,
  items: CalendarImportRow[],
  jobLimit: number,
  box: ImportBox,
) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext('calendar-import'))`;
    if ((await tx.calendarImportJob.count({ where: { userId } })) >= jobLimit)
      return null;
    return tx.calendarImportJob.create({
      data: {
        id: randomUUID(),
        userId,
        accountId,
        calendarId,
        items: {
          create: items.map((item, index) => {
            const id = randomUUID();
            const event =
              item.event === null
                ? null
                : protectedValue(box, item.event, userId, `${id}:event`);
            return {
              id,
              index,
              file: item.file,
              sourceId: item.sourceId,
              uid: item.uid,
              title: protectedValue(
                box,
                JSON.stringify(item.title),
                userId,
                `${id}:title`,
              ),
              event,
              issues: item.issues,
              previewState: item.previewState,
              previewReason: item.previewReason,
              state: item.state,
              error: item.error,
            };
          }),
        },
      },
      include: { items: { orderBy: { index: "asc" } } },
    });
  });
}

type Identity = {
  accountId: string;
  calendarId: string;
  uid: string;
  source: string;
};
function lockIdentity(
  tx: Prisma.TransactionClient,
  userId: string,
  identity: Pick<Identity, "accountId" | "calendarId" | "uid">,
) {
  const key = JSON.stringify([
    identity.accountId,
    identity.calendarId,
    identity.uid,
  ]);
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${key}))`;
}
type FinishInput = {
  userId: string;
  jobId: string;
  itemId: string;
  state: "imported" | "duplicate" | "failed";
  error: string | null;
  eventId: string | null;
  identity: Identity | undefined;
  generation: number;
};
function finishJob(db: PrismaClient, input: FinishInput) {
  const {
    userId,
    jobId,
    itemId: id,
    state,
    error,
    eventId,
    identity,
    generation,
  } = input;
  return db.$transaction(async (tx) => {
    const updated = await tx.calendarImportItem.updateMany({
      where: {
        id,
        jobId,
        generation,
        job: { userId, generation, abandoned: false },
        state: "processing",
      },
      data: { state, error, eventId },
    });
    if (updated.count && identity) await lockIdentity(tx, userId, identity);
    if (updated.count && identity && state === "failed" && !eventId) {
      const competing = await tx.calendarImportItem.count({
        where: {
          id: { not: id },
          uid: identity.uid,
          state: "processing",
          job: {
            userId,
            accountId: identity.accountId,
            calendarId: identity.calendarId,
            abandoned: false,
          },
        },
      });
      if (!competing)
        await tx.calendarImportIdentity.deleteMany({
          where: { userId, ...identity, eventId: null },
        });
    }
    if (updated.count && identity && eventId)
      await tx.calendarImportIdentity.upsert({
        where: {
          userId_accountId_calendarId_uid: {
            userId,
            accountId: identity.accountId,
            calendarId: identity.calendarId,
            uid: identity.uid,
          },
        },
        create: { id: randomUUID(), userId, ...identity, eventId },
        update: { eventId },
      });
    return updated;
  });
}

async function reserveIdentity(
  db: PrismaClient,
  userId: string,
  accountId: string,
  calendarId: string,
  uid: string,
  source: string,
) {
  return db.$transaction(async (tx) => {
    await lockIdentity(tx, userId, { accountId, calendarId, uid });
    await tx.calendarImportIdentity.createMany({
      data: [{ id: randomUUID(), userId, accountId, calendarId, uid, source }],
      skipDuplicates: true,
    });
    return tx.calendarImportIdentity.findUnique({
      where: {
        userId_accountId_calendarId_uid: { userId, accountId, calendarId, uid },
      },
    });
  });
}

function jobs(db: PrismaClient, jobLimit: number, box: ImportBox) {
  return {
    hasCapacity: async (userId: string) =>
      (await db.calendarImportJob.count({ where: { userId } })) < jobLimit,
    create: async (
      userId: string,
      accountId: string,
      calendarId: string,
      items: CalendarImportRow[],
    ) => {
      const job = await createJob(
        db,
        userId,
        accountId,
        calendarId,
        items,
        jobLimit,
        box,
      );
      return job ? openJob(box, userId, job, false) : null;
    },
    list: async (userId: string, accountId: string | undefined) => {
      const list = await db.calendarImportJob.findMany({
        where: { userId, ...(accountId === undefined ? {} : { accountId }) },
        include: { items: { orderBy: { index: "asc" } } },
        orderBy: { createdAt: "desc" },
        take: jobLimit,
      });
      return list.map((job) => openJob(box, userId, job, false));
    },
    get: async (userId: string, id: string) => {
      const job = await db.calendarImportJob.findFirst({
        where: { id, userId },
        include: { items: { orderBy: { index: "asc" } } },
      });
      return job ? openJob(box, userId, job, true) : null;
    },
    confirm: (userId: string, id: string, generation: number) =>
      db.calendarImportJob.updateMany({
        where: { id, userId, generation, abandoned: false },
        data: { confirmed: true },
      }),
    processing: (
      userId: string,
      jobId: string,
      id: string,
      generation: number,
      wasPending = true,
    ) =>
      db.calendarImportItem.updateMany({
        where: {
          id,
          jobId,
          generation,
          job: { userId, confirmed: true, abandoned: false, generation },
          state: wasPending ? "pending" : "processing",
        },
        data: { state: "processing" },
      }),
  };
}

function itemOperations(db: PrismaClient) {
  return {
    reserve: (
      userId: string,
      accountId: string,
      calendarId: string,
      uid: string,
      source: string,
    ) => reserveIdentity(db, userId, accountId, calendarId, uid, source),
    identity: (
      userId: string,
      accountId: string,
      calendarId: string,
      uid: string,
    ) =>
      db.calendarImportIdentity.findUnique({
        where: {
          userId_accountId_calendarId_uid: {
            userId,
            accountId,
            calendarId,
            uid,
          },
        },
      }),
    finish: (input: FinishInput) => finishJob(db, input),
    recover: (
      userId: string,
      jobId: string,
      generation: number,
      oldCalendarId: string,
      input:
        | { action: "retarget"; calendarId: string; preview: ImportPreview[] }
        | { action: "abandon" },
    ) =>
      recoverCalendarImport(
        db,
        userId,
        jobId,
        generation,
        oldCalendarId,
        input,
      ),
    identities: (
      userId: string,
      accountId: string,
      calendarId: string,
      uids: string[],
    ) =>
      db.calendarImportIdentity.findMany({
        where: { userId, accountId, calendarId, uid: { in: uids } },
      }),
    delete: (userId: string, id: string) =>
      db.calendarImportJob.deleteMany({
        where: { id, userId, items: { none: { state: "processing" } } },
      }),
  };
}
export function createCalendarImportStore(
  db: PrismaClient,
  jobLimit: number,
  box: ImportBox,
) {
  return { ...jobs(db, jobLimit, box), ...itemOperations(db) };
}
export type CalendarImportStore = ReturnType<typeof createCalendarImportStore>;
