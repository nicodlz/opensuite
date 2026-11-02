import { inspectMigrationCandidates } from "./migration-candidates.ts";
import type { MigrationMailClient } from "./migration-mail.ts";
import type { MigrationSnapshot } from "./migration-snapshot.ts";
import type { Session } from "./protocol.ts";

type Client = Pick<
  MigrationMailClient,
  "queryEmails" | "migrationEmails" | "download" | "migrationMap"
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

function stateMismatch(result: Awaited<ReturnType<Client["migrationMap"]>>) {
  return (
    result.isErr() &&
    result.error.kind === "method" &&
    result.error.type === "stateMismatch"
  );
}

/** Inspect candidate bytes and fence a mailbox update against snapshot changes. */
export async function resolveMigrationCandidate(input: Input) {
  const { client, session, accountId, marker, snapshot } = input;
  const inspected = await inspectMigrationCandidates(input);
  if (
    inspected.isErr() ||
    inspected.value.kind === "collision" ||
    (marker !== undefined && inspected.value.kind !== "match")
  )
    return {
      action: "continue" as const,
      status:
        marker === undefined ? ("failed" as const) : ("uncertain" as const),
      error: "Import outcome or duplicate could not be established",
      id: null,
    };
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
    return { action: "stop" as const };
  const updated = await client.migrationMap(
    session,
    accountId,
    id,
    input.mailboxPatch,
    snapshot.state,
  );
  if (updated.isOk()) snapshot.state = updated.value.newState;
  const changed = stateMismatch(updated);
  return {
    action: changed ? ("stop" as const) : ("continue" as const),
    status: updated.isErr() ? ("failed" as const) : ("duplicate" as const),
    error: updated.isErr() ? "Duplicate mailbox mapping failed" : null,
    id,
  };
}
