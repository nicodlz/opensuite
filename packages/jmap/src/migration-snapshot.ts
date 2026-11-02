import { err, ok, type Result } from "neverthrow";
import type { Session } from "./protocol.ts";
import type { MigrationMailClient } from "./migration-mail.ts";

type Client = Pick<
  MigrationMailClient,
  "emailState" | "queryEmails" | "migrationEmails"
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
  private queryState: string | undefined;
  private total: number | undefined;
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

  private validPage(
    page: {
      accountId: string;
      position: number;
      total?: number | undefined;
      ids: string[];
      queryState: string;
    },
    position: number,
  ) {
    return (
      page.accountId === this.input.accountId &&
      page.position === position &&
      page.total !== undefined &&
      page.ids.length <= 100 &&
      position + page.ids.length <= page.total &&
      (this.queryState === undefined || page.queryState === this.queryState) &&
      (this.total === undefined || page.total === this.total)
    );
  }

  private validFetched(
    data: {
      accountId: string;
      state: string;
      notFound: string[];
      list: MigrationCandidate[];
    },
    ids: string[],
  ) {
    return (
      data.accountId === this.input.accountId &&
      data.state === this.state &&
      !data.notFound.length &&
      data.list.length === ids.length &&
      new Set(data.list.map((item) => item.id)).size === ids.length &&
      data.list.every((item) => ids.includes(item.id))
    );
  }

  private async page(position: number): Promise<Result<number, Failure>> {
    const { client, session, accountId, keepAlive } = this.input;
    if (!(await keepAlive())) return err({ kind: "unavailable" });
    const query = await client.queryEmails(session, accountId, {
      position,
      limit: 100,
      calculateTotal: true,
    });
    if (query.isErr()) return err({ kind: "unavailable" });
    const page = query.value;
    if (!this.validPage(page, position) || page.total === undefined)
      return err({ kind: "unavailable" });
    if (page.total > this.maxScan) return err({ kind: "limit" });
    this.queryState = page.queryState;
    this.total = page.total;
    for (const id of page.ids) {
      if (this.seen.has(id)) return err({ kind: "unavailable" });
      this.seen.add(id);
    }
    if (!page.ids.length)
      return position === page.total ? ok(0) : err({ kind: "unavailable" });
    const fetched = await client.migrationEmails(session, accountId, page.ids);
    if (fetched.isErr()) return err({ kind: "unavailable" });
    const data = fetched.value;
    if (!this.validFetched(data, page.ids)) return err({ kind: "unavailable" });
    for (const candidate of data.list) {
      const remembered = this.remember(candidate);
      if (remembered.isErr()) return err(remembered.error);
    }
    return ok(page.ids.length);
  }

  private async scanFrom(position: number): Promise<Result<void, Failure>> {
    const page = await this.page(position);
    if (page.isErr()) return err(page.error);
    const next = position + page.value;
    return next < (this.total ?? 0) ? this.scanFrom(next) : ok(undefined);
  }

  async build(): Promise<Result<MigrationSnapshot, Failure>> {
    const state = await this.emailState();
    if (state === undefined) return err({ kind: "unavailable" });
    this.state = state;
    if (!this.targets.size) return ok({ state, candidates: this.candidates });
    const scanned = await this.scanFrom(0);
    if (scanned.isErr()) return err(scanned.error);
    if ((await this.emailState()) !== state)
      return err({ kind: "unavailable" });
    return ok({ state, candidates: this.candidates });
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
    fetched.value.state !== input.snapshot.state ||
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
