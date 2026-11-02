import { resolveMigrationCandidate } from "./migration-resolve.ts";
import type { MigrationMailClient } from "./migration-mail.ts";
import type { MigrationSnapshot } from "./migration-snapshot.ts";
import type { Session } from "./protocol.ts";

type Client = Pick<
  MigrationMailClient,
  | "queryEmails"
  | "migrationEmails"
  | "download"
  | "migrationMap"
  | "emailChanges"
  | "emailState"
  | "mailboxes"
  | "upload"
  | "migrationImport"
>;
type Metadata = {
  messageId: string | null;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  receivedAt?: string;
};
type ImportResult =
  | { kind: "recorded"; proceed: boolean }
  | { kind: "retry"; proceed: false }
  | { kind: "failed" | "uncertain"; error: string; proceed: boolean };
interface MigrationItemActions {
  beforeImport: () => Promise<boolean>;
  onChanged: () => Promise<unknown>;
  record: (
    status: string,
    error: string | null,
    id: string | null,
  ) => Promise<boolean>;
  keepAlive: () => Promise<boolean>;
}
export type MigrationItemInput<C extends Client, Raw extends Uint8Array> = {
  client: C;
  session: Session;
  accountId: string;
  raw: Raw;
  envelope?: Raw | undefined;
  status: string;
  marker: string;
  mapping: Record<string, string>;
  destination: string;
  snapshot: MigrationSnapshot | undefined;
  snapshotError: string;
  metadata: (
    raw: Raw,
    mapping: Record<string, string>,
    destination: string,
    envelope?: Raw,
  ) => Promise<Metadata>;
  mailboxPatch: (mailboxes: Record<string, boolean>) => Record<string, boolean>;
  importMessage: (input: {
    client: C;
    session: Session;
    accountId: string;
    bytes: Raw;
    metadata: Metadata;
    marker: string;
    snapshot: MigrationSnapshot;
    beforeImport: () => Promise<boolean>;
    onImported: (id: string) => Promise<boolean>;
  }) => Promise<ImportResult>;
  expected: unknown;
} & MigrationItemActions;
type Decision = "continue" | "retry" | "defer" | "stop";
function inspectionOptions<C extends Client, Raw extends Uint8Array>(
  input: MigrationItemInput<C, Raw>,
) {
  if (input.status !== "pending") return { marker: input.marker };
  return input.snapshot === undefined ? {} : { snapshot: input.snapshot };
}

async function importMessage<C extends Client, Raw extends Uint8Array>(
  input: MigrationItemInput<C, Raw>,
  metadata: Metadata,
): Promise<Decision> {
  if (input.snapshot === undefined) return "stop";
  const result = await input.importMessage({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    bytes: input.raw,
    metadata,
    marker: input.marker,
    snapshot: input.snapshot,
    beforeImport: input.beforeImport,
    onImported: (id) => input.record("imported", null, id),
  });
  if (result.kind === "retry")
    return (await input.record("pending", null, null)) ? "retry" : "stop";
  if (result.kind === "recorded") return result.proceed ? "continue" : "defer";
  if (!(await input.record(result.kind, result.error, null))) return "stop";
  return result.proceed ? "continue" : "stop";
}

/** Process one item; durable writes are supplied by the owning service. */
export async function processMigrationItem<
  C extends Client,
  Raw extends Uint8Array,
>(input: MigrationItemInput<C, Raw>): Promise<Decision> {
  if (["imported", "duplicate", "failed"].includes(input.status))
    return "continue";
  let metadata: Metadata;
  try {
    metadata = await input.metadata(
      input.raw,
      input.mapping,
      input.destination,
      input.envelope,
    );
  } catch {
    const status = input.status === "pending" ? "failed" : "uncertain";
    return (await input.record(
      status,
      "Message metadata could not be parsed",
      null,
    ))
      ? "continue"
      : "stop";
  }
  if (input.status === "pending" && input.snapshot === undefined)
    return (await input.record("failed", input.snapshotError, null))
      ? "continue"
      : "stop";
  const decision = await resolveMigrationCandidate({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    bytes: input.raw,
    messageId: metadata.messageId,
    ...inspectionOptions(input),
    mailboxPatch: input.mailboxPatch(metadata.mailboxIds),
    beforeMapping: input.keepAlive,
  });
  if (
    "status" in decision &&
    !(await input.record(
      decision.status,
      decision.error ?? null,
      decision.id ?? null,
    ))
  )
    return "stop";
  return decision.action === "import"
    ? importMessage(input, metadata)
    : decision.action;
}
