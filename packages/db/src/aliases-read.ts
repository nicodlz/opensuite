import { ResultAsync } from "neverthrow";
import type { PrismaClient } from "./generated/index.js";
import { unavailable } from "./aliases-shared.ts";
import { withUserLease } from "./alias-locks.ts";

export const createLeaseAndList = (db: PrismaClient) => ({
  withUserLease: <T>(userId: string, work: (token: string) => Promise<T>) =>
    withUserLease(db, userId, work),
  findRequest: (userId: string, requestId: string) =>
    ResultAsync.fromPromise(
      db.emailAlias.findUnique({
        where: { userId_requestId: { userId, requestId } },
      }),
      unavailable,
    ),
  domains: () =>
    ResultAsync.fromPromise(
      db.domain.findMany({
        where: {
          status: "verified",
          removalPending: false,
          stalwartId: { not: null },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      unavailable,
    ),
  list: (userId: string, search?: string) =>
    ResultAsync.fromPromise(
      db.emailAlias.findMany({
        where: {
          userId,
          deletedAt: null,
          ...(search
            ? {
                OR: [
                  { address: { contains: search, mode: "insensitive" } },
                  { website: { contains: search, mode: "insensitive" } },
                  { note: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
      }),
      unavailable,
    ),
});

export const createSnapshot = (db: PrismaClient) => ({
  snapshot: (userId: string, id: string) =>
    ResultAsync.fromPromise(
      db.emailAlias.findFirst({
        where: { id, userId },
        include: { domain: true, user: { include: { mailbox: true } } },
      }),
      unavailable,
    ),
  touch: (userId: string, id: string) =>
    ResultAsync.fromPromise(
      db.emailAlias
        .updateMany({
          where: { id, userId, ready: false },
          data: { updatedAt: new Date() },
        })
        .then(() => undefined),
      unavailable,
    ),
  finish: (
    userId: string,
    id: string,
    token: string,
    row: {
      revision: number;
      domain: { status: string };
      user: { disabled: boolean; mailbox: { status: string } | null };
    },
    data: {
      ready: boolean;
      detachedByDomain: boolean;
      suspended: boolean;
      lastAccountId: string | null;
    },
  ) =>
    ResultAsync.fromPromise(
      db.emailAlias
        .updateMany({
          where: {
            id,
            userId,
            revision: row.revision,
            domain: { status: row.domain.status },
            user: {
              aliasSyncToken: token,
              disabled: row.user.disabled,
              mailbox:
                row.user.mailbox === null
                  ? { is: null }
                  : { is: { status: row.user.mailbox.status } },
            },
          },
          data,
        })
        .then((result) => result.count === 1),
      unavailable,
    ),
  dirty: (userId: string, id: string) =>
    ResultAsync.fromPromise(
      db.emailAlias
        .updateMany({ where: { id, userId }, data: { ready: false } })
        .then(() => undefined),
      unavailable,
    ),
  get: (userId: string, id: string) =>
    ResultAsync.fromPromise(
      db.emailAlias.findFirst({ where: { id, userId } }),
      unavailable,
    ),
});

export const createSubmission = (db: PrismaClient) => ({
  pending: () =>
    ResultAsync.fromPromise(
      db.emailAlias.findMany({
        where: { ready: false },
        select: { userId: true, id: true },
        take: 100,
        orderBy: { updatedAt: "asc" },
      }),
      unavailable,
    ),
  canSendAs: (userId: string, address: string) =>
    ResultAsync.fromPromise(
      db.emailAlias.findFirst({
        where: {
          userId,
          address,
          enabled: true,
          ready: true,
          suspended: false,
          detachedByDomain: false,
          deletedAt: null,
          domain: { status: "verified" },
        },
        select: { id: true },
      }),
      unavailable,
    ),
  auditSubmission: (userId: string, aliasId: string) =>
    ResultAsync.fromPromise(
      db.auditEvent
        .create({
          data: {
            userId,
            action: "alias.submission.attempt",
            detail: { aliasId },
          },
        })
        .then(() => undefined),
      unavailable,
    ),
});
