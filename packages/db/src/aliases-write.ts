import { err, ok, ResultAsync } from "neverthrow";
import type { PrismaClient } from "./generated/index.js";
import {
  unavailable,
  wrap,
  validDomain,
  aliasCapReached,
  aliasMetadata,
  type Locked,
} from "./aliases-shared.ts";
import { ALIAS_DOMAIN_LOCK_SEED } from "./alias-locks.ts";

export const createReserve = (
  locked: Locked,
  subscriberDomains?: readonly string[],
) => ({
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
        // An explicit domain must be eligible even on an idempotent retry.
        if (subscriberDomains !== undefined && input.domainId !== undefined) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
          const user = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true },
          });
          const domain = await tx.domain.findUnique({
            where: { id: input.domainId },
            select: { name: true },
          });
          if (
            !user ||
            !domain ||
            (user.role !== "admin" && !subscriberDomains.includes(domain.name))
          )
            return err({ kind: "invalid" });
        }
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
            role: true,
            mailbox: { select: { accountId: true } },
          },
        });
        if (!user) return err({ kind: "invalid" });
        const restricted =
          subscriberDomains !== undefined && user.role !== "admin";
        let domainId = input.domainId ?? user.defaultAliasDomainId;
        // The compatible API has no domain selector. Ignore a stale default
        // and choose the first available domain in the configured order.
        if (input.domainId === undefined && restricted) {
          const existing =
            domainId === null
              ? null
              : await tx.domain.findUnique({
                  where: { id: domainId },
                  select: { name: true },
                });
          if (!existing || !subscriberDomains.includes(existing.name)) {
            const candidates = await tx.domain.findMany({
              where: {
                name: { in: [...subscriberDomains] },
                status: "verified",
                removalPending: false,
                stalwartId: { not: null },
              },
              select: { id: true, name: true },
            });
            domainId =
              subscriberDomains.flatMap((name) =>
                candidates.filter((candidate) => candidate.name === name),
              )[0]?.id ?? null;
          }
        }
        if (!domainId) return err({ kind: "invalid" });
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const domain = await validDomain(tx, domainId);
        if (!domain || (restricted && !subscriberDomains.includes(domain.name)))
          return err({ kind: "invalid" });
        // Another account's primary address, provisioned or not.
        if (
          await tx.user.count({
            where: {
              email: {
                equals: `${localPart}@${domain.name}`,
                mode: "insensitive",
              },
            },
          })
        )
          return err({ kind: "conflict" });
        if (await aliasCapReached(tx, userId, cap))
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
            ...aliasMetadata(input),
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
});

export const createMutations = (db: PrismaClient, locked: Locked) => ({
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
          ? ok(await db.emailAlias.findFirstOrThrow({ where: { id, userId } }))
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
});

export const createDefaults = (
  db: PrismaClient,
  locked: Locked,
  subscriberDomains?: readonly string[],
) => ({
  setDefault: (userId: string, domainId: string) =>
    wrap(
      locked(userId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { role: true },
        });
        const domain = await validDomain(tx, domainId);
        if (
          !domain ||
          (subscriberDomains !== undefined &&
            user.role !== "admin" &&
            !subscriberDomains.includes(domain.name))
        )
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
          select: {
            defaultAliasDomainId: true,
            role: true,
            defaultAliasDomain: { select: { name: true } },
          },
        })
        .then((user) => ({
          domainId:
            subscriberDomains !== undefined &&
            user.role !== "admin" &&
            user.defaultAliasDomain !== null &&
            !subscriberDomains.includes(user.defaultAliasDomain.name)
              ? null
              : user.defaultAliasDomainId,
        })),
      unavailable,
    ),
});
