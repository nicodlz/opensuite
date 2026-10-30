import { ResultAsync } from "neverthrow";
import { ALIAS_DOMAIN_LOCK_SEED, withUserLease } from "./alias-locks.ts";
import { z } from "zod";
import type { PrismaClient } from "./generated/index.js";

const records = z.array(
  z.object({
    type: z.enum(["MX", "TXT", "CNAME"]),
    name: z.string(),
    value: z.string(),
    priority: z.number().int().optional(),
    status: z.enum(["pending", "verified", "failing"]),
  }),
);
const status = z.enum(["pending", "verified", "failing"]);
const failure = (): { kind: "unavailable"; message: string } => ({
  kind: "unavailable",
  message: "domain database operation failed",
});
const include = {
  addresses: {
    select: { id: true, userId: true, localPart: true, isAlias: true },
  },
};
const convert = (row: {
  id: string;
  name: string;
  stalwartId: string | null;
  status: string;
  checkedAt: Date | null;
  records: unknown;
  addresses: {
    id: string;
    userId: string;
    localPart: string;
    isAlias: boolean;
  }[];
}) => ({
  ...row,
  status: status.parse(row.status),
  records: records.parse(row.records),
  checkedAt: row.checkedAt?.toISOString() ?? null,
});
export const createDomainStore = (db: PrismaClient) => ({
  withUserLease<T>(userId: string, work: () => Promise<T>) {
    return withUserLease(db, userId, work);
  },
  beginRemoval(domainId: string) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const { name } = await tx.domain.findUniqueOrThrow({
          where: { id: domainId },
          select: { name: true },
        });
        // Accounts created by signup have a primary address but no record,
        // and may still be waiting for their mailbox.
        const [addresses, defaults, mailboxes] = await Promise.all([
          tx.address.count({ where: { domainId } }),
          tx.user.count({ where: { defaultAliasDomainId: domainId } }),
          tx.user.count({
            where: { email: { endsWith: `@${name}`, mode: "insensitive" } },
          }),
        ]);
        if (addresses || defaults || mailboxes) return false;
        await tx.domain.update({
          where: { id: domainId },
          data: { removalPending: true },
        });
        return true;
      }),
      failure,
    );
  },
  cancelRemoval(domainId: string) {
    return ResultAsync.fromPromise(
      db.domain
        .updateMany({
          where: { id: domainId },
          data: { removalPending: false },
        })
        .then(() => undefined),
      failure,
    );
  },
  isManagedAddress(addressId: string) {
    return ResultAsync.fromPromise(
      db.address
        .count({
          where: {
            id: addressId,
            OR: [{ mailboxManaged: true }, { emailAlias: { isNot: null } }],
          },
        })
        .then((count) => count > 0),
      failure,
    );
  },
  verificationTargets() {
    return ResultAsync.fromPromise(
      db.domain.findMany({
        where: {
          stalwartId: { not: null },
          user: { role: "admin", disabled: false },
        },
        select: { id: true, user: { select: { id: true, email: true } } },
      }),
      failure,
    );
  },
  audit(actor: string, action: string, domainId: string) {
    return ResultAsync.fromPromise(
      db.auditEvent
        .create({ data: { userId: actor, action, detail: { domainId } } })
        .then(() => undefined),
      failure,
    );
  },
  list(actor: string) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        const rows = await tx.domain.findMany({
          include,
          orderBy: { name: "asc" },
        });
        await tx.auditEvent.create({
          data: { userId: actor, action: "admin.domains.list", detail: {} },
        });
        return rows.map(convert);
      }),
      failure,
    );
  },
  get(id: string) {
    return ResultAsync.fromPromise(
      db.domain.findUniqueOrThrow({ where: { id }, include }).then(convert),
      failure,
    );
  },
  create(actor: string, name: string) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const row = await tx.domain.create({
          data: { name, userId: actor },
          include,
        });
        await tx.auditEvent.create({
          data: {
            userId: actor,
            action: "admin.domain.add",
            detail: { domainId: row.id, name },
          },
        });
        return convert(row);
      }),
      failure,
    );
  },
  save(
    actor: string,
    id: string,
    data: {
      stalwartId?: string;
      status: "pending" | "verified" | "failing";
      records: z.infer<typeof records>;
      checkedAt?: Date;
    },
    action: string,
  ) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const previous = await tx.domain.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        const row = await tx.domain.update({ where: { id }, data, include });
        if (previous.status !== data.status) {
          await tx.address.updateMany({
            where: { domainId: id, mailboxManaged: true },
            data: { ready: false, revision: { increment: 1 } },
          });
          await tx.emailAlias.updateMany({
            where: { domainId: id, deletedAt: null, enabled: true },
            data: {
              ready: false,
              detachedByDomain: false,
              revision: { increment: 1 },
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            userId: actor,
            action,
            detail: { domainId: id, status: data.status },
          },
        });
        return convert(row);
      }),
      failure,
    );
  },
  // Serialize status transitions and the persisted streak across API processes.
  recordAdoptionCheck(
    actor: string,
    id: string,
    outcome: "verified" | "confirmed" | "unavailable",
    checkedRecords: z.infer<typeof records>,
    source: "manual" | "scheduled",
  ) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const previous = await tx.domain.findUniqueOrThrow({
          where: { id },
          select: { status: true, adoptionFailureCount: true },
        });
        const count =
          outcome === "confirmed"
            ? Math.min(previous.adoptionFailureCount + 1, 3)
            : 0;
        const nextStatus =
          outcome === "verified"
            ? "verified"
            : count >= 3
              ? "failing"
              : previous.status;
        const row = await tx.domain.update({
          where: { id },
          data: {
            adoptionFailureCount: count,
            status: nextStatus,
            ...(outcome === "verified" ||
            (outcome === "confirmed" && count >= 3)
              ? { records: checkedRecords, checkedAt: new Date() }
              : {}),
          },
          include,
        });
        if (previous.status !== nextStatus) {
          await tx.address.updateMany({
            where: { domainId: id, mailboxManaged: true },
            data: { ready: false, revision: { increment: 1 } },
          });
          await tx.emailAlias.updateMany({
            where: { domainId: id, deletedAt: null, enabled: true },
            data: {
              ready: false,
              detachedByDomain: false,
              revision: { increment: 1 },
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            userId: actor,
            action: `admin.domain.recheck.${source}`,
            detail: {
              domainId: id,
              status: nextStatus,
              outcome,
              confirmedFailures: count,
            },
          },
        });
        return convert(row);
      }),
      failure,
    );
  },
  remove(actor: string, id: string) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.domain.delete({ where: { id } });
        await tx.auditEvent.create({
          data: {
            userId: actor,
            action: "admin.domain.remove",
            detail: { domainId: id },
          },
        });
      }),
      failure,
    );
  },
  mailbox(userId: string) {
    return ResultAsync.fromPromise(
      db.mailboxLink.findFirstOrThrow({
        where: { userId, status: "active", user: { disabled: false } },
        select: { accountId: true, address: true },
      }),
      failure,
    );
  },
  addAddress(
    actor: string,
    domainId: string,
    userId: string,
    localPart: string,
    isAlias: boolean,
  ) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${domainId}, ${ALIAS_DOMAIN_LOCK_SEED}))`;
        const domain = await tx.domain.findUniqueOrThrow({
          where: { id: domainId },
        });
        if (domain.removalPending) throw new Error("domain removal pending");
        // Another account's primary address, provisioned or not, is not an
        // address record.
        if (
          await tx.user.count({
            where: {
              email: {
                equals: `${localPart}@${domain.name}`,
                mode: "insensitive",
              },
              id: { not: userId },
            },
          })
        )
          throw new Error("address belongs to another mailbox");
        await tx.address.create({
          data: { domainId, userId, localPart, isAlias },
        });
        await tx.auditEvent.create({
          data: {
            userId: actor,
            action: "admin.domain.address.add",
            detail: { domainId, userId, localPart, isAlias },
          },
        });
        const row = await tx.domain.findUniqueOrThrow({
          where: { id: domainId },
          include,
        });
        return convert(row);
      }),
      failure,
    );
  },
  removeAddress(actor: string, domainId: string, addressId: string) {
    return ResultAsync.fromPromise(
      db.$transaction(async (tx) => {
        const deleted = await tx.address.deleteMany({
          where: { id: addressId, domainId },
        });
        if (deleted.count !== 1) throw new Error("address not found");
        await tx.auditEvent.create({
          data: {
            userId: actor,
            action: "admin.domain.address.remove",
            detail: { domainId, addressId },
          },
        });
        return convert(
          await tx.domain.findUniqueOrThrow({
            where: { id: domainId },
            include,
          }),
        );
      }),
      failure,
    );
  },
  /**
   * Routes for active mailboxes: their primary address, which exists for
   * every provisioned mailbox, and their enabled address records. An address
   * claimed by two mailboxes gets no route, so its mail is held.
   */
  routes(addresses: string[]) {
    const wanted = new Set(addresses.map((value) => value.toLowerCase()));
    const primary = db.mailboxLink
      .findMany({
        where: {
          address: { in: [...wanted], mode: "insensitive" },
          status: "active",
          user: { disabled: false },
        },
        select: { address: true, accountId: true },
      })
      .then((rows) =>
        rows.map((row) => ({
          address: row.address.toLowerCase(),
          destination: row.accountId,
        })),
      );
    const recorded = db.address
      .findMany({
        where: {
          user: { disabled: false, mailbox: { status: "active" } },
          OR: [
            {
              emailAlias: null,
              OR: [
                { mailboxManaged: false },
                {
                  ready: true,
                  removalPending: false,
                  domain: { removalPending: false },
                },
              ],
            },
            {
              emailAlias: {
                is: {
                  enabled: true,
                  ready: true,
                  deletedAt: null,
                  domain: { status: "verified" },
                },
              },
            },
          ],
        },
        select: {
          localPart: true,
          domain: { select: { name: true } },
          user: { select: { mailbox: { select: { accountId: true } } } },
        },
      })
      .then((rows) =>
        rows.flatMap((row) => {
          const address = `${row.localPart}@${row.domain.name}`.toLowerCase();
          const destination = row.user.mailbox?.accountId;
          return wanted.has(address) && destination !== undefined
            ? [{ address, destination }]
            : [];
        }),
      );
    return ResultAsync.fromPromise(
      Promise.all([primary, recorded]).then(([links, rows]) => {
        const found = [...links, ...rows].reduce(
          (map, route) =>
            map.set(
              route.address,
              (map.get(route.address) ?? new Set<string>()).add(
                route.destination,
              ),
            ),
          new Map<string, Set<string>>(),
        );
        return [...found].flatMap(([address, destinations]) => {
          const [destination, ...others] = destinations;
          return destination !== undefined && others.length === 0
            ? [{ address, destination }]
            : [];
        });
      }),
      failure,
    );
  },
});
