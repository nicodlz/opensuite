import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AliasPrefix, AliasWebsite } from "@opensuite/contracts";
import type { Prisma, PrismaClient } from "@opensuite/db";
import { err, ok, type Result } from "neverthrow";

type FailureKind =
  "invalid" | "not_found" | "conflict" | "limit" | "unavailable";
type Failure = { kind: FailureKind };
type Output<T> = Promise<Result<T, Failure>>;
type Row = {
  id: string;
  userId: string;
  address: string;
  localPart: string;
  domainId: string;
  website: string | null;
  note: string | null;
  enabled: boolean;
  ready: boolean;
  createdAt: Date;
  updatedAt: Date;
};
type Key = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};
const view = (row: Row) => ({
  id: row.id,
  address: row.address,
  localPart: row.localPart,
  domainId: row.domainId,
  website: row.website,
  note: row.note,
  enabled: row.enabled,
  ready: row.ready,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const keyView = (row: Key) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});
const failure = (kind: FailureKind): Failure => ({ kind });
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export const generateAliasLocalPart = (prefix?: string) =>
  `${prefix === undefined ? "" : `${AliasPrefix.parse(prefix)}-`}${randomBytes(12).toString("hex")}`;
export interface AliasMail {
  set(
    accountId: string,
    localPart: string,
    domainId: string,
    address: string,
    userId: string,
    enabled: boolean,
  ): PromiseLike<Result<void, { kind: string }>>;
}
export interface AliasCreate {
  domainId?: string | undefined;
  prefix?: string | undefined;
  requestId?: string | undefined;
  website?: string | null | undefined;
  note?: string | null | undefined;
}
const run = async <T>(work: () => Promise<Result<T, Failure>>): Output<T> => {
  try {
    return await work();
  } catch {
    return err(failure("unavailable"));
  }
};
const validDomain = async (tx: Prisma.TransactionClient, domainId: string) =>
  tx.domain.findFirst({
    where: {
      id: domainId,
      enabled: true,
      status: "verified",
      stalwartId: { not: null },
    },
  });
