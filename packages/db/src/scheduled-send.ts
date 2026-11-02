import type { PrismaClient } from "./generated/index.js";
import {
  clearScheduledGuard,
  failScheduled,
} from "./scheduled-send-failure.ts";
import {
  acceptScheduledHandoff,
  beginScheduledHandoff,
} from "./scheduled-send-handoff.ts";

export type DraftGuardWrite = "destroy" | "send" | "mutation";
export type DraftGuardBegin = (
  phase: DraftGuardWrite,
  mutationState?: string,
) => Promise<string | undefined>;
type ScheduledState =
  | "preparing"
  | "creating"
  | "pending"
  | "canceling"
  | "unknown"
  | "releasing"
  | "sent"
  | "canceled"
  | "failed";
export type ScheduledFailure =
  | "account_inactive"
  | "sender_unavailable"
  | "domain_unavailable"
  | "entitlement_required"
  | "quota_exceeded"
  | "draft_unavailable"
  | "submission_rejected";

export type ScheduledRecord = {
  id: string;
  userId: string;
  accountId: string;
  draftId: string;
  threadId: string;
  identityId: string;
  senderAddress: string;
  releaseAt: Date;
  submissionId: string | null;
  previousIds: string[];
  requestDelivery: string;
  state: string;
  failureReason: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  createdAt?: Date;
};
export type ScheduledReservation = Pick<
  ScheduledRecord,
  | "id"
  | "userId"
  | "accountId"
  | "draftId"
  | "threadId"
  | "identityId"
  | "senderAddress"
  | "releaseAt"
  | "requestDelivery"
> & { leaseToken: string; leaseUntil: Date };

