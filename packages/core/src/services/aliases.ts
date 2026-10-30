import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AliasPrefix, AliasWebsite } from "@opensuite/contracts";
import type { AliasStore, AliasStoreFailure } from "@opensuite/db";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

type Failure = AliasStoreFailure | { kind: "busy" };
type Output<T> = Promise<Result<T, Failure>>;
type StoreRow = NonNullable<
  Awaited<ReturnType<AliasStore["get"]>> extends Result<infer T, unknown>
    ? T
    : never
>;
type Key = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};
const view = (row: StoreRow) => ({
  id: row.id,
  address: row.address,
  localPart: row.localPart,
  domainId: row.domainId,
  website: row.website,
  note: row.note,
  enabled: row.enabled,
  ready: row.ready,
  detachedByDomain: row.detachedByDomain,
  suspended: row.suspended,
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
const failure = (kind: Failure["kind"]): Failure => ({ kind });
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
export function createAliasService(
  store: AliasStore,
  mail: AliasMail,
  cap: number,
) {
  const sync = (userId: string, id: string): Output<ReturnType<typeof view>> =>
    run(async () => {
      const leased = await store.withUserLease(userId, async (token) => {
        const found = await store.snapshot(userId, id);
        if (found.isErr()) return err(found.error);
        const row = found.value;
        if (!row) return err(failure("not_found"));
        const mailbox = row.user.mailbox;
        const detachedByDomain =
          row.enabled &&
          row.deletedAt === null &&
          row.domain.status !== "verified";
        const suspended =
          row.enabled &&
          row.deletedAt === null &&
          (row.user.disabled || !mailbox || mailbox.status !== "active");
        const enabled =
          row.enabled &&
          row.deletedAt === null &&
          !detachedByDomain &&
          !suspended;
        const accountId = mailbox?.accountId ?? row.lastAccountId;
        if (accountId) {
          if (!row.domain.stalwartId) return err(failure("unavailable"));
          if (
            mailbox &&
            row.lastAccountId &&
            row.lastAccountId !== mailbox.accountId
          ) {
            const removed = await mail.set(
              row.lastAccountId,
              row.localPart,
              row.domain.stalwartId,
              row.address,
              userId,
              false,
            );
            if (removed.isErr()) return err(failure("unavailable"));
          }
          const result = await mail.set(
            accountId,
            row.localPart,
            row.domain.stalwartId,
            row.address,
            userId,
            enabled,
          );
          if (result.isErr()) return err(failure("unavailable"));
        } else if (mailbox) return err(failure("unavailable"));
        const saved = await store.finish(userId, id, token, row, {
          ready: true,
          detachedByDomain,
          suspended,
          lastAccountId: accountId ?? null,
        });
        if (saved.isErr()) return err(saved.error);
        if (!saved.value) {
          await store.dirty(userId, id);
          return err(failure("unavailable"));
        }
        const current = await store.get(userId, id);
        if (current.isErr()) return err(current.error);
        return current.value
          ? ok(view(current.value))
          : err(failure("not_found"));
      });
      if (leased.isErr()) {
        await store.touch(userId, id);
        return err(failure(leased.error.kind));
      }
      if (leased.value.isErr()) await store.touch(userId, id);
      return leased.value;
    });
  return {
    findRequest: async (userId: string, requestId: string) =>
      (await store.findRequest(userId, requestId)).map((row) => row !== null),
    domains: async () => store.domains(),
    list: async (userId: string, search?: string) =>
      (await store.list(userId, search)).map((rows) => rows.map(view)),
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
        const reserved = await store.reserve(
          userId,
          input,
          generateAliasLocalPart(input.prefix),
          cap,
        );
        if (reserved.isErr()) return err(reserved.error);
        if (reserved.value.ready)
          return reserved.value.detachedByDomain || reserved.value.suspended
            ? err(failure("unavailable"))
            : ok(view(reserved.value));
        const result = await sync(userId, reserved.value.id);
        if (result.isErr() && result.error.kind === "busy")
          return ok(view(reserved.value));
        if (result.isErr()) return err(result.error);
        return result.value.detachedByDomain || result.value.suspended
          ? err(failure("unavailable"))
          : result;
      }),
    update: async (
      userId: string,
      id: string,
      data: {
        website?: string | null | undefined;
        note?: string | null | undefined;
      },
    ) => {
      if (
        (data.website !== null &&
          data.website !== undefined &&
          !AliasWebsite.safeParse(data.website).success) ||
        (data.note !== null &&
          data.note !== undefined &&
          data.note.length > 500)
      )
        return err(failure("invalid"));
      return (await store.update(userId, id, data)).map(view);
    },
    transition: (
      userId: string,
      id: string,
      desired: "enable" | "disable" | "delete",
    ) =>
      run(async () => {
        const changed = await store.transition(userId, id, desired);
        return changed.isErr() ? err(changed.error) : sync(userId, id);
      }),
    match: async (userId: string, addresses: string[]) => {
      const valid = addresses.flatMap((entry) => {
        const candidate = /<([^<>]+)>\s*$/.exec(entry)?.[1] ?? entry;
        const parsed = z.email().safeParse(candidate.trim().toLowerCase());
        return parsed.success ? [parsed.data] : [];
      });
      return (await store.match(userId, valid)).map((rows) => rows.map(view));
    },
    setDefault: async (userId: string, domainId: string) =>
      store.setDefault(userId, domainId),
    getDefault: async (userId: string) => store.getDefault(userId),
    createKey: (userId: string, name: string) =>
      run(async () => {
        const prefix = randomBytes(9).toString("base64url");
        const secret = `osa_${prefix}_${randomBytes(32).toString("base64url")}`;
        const row = await store.createKey(userId, name, prefix, hash(secret));
        return row.isErr()
          ? err(row.error)
          : ok({ ...keyView(row.value), secret });
      }),
    listKeys: async (userId: string) =>
      (await store.listKeys(userId)).map((rows) => rows.map(keyView)),
    revokeKey: async (userId: string, id: string) =>
      store.revokeKey(userId, id),
    authenticate: (secret: string) =>
      run(async () => {
        const match = /^osa_([A-Za-z0-9_-]{12})_[A-Za-z0-9_-]{43}$/.exec(
          secret,
        );
        if (!match?.[1]) return err(failure("invalid"));
        const found = await store.keyForPrefix(match[1]);
        if (found.isErr()) return err(found.error);
        const row = found.value;
        const actual = Buffer.from(hash(secret), "hex");
        const expected = Buffer.from(row?.secretHash ?? "0".repeat(64), "hex");
        if (
          !timingSafeEqual(actual, expected) ||
          !row ||
          row.revokedAt ||
          row.user.disabled
        )
          return err(failure("invalid"));
        const used = await store.useKey(row.id);
        if (used.isErr()) return err(used.error);
        return used.value
          ? ok({ userId: row.userId, keyId: row.id })
          : err(failure("invalid"));
      }),
    reconcile: () =>
      run(async () => {
        const pending = await store.pending();
        if (pending.isErr()) return err(pending.error);
        let failures = 0;
        for (const row of pending.value)
          if ((await sync(row.userId, row.id)).isErr()) failures++;
        return ok(failures);
      }),
    canSendAs: async (userId: string, address: string) =>
      (await store.canSendAs(userId, address)).map((row) => row?.id ?? null),
    auditSubmission: async (userId: string, aliasId: string) =>
      store.auditSubmission(userId, aliasId),
  };
}
export type AliasService = ReturnType<typeof createAliasService>;
