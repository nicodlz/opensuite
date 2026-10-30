import { ResultAsync } from "neverthrow";
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
        const row = await tx.domain.update({ where: { id }, data, include });
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
  routes(addresses: string[]) {
    return ResultAsync.fromPromise(
      db.address
        .findMany({
          where: {
            user: { disabled: false, mailbox: { status: "active" } },
          },
          select: {
            localPart: true,
            domain: { select: { name: true } },
            user: { select: { mailbox: { select: { accountId: true } } } },
          },
        })
        .then((rows) => {
          const wanted = new Set(addresses.map((value) => value.toLowerCase()));
          return rows.flatMap((row) => {
            const address = `${row.localPart}@${row.domain.name}`.toLowerCase();
            const destination = row.user.mailbox?.accountId;
            return wanted.has(address) && destination !== undefined
              ? [{ address, destination }]
              : [];
          });
        }),
      failure,
    );
  },
});