class Store {
  readonly #db: PrismaClient;
  constructor(db: PrismaClient) {
    this.#db = db;
  }
  async acquire(
    userId: string,
    accountId: string,
    draftId: string,
    token: string,
  ) {
    try {
      await this.#db.mailDraftGuard.create({
        data: { userId, accountId, draftId, token, phase: "preparing" },
      });
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      )
        return false;
      throw error;
    }
  }
  async release(
    userId: string,
    accountId: string,
    draftId: string,
    token: string,
  ) {
    await this.#db.mailDraftGuard.deleteMany({
      where: { userId, accountId, draftId, token },
    });
  }
  async beginWrite(
    userId: string,
    accountId: string,
    ids: string[],
    token: string,
    phase: DraftGuardWrite,
    mutationState?: string,
  ) {
    if (phase === "mutation" && ids.length && !mutationState)
      throw new Error("draft mutation state required");
    await this.#db.$transaction(async (tx) => {
      const result = await tx.mailDraftGuard.updateMany({
        where: {
          userId,
          accountId,
          draftId: { in: ids },
          token,
          phase: "preparing",
        },
        data: { phase, mutationState: mutationState ?? null },
      });
      if (result.count !== ids.length) throw new Error("draft guard changed");
    });
  }
  staleGuards(before: Date) {
    return this.#db.mailDraftGuard.findMany({
      where: {
        phase: { in: ["preparing", "destroy", "send", "mutation"] },
        updatedAt: { lt: before },
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
    });
  }
  async clearStaleGuard(
    guard: {
      userId: string;
      accountId: string;
      draftId: string;
      token: string;
      phase: string;
    },
    before: Date,
  ) {
    await this.#db.mailDraftGuard.deleteMany({
      where: { ...guard, updatedAt: { lt: before } },
    });
  }
  async touchGuard(
    guard: {
      userId: string;
      accountId: string;
      draftId: string;
      token: string;
    },
    now: Date,
  ) {
    const { userId, accountId, draftId, token } = guard;
    await this.#db.mailDraftGuard.updateMany({
      where: { userId, accountId, draftId, token },
      data: { updatedAt: now },
    });
  }
  guard(userId: string, accountId: string, draftId: string) {
    return this.#db.mailDraftGuard.findUnique({
      where: { userId_accountId_draftId: { userId, accountId, draftId } },
    });
  }
  async guardStatus(userId: string, accountId: string, draftId: string) {
    const guard = await this.guard(userId, accountId, draftId);
    if (!guard) return "clear" as const;
    const scheduled = await this.get(userId, guard.token);
    if (scheduled && ["preparing", "pending"].includes(scheduled.state))
      return "scheduled" as const;
    return "unknown" as const;
  }
  async reserve(input: ScheduledReservation) {
    try {
      await this.#db.$transaction(async (tx) => {
        await tx.mailDraftGuard.create({
          data: {
            userId: input.userId,
            accountId: input.accountId,
            draftId: input.draftId,
            token: input.id,
            phase: "scheduled",
          },
        });
        await tx.scheduledSend.create({
          data: { ...input, previousIds: [], state: "preparing" },
        });
      });
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      )
        return false;
      throw error;
    }
  }
  get(userId: string, id: string) {
    return this.#db.scheduledSend.findFirst({ where: { id, userId } });
  }
  async queue(id: string, token: string) {
    const result = await this.#db.scheduledSend.updateMany({
      where: { id, state: "preparing", leaseToken: token },
      data: { state: "pending", leaseToken: null, leaseUntil: null },
    });
    return result.count === 1;
  }
  async claim(id: string, now: Date, token: string) {
    const result = await this.#db.scheduledSend.updateMany({
      where: {
        id,
        releaseAt: { lte: now },
        OR: [
          { state: "pending" },
          { state: "preparing", leaseUntil: { lte: now } },
        ],
      },
      data: {
        state: "preparing",
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + 60_000),
      },
    });
    return result.count === 1;
  }
  async defer(id: string, token: string) {
    await this.#db.scheduledSend.updateMany({
      where: { id, state: "preparing", leaseToken: token },
      data: { state: "pending", leaseToken: null, leaseUntil: null },
    });
  }
  beginHandoff(
    row: ScheduledRecord,
    token: string,
    now: () => number,
    previousIds: string[],
    configured: readonly string[],
  ) {
    return beginScheduledHandoff(
      this.#db,
      row,
      token,
      now,
      previousIds,
      configured,
    );
  }
  acceptHandoff(row: ScheduledRecord, submissionId: string) {
    return acceptScheduledHandoff(this.#db, row, submissionId);
  }
  list(userId: string, accountId: string) {
    return this.#db.scheduledSend.findMany({
      where: {
        userId,
        accountId,
        state: {
          in: [
            "preparing",
            "creating",
            "pending",
            "canceling",
            "unknown",
            "releasing",
            "sent",
            "canceled",
            "failed",
          ],
        },
      },
      orderBy: { releaseAt: "asc" },
    });
  }
  work(after: string | undefined, now: Date) {
    return this.#db.scheduledSend.findMany({
      where: {
        ...(after ? { id: { gt: after } } : {}),
        OR: [
          { state: "pending", releaseAt: { lte: now } },
          {
            state: "preparing",
            releaseAt: { lte: now },
            leaseUntil: { lte: now },
          },
          {
            state: {
              in: ["creating", "canceling", "unknown", "releasing"],
            },
          },
        ],
      },
      orderBy: { id: "asc" },
      take: 100,
    });
  }
  beginCancel(id: string) {
    return this.transition(
      id,
      ["pending", "unknown", "canceling"],
      "canceling",
    );
  }
  async transition(
    id: string,
    from: ScheduledState[],
    state: ScheduledState,
    extra: {
      submissionId?: string;
      releaseAt?: Date;
      previousIds?: string[];
    } = {},
    onlyUnidentified = false,
  ) {
    const result = await this.#db.scheduledSend.updateMany({
      where: {
        id,
        state: { in: from },
        ...(onlyUnidentified ? { submissionId: null } : {}),
      },
      data: { state, ...extra },
    });
    return result.count === 1;
  }
  async finish(
    row: ScheduledRecord,
    from: ScheduledState[],
    state: ScheduledState,
  ) {
    return this.#db.$transaction(async (tx) => {
      const result = await tx.scheduledSend.updateMany({
        where: { id: row.id, state: { in: from } },
        data: { state, leaseToken: null, leaseUntil: null },
      });
      if (result.count !== 1) return false;
      await clearScheduledGuard(tx, row);
      return true;
    });
  }
  fail(row: ScheduledRecord, reason: ScheduledFailure, token?: string) {
    return this.#db.$transaction((tx) => failScheduled(tx, row, reason, token));
  }
}
export const createScheduledSendStore = (db: PrismaClient) => new Store(db);
export type ScheduledSendStore = ReturnType<typeof createScheduledSendStore>;
