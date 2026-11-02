import { projectCalendarImport } from "./migration-calendar-view.ts";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/index.js";
import {
  recoverCalendarImport,
  type ImportPreview,
} from "./migration-calendar-recovery.ts";

export interface CalendarImportRow {
  file: string;
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
  files: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext('calendar-import'))`;
    if ((await tx.calendarImportJob.count({ where: { userId } })) >= 10)
      return null;
    return tx.calendarImportJob.create({
      data: {
        id: randomUUID(),
        userId,
        accountId,
        calendarId,
        files,
        items: {
          create: items.map((item, index) => ({
            ...item,
            id: randomUUID(),
            index,
          })),
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
function finishJob(
  db: PrismaClient,
  userId: string,
  jobId: string,
  id: string,
  state: "imported" | "duplicate" | "failed",
  error: string | null,
  eventId: string | null,
  identity: Identity | undefined,
  generation: number,
) {
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
  await db.calendarImportIdentity.createMany({
    data: [{ id: randomUUID(), userId, accountId, calendarId, uid, source }],
    skipDuplicates: true,
  });
  return db.calendarImportIdentity.findUnique({
    where: {
      userId_accountId_calendarId_uid: { userId, accountId, calendarId, uid },
    },
  });
}

function jobs(db: PrismaClient) {
  return {
    project: projectCalendarImport,
    hasCapacity: async (userId: string) =>
      (await db.calendarImportJob.count({ where: { userId } })) < 10,
    create: (
      userId: string,
      accountId: string,
      calendarId: string,
      items: CalendarImportRow[],
      files: string,
    ) => createJob(db, userId, accountId, calendarId, items, files),
    list: (userId: string, accountId: string) =>
      db.calendarImportJob.findMany({
        where: { userId, accountId },
        include: { items: { orderBy: { index: "asc" } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    get: (userId: string, id: string) =>
      db.calendarImportJob.findFirst({
        where: { id, userId },
        include: { items: { orderBy: { index: "asc" } } },
      }),
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
    finish: (
      userId: string,
      jobId: string,
      id: string,
      state: "imported" | "duplicate" | "failed",
      error: string | null,
      eventId: string | null,
      identity: Identity | undefined,
      generation: number,
    ) =>
      finishJob(
        db,
        userId,
        jobId,
        id,
        state,
        error,
        eventId,
        identity,
        generation,
      ),
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
export function createCalendarImportStore(db: PrismaClient) {
  return { ...jobs(db), ...itemOperations(db) };
}
export type CalendarImportStore = ReturnType<typeof createCalendarImportStore>;
