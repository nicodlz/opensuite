import type { DependencyProbe, ProbeFailure } from "@opensuite/core";
import { err, errAsync, ok, ResultAsync, type Result } from "neverthrow";
import { z } from "zod";
import { PrismaClient } from "./generated/index.js";
import type { DatabaseError } from "./errors.ts";

export const createDatabase = (
  url: unknown,
): Result<PrismaClient, DatabaseError> => {
  const parsed = z
    .url()
    .refine(
      (value) =>
        URL.canParse(value) &&
        ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    )
    .safeParse(url);
  if (!parsed.success)
    return err({
      kind: "invalid_environment",
      message: "DATABASE_URL is invalid",
    });
  return ok(new PrismaClient({ datasources: { db: { url: parsed.data } } }));
};

export const createDatabaseProbe = (client: PrismaClient): DependencyProbe => ({
  name: "database",
  check(signal) {
    if (signal.aborted)
      return errAsync({ kind: "timeout", message: "database probe aborted" });
    let onAbort: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return ResultAsync.fromPromise(
      Promise.race([client.$queryRaw`SELECT 1`, aborted])
        .then(() => undefined)
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        }),
      (): ProbeFailure =>
        signal.aborted
          ? { kind: "timeout", message: "database probe aborted" }
          : { kind: "unavailable", message: "database query failed" },
    );
  },
});
