import { err, ok, type Result } from "neverthrow";
import type { MigrationMailClient } from "./migration-mail.ts";
import type { Session } from "./protocol.ts";
import type { MigrationSnapshot } from "./migration-snapshot.ts";

type Client = Pick<
  MigrationMailClient,
  "queryEmails" | "migrationEmails" | "download"
>;
type Inspection =
  | { kind: "match"; id: string }
  | { kind: "none" }
  | { kind: "unresolved" }
  | { kind: "collision" };
type Failure = { kind: "unavailable" | "limit" };

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type InspectionInput = {
  client: Client;
  session: Session;
  accountId: string;
  bytes: Uint8Array;
  messageId: string | null;
  marker?: string;
  maxCandidates?: number;
  snapshot?: MigrationSnapshot;
};
type Candidate = {
  id: string;
  blobId: string;
  size: number;
  messageId: string[] | null;
  keywords: Record<string, boolean>;
};

class CandidateScanner {
  readonly input: InspectionInput;
  readonly seen = new Set<string>();
  readonly matches: string[] = [];
  readonly max: number;
  private expected: Promise<string> | undefined;
  state: string | undefined;
  collision = false;
  constructor(input: InspectionInput) {
    this.input = input;
    this.max = Math.min(Math.max(input.maxCandidates ?? 10_000, 1), 10_000);
  }
  query(position: number) {
    const { client, session, accountId, marker } = this.input;
    return client.queryEmails(session, accountId, {
      ...(marker === undefined ? {} : { filter: { hasKeyword: marker } }),
      position,
      limit: Math.min(100, this.max + 1),
    });
  }
  async compare(email: Candidate): Promise<Result<void, Failure>> {
    const { marker, messageId, bytes, client, session, accountId } = this.input;
    const relevant =
      marker === undefined
        ? email.messageId?.includes(messageId ?? "") === true
        : email.keywords[marker] === true;
    if (!relevant) return ok(undefined);
    if (email.size !== bytes.byteLength) {
      this.collision = true;
      return ok(undefined);
    }
    const raw = await client.download(session, accountId, email.blobId);
    if (raw.isErr()) return err({ kind: "unavailable" });
    if (
      raw.value.byteLength === bytes.byteLength &&
      (await digest(raw.value)) === (await (this.expected ??= digest(bytes)))
    )
      this.matches.push(email.id);
    else this.collision = true;
    return ok(undefined);
  }
  async inspectIds(ids: string[]): Promise<Result<void, Failure>> {
    const { client, session, accountId } = this.input;
    const fetched = await client.migrationEmails(session, accountId, ids);
    if (fetched.isErr()) return err({ kind: "unavailable" });
    const data = fetched.value;
    if (
      data.accountId !== accountId ||
      data.notFound.length ||
      data.list.length !== ids.length ||
      new Set(data.list.map((email) => email.id)).size !== ids.length ||
      data.list.some((email) => !ids.includes(email.id))
    )
      return err({ kind: "unavailable" });
    return this.compareAll(data.list, 0);
  }
  private async compareAll(
    candidates: Candidate[],
    index: number,
  ): Promise<Result<void, Failure>> {
    const candidate = candidates[index];
    if (candidate === undefined || this.collision || this.matches.length > 1)
      return ok(undefined);
    const result = await this.compare(candidate);
    return result.isErr() ? result : this.compareAll(candidates, index + 1);
  }
  async page(position: number): Promise<Result<number, Failure>> {
    const page = await this.query(position);
    if (page.isErr()) return err({ kind: "unavailable" });
    const data = page.value;
    if (
      data.accountId !== this.input.accountId ||
      data.position !== position ||
      (this.state !== undefined && this.state !== data.queryState)
    )
      return err({ kind: "unavailable" });
    this.state = data.queryState;
    for (const id of data.ids) {
      if (this.seen.has(id)) return err({ kind: "unavailable" });
      this.seen.add(id);
    }
    if (this.seen.size > this.max) return err({ kind: "limit" });
    if (data.ids.length) {
      const fetched = await this.inspectIds(data.ids);
      if (fetched.isErr()) return err(fetched.error);
    }
    return ok(data.ids.length);
  }
  private async scanPage(position: number): Promise<Result<void, Failure>> {
    const page = await this.page(position);
    if (page.isErr()) return err(page.error);
    return page.value === Math.min(100, this.max + 1)
      ? this.scanPage(position + page.value)
      : ok(undefined);
  }
  async scan(): Promise<Result<Inspection, Failure>> {
    const scanned = await this.scanPage(0);
    if (scanned.isErr()) return err(scanned.error);
    const check = await this.query(0);
    if (
      check.isErr() ||
      check.value.accountId !== this.input.accountId ||
      check.value.position !== 0 ||
      check.value.queryState !== this.state
    )
      return err({ kind: "unavailable" });
    return this.result();
  }
  async scanSnapshot(
    snapshot: MigrationSnapshot,
  ): Promise<Result<Inspection, Failure>> {
    const candidates = snapshot.candidates.get(this.input.messageId ?? "");
    if (candidates === undefined) return err({ kind: "unavailable" });
    const compared = await this.compareAll(candidates, 0);
    if (compared.isErr()) return err(compared.error);
    return this.result();
  }
  private result(): Result<Inspection, Failure> {
    if (this.collision || this.matches.length > 1)
      return ok({ kind: "collision" });
    const id = this.matches[0];
    if (id !== undefined) return ok({ kind: "match", id });
    return ok({
      kind: this.input.marker === undefined ? "none" : "unresolved",
    });
  }
}

/** A missing marker cannot prove that an in-flight write will not commit. */
export function inspectMigrationCandidates(
  input: InspectionInput,
): Promise<Result<Inspection, Failure>> {
  if (input.marker === undefined && input.messageId === null)
    return Promise.resolve(ok({ kind: "unresolved" }));
  const scanner = new CandidateScanner(input);
  return input.snapshot === undefined
    ? scanner.scan()
    : scanner.scanSnapshot(input.snapshot);
}
