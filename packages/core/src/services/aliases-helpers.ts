import { createHash, randomBytes } from "node:crypto";
import { AliasPrefix } from "@opensuite/contracts";
import type { AliasStore, AliasStoreFailure } from "@opensuite/db";
import { err, type Result } from "neverthrow";

export type Failure = AliasStoreFailure | { kind: "busy" };
export type Output<T> = Promise<Result<T, Failure>>;
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
export const view = (row: StoreRow) => ({
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
export const keyView = (row: Key) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});
export const failure = (kind: Failure["kind"]): Failure => ({ kind });
export const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export const generateAliasLocalPart = (prefix?: string) =>
  `${prefix === undefined ? "" : `${AliasPrefix.parse(prefix)}-`}${randomBytes(12).toString("hex")}`;
export const run = async <T>(
  work: () => Promise<Result<T, Failure>>,
): Output<T> => {
  try {
    return await work();
  } catch {
    return err(failure("unavailable"));
  }
};
