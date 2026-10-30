import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { err, ok, type Result } from "neverthrow";
import {
  parseNotification,
  type Notification,
} from "../domain/notification.ts";
import type { Failure, Ledger, RecoveryStore, Storage } from "./contracts.ts";

/** Runs `work` on each item in turn: recovery bounds memory and load. */
const inTurn = <T>(items: T[], work: (item: T) => Promise<void>) =>
  items.reduce<Promise<void>>(
    (previous, item) => previous.then(() => work(item)),
    Promise.resolve(),
  );

/** Archive entries are named after the exact notification text. */
export const archiveKey = (body: string) =>
  `${createHash("sha256").update(body).digest("hex")}.json`;

/** The bucket, topic and buffer prefix this installation accepts. */
export interface RecoveryScope {
  bucket: string;
  topic: string;
  bufferPrefix: string;
}
export const belongs = (n: Notification, scope: RecoveryScope) =>
  n.receipt.action.bucketName === scope.bucket &&
  n.receipt.action.topicArn === scope.topic &&
  n.receipt.action.objectKey.startsWith(scope.bufferPrefix);

/**
 * One notification carrying every envelope recipient of several variants of
 * the same message, in their first-seen order; the rest is the first
 * variant's. Unparsable variants are left out.
 */
export function mergeVariants(bodies: string[]): string {
  const parsed = bodies.flatMap((body) => {
    const n = parseNotification(body);
    return n.isOk() ? [n.value] : [];
  });
  const [first] = parsed;
  if (first === undefined) return bodies[0] ?? "";
  const seen = new Set<string>();
  const recipients = parsed
    .flatMap((n) => n.receipt.recipients)
    .filter((address) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return JSON.stringify({
    ...first,
    receipt: { ...first.receipt, recipients },
  });
}
export interface Divergence {
  messageId: string;
  /** Distinct notifications carrying this SES message ID. */
  variants: number;
  /** Envelope recipients of every variant; replay delivers to all of them. */
  recipients: string[];
  recipientsDiffer: boolean;
}
export interface FirehoseReport {
  apply: boolean;
  objects: number;
  unreadable: number;
  records: number;
  invalid: number;
  foreign: number;
  notifications: number;
  alreadyArchived: number;
  /** Missing from the archive: written with `apply`, otherwise to write. */
  missing: number;
  written: number;
  failed: number;
  divergent: Divergence[];
}

/**
 * Copies SES notifications that Firehose archived into the replay archive,
 * so a replay delivers mail whose queue message expired or was lost. Records
 * are kept byte for byte: the archive name is the text's digest, so a
 * notification the worker already archived is recognised. Notifications
 * sharing an SES message ID but differing are all kept (the ledger merges
 * their recipients) and reported.
 */
export async function recoverFirehose(
  store: RecoveryStore,
  scope: RecoveryScope,
  options: { prefix: string; since?: Date; until?: Date; apply: boolean },
): Promise<Result<FirehoseReport, Failure>> {
  const listed = await store.firehoseObjects(options.prefix);
  if (listed.isErr()) return err(listed.error);
  const objects = listed.value.filter(
    (item) =>
      (options.since === undefined || item.modified >= options.since) &&
      (options.until === undefined || item.modified <= options.until),
  );
  const report: FirehoseReport = {
    apply: options.apply,
    objects: objects.length,
    unreadable: 0,
    records: 0,
    invalid: 0,
    foreign: 0,
    notifications: 0,
    alreadyArchived: 0,
    missing: 0,
    written: 0,
    failed: 0,
    divergent: [],
  };
  const bodies = new Map<string, { body: string; n: Notification }>();
  await inTurn(objects, async (item) => {
    const read = await store.readFirehose(item.key);
    let text: string;
    try {
      if (read.isErr()) throw new Error(read.error.message);
      text = gunzipSync(read.value).toString("utf8");
    } catch {
      report.unreadable++;
      return;
    }
    // Firehose appends a newline to each record; the record itself is
    // the notification exactly as SNS delivered it.
    for (const line of text.split("\n")) {
      if (line === "") continue;
      report.records++;
      const parsed = parseNotification(line);
      if (parsed.isErr()) report.invalid++;
      else if (!belongs(parsed.value, scope)) report.foreign++;
      else bodies.set(archiveKey(line), { body: line, n: parsed.value });
    }
  });
  report.notifications = bodies.size;
  const byMessage = new Map<string, Notification[]>();
  for (const { n } of bodies.values())
    byMessage.set(n.mail.messageId, [
      ...(byMessage.get(n.mail.messageId) ?? []),
      n,
    ]);
  for (const [messageId, variants] of byMessage) {
    if (variants.length < 2) continue;
    const sets = variants.map((n) =>
      [...new Set(n.receipt.recipients.map((r) => r.toLowerCase()))]
        .toSorted()
        .join(","),
    );
    report.divergent.push({
      messageId,
      variants: variants.length,
      recipients: [
        ...new Set(variants.flatMap((n) => n.receipt.recipients)),
      ].toSorted(),
      recipientsDiffer: new Set(sets).size > 1,
    });
  }
  await inTurn([...bodies], async ([key, { body }]) => {
    const exists = await store.archiveExists(key);
    if (exists.isErr()) {
      report.failed++;
      return;
    }
    if (exists.value) {
      report.alreadyArchived++;
      return;
    }
    report.missing++;
    if (!options.apply) return;
    const written = await store.archiveIfAbsent(key, body);
    if (written.isErr()) report.failed++;
    else if (written.value === "written") report.written++;
    // Written concurrently since the check: present, nothing lost.
    else report.alreadyArchived++;
  });
  return ok(report);
}

export interface ObjectReport {
  apply: boolean;
  /** Archived messages the ledger does not record as imported. */
  pending: number;
  present: number;
  /** Missing objects with a stored version: restored with `apply`. */
  restorable: number;
  restored: number;
  /** Missing objects with no version left; their mail cannot be replayed. */
  unrecoverable: { messageId: string; objectKey: string }[];
  failed: number;
}

/**
 * Restores, from the buffer's stored versions, the MIME objects that
 * archived but unfinished messages need, for instance after the ledger was
 * restored from a backup older than their import. A current object is never
 * replaced and no version is removed. Replay then looks each recipient up in
 * its mailbox before importing.
 */
export async function recoverObjects(
  store: RecoveryStore,
  storage: Storage,
  ledger: Ledger,
  scope: RecoveryScope,
  options: { apply: boolean },
): Promise<Result<ObjectReport, Failure>> {
  const keys = await storage.archives();
  if (keys.isErr()) return err(keys.error);
  const messages = new Map<string, Notification>();
  // Messages archived more than once are replayed even when imported.
  const repeated = new Set<string>();
  let failed = 0;
  await inTurn(keys.value, async (key) => {
    const body = await storage.readArchive(key);
    const parsed = body.isOk() ? parseNotification(body.value) : undefined;
    if (parsed === undefined || parsed.isErr()) {
      failed++;
      return;
    }
    if (!belongs(parsed.value, scope)) return;
    const id = parsed.value.mail.messageId;
    if (messages.has(id)) repeated.add(id);
    messages.set(id, parsed.value);
  });
  const ids = [...messages.keys()];
  const imported = new Set<string>();
  let lookup: Failure | undefined;
  await inTurn(
    Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) =>
      ids.slice(i * 500, (i + 1) * 500),
    ),
    async (batch) => {
      if (lookup !== undefined) return;
      const found = await ledger.importedMessages(batch);
      if (found.isErr()) lookup = found.error;
      else for (const id of found.value) imported.add(id);
    },
  );
  if (lookup !== undefined) return err(lookup);
  const report: ObjectReport = {
    apply: options.apply,
    pending: 0,
    present: 0,
    restorable: 0,
    restored: 0,
    unrecoverable: [],
    failed,
  };
  const objects = new Map<string, string>();
  for (const [messageId, n] of messages)
    if (!imported.has(messageId) || repeated.has(messageId))
      objects.set(n.receipt.action.objectKey, messageId);
  report.pending = objects.size;
  await inTurn([...objects], async ([objectKey, messageId]) => {
    const exists = await store.bufferExists(scope.bucket, objectKey);
    if (exists.isErr()) {
      report.failed++;
      return;
    }
    if (exists.value) {
      report.present++;
      return;
    }
    const version = await store.latestVersion(scope.bucket, objectKey);
    if (version.isErr()) {
      report.failed++;
      return;
    }
    if (version.value === null) {
      report.unrecoverable.push({ messageId, objectKey });
      return;
    }
    report.restorable++;
    if (!options.apply) return;
    const restored = await store.restoreIfAbsent(
      scope.bucket,
      objectKey,
      version.value,
    );
    if (restored.isErr()) report.failed++;
    else if (restored.value === "restored") report.restored++;
    else report.present++;
  });
  return ok(report);
}
