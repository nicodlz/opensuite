import { err, ok, ResultAsync } from "neverthrow";
import type { PrismaClient } from "./generated/index.js";
import { createLocked, unavailable, wrap } from "./aliases-shared.ts";
import { ALIAS_DOMAIN_LOCK_SEED, withUserLease } from "./alias-locks.ts";

/** Configured domains are usable even if DNS verification is not configured. */
export function createAddressStore(
  db: PrismaClient,
  configured: readonly string[],
) {
  const locked = createLocked(db);
  const usable = {
    removalPending: false,
    stalwartId: { not: null },
    OR: [
      { status: "verified", user: { role: "admin", disabled: false } },
      { name: { in: [...configured] } },
    ],
  };
  return {
    withPrimaryReservation: async <T>(
      email: string,
      work: () => Promise<T>,
    ): Promise<T | null> => {
      const [localPart, name, extra] = email.toLowerCase().split("@");
      if (!localPart || !name || extra !== undefined) return null;
      return db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
          const domain = await tx.domain.findUnique({ where: { name } });
          if (domain) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domain.id}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
            const currentDomain = await tx.domain.findUnique({
              where: { id: domain.id },
              select: { removalPending: true },
            });
            if (
              !currentDomain ||
              currentDomain.removalPending ||
              (await tx.address.count({
                where: {
                  domainId: domain.id,
                  localPart: { equals: localPart, mode: "insensitive" },
                },
              }))
            )
              return null;
          }
          return work();
        },
        { timeout: 60000 },
      );
    },
    audit: (userId: string, action: string, id?: string) =>
      ResultAsync.fromPromise(
        db.auditEvent
          .create({
            data: { userId, action, detail: id ? { addressId: id } : {} },
          })
          .then(() => undefined),
        unavailable,
      ),
    ensureConfigured: (createDomain: (name: string) => Promise<string>) =>
      ResultAsync.fromPromise(
        (async () => {
          // Keep management operations bounded and ordered.
          /* oxlint-disable eslint/no-await-in-loop */
          for (const name of configured) {
            await db.$transaction(
              async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
                const existing = await tx.domain.findUnique({
                  where: { name },
                });
                if (existing?.removalPending || existing?.stalwartId) return;
                const owner =
                  existing?.userId ??
                  (
                    await tx.user.findFirst({
                      where: { role: "admin", disabled: false },
                      orderBy: { createdAt: "asc" },
                      select: { id: true },
                    })
                  )?.id;
                if (!owner) return;
                if (existing)
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${existing.id}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
                const domainId = await createDomain(name);
                if (existing)
                  await tx.domain.updateMany({
                    where: {
                      id: existing.id,
                      removalPending: false,
                      stalwartId: null,
                    },
                    data: { stalwartId: domainId },
                  });
                else
                  await tx.domain.create({
                    data: { name, userId: owner, stalwartId: domainId },
                  });
              },
              { timeout: 20000 },
            );
          }
          /* oxlint-enable eslint/no-await-in-loop */
        })(),
        unavailable,
      ),
    domains: () =>
      ResultAsync.fromPromise(
        db.domain.findMany({
          where: usable,
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        unavailable,
      ),
    list: (userId: string) =>
      ResultAsync.fromPromise(
        db.user.findUniqueOrThrow({
          where: { id: userId },
          select: {
            email: true,
            addresses: {
              where: {
                isAlias: false,
                mailboxManaged: true,
              },
              include: {
                domain: {
                  include: { user: { select: { role: true, disabled: true } } },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        unavailable,
      ),
    reserve: (
      userId: string,
      domainId: string,
      localPart: string,
      limit: number | null,
    ) =>
      wrap(
        locked(userId, async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
          const user = await tx.user.findFirst({
            where: {
              id: userId,
              disabled: false,
              mailbox: { status: "active" },
            },
            select: { email: true, mailbox: { select: { accountId: true } } },
          });
          const domain = await tx.domain.findFirst({
            where: { id: domainId, ...usable },
          });
          if (!user || !domain || !user.mailbox)
            return err({ kind: "invalid" });
          const full = `${localPart}@${domain.name}`;
          if (
            (await tx.user.count({
              where: { email: { equals: full, mode: "insensitive" } },
            })) ||
            (await tx.address.count({
              where: {
                domainId,
                localPart: { equals: localPart, mode: "insensitive" },
              },
            }))
          )
            return err({ kind: "conflict" });
          // Pending removals retain their reservation and count until delivery is removed.
          const count = await tx.address.count({
            where: {
              userId,
              isAlias: false,
              NOT: {
                localPart: {
                  equals: user.email.split("@")[0] ?? "",
                  mode: "insensitive",
                },
                domain: {
                  name: {
                    equals: user.email.split("@")[1] ?? "",
                    mode: "insensitive",
                  },
                },
              },
            },
          });
          if (limit !== null && count + 1 >= limit)
            return err({ kind: "limit" });
          const row = await tx.address.create({
            data: {
              userId,
              domainId,
              localPart,
              mailboxManaged: true,
              lastAccountId: user.mailbox.accountId,
            },
            include: { domain: true },
          });
          await tx.auditEvent.create({
            data: {
              userId,
              action: "address.create.pending",
              detail: { addressId: row.id },
            },
          });
          return ok(row);
        }),
      ),
    remove: (userId: string, id: string) =>
      wrap(
        locked(userId, async (tx) => {
          const row = await tx.address.findFirst({
            where: { id, userId, isAlias: false, mailboxManaged: true },
          });
          if (!row) return err({ kind: "not_found" });
          await tx.address.update({
            where: { id },
            data: {
              removalPending: true,
              ready: false,
              revision: { increment: 1 },
            },
          });
          await tx.auditEvent.create({
            data: {
              userId,
              action: "address.remove.pending",
              detail: { addressId: id },
            },
          });
          return ok(undefined);
        }),
      ),
    withUserLease: <T>(userId: string, work: (token: string) => Promise<T>) =>
      withUserLease(db, userId, work),
    snapshot: (userId: string, id: string) =>
      ResultAsync.fromPromise(
        db.address.findFirst({
          where: { id, userId, mailboxManaged: true, isAlias: false },
          include: {
            domain: {
              include: { user: { select: { role: true, disabled: true } } },
            },
            user: { include: { mailbox: true } },
          },
        }),
        unavailable,
      ),
    finish: (
      userId: string,
      id: string,
      token: string,
      row: {
        revision: number;
        removalPending: boolean;
        domain: {
          status: string;
          removalPending: boolean;
          user: { role: string; disabled: boolean };
        };
        user: {
          disabled: boolean;
          mailbox: { accountId: string; status: string } | null;
        };
      },
      accountId: string | null,
      enabled: boolean,
    ) =>
      ResultAsync.fromPromise(
        db.$transaction(async (tx) => {
          const where = {
            id,
            userId,
            revision: row.revision,
            removalPending: row.removalPending,
            domain: {
              status: row.domain.status,
              removalPending: row.domain.removalPending,
              user: {
                role: row.domain.user.role,
                disabled: row.domain.user.disabled,
              },
            },
            user: {
              aliasSyncToken: token,
              disabled: row.user.disabled,
              mailbox:
                row.user.mailbox === null
                  ? { is: null }
                  : {
                      is: {
                        accountId: row.user.mailbox.accountId,
                        status: row.user.mailbox.status,
                      },
                    },
            },
          };
          const updated = await tx.address.updateMany({
            where,
            data: { ready: enabled, lastAccountId: accountId },
          });
          if (!updated.count) return false;
          if (row.removalPending) await tx.address.delete({ where: { id } });
          if (row.removalPending || enabled)
            await tx.auditEvent.create({
              data: {
                userId,
                action: row.removalPending
                  ? "address.remove.success"
                  : "address.create.success",
                detail: { addressId: id },
              },
            });
          return true;
        }),
        unavailable,
      ),
    dirty: (userId: string, id: string) =>
      ResultAsync.fromPromise(
        db.address
          .updateMany({
            where: { id, userId },
            data: { ready: false, updatedAt: new Date() },
          })
          .then(() => undefined),
        unavailable,
      ),
    pending: () =>
      ResultAsync.fromPromise(
        db.address.findMany({
          where: { mailboxManaged: true, ready: false },
          select: { id: true, userId: true },
          orderBy: { updatedAt: "asc" },
          take: 100,
        }),
        unavailable,
      ),
    canSendAs: (userId: string, email: string) =>
      ResultAsync.fromPromise(
        (async () => {
          const [localPart, domain, extra] = email.toLowerCase().split("@");
          if (!localPart || !domain || extra !== undefined) return null;
          return db.address.findFirst({
            where: {
              userId,
              localPart: { equals: localPart, mode: "insensitive" },
              isAlias: false,
              mailboxManaged: true,
              ready: true,
              removalPending: false,
              domain: { name: domain, ...usable },
              user: { disabled: false, mailbox: { status: "active" } },
            },
            select: { id: true },
          });
        })(),
        unavailable,
      ),
    resolveLogin: async (email: string) => {
      const [localPart, domain, extra] = email.toLowerCase().split("@");
      if (!localPart || !domain || extra !== undefined) return null;
      const row = await db.address.findFirst({
        where: {
          localPart: { equals: localPart, mode: "insensitive" },
          isAlias: false,
          mailboxManaged: true,
          ready: true,
          removalPending: false,
          domain: { name: domain, ...usable },
          user: { disabled: false, mailbox: { status: "active" } },
        },
        select: { user: { select: { id: true, email: true } } },
      });
      return row?.user ?? null;
    },
  };
}
export type AddressStore = ReturnType<typeof createAddressStore>;
