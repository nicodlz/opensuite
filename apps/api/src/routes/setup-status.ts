import { readFile, stat } from "node:fs/promises";
import { ReadinessSchema, type SetupStatus } from "@opensuite/contracts";
import type { ReadinessService } from "@opensuite/core/services/readiness";
import { StalwartAdmin } from "@opensuite/jmap/admin";

type State = SetupStatus["database"];
const dependency = (
  report: { dependencies: { name: string; status: "up" | "down" }[] },
  name: string,
): State => {
  const check = report.dependencies.find((item) => item.name === name);
  return check === undefined
    ? "unknown"
    : check.status === "up"
      ? "ready"
      : "attention";
};

/** Only fixed internal endpoints and an optional read-only marker are inspected. */
export function createSetupStatus(options: {
  readiness: ReadinessService;
  mailDomain: string;
  relayManagement?: { origin: string; username: string; passwordFile: string };
  backupMarker?: string;
  backupMaxAgeSeconds: number;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const fetcher = options.fetcher ?? fetch;
  const relayStatus = async (): Promise<State> => {
    if (options.relayManagement === undefined) return "unknown";
    try {
      const password = (
        await readFile(options.relayManagement.passwordFile, "utf8")
      ).trim();
      if (!password) return "unknown";
      const admin = new StalwartAdmin(
        options.relayManagement.origin,
        { username: options.relayManagement.username, password },
        {
          fetch: (input, init) =>
            fetcher(input, { ...init, signal: AbortSignal.timeout(2000) }),
        },
      );
      const result = await admin.sesRelayConfigured();
      return result.isErr() ? "unknown" : result.value ? "ready" : "attention";
    } catch {
      return "unknown";
    }
  };
  return async (): Promise<SetupStatus> => {
    const [api, drive, relay, backup] = await Promise.all([
      options.readiness.check(),
      fetcher("http://drive:3001/ready", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      })
        .then(async (response) =>
          ReadinessSchema.safeParse(await response.json()),
        )
        .catch(() => null),
      relayStatus(),
      (async (): Promise<{ state: State; age: number | null }> => {
        if (options.backupMarker === undefined)
          return { state: "unknown" satisfies State, age: null };
        try {
          const age =
            ((options.now?.() ?? Date.now()) -
              (await stat(options.backupMarker)).mtimeMs) /
            1000;
          if (age < 0 || !Number.isFinite(age))
            return { state: "attention" satisfies State, age: null };
          return {
            state:
              age <= options.backupMaxAgeSeconds
                ? ("ready" satisfies State)
                : ("attention" satisfies State),
            age,
          };
        } catch {
          return { state: "unknown" satisfies State, age: null };
        }
      })(),
    ]);
    const driveReport = drive?.success ? drive.data : null;
    return {
      database: dependency(api.readiness, "database"),
      stalwart: dependency(api.readiness, "mail-server"),
      drive:
        driveReport === null
          ? "unknown"
          : driveReport.status === "ready"
            ? "ready"
            : "attention",
      objectStorage:
        driveReport === null
          ? "unknown"
          : dependency(driveReport, "object-storage"),
      relay,
      backup: backup.state,
      backupAgeSeconds: backup.age,
      mailDomain: options.mailDomain,
    };
  };
}
