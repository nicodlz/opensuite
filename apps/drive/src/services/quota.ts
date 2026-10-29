import { err, ok } from "neverthrow";

export const reserveQuota = (used: bigint, requested: bigint, limit: bigint) =>
  requested >= 0n && used >= 0n && used + requested <= limit
    ? ok(used + requested)
    : err("quota_exceeded");
