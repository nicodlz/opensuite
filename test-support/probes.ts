import type { DependencyProbe } from "@opensuite/core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

export const upProbe = (name: string): DependencyProbe => ({
  name,
  check: () => okAsync(undefined),
});

export const downProbe = (name: string, message: string): DependencyProbe => ({
  name,
  check: () => errAsync({ kind: "unavailable", message }),
});

/** Never answers until the readiness timeout aborts it. */
export const hangingProbe = (name: string): DependencyProbe => ({
  name,
  check: (signal) =>
    ResultAsync.fromSafePromise(
      new Promise<undefined>((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            resolve(undefined);
          }, 1000);
        });
      }),
    ),
});

export const throwingProbe = (name: string): DependencyProbe => ({
  name,
  check: () => {
    throw new Error("driver crashed");
  },
});
