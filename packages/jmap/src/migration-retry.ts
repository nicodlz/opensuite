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
  if (!(await input.keepAlive())) return "defer" as const;
  const checked = await checkMigrationDestinations({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    ids: [input.destination, ...Object.values(input.mapping)],
    expected: input.expected,
  });
  if (checked.kind === "changed") {
    await input.onChanged();
    return "stop" as const;
  }
  return checked.kind === "ready" ? ("continue" as const) : ("defer" as const);
}

/** Retry definite state conflicts without ever retrying an ambiguous write. */
export async function runMigrationItem<
  C extends Client,
  Raw extends Uint8Array,
>(
  input: MigrationItemInput<C, Raw>,
  attempt = 0,
): Promise<"continue" | "defer" | "stop"> {
  if (input.status !== "pending" || input.snapshot === undefined) {
    const decision = await processMigrationItem(input);
    return decision === "retry" ? "defer" : decision;
  }
  if (attempt >= 5) return "defer";
  const target = await targets(input);
  if (target !== "continue") return target;
  const updated = await refreshMigrationSnapshot({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    snapshot: input.snapshot,
    keepAlive: input.keepAlive,
  });
  if (updated.isErr()) {
    if (updated.error.kind === "limit")
      return (await input.record(
        "failed",
        "Destination exceeds the duplicate scan limit",
        null,
      ))
        ? "continue"
        : "stop";
    return "defer";
  }
  const decision = await processMigrationItem(input);
  if (decision === "retry") return runMigrationItem(input, attempt + 1);
  return decision === "continue" ? targets(input) : decision;
}
