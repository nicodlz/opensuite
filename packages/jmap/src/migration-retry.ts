import { checkMigrationDestinations } from "./migration-destinations.ts";
import { refreshMigrationSnapshot } from "./migration-changes.ts";
import {
  processMigrationItem,
  type MigrationItemInput,
} from "./migration-item.ts";
import type { MigrationMailClient } from "./migration-mail.ts";

type Client = Parameters<typeof checkMigrationDestinations>[0]["client"] &
  Pick<
    MigrationMailClient,
    | "queryEmails"
    | "migrationEmails"
    | "download"
    | "migrationMap"
    | "emailChanges"
    | "emailState"
    | "upload"
    | "migrationImport"
  >;

async function targets<C extends Client, Raw extends Uint8Array>(
  input: MigrationItemInput<C, Raw>,
) {
  if (!(await input.keepAlive())) return false;
  const checked = await checkMigrationDestinations({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    ids: [input.destination, ...Object.values(input.mapping)],
    expected: input.expected,
  });
  if (checked.kind === "changed") await input.onChanged();
  return checked.kind === "ready";
}

/** Retry definite state conflicts without ever retrying an ambiguous write. */
export async function runMigrationItem<
  C extends Client,
  Raw extends Uint8Array,
>(input: MigrationItemInput<C, Raw>, attempt = 0): Promise<boolean> {
  if (input.status !== "pending" || input.snapshot === undefined)
    return (await processMigrationItem(input)) === "continue";
  if (attempt >= 5 || !(await targets(input))) return false;
  const updated = await refreshMigrationSnapshot({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    snapshot: input.snapshot,
    keepAlive: input.keepAlive,
  });
  if (updated.isErr()) {
    if (updated.error.kind === "limit")
      return input.record(
        "failed",
        "Destination exceeds the duplicate scan limit",
        null,
      );
    return false;
  }
  const decision = await processMigrationItem(input);
  if (decision === "retry") return runMigrationItem(input, attempt + 1);
  return decision === "continue" && (await targets(input));
}
