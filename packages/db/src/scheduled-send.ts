import type { PrismaClient } from "./generated/index.js";

export type ScheduledRecord = {
  id: string;
  userId: string;
  accountId: string;
  draftId: string;
  threadId: string;
  identityId: string;
  releaseAt: Date;
  submissionId: string | null;
  previousIds: string[];
  requestDelivery: string;
  state: string;
  createdAt?: Date;
};

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
        data: { userId, accountId, draftId, token },
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
  async reserve(input: Omit<ScheduledRecord, "submissionId" | "createdAt">) {
    try {
      await this.#db.$transaction(async (tx) => {
        await tx.mailDraftGuard.create({
          data: {
            userId: input.userId,
            accountId: input.accountId,
            draftId: input.draftId,
            token: input.id,
          },
        });
        await tx.scheduledSend.create({ data: input });
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
            state: {
              in: [
                "preparing",
                "creating",
                "canceling",
                "unknown",
                "releasing",
              ],
            },
          },
        ],
      },
      orderBy: { id: "asc" },
      take: 100,
    });
  }
  async transition(
    id: string,
    from: string[],
    state: string,
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
  async finish(row: ScheduledRecord, from: string[], state: string) {
    return this.#db.$transaction(async (tx) => {
      const result = await tx.scheduledSend.updateMany({
        where: { id: row.id, state: { in: from } },
        data: { state },
      });
      if (result.count !== 1) return false;
      await tx.mailDraftGuard.deleteMany({
        where: {
          userId: row.userId,
          accountId: row.accountId,
          draftId: row.draftId,
          token: row.id,
        },
      });
      return true;
    });
  }
}
export const createScheduledSendStore = (db: PrismaClient) => new Store(db);
export type ScheduledSendStore = ReturnType<typeof createScheduledSendStore>;
