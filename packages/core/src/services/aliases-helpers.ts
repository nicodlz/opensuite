import { createHash, randomBytes } from "node:crypto";
import { AliasPrefix, AliasWebsite } from "@opensuite/contracts";
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
const colors = [
  "amber",
  "blue",
  "coral",
  "cyan",
  "gold",
  "green",
  "indigo",
  "ivory",
  "jade",
  "lilac",
  "lime",
  "olive",
  "pearl",
  "rose",
  "silver",
  "violet",
] as const;
const animals = [
  "bear",
  "bird",
  "cat",
  "deer",
  "dove",
  "fox",
  "frog",
  "hare",
  "koala",
  "lynx",
  "mole",
  "otter",
  "owl",
  "panda",
  "seal",
  "wolf",
] as const;

export function generateAliasLocalPart(
  prefix?: string,
  website?: string | null,
) {
  const random = randomBytes(12);
  if (prefix !== undefined)
    return `${AliasPrefix.parse(prefix)}-${random.toString("hex")}`;

  // The word pair encodes the first random byte; base36 encodes the other 11.
  // Together they retain all 96 random bits without a biased modulo operation.
  const wordByte = random.readUInt8(0);
  const color = colors[wordByte >>> 4];
  const animal = animals[wordByte & 15];
  const token = BigInt(`0x${random.subarray(1).toString("hex")}`)
    .toString(36)
    .padStart(18, "0");
  const parsed = AliasWebsite.safeParse(website);
  const hostname = parsed.success ? parsed.data : "";
  const labels = hostname.split(".");
  const label = (labels[0] === "www" ? labels[1] : labels[0]) ?? "";
  const site = label
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 12)
    .replace(/-+$/, "");
  return [
    site,
    color,
    animal,
    token.slice(0, 6),
    token.slice(6, 12),
    token.slice(12),
  ]
    .filter(Boolean)
    .join("-");
}
export const run = async <T>(
  work: () => Promise<Result<T, Failure>>,
): Output<T> => {
  try {
    return await work();
  } catch {
    return err(failure("unavailable"));
  }
};