export function createAliasService(
  db: PrismaClient,
  mail: AliasMail,
  cap: number,
) {
  const locked = async <T>(
    userId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 427391))`;
        return work(tx);
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  const sync = async (
    userId: string,
    id: string,
  ): Output<ReturnType<typeof view>> =>
    run(() =>
      locked(userId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(9876)`;
        const row = await tx.emailAlias.findFirst({
          where: { id, userId },
          include: { domain: true, user: { include: { mailbox: true } } },
        });
        if (!row) return err(failure("not_found"));
        const mailbox = row.user.mailbox;
        if (!mailbox || !row.domain.stalwartId) {
          await tx.emailAlias.update({
            where: { id },
            data: { updatedAt: new Date() },
          });
          return err(failure("unavailable"));
        }
        const enabled =
          row.enabled &&
          row.deletedAt === null &&
          row.domain.enabled &&
          row.domain.status === "verified" &&
          !row.user.disabled &&
          mailbox.status === "active";
        const result = await mail.set(
          mailbox.accountId,
          row.localPart,
          row.domain.stalwartId,
          row.address,
          userId,
          enabled,
        );
        if (result.isErr()) {
          await tx.emailAlias.update({
            where: { id },
            data: { updatedAt: new Date() },
          });
          return err(failure("unavailable"));
        }
        const saved = await tx.emailAlias.update({
          where: { id },
          data: { ready: enabled === row.enabled || row.deletedAt !== null },
        });
        if (row.enabled && row.deletedAt === null && !enabled)
          return err(failure("unavailable"));
        return ok(view(saved));
      }),
    );
  return {
    domains: () =>
      run(async () =>
        ok(
          await db.domain.findMany({
            where: {
              enabled: true,
              status: "verified",
              stalwartId: { not: null },
            },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          }),
        ),
      ),
    list: (userId: string, search?: string) =>
      run(async () =>
        ok(
          (
            await db.emailAlias.findMany({
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
            })
          ).map(view),
        ),
      ),
    create: (
      userId: string,
      input: AliasCreate,
    ): Output<ReturnType<typeof view>> =>
      run(async () => {
        if (
          (input.prefix !== undefined &&
            !AliasPrefix.safeParse(input.prefix).success) ||
          (input.website !== null &&
            input.website !== undefined &&
            !AliasWebsite.safeParse(input.website).success) ||
          (input.note !== null &&
            input.note !== undefined &&
            input.note.length > 500)
        )
          return err(failure("invalid"));
        const reserved = await locked(userId, async (tx) => {
          if (input.requestId) {
            const prior = await tx.emailAlias.findUnique({
              where: {
                userId_requestId: { userId, requestId: input.requestId },
              },
            });
            if (prior)
              return prior.deletedAt ? err(failure("conflict")) : ok(prior);
          }
          const user = await tx.user.findFirst({
            where: {
              id: userId,
              disabled: false,
              mailbox: { status: "active" },
            },
            select: { defaultAliasDomainId: true },
          });
          const domainId = input.domainId ?? user?.defaultAliasDomainId;
          if (!user || !domainId) return err(failure("invalid"));
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(9876)`;
          const domain = await validDomain(tx, domainId);
          if (!domain) return err(failure("invalid"));
          if (
            (await tx.emailAlias.count({
              where: { userId, deletedAt: null },
            })) >= cap
          )
            return err(failure("limit"));
          const localPart = generateAliasLocalPart(input.prefix);
          const address = `${localPart}@${domain.name}`;
          const record = await tx.address.create({
            data: { userId, domainId, localPart, isAlias: true },
          });
          const alias = await tx.emailAlias.create({
            data: {
              userId,
              domainId,
              addressId: record.id,
              address,
              localPart,
              website: input.website?.toLowerCase() ?? null,
              note: input.note ?? null,
              requestId: input.requestId ?? null,
            },
          });
          return ok(alias);
        });
        if (reserved.isErr()) return err(reserved.error);
        return sync(userId, reserved.value.id);
      }),
    update: (
      userId: string,
      id: string,
      data: {
        website?: string | null | undefined;
        note?: string | null | undefined;
      },
    ) =>
      run(async () => {
        if (
          (data.website !== null &&
            data.website !== undefined &&
            !AliasWebsite.safeParse(data.website).success) ||
          (data.note !== null &&
            data.note !== undefined &&
            data.note.length > 500)
        )
          return err(failure("invalid"));
        const result = await db.emailAlias.updateMany({
          where: { id, userId, deletedAt: null },
          data: {
            ...(data.website === undefined
              ? {}
              : { website: data.website?.toLowerCase() ?? null }),
            ...(data.note === undefined ? {} : { note: data.note }),
          },
        });
        if (!result.count) return err(failure("not_found"));
        const row = await db.emailAlias.findFirstOrThrow({
          where: { id, userId, deletedAt: null },
        });
        return ok(view(row));
      }),
    transition: (
      userId: string,
      id: string,
      desired: "enable" | "disable" | "delete",
    ) =>
      run(async () => {
        const changed = await locked(userId, async (tx) => {
          const row = await tx.emailAlias.findFirst({ where: { id, userId } });
          if (!row || (row.deletedAt && desired !== "delete"))
            return err(failure("not_found"));
          if (desired === "enable" && !(await validDomain(tx, row.domainId)))
            return err(failure("invalid"));
          await tx.emailAlias.update({
            where: { id },
            data: {
              enabled: desired === "enable",
              ready: false,
              ...(desired === "delete" && !row.deletedAt
                ? { deletedAt: new Date() }
                : {}),
            },
          });
          return ok(undefined);
        });
        if (changed.isErr()) return err(changed.error);
        return sync(userId, id);
      }),
    match: (userId: string, addresses: string[]) =>
      run(async () =>
        ok(
          (
            await db.emailAlias.findMany({
              where: {
                userId,
                address: { in: addresses.map((v) => v.toLowerCase()) },
              },
            })
          ).map(view),
        ),
      ),
    setDefault: (userId: string, domainId: string) =>
      run(() =>
        locked(userId, async (tx) => {
          if (!(await validDomain(tx, domainId)))
            return err(failure("invalid"));
          await tx.user.update({
            where: { id: userId },
            data: { defaultAliasDomainId: domainId },
          });
          return ok({ domainId });
        }),
      ),
    getDefault: (userId: string) =>
      run(async () =>
        ok({
          domainId: (
            await db.user.findUniqueOrThrow({
              where: { id: userId },
              select: { defaultAliasDomainId: true },
            })
          ).defaultAliasDomainId,
        }),
      ),
    createKey: (userId: string, name: string) =>
      run(async () => {
        const prefix = randomBytes(9).toString("base64url");
        const secret = `osa_${prefix}_${randomBytes(32).toString("base64url")}`;
        const row = await db.aliasApiKey.create({
          data: { userId, name, prefix, secretHash: hash(secret) },
        });
        return ok({ ...keyView(row), secret });
      }),
    listKeys: (userId: string) =>
      run(async () =>
        ok(
          (
            await db.aliasApiKey.findMany({
              where: { userId },
              orderBy: { createdAt: "desc" },
            })
          ).map(keyView),
        ),
      ),
    revokeKey: (userId: string, id: string) =>
      run(async () => {
        const result = await db.aliasApiKey.updateMany({
          where: { id, userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return result.count
          ? ok({ revoked: true as const })
          : err(failure("not_found"));
      }),
    authenticate: (secret: string) =>
      run(async () => {
        const match = /^osa_([A-Za-z0-9_-]{12})_[A-Za-z0-9_-]{43}$/.exec(
          secret,
        );
        if (!match?.[1]) return err(failure("invalid"));
        const row = await db.aliasApiKey.findUnique({
          where: { prefix: match[1] },
          include: { user: true },
        });
        const actual = Buffer.from(hash(secret), "hex");
        const expected = Buffer.from(row?.secretHash ?? "0".repeat(64), "hex");
        if (
          !timingSafeEqual(actual, expected) ||
          !row ||
          row.revokedAt ||
          row.user.disabled
        )
          return err(failure("invalid"));
        const used = await db.aliasApiKey.updateMany({
          where: { id: row.id, revokedAt: null, user: { disabled: false } },
          data: { lastUsedAt: new Date() },
        });
        return used.count
          ? ok({ userId: row.userId, keyId: row.id })
          : err(failure("invalid"));
      }),
    reconcile: () =>
      run(async () => {
        const pending = await db.emailAlias.findMany({
          where: { ready: false },
          select: { userId: true, id: true },
          take: 100,
          orderBy: { updatedAt: "asc" },
        });
        let failures = 0;
        for (const row of pending)
          if ((await sync(row.userId, row.id)).isErr()) failures++;
        return ok(failures);
      }),
  };
}
export type AliasService = ReturnType<typeof createAliasService>;
