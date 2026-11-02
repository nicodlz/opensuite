import { err, ok, type Result } from "neverthrow";
import type { Session } from "./protocol.ts";
import type { MigrationMailClient } from "./migration-mail.ts";
import {
  migrationBatchComplete,
  refreshMigrationSnapshot,
} from "./migration-changes.ts";

type Client = Pick<
  MigrationMailClient,
  "emailState" | "emailChanges" | "queryEmails" | "migrationEmails"
>;
export type MigrationCandidate = {
  id: string;
  blobId: string;
  size: number;
  messageId: string[] | null;
  keywords: Record<string, boolean>;
};
export type MigrationSnapshot = {
  state: string;
  candidates: Map<string, MigrationCandidate[]>;
};
type Failure = { kind: "unavailable" | "limit" };
type Input = {
  client: Client;
  session: Session;
  accountId: string;
  messageIds: readonly string[];
  keepAlive: () => Promise<boolean>;
  maxScan?: number;
};

class SnapshotBuilder {
  private readonly input: Input;
  private readonly targets: Set<string>;
  private readonly seen = new Set<string>();
  private readonly candidates = new Map<string, MigrationCandidate[]>();
  private readonly maxScan: number;
  private state = "";
  private matches = 0;
  constructor(input: Input) {
    this.input = input;
    this.targets = new Set(input.messageIds);
    for (const id of this.targets) this.candidates.set(id, []);
    this.maxScan = Math.min(Math.max(input.maxScan ?? 1_000_000, 1), 1_000_000);
  }

  private async emailState() {
    const { client, session, accountId } = this.input;
    const response = await client.emailState(session, accountId);
    return response.isOk() && response.value.accountId === accountId
      ? response.value.state
      : undefined;
  }

  private remember(candidate: MigrationCandidate): Result<void, Failure> {
    for (const id of candidate.messageId ?? []) {
      if (!this.targets.has(id)) continue;
      if (++this.matches > 10_000) return err({ kind: "limit" });
      const entries = this.candidates.get(id) ?? [];
      entries.push(candidate);
      this.candidates.set(id, entries);
    }
    return ok(undefined);
  }

  private validPage(page: {
    accountId: string;
    total?: number | undefined;
    position: number;
    ids: string[];
  }) {
    return (
      page.accountId === this.input.accountId &&
      page.total !== undefined &&
      page.position >= 0 &&
      page.ids.length <= 100 &&
      page.position + page.ids.length <= page.total
    );
  }

  private trackIds(ids: string[]): Result<void, Failure> {
    for (const id of ids) {
      if (this.seen.has(id)) return err({ kind: "unavailable" });
      this.seen.add(id);
    }
    return this.seen.size > this.maxScan
      ? err({ kind: "limit" })
      : ok(undefined);
  }
  private emptyPage(position: number, total: number): Result<null, Failure> {
    return position === total ? ok(null) : err({ kind: "unavailable" });
  }

  private async page(
    anchor: string | undefined,
  ): Promise<Result<string | null, Failure>> {
    const { client, session, accountId, keepAlive } = this.input;
    if (!(await keepAlive())) return err({ kind: "unavailable" });
    const query = await client.queryEmails(session, accountId, {
      sort: [{ property: "receivedAt", isAscending: true }],
      ...(anchor === undefined ? {} : { anchor, anchorOffset: 1 }),
      limit: 100,
      calculateTotal: true,
    });
    if (query.isErr()) return err({ kind: "unavailable" });
    const page = query.value;
    if (!this.validPage(page) || page.total === undefined)
      return err({ kind: "unavailable" });
    if (page.total > this.maxScan) return err({ kind: "limit" });
    const tracked = this.trackIds(page.ids);
    if (tracked.isErr()) return err(tracked.error);
    if (!page.ids.length) return this.emptyPage(page.position, page.total);
    const fetched = await client.migrationEmails(session, accountId, page.ids);
    if (fetched.isErr()) return err({ kind: "unavailable" });
    const data = fetched.value;
    if (data.accountId !== accountId || !migrationBatchComplete(page.ids, data))
      return err({ kind: "unavailable" });
    for (const candidate of data.list) {
      const remembered = this.remember(candidate);
      if (remembered.isErr()) return err(remembered.error);
    }
    return ok(page.ids.at(-1) ?? null);
  }

  private async scanFrom(
    anchor: string | undefined,
  ): Promise<Result<void, Failure>> {
    const page = await this.page(anchor);
    if (page.isErr()) return err(page.error);
    return page.value === null ? ok(undefined) : this.scanFrom(page.value);
  }

  async build(): Promise<Result<MigrationSnapshot, Failure>> {
    const state = await this.emailState();
    if (state === undefined) return err({ kind: "unavailable" });
    this.state = state;
    if (!this.targets.size) return ok({ state, candidates: this.candidates });
    const scanned = await this.scanFrom(undefined);
    if (scanned.isErr()) return err(scanned.error);
    const snapshot = { state, candidates: this.candidates };
    const refreshed = await refreshMigrationSnapshot({
      ...this.input,
      snapshot,
    });
    return refreshed.isErr() ? err(refreshed.error) : ok(snapshot);
  }
}

/** Scan once per job; never infer Message-ID absence from text-search results. */
export const createMigrationSnapshot = (input: Input) =>
  new SnapshotBuilder(input).build();

/** Add a newly imported message only when its identity and state are proven. */
export async function rememberMigrationImport(input: {
  client: Pick<MigrationMailClient, "migrationEmails">;
  session: Session;
  accountId: string;
  snapshot: MigrationSnapshot;
  id: string;
  messageId: string | null;
}): Promise<boolean> {
  if (input.messageId === null) return true;
  const fetched = await input.client.migrationEmails(
    input.session,
    input.accountId,
    [input.id],
  );
  if (
    fetched.isErr() ||
    fetched.value.accountId !== input.accountId ||
    fetched.value.notFound.length ||
    fetched.value.list.length !== 1 ||
    fetched.value.list[0]?.id !== input.id
  )
    return false;
  const candidate = fetched.value.list[0];
  if (!candidate.messageId?.includes(input.messageId)) return false;
  const entries = input.snapshot.candidates.get(input.messageId);
  if (entries === undefined) return false;
  entries.push(candidate);
  return true;
}
