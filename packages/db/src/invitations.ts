import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/index.js";

export interface InvitationSeriesInput {
  userId: string;
  accountId: string;
  uid: string;
  organizer: string;
  recipient: string;
  calendarId: string;
}
export interface InvitationOperationInput {
  id: string;
  fingerprint: string;
  calendar: string;
  organizerCalendar: string | null;
  baseSnapshot: string | null;
  participation: string | null;
  recurrenceId: string | null;
}

async function reserve(
  db: PrismaClient,
  input: InvitationSeriesInput,
  operation: InvitationOperationInput,
  expectedRevision: number | null,
) {
  return db.$transaction(async (tx) => {
    const existingOperation = await tx.invitationOperation.findUnique({
      where: { id: operation.id },
      include: { series: true },
    });
    if (existingOperation) {
      if (
        existingOperation.userId !== input.userId ||
        existingOperation.fingerprint !== operation.fingerprint
      )
        return null;
      return existingOperation;
    }
    if (expectedRevision === null) {
      await tx.invitationSeries.createMany({
        data: [{ id: randomUUID(), ...input }],
        skipDuplicates: true,
      });
    }
    const series = await tx.invitationSeries.findUnique({
      where: {
        userId_accountId_uid: {
          userId: input.userId,
          accountId: input.accountId,
          uid: input.uid,
        },
      },
    });
    if (
      !series ||
      series.organizer !== input.organizer ||
      series.recipient !== input.recipient ||
      series.calendarId !== input.calendarId ||
      series.pendingId ||
      series.revision !== (expectedRevision ?? 0)
    )
      return null;
    const lock = await tx.invitationSeries.updateMany({
      where: { id: series.id, revision: series.revision, pendingId: null },
      data: { pendingId: operation.id, revision: { increment: 1 } },
    });
    if (lock.count !== 1) return null;
    return tx.invitationOperation.create({
      data: {
        ...operation,
        userId: input.userId,
        seriesId: series.id,
        phase: "reserved",
      },
      include: { series: true },
    });
  });
}

async function transition(
  db: PrismaClient,
  userId: string,
  id: string,
  from: string,
  to: string,
  changes: {
    eventId?: string;
    calendar?: string;
    eventSnapshot?: string;
    draftId?: string;
    identityId?: string;
    release?: boolean;
  } = {},
) {
  return db.$transaction(async (tx) => {
    const operation = await tx.invitationOperation.findFirst({
      where: { id, userId, phase: from },
      include: { series: true },
    });
    if (!operation || operation.series.pendingId !== id) return false;
    const updated = await tx.invitationOperation.updateMany({
      where: { id, userId, phase: from },
      data: {
        phase: to,
        ...(changes.draftId === undefined ? {} : { draftId: changes.draftId }),
        ...(changes.identityId === undefined
          ? {}
          : { identityId: changes.identityId }),
      },
    });
    if (updated.count !== 1) return false;
    const series = await tx.invitationSeries.updateMany({
      where: { id: operation.seriesId, pendingId: id },
      data: {
        revision: { increment: 1 },
        ...(changes.eventId === undefined ? {} : { eventId: changes.eventId }),
        ...(changes.calendar === undefined
          ? {}
          : { calendar: changes.calendar }),
        ...(changes.eventSnapshot === undefined
          ? {}
          : { eventSnapshot: changes.eventSnapshot }),
        ...(changes.release
          ? { pendingId: null, revision: { increment: 1 } }
          : {}),
      },
    });
    if (series.count !== 1) throw new Error("Invitation operation changed");
    return true;
  });
}

/** A pending operation is never leased or retried automatically. */
export function createInvitationStore(db: PrismaClient) {
  return {
    authentication: async (accountId: string, messageId: string) =>
      db.inboundRecipient.findMany({
        where: {
          destination: accountId,
          remoteId: messageId,
          state: "imported",
        },
        select: { message: { select: { notification: true } } },
        take: 51,
      }),
    series: (
      input: Pick<InvitationSeriesInput, "userId" | "accountId" | "uid">,
    ) =>
      db.invitationSeries.findUnique({
        where: { userId_accountId_uid: input },
      }),
    operation: (userId: string, id: string) =>
      db.invitationOperation.findFirst({
        where: { id, userId },
        include: { series: true },
      }),
    reserve: (
      input: InvitationSeriesInput,
      operation: InvitationOperationInput,
      expectedRevision: number | null,
    ) => reserve(db, input, operation, expectedRevision),
    transition: (
      userId: string,
      id: string,
      from: string,
      to: string,
      changes?: Parameters<typeof transition>[5],
    ) => transition(db, userId, id, from, to, changes),
  };
}
export type InvitationStore = ReturnType<typeof createInvitationStore>;
