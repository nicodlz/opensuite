import type { PrismaClient } from "./generated/index.js";
import {
  reserveOrganized,
  type SeriesInput,
  type OperationInput,
} from "./organized-reserve.ts";
import {
  transitionOrganized,
  rejectOrganized,
  organizedCalendarWritten,
  transitionDelivery,
  finishOrganized,
} from "./organized-progress.ts";
import { recordOrganizedResponse } from "./organized-response.ts";
import {
  pendingOrganized,
  claimOrganizedRecovery,
} from "./organized-pending.ts";

export function createOrganizedInvitationStore(db: PrismaClient) {
  return {
    pending: () => pendingOrganized(db),
    claimRecovery: (userId: string, operationId: string, updatedAt: Date) =>
      claimOrganizedRecovery(db, userId, operationId, updatedAt),
    operation: (userId: string, id: string) =>
      db.organizedOperation.findFirst({
        where: { id, series: { userId } },
        include: { series: true, deliveries: true },
      }),
    series: (userId: string, accountId: string, eventId: string) =>
      db.organizedSeries.findUnique({
        where: { userId_accountId_eventId: { userId, accountId, eventId } },
        include: { responses: true },
      }),
    byUid: (userId: string, accountId: string, uid: string) =>
      db.organizedSeries.findUnique({
        where: { userId_accountId_uid: { userId, accountId, uid } },
        include: { responses: true },
      }),
    rebase: (
      userId: string,
      id: string,
      revision: number,
      calendar: string,
      snapshot: string,
      sequence: number,
    ) =>
      db.organizedSeries
        .updateMany({
          where: { id, userId, revision, pendingId: null, cancelled: false },
          data: { calendar, snapshot, sequence, revision: { increment: 1 } },
        })
        .then((result) => result.count === 1),
    reserve: (
      series: SeriesInput,
      input: OperationInput,
      revision: number | null,
    ) => reserveOrganized(db, series, input, revision),
    transition: (
      ...args: Parameters<typeof transitionOrganized> extends [
        PrismaClient,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => transitionOrganized(db, ...args),
    reject: (
      ...args: Parameters<typeof rejectOrganized> extends [
        PrismaClient,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => rejectOrganized(db, ...args),
    calendarWritten: (
      ...args: Parameters<typeof organizedCalendarWritten> extends [
        PrismaClient,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => organizedCalendarWritten(db, ...args),
    delivery: (
      ...args: Parameters<typeof transitionDelivery> extends [
        PrismaClient,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => transitionDelivery(db, ...args),
    finish: (userId: string, id: string) => finishOrganized(db, userId, id),
    response: (input: Parameters<typeof recordOrganizedResponse>[1]) =>
      recordOrganizedResponse(db, input),
  };
}
export type OrganizedInvitationStore = ReturnType<
  typeof createOrganizedInvitationStore
>;
