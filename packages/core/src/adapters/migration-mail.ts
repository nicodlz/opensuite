import { Readable } from "node:stream";
import {
  MAIL_ARCHIVE_LIMIT,
  MAIL_MESSAGE_LIMIT,
  MAIL_IMPORT_OVER_QUOTA,
  migrationReport,
  type MailImportMetadata,
  type MailImportSnapshot,
} from "@opensuite/contracts";
import { simpleParser } from "mailparser";
import {
  createMigrationSnapshot,
  captureMigrationDestinations,
  checkMigrationDestinations,
  inspectMigrationCandidates,
  migrationMailboxPatch as mailboxPatch,
  rememberMigrationImport,
  runMigrationItem,
  resolveMigrationCandidate,
  type JmapClient,
  type JmapError,
  type Session,
} from "@opensuite/jmap";

type Client = Pick<
  JmapClient,
  | "queryEmails"
  | "migrationEmails"
  | "emailState"
  | "emailChanges"
  | "mailboxes"
  | "download"
  | "upload"
  | "migrationImport"
>;
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

export { inspectMigrationCandidates };

export async function prepareMigrationSnapshot(input: {
  client: Client;
  session: Session;
  accountId: string;
  archive: Buffer;
  format: string;
  variant: string;
  ids: readonly string[];
  expected: unknown;
  keepAlive: () => Promise<boolean>;
}) {
  if (!(await input.keepAlive()))
    return { kind: "failed" as const, error: "unavailable" as const };
  const destinations = await checkMigrationDestinations(input);
  if (destinations.kind !== "ready")
    return {
      kind: "failed" as const,
      error:
        destinations.kind === "changed"
          ? ("destination" as const)
          : ("unavailable" as const),
    };
  const messageIds = new Set<string>();
  for await (const raw of archiveMessages(
    input.archive,
    input.format,
    input.variant,
  )) {
    if (!(await input.keepAlive()))
      return { kind: "failed" as const, error: "unavailable" as const };
    try {
      const metadata = await messageMetadata(raw, {}, "");
      if (metadata.messageId !== null) messageIds.add(metadata.messageId);
    } catch {
      // The worker reports malformed metadata for the individual message.
    }
  }
  const snapshot = await createMigrationSnapshot({
    client: input.client,
    session: input.session,
    accountId: input.accountId,
    messageIds: [...messageIds],
    keepAlive: input.keepAlive,
  });
  return snapshot.isErr()
    ? { kind: "failed" as const, error: snapshot.error.kind }
    : { kind: "ready" as const, snapshot: snapshot.value };
}

function importFailure(error: JmapError) {
  const transient =
    (error.kind === "method" &&
      ["stateMismatch", "serverUnavailable"].includes(error.type)) ||
    (error.kind === "set" && error.type === "rateLimit");
  if (transient) return { kind: "retry" as const, proceed: false as const };
  if (error.kind === "network" && error.beforeRequest === true)
    return { kind: "retry" as const, proceed: false as const };
  const quota = error.kind === "set" && error.type === "overQuota";
  const certain =
    error.kind === "set" ||
    (error.kind === "method" && error.type !== "serverPartialFail");
  return {
    kind: certain ? ("failed" as const) : ("uncertain" as const),
    error: quota
      ? MAIL_IMPORT_OVER_QUOTA
      : certain
        ? "Message import rejected"
        : "Import outcome uncertain",
    proceed: certain && !quota,
  };
}

/** Fence the external write with durable intent and record success before further reads. */
export async function importMigrationMessage(input: {
  client: Client;
  session: Session;
  accountId: string;
  bytes: Buffer;
  metadata: MailImportMetadata;
  marker: string;
  snapshot: MailImportSnapshot;
  beforeImport: () => Promise<boolean>;
  onImported: (id: string) => Promise<boolean>;
}) {
  const { client, session, accountId, metadata, snapshot } = input;
  const uploaded = await client.upload(session, accountId, input.bytes);
  if (uploaded.isErr()) {
    if (uploaded.error.kind === "http" && uploaded.error.status === 507)
      return {
        kind: "failed" as const,
        error: MAIL_IMPORT_OVER_QUOTA,
        proceed: false,
      };
    return { kind: "retry" as const, proceed: false as const };
  }
  if (!(await input.beforeImport()))
    return { kind: "recorded" as const, proceed: false };
  const imported = await client.migrationImport(
    session,
    accountId,
    {
      blobId: uploaded.value.blobId,
      mailboxIds: metadata.mailboxIds,
      keywords: { ...metadata.keywords, [input.marker]: true },
      ...(metadata.receivedAt === undefined
        ? {}
        : { receivedAt: metadata.receivedAt }),
    },
    snapshot.state,
  );
  if (imported.isErr()) return importFailure(imported.error);
  if (!(await input.onImported(imported.value.id)))
    return { kind: "recorded" as const, proceed: false };
  snapshot.state = imported.value.newState;
  const proceed = await rememberMigrationImport({
    client,
    session,
    accountId,
    snapshot,
    id: imported.value.id,
    messageId: metadata.messageId,
  });
  return { kind: "recorded" as const, proceed };
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

export const migrationMailTools = {
  mailboxPatch,
  archiveMessages,
  countArchive,
  migrationReport,
  messageMetadata,
  prepareMigrationSnapshot,
  runMigrationItem,
  inspectMigrationCandidates,
  captureMigrationDestinations,
  checkMigrationDestinations,
  resolveMigrationCandidate,
  importMigrationMessage,
};
