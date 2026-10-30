import {
  DependencyNameSchema,
  type DependencyCheck,
  type Readiness,
} from "@opensuite/contracts";
import { ResultAsync, err, type Result } from "neverthrow";

export interface ProbeFailure {
  readonly kind: "unavailable" | "timeout";
  readonly message: string;
}

/** A dependency the service cannot serve traffic without. */
export interface DependencyProbe {
  readonly name: string;
  check(signal: AbortSignal): ResultAsync<void, ProbeFailure>;
}

export interface ReadinessReport {
  readonly readiness: Readiness;
  /** Failure details for server-side logs; never sent to clients. */
  readonly failures: readonly { name: string; failure: ProbeFailure }[];
}

export interface ReadinessService {
  check(): Promise<ReadinessReport>;
}

export interface ReadinessOptions {
  readonly probes: readonly DependencyProbe[];
  readonly timeoutMs: number;
  readonly now: () => Date;
  readonly monotonicMs: () => number;
}

const describe = (): ProbeFailure => ({
  kind: "unavailable",
  message: "dependency check failed",
});

const timeoutAfter = (
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Result<void, ProbeFailure>> =>
  new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve(
          err({
            kind: "timeout",
            message: `no response within ${String(timeoutMs)} ms`,
          }),
        );
      },
      { once: true },
    );
  });

export const createReadinessService = (
  options: ReadinessOptions,
): ReadinessService => {
  const names = options.probes.map((probe) => probe.name);
  const invalid = names.find(
    (name) => !DependencyNameSchema.safeParse(name).success,
  );
  if (invalid !== undefined) {
    throw new Error(`invalid readiness probe name: ${invalid}`);
  }
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new Error(`duplicate readiness probe: ${duplicate}`);
  }

  const run = async (probe: DependencyProbe) => {
    const started = options.monotonicMs();
    const signal = AbortSignal.timeout(options.timeoutMs);
    // A probe that throws or rejects is reported down, never treated as up.
    const attempt = ResultAsync.fromPromise(
      Promise.resolve().then(() => probe.check(signal)),
      describe,
    ).andThen((result) => result);
    const result = await Promise.race([
      attempt,
      timeoutAfter(signal, options.timeoutMs),
    ]);
    const check: DependencyCheck = {
      name: probe.name,
      status: result.isOk() ? "up" : "down",
      durationMs: Math.max(0, Math.round(options.monotonicMs() - started)),
    };
    return { check, failure: result.isErr() ? result.error : undefined };
  };

  return {
    async check() {
      const outcomes = await Promise.all(options.probes.map(run));
      const failures = outcomes.flatMap(({ check, failure }) =>
        failure === undefined ? [] : [{ name: check.name, failure }],
      );
      return {
        readiness: {
          status: failures.length === 0 ? "ready" : "not_ready",
          checkedAt: options.now().toISOString(),
          dependencies: outcomes.map(({ check }) => check),
        },
        failures,
      };
    },
  };
};
