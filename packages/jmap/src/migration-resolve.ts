import { inspectMigrationCandidates } from "./migration-candidates.ts";
import { migrationResponseStatus } from "./migration-failures.ts";
import type { MigrationMailClient } from "./migration-mail.ts";
import type { MigrationSnapshot } from "./migration-snapshot.ts";
import type { Session } from "./protocol.ts";

type Client = Pick<
  MigrationMailClient,
  "queryEmails" | "migrationEmails" | "download" | "migrationMap" | "emailState"
>;
type Input = {
  client: Client;
  session: Session;
  accountId: string;
  bytes: Uint8Array;
  messageId: string | null;
  marker?: string;
  snapshot?: MigrationSnapshot;
  mailboxPatch: Record<string, boolean>;
  beforeMapping: () => Promise<boolean>;
};

export function migrationMailboxPatch(mailboxes: Record<string, boolean>) {
  return Object.fromEntries(
    Object.keys(mailboxes).map((id) => [
      `mailboxIds/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      true,
    ]),
  );
}

function retryableMapping(result: Awaited<ReturnType<Client["migrationMap"]>>) {
  if (result.isOk()) return false;
  const error = result.error;
  const status = migrationResponseStatus(error);
  return (
    error.kind === "network" ||
    (status !== undefined && [408, 429, 500, 502, 503, 504].includes(status)) ||
    (error.kind === "method" &&
      ["stateMismatch", "serverUnavailable", "serverPartialFail"].includes(
        error.type,
      )) ||
    (error.kind === "set" && ["rateLimit", "notFound"].includes(error.type))
  );
}
function mappingError(result: Awaited<ReturnType<Client["migrationMap"]>>) {
  if (result.isOk()) return null;
  const error = result.error;
  return ((error.kind === "set" || error.kind === "request") &&
    error.type === "overQuota") ||
    migrationResponseStatus(error) === 507
    ? "Mailbox quota exceeded. Free space and resume the import."
    : "Duplicate mailbox mapping failed";
}
function mappingOutcome(
  result: Awaited<ReturnType<Client["migrationMap"]>>,
  id: string,
) {
  const error = mappingError(result);
  return {
    action:
      error === "Mailbox quota exceeded. Free space and resume the import."
        ? ("stop" as const)
        : ("continue" as const),
    status: result.isErr() ? ("failed" as const) : ("duplicate" as const),
    error,
    id,
  };
}
function inspectionFailure(marker: string | undefined) {
  return {
    action: "continue" as const,
    status: marker === undefined ? ("failed" as const) : ("uncertain" as const),
    error: "Import outcome or duplicate could not be established",
    id: null,
  };
}
async function sameSnapshotState(input: Input) {
  if (input.snapshot === undefined) return false;
  const result = await input.client.emailState(input.session, input.accountId);
  return (
    result.isOk() &&
    result.value.accountId === input.accountId &&
    result.value.state === input.snapshot.state
  );
}

/** Inspect candidate bytes and fence a mailbox update against snapshot changes. */
export async function resolveMigrationCandidate(input: Input) {
  const { client, session, accountId, marker, snapshot } = input;
  const inspected = await inspectMigrationCandidates(input);
  if (inspected.isErr())
    return marker === undefined
      ? { action: "retry" as const }
      : inspectionFailure(marker);
  if (
    marker === undefined &&
    inspected.value.kind === "collision" &&
    !(await sameSnapshotState(input))
  )
    return { action: "retry" as const };
  if (
    inspected.value.kind === "collision" ||
    (marker !== undefined && inspected.value.kind !== "match")
  )
    return inspectionFailure(marker);
  if (inspected.value.kind !== "match") return { action: "import" as const };
  const id = inspected.value.id;
  if (marker !== undefined)
    return {
      action: "continue" as const,
      status: "imported" as const,
      error: null,
      id,
    };
  if (snapshot === undefined || !(await input.beforeMapping()))
    return { action: "defer" as const };
  const updated = await client.migrationMap(
    session,
    accountId,
    id,
    input.mailboxPatch,
    snapshot.state,
  );
  if (updated.isOk()) snapshot.state = updated.value.newState;
  const changed = retryableMapping(updated);
  if (changed) return { action: "retry" as const };
  return mappingOutcome(updated, id);
}
