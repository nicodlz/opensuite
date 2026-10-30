import { err, ok, ResultAsync } from "neverthrow";
import type { PrismaClient } from "./generated/index.js";
import { createLocked, unavailable, wrap } from "./aliases-shared.ts";
import { ALIAS_DOMAIN_LOCK_SEED, withUserLease } from "./alias-locks.ts";

export const validMailboxLocalPart = (part: string) =>
  part.length <= 39 && /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(part);
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
      if (
        !localPart ||
        !validMailboxLocalPart(localPart) ||
        !name ||
        extra !== undefined
      )
        return null;
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
              (
                await tx.$queryRaw<
                  { id: string }[]
                >`SELECT "id" FROM "Address" WHERE "domainId" = ${domain.id} AND lower("localPart") = ${localPart} LIMIT 1`
              ).length
            )
              return null;
          }
          if (
            await tx.checkoutClaim.count({
              where: {
                pendingEmail: email.toLowerCase(),
                claimedAt: null,
                OR: [
                  { expiresAt: { gt: new Date() } },
                  { signupLeaseUntil: { gt: new Date() } },
                ],
              },
            })
          )
            return null;
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
          let failures = 0;
          // Bound management requests and preserve per-domain failure isolation.
          /* oxlint-disable eslint/no-await-in-loop */
          for (const name of configured) {
            try {
              const existing = await db.domain.findUnique({ where: { name } });
              if (existing?.removalPending || existing?.stalwartId) continue;
              const owner =
                existing?.userId ??
                (
                  await db.user.findFirst({
                    where: { role: "admin", disabled: false },
                    orderBy: { createdAt: "asc" },
                    select: { id: true },
                  })
                )?.id;
              if (!owner) continue;
              const remoteId = await createDomain(name);
              await db.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
                const current = await tx.domain.findUnique({ where: { name } });
                if (current) {
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${current.id}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
                  await tx.domain.updateMany({
                    where: {
                      id: current.id,
                      removalPending: false,
                      stalwartId: null,
                    },
                    data: { stalwartId: remoteId },
                  });
                } else
                  await tx.domain.create({
                    data: { name, userId: owner, stalwartId: remoteId },
                  });
              });
            } catch {
              failures++;
            }
          }
          /* oxlint-enable eslint/no-await-in-loop */
          return failures;
        })(),
        unavailable,
      ),
    markChanged: () =>
      ResultAsync.fromPromise(
        (async () => {
          const rows = await db.address.findMany({
            where: { mailboxManaged: true, ready: true, removedAt: null },
            include: {
              domain: {
                include: { user: { select: { role: true, disabled: true } } },
              },
              user: { include: { mailbox: true } },
            },
          });
          // Preserve ordering while marking stale desired states.
          /* oxlint-disable eslint/no-await-in-loop */
          for (const row of rows) {
            const domainUsable =
              !row.domain.removalPending &&
              row.domain.stalwartId !== null &&
              (configured.includes(row.domain.name) ||
                (row.domain.status === "verified" &&
                  row.domain.user.role === "admin" &&
                  !row.domain.user.disabled));
            const desired =
              !row.removalPending &&
              domainUsable &&
              !row.user.disabled &&
              row.user.mailbox?.status === "active";
            if (row.active !== desired)
              await db.address.updateMany({
                where: { id: row.id, ready: true, revision: row.revision },
                data: {
                  ready: false,
                  active: false,
                  revision: { increment: 1 },
                },
              });
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
                removedAt: null,
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
          localPart = localPart.toLowerCase();
          if (!validMailboxLocalPart(localPart))
            return err({ kind: "invalid" });
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
          const primary = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "User" WHERE lower("email") = ${full.toLowerCase()} LIMIT 1`;
          const occupied = await tx.$queryRaw<
            {
              id: string;
              userId: string;
              removedAt: Date | null;
              mailboxManaged: boolean;
              isAlias: boolean;
            }[]
          >`SELECT "id", "userId", "removedAt", "mailboxManaged", "isAlias" FROM "Address" WHERE "domainId" = ${domainId} AND lower("localPart") = ${localPart} LIMIT 1`;
          const prior = occupied[0];
          if (
            (await tx.checkoutClaim.count({
              where: {
                pendingEmail: full.toLowerCase(),
                claimedAt: null,
                OR: [
                  { expiresAt: { gt: new Date() } },
                  { signupLeaseUntil: { gt: new Date() } },
                ],
              },
            })) ||
            primary.length ||
            (prior &&
              (prior.userId !== userId ||
                !prior.removedAt ||
                !prior.mailboxManaged ||
                prior.isAlias))
          )
            return err({ kind: "conflict" });
          // Pending removals retain their reservation and count until delivery is removed.
          const count = await tx.address.count({
            where: {
              userId,
              isAlias: false,
              mailboxManaged: true,
              removedAt: null,
            },
          });
          if (limit !== null && count + 1 >= limit)
            return err({ kind: "limit" });
          const row = prior
            ? await tx.address.update({
                where: { id: prior.id },
                data: {
                  removedAt: null,
                  removalPending: false,
                  ready: false,
                  active: false,
                  lastAccountId: user.mailbox.accountId,
                  revision: { increment: 1 },
                },
                include: { domain: true },
              })
            : await tx.address.create({
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
            where: {
              id,
              userId,
              isAlias: false,
              mailboxManaged: true,
              removedAt: null,
            },
          });
          if (!row) return err({ kind: "not_found" });
          await tx.address.update({
            where: { id },
            data: {
              removalPending: true,
              ready: false,
              active: false,
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
            data: {
              ready: true,
              active: enabled,
              lastAccountId: accountId,
              ...(row.removalPending
                ? { removedAt: new Date(), removalPending: false }
                : {}),
            },
          });
          if (!updated.count) return false;
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
          where: { mailboxManaged: true, ready: false, removedAt: null },
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
          if (
            !localPart ||
            !validMailboxLocalPart(localPart) ||
            !domain ||
            extra !== undefined
          )
            return null;
          const ids = await db.$queryRaw<
            { id: string }[]
          >`SELECT a."id" FROM "Address" a JOIN "Domain" d ON d."id" = a."domainId" WHERE lower(a."localPart") = ${localPart} AND d."name" = ${domain}`;
          return db.address.findFirst({
            where: {
              userId,
              id: { in: ids.map((row) => row.id) },
              isAlias: false,
              mailboxManaged: true,
              ready: true,
              active: true,
              removedAt: null,
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
      const normalized = email.toLowerCase();
      const primary = await db.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "User" WHERE lower("email") = ${normalized} LIMIT 1`;
      const [localPart, domain, extra] = normalized.split("@");
      if (!localPart || !domain || extra !== undefined) return null;
      const ids = await db.$queryRaw<
        { id: string }[]
      >`SELECT a."id" FROM "Address" a JOIN "Domain" d ON d."id" = a."domainId" WHERE lower(a."localPart") = ${localPart} AND d."name" = ${domain}`;
      const row = await db.address.findFirst({
        where: {
          id: { in: ids.map((item) => item.id) },
          isAlias: false,
          mailboxManaged: true,
          ready: true,
          active: true,
          removedAt: null,
          removalPending: false,
          domain: { name: domain, ...usable },
          user: { disabled: false, mailbox: { status: "active" } },
        },
        select: { user: { select: { id: true, email: true } } },
      });
      return primary.length || !validMailboxLocalPart(localPart)
        ? null
        : (row?.user ?? null);
    },
  };
}
export type AddressStore = ReturnType<typeof createAddressStore>;
