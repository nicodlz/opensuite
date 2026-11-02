/* oxlint-disable eslint/no-await-in-loop */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  MAIL_ARCHIVE_LIMIT,
  MAIL_MESSAGE_LIMIT,
  migrationReport,
} from "@opensuite/contracts";
import { simpleParser } from "mailparser";
import type { JmapClient, Session } from "@opensuite/jmap";
import { err, ok, type Result } from "neverthrow";

type Client = Pick<JmapClient, "queryEmails" | "migrationEmails" | "download">;
type Inspection =
  | { kind: "match"; id: string }
  | { kind: "none" }
  | { kind: "unresolved" }
  | { kind: "collision" };
type Failure = { kind: "unavailable" | "limit" };

export class ArchiveError extends Error {
  readonly kind: "invalid_archive" | "archive_limit" | "message_limit";
  constructor(kind: "invalid_archive" | "archive_limit" | "message_limit") {
    super(kind);
    this.kind = kind;
  }
}

const fromLine = (line: Buffer) =>
  line.length >= 5 && line.subarray(0, 5).equals(Buffer.from("From "));
const blankLine = (line: Buffer) =>
  (line.length === 1 && line[0] === 10) ||
  (line.length === 2 && line[0] === 13 && line[1] === 10);
const unquote = (line: Buffer, variant: "mboxo" | "mboxrd") => {
  if (variant !== "mboxrd" || line[0] !== 62) return line;
  let offset = 0;
  while (line[offset] === 62) offset++;
  return fromLine(line.subarray(offset)) ? line.subarray(1) : line;
};

class MboxFramer {
  private parts: Buffer[] | undefined;
  private envelope: Buffer | undefined;
  private size = 0;
  private lines = 0;
  private blank = true;
  private readonly variant: "mboxo" | "mboxrd";
  private readonly maxMessageBytes: number;
  constructor(variant: "mboxo" | "mboxrd", maxMessageBytes: number) {
    this.variant = variant;
    this.maxMessageBytes = maxMessageBytes;
  }

  line(line: Buffer): { bytes: Buffer; envelope: Buffer } | undefined {
    if (this.blank && fromLine(line)) {
      const previous = this.finish();
      this.parts = [];
      this.envelope = line;
      this.size = 0;
      this.lines = 0;
      this.blank = false;
      return previous;
    }
    if (this.parts === undefined) throw new ArchiveError("invalid_archive");
    if (++this.lines > 100_000) throw new ArchiveError("message_limit");
    const content = unquote(line, this.variant);
    this.size += content.length;
    if (this.size > this.maxMessageBytes)
      throw new ArchiveError("message_limit");
    this.parts.push(content);
    this.blank = blankLine(line);
    return undefined;
  }

  finish(): { bytes: Buffer; envelope: Buffer } | undefined {
    return this.parts === undefined || this.envelope === undefined
      ? undefined
      : {
          bytes: Buffer.concat(this.parts, this.size),
          envelope: this.envelope,
        };
  }
}

/** Mboxrd reverses one level of From-quoting; mboxo leaves all bytes intact. */
export async function* splitMbox(
  source: AsyncIterable<Uint8Array>,
  options: {
    variant: "mboxo" | "mboxrd";
    maxMessageBytes: number;
    maxArchiveBytes: number;
    onEnvelope?: (line: Buffer) => void;
  },
): AsyncGenerator<Buffer> {
  const framer = new MboxFramer(options.variant, options.maxMessageBytes);
  let total = 0;
  let pending: Buffer[] = [];
  let pendingSize = 0;
  for await (const input of source) {
    const chunk = Buffer.from(input);
    total += chunk.length;
    if (total > options.maxArchiveBytes)
      throw new ArchiveError("archive_limit");
    let start = 0;
    for (
      let end = chunk.indexOf(10, start);
      end !== -1;
      end = chunk.indexOf(10, start)
    ) {
      const piece = chunk.subarray(start, end + 1);
      pendingSize += piece.length;
      if (pendingSize > options.maxMessageBytes)
        throw new ArchiveError("message_limit");
      pending.push(piece);
      const message = framer.line(Buffer.concat(pending, pendingSize));
      pending = [];
      pendingSize = 0;
      if (message !== undefined) {
        options.onEnvelope?.(message.envelope);
        yield message.bytes;
      }
      start = end + 1;
    }
    const rest = chunk.subarray(start);
    pendingSize += rest.length;
    if (pendingSize > options.maxMessageBytes)
      throw new ArchiveError("message_limit");
    if (rest.length) pending.push(rest);
  }
  if (pendingSize) {
    const message = framer.line(Buffer.concat(pending, pendingSize));
    if (message !== undefined) {
      options.onEnvelope?.(message.envelope);
      yield message.bytes;
    }
  }
  const last = framer.finish();
  if (last !== undefined) {
    options.onEnvelope?.(last.envelope);
    yield last.bytes;
  }
}

