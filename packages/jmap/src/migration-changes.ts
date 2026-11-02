import { err, ok, type Result } from "neverthrow";
import type { MigrationMailClient } from "./migration-mail.ts";
import type {
  MigrationCandidate,
  MigrationSnapshot,
} from "./migration-snapshot.ts";
import type { Session } from "./protocol.ts";

type Failure = { kind: "unavailable" | "limit" };
type Input = {
  client: Pick<MigrationMailClient, "emailChanges" | "migrationEmails">;
  session: Session;
  accountId: string;
  snapshot: MigrationSnapshot;
  keepAlive: () => Promise<boolean>;
};

/** Verify that an Email/get response accounts for every requested id. */
export function migrationBatchComplete(
  ids: readonly string[],
  data: { list: MigrationCandidate[]; notFound: string[] },
) {
  const returned = [...data.list.map((item) => item.id), ...data.notFound];
  return (
    returned.length === ids.length &&
    new Set(returned).size === ids.length &&
    returned.every((id) => ids.includes(id))
  );
}

function applyBatch(
  snapshot: MigrationSnapshot,
  changed: Set<string>,
  rows: MigrationCandidate[],
) {
  for (const [messageId, entries] of snapshot.candidates)
    snapshot.candidates.set(
      messageId,
      entries.filter((entry) => !changed.has(entry.id)),
    );
  let matches = [...snapshot.candidates.values()].reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  for (const candidate of rows) {
    for (const id of new Set(candidate.messageId ?? [])) {
      const entries = snapshot.candidates.get(id);
      if (entries === undefined) continue;
      if (++matches > 10_000) return false;
      entries.push(candidate);
    }
  }
  return true;
}

async function readChanges(
  input: Input,
  ids: string[],
  position = 0,
): Promise<Result<MigrationCandidate[], Failure>> {
  if (position >= ids.length) return ok([]);
  if (!(await input.keepAlive())) return err({ kind: "unavailable" });
  const chunk = ids.slice(position, position + 100);
  const fetched = await input.client.migrationEmails(
    input.session,
    input.accountId,
    chunk,
  );
  if (
    fetched.isErr() ||
    fetched.value.accountId !== input.accountId ||
    !migrationBatchComplete(chunk, fetched.value)
  )
    return err({ kind: "unavailable" });
  const remaining = await readChanges(input, ids, position + chunk.length);
  return remaining.isErr()
    ? err(remaining.error)
    : ok([...fetched.value.list, ...remaining.value]);
}

/** Bring the candidate index forward without requiring a quiet mailbox. */
export async function refreshMigrationSnapshot(
  input: Input,
  pages = 0,
): Promise<Result<void, Failure>> {
  if (pages >= 100 || !(await input.keepAlive()))
    return err({ kind: "unavailable" });
  const { client, session, accountId, snapshot } = input;
  const result = await client.emailChanges(session, accountId, snapshot.state);
  if (result.isErr()) return err({ kind: "unavailable" });
  const change = result.value;
  if (
    change.accountId !== accountId ||
    change.oldState !== snapshot.state ||
    change.created.length + change.updated.length + change.destroyed.length >
      500 ||
    (change.hasMoreChanges && change.newState === change.oldState)
  )
    return err({ kind: "unavailable" });
  const removed = new Set(change.destroyed);
  const ids = [...new Set([...change.created, ...change.updated])].filter(
    (id) => !removed.has(id),
  );
  const rows = await readChanges(input, ids);
  if (rows.isErr()) return err(rows.error);
  const changed = new Set([...ids, ...removed]);
  if (!applyBatch(snapshot, changed, rows.value)) return err({ kind: "limit" });
  snapshot.state = change.newState;
  return change.hasMoreChanges
    ? refreshMigrationSnapshot(input, pages + 1)
    : ok(undefined);
}
