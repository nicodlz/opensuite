import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { Prisma, PrismaClient } from "./generated/index.js";
import {
  ALIAS_DOMAIN_LOCK_SEED,
  ALIAS_USER_LOCK_SEED,
  withUserLease,
} from "./alias-locks.ts";

type Kind =
  "invalid" | "not_found" | "conflict" | "limit" | "key_limit" | "unavailable";
export type AliasStoreFailure = { kind: Kind };
const unavailable = (): AliasStoreFailure => ({ kind: "unavailable" });
const wrap = <T>(promise: Promise<Result<T, AliasStoreFailure>>) =>
  ResultAsync.fromPromise(promise, unavailable).andThen((result) => result);
const validDomain = (tx: Prisma.TransactionClient, id: string) =>
  tx.domain.findFirst({
    where: {
      id,
      status: "verified",
      removalPending: false,
      stalwartId: { not: null },
    },
  });
export const createAliasStore = (db: PrismaClient) => {
  const locked = <T>(
    userId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${ALIAS_USER_LOCK_SEED}))`;
        return work(tx);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  return {
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
    reserve: (
      userId: string,
      input: {
        domainId?: string | undefined;
        requestId?: string | undefined;
        website?: string | null | undefined;
        note?: string | null | undefined;
      },
      localPart: string,
      cap: number,
    ) =>
      wrap(
        locked(userId, async (tx) => {
          if (input.requestId) {
            const prior = await tx.emailAlias.findUnique({
              where: {
                userId_requestId: { userId, requestId: input.requestId },
              },
            });
            if (prior)
              return prior.deletedAt ? err({ kind: "conflict" }) : ok(prior);
          }
          const user = await tx.user.findFirst({
            where: {
              id: userId,
              disabled: false,
              mailbox: { status: "active" },
            },
            select: {
              defaultAliasDomainId: true,
              mailbox: { select: { accountId: true } },
            },
          });
          const domainId = input.domainId ?? user?.defaultAliasDomainId;
          if (!user || !domainId) return err({ kind: "invalid" });
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
          const domain = await validDomain(tx, domainId);
          if (!domain) return err({ kind: "invalid" });
          if (
            (await tx.emailAlias.count({
              where: { userId, deletedAt: null },
            })) >= cap ||
            (await tx.emailAlias.count({ where: { userId } })) >= cap * 10
          )
            return err({ kind: "limit" });
          const record = await tx.address.create({
            data: { userId, domainId, localPart, isAlias: true },
          });
          const alias = await tx.emailAlias.create({
            data: {
              userId,
              domainId,
              addressId: record.id,
              address: `${localPart}@${domain.name}`,
              localPart,
              lastAccountId: user.mailbox?.accountId ?? null,
              website: input.website?.toLowerCase() ?? null,
              note: input.note ?? null,
              requestId: input.requestId ?? null,
            },
          });
          await tx.auditEvent.create({
            data: {
              userId,
              action: "alias.create",
              detail: { aliasId: alias.id },
            },
          });
          return ok(alias);
        }),
      ),
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
    update: (
      userId: string,
      id: string,
      data: {
        website?: string | null | undefined;
        note?: string | null | undefined;
      },
    ) =>
      wrap(
        (async () => {
          const result = await db.emailAlias.updateMany({
            where: { id, userId, deletedAt: null },
            data: {
              ...(data.website === undefined
                ? {}
                : { website: data.website?.toLowerCase() ?? null }),
              ...(data.note === undefined ? {} : { note: data.note }),
            },
          });
          return result.count
            ? ok(
                await db.emailAlias.findFirstOrThrow({ where: { id, userId } }),
              )
            : err({ kind: "not_found" });
        })(),
      ),
    transition: (
      userId: string,
      id: string,
      desired: "enable" | "disable" | "delete",
    ) =>
      wrap(
        locked(userId, async (tx) => {
          const row = await tx.emailAlias.findFirst({ where: { id, userId } });
          if (!row || (row.deletedAt && desired !== "delete"))
            return err({ kind: "not_found" });
          if (desired === "enable" && !(await validDomain(tx, row.domainId)))
            return err({ kind: "invalid" });
          await tx.emailAlias.update({
            where: { id },
            data: {
              enabled: desired === "enable",
              ready: false,
              detachedByDomain: false,
              suspended: false,
              revision: { increment: 1 },
              ...(desired === "delete" && !row.deletedAt
                ? { deletedAt: new Date() }
                : {}),
            },
          });
          await tx.auditEvent.create({
            data: {
              userId,
              action: `alias.${desired}`,
              detail: { aliasId: id },
            },
          });
          return ok(undefined);
        }),
      ),
    match: (userId: string, addresses: string[]) =>
      ResultAsync.fromPromise(
        db.emailAlias.findMany({
          where: { userId, address: { in: addresses } },
        }),
        unavailable,
      ),
    setDefault: (userId: string, domainId: string) =>
      wrap(
        locked(userId, async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
          if (!(await validDomain(tx, domainId)))
            return err({ kind: "invalid" });
          await tx.user.update({
            where: { id: userId },
            data: { defaultAliasDomainId: domainId },
          });
          return ok({ domainId });
        }),
      ),
    getDefault: (userId: string) =>
      ResultAsync.fromPromise(
        db.user
          .findUniqueOrThrow({
            where: { id: userId },
            select: { defaultAliasDomainId: true },
          })
          .then((user) => ({ domainId: user.defaultAliasDomainId })),
        unavailable,
      ),
    createKey: (
      userId: string,
      name: string,
      prefix: string,
      secretHash: string,
    ) =>
      wrap(
        locked(userId, async (tx) => {
          if (
            (await tx.aliasApiKey.count({
              where: { userId, revokedAt: null },
            })) >= 20 ||
            (await tx.aliasApiKey.count({ where: { userId } })) >= 200
          )
            return err({ kind: "key_limit" });
          const row = await tx.aliasApiKey.create({
            data: { userId, name, prefix, secretHash },
          });
          await tx.auditEvent.create({
            data: {
              userId,
              action: "alias.key.create",
              detail: { keyId: row.id },
            },
          });
          return ok(row);
        }),
      ),
    listKeys: (userId: string) =>
      ResultAsync.fromPromise(
        db.aliasApiKey.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
        }),
        unavailable,
      ),
    revokeKey: (userId: string, id: string) =>
      wrap(
        db.$transaction(async (tx) => {
          const result = await tx.aliasApiKey.updateMany({
            where: { id, userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          if (!result.count) return err({ kind: "not_found" });
          await tx.auditEvent.create({
            data: { userId, action: "alias.key.revoke", detail: { keyId: id } },
          });
          return ok({ revoked: true as const });
        }),
      ),
    keyForPrefix: (prefix: string) =>
      ResultAsync.fromPromise(
        db.aliasApiKey.findUnique({
          where: { prefix },
          include: { user: true },
        }),
        unavailable,
      ),
    useKey: (id: string) =>
      ResultAsync.fromPromise(
        db.aliasApiKey
          .updateMany({
            where: { id, revokedAt: null, user: { disabled: false } },
            data: { lastUsedAt: new Date() },
          })
          .then((result) => result.count === 1),
        unavailable,
      ),
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
  };
};
export type AliasStore = ReturnType<typeof createAliasStore>;