type InspectionInput = {
  client: Client;
  session: Session;
  accountId: string;
  bytes: Uint8Array;
  messageId: string | null;
  marker?: string;
  maxCandidates?: number;
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
  readonly expected: string;
  state: string | undefined;
  collision = false;
  constructor(input: InspectionInput) {
    this.input = input;
    this.max = Math.min(Math.max(input.maxCandidates ?? 10_000, 1), 10_000);
    this.expected = createHash("sha256").update(input.bytes).digest("hex");
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
      createHash("sha256").update(raw.value).digest("hex") === this.expected
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
    for (const email of data.list) {
      const result = await this.compare(email);
      if (result.isErr()) return result;
    }
    return ok(undefined);
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
  async scan(): Promise<Result<Inspection, Failure>> {
    let position = 0;
    let more = true;
    while (more) {
      const page = await this.page(position);
      if (page.isErr()) return err(page.error);
      position += page.value;
      more = page.value === Math.min(100, this.max + 1);
    }
    const check = await this.query(0);
    if (
      check.isErr() ||
      check.value.accountId !== this.input.accountId ||
      check.value.position !== 0 ||
      check.value.queryState !== this.state
    )
      return err({ kind: "unavailable" });
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
  return new CandidateScanner(input).scan();
}

export async function* archiveMessages(
  raw: Buffer,
  format: string,
  variant: string,
  onEnvelope?: (line: Buffer) => void,
) {
  if (format === "eml") {
    if (!raw.length || raw.length > MAIL_MESSAGE_LIMIT)
      throw new ArchiveError("message_limit");
    yield raw;
    return;
  }
  if (format !== "mbox" || (variant !== "mboxo" && variant !== "mboxrd"))
    throw new ArchiveError("invalid_archive");
  yield* splitMbox(Readable.from([raw]), {
    variant,
    maxArchiveBytes: MAIL_ARCHIVE_LIMIT,
    maxMessageBytes: MAIL_MESSAGE_LIMIT,
    ...(onEnvelope === undefined ? {} : { onEnvelope }),
  });
}

function messageKeywords(gmail: string[], flags: string, hasGmail: boolean) {
  const keywords: Record<string, boolean> = {};
  if (flags.includes("R") || (hasGmail && !gmail.includes("Unread")))
    keywords["$seen"] = true;
  if (flags.includes("F") || gmail.includes("Starred"))
    keywords["$flagged"] = true;
  if (flags.includes("A")) keywords["$answered"] = true;
  if (flags.includes("T") || gmail.includes("Draft")) keywords["$draft"] = true;
  return keywords;
}

export async function messageMetadata(
  raw: Buffer,
  mapped: Record<string, string>,
  destination: string,
  envelope?: Buffer,
) {
  const parsed = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const header = (name: string) => {
    const item = parsed.headers.get(name);
    return typeof item === "string" ? item : "";
  };
  const gmail = header("x-gmail-labels")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const flags = `${header("status")}${header("x-status")}`.toUpperCase();
  const mailboxIds: Record<string, boolean> = { [destination]: true };
  for (const label of gmail) {
    const id = Object.hasOwn(mapped, label) ? mapped[label] : undefined;
    if (id !== undefined)
      Object.defineProperty(mailboxIds, id, {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  const keywords = messageKeywords(
    gmail,
    flags,
    parsed.headerLines.some((line) => line.key === "x-gmail-labels"),
  );
  const separator = envelope?.toString("ascii");
  const envelopeDate = separator?.match(
    /^From\s+\S+\s+(.+(?:[+-]\d{2}:?\d{2}|UTC|GMT))\s*$/i,
  )?.[1];
  const timestamp = envelopeDate === undefined ? NaN : Date.parse(envelopeDate);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : parsed.date;
  return {
    messageId: parsed.messageId?.replace(/^<|>$/g, "") ?? null,
    mailboxIds,
    keywords,
    ...(date !== undefined && Number.isFinite(date.getTime())
      ? { receivedAt: date.toISOString().replace(/\.\d{3}Z$/, "Z") }
      : {}),
  };
}

export async function countArchive(
  raw: Buffer,
  format: string,
  variant: string,
  labelCount: number,
) {
  if (
    (!raw.length && format !== "mbox") ||
    raw.length > MAIL_ARCHIVE_LIMIT ||
    labelCount > 100
  )
    throw new ArchiveError("archive_limit");
  let total = 0;
  for await (const message of archiveMessages(raw, format, variant)) {
    if (!message.length || ++total > 1000)
      throw new ArchiveError("archive_limit");
  }
  return total;
}

function mailboxPatch(mailboxes: Record<string, boolean>) {
  const patch: Record<string, boolean> = {};
  for (const id of Object.keys(mailboxes))
    Object.defineProperty(
      patch,
      `mailboxIds/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      { value: true, enumerable: true },
    );
  return patch;
}

export const migrationMailTools = {
  mailboxPatch,
  archiveMessages,
  countArchive,
  migrationReport,
  messageMetadata,
  inspectMigrationCandidates,
};
