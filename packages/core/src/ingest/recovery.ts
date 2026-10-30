import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
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
/**
 * Whether an archive entry still holds the text it is named after. Another
 * writer replacing an entry with different content is detected here, as no
 * archive can exclude every writer.
 */
export const namedAfter = (key: string, body: string) =>
  key.split("/").at(-1) === archiveKey(body);

/** The bucket, topic and buffer prefix this installation accepts. */
export interface RecoveryScope {
  bucket: string;
  topic: string;
  bufferPrefix: string;
  /**
   * Object key prefixes of the receipt rules, current and past, each within
   * the buffer prefix; the buffer prefix alone by default.
   */
  objectPrefixes?: string[] | undefined;
}
/** The message ID SES gives the test message it writes when a rule is set up. */
export const SETUP_MARKER = "AMAZON_SES_SETUP_NOTIFICATION";
const SetupShape = z.object({
  notificationType: z.literal("Received"),
  mail: z.object({ messageId: z.literal(SETUP_MARKER) }),
  receipt: z.object({
    action: z.object({
      bucketName: z.string(),
      topicArn: z.string(),
      objectKey: z.string(),
    }),
  }),
});
/**
 * Whether a record is SES's setup test for one of this installation's rules:
 * a `Received` notification with the marker as message ID, naming this
 * bucket and topic and an object key that is an accepted prefix followed by
 * the marker. It carries no mail and lacks verdicts, so it is neither
 * delivered nor counted as an invalid notification. Anything else with the
 * marker remains invalid.
 */
export const isSetupNotice = (text: string, scope: RecoveryScope) =>
  setupNotice(text, scope) === "setup";
/**
 * `setup` for this installation's setup test, `foreign` for one naming this
 * bucket and topic under a prefix that is not accepted (a prefix missing
 * from the configuration, like a refused notification), otherwise `null`.
 */
export function setupNotice(
  text: string,
  scope: RecoveryScope,
): "setup" | "foreign" | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = SetupShape.safeParse(value);
  if (!parsed.success) return null;
  const action = parsed.data.receipt.action;
  if (action.bucketName !== scope.bucket || action.topicArn !== scope.topic)
    return null;
  return isSetupObject(action.objectKey, scope) ? "setup" : "foreign";
}
/** The test object SES writes under an accepted prefix when a rule is set up. */
export const isSetupObject = (key: string, scope: RecoveryScope) =>
  (scope.objectPrefixes?.length
    ? scope.objectPrefixes
    : [scope.bufferPrefix]
  ).some((prefix) => key === prefix + SETUP_MARKER);
/**
 * Whether a notification is this installation's, and names its own message:
 * SES stores each message under its rule's object key prefix followed by the
 * message ID, so a notification cannot point at another message's object.
 * SES message IDs contain no slash; one that did could reach into a nested
 * prefix.
 */
export const belongs = (n: Notification, scope: RecoveryScope) =>
  n.receipt.action.bucketName === scope.bucket &&
  n.receipt.action.topicArn === scope.topic &&
  !n.mail.messageId.includes("/") &&
  (scope.objectPrefixes?.length
    ? scope.objectPrefixes
    : [scope.bufferPrefix]
  ).some((prefix) => n.receipt.action.objectKey === prefix + n.mail.messageId);

// JSON with sorted keys, so equal notifications compare equal.
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
// What must agree between variants: everything but their envelope and the
// time and duration of the receipt rule that produced each.
const shared = (n: Notification) =>
  canonical({
    ...n,
    receipt: {
      ...n.receipt,
      recipients: [],
      timestamp: "",
      processingTimeMillis: 0,
    },
  });

/**
 * One notification carrying every envelope recipient of several variants of
 * the same message, in their first-seen order. Variants are merged only when
 * everything else agrees (object, verdicts, sender, times); otherwise they
 * are refused, never resolved by picking one.
 */
export function mergeVariants(
  bodies: string[],
): Result<{ body: string; recipients: string[] }, Failure> {
  const parsed = bodies.map((body) => parseNotification(body));
  const valid = parsed.flatMap((n) => (n.isOk() ? [n.value] : []));
  const [first] = valid;
  if (first === undefined || valid.length !== parsed.length)
    return err({ message: "Invalid notification variant" });
  if (new Set(valid.map(shared)).size > 1)
    return err({ message: "Notification variants disagree" });
  const seen = new Set<string>();
  const recipients = valid
    .flatMap((n) => n.receipt.recipients)
    .filter((address) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return ok({
    body: JSON.stringify({
      ...first,
      receipt: { ...first.receipt, recipients },
    }),
    recipients,
  });
}
/** Whether every address is already recorded for the message. */
export const covered = (addresses: string[], recorded: string[]) => {
  const known = new Set(recorded.map((address) => address.toLowerCase()));
  return addresses.every((address) => known.has(address.toLowerCase()));
};
export interface Divergence {
  messageId: string;
  /** Distinct notifications carrying this SES message ID. */
  variants: number;
  /** Envelope recipients of every variant; replay delivers to all of them. */
  recipients: string[];
  recipientsDiffer: boolean;
  /** False when anything but the envelope differs: replay then skips it. */
  mergeable: boolean;
}
export interface FirehoseReport {
  apply: boolean;
  objects: number;
  unreadable: number;
  records: number;
  /**
   * Records that are not a valid notification of received mail: these may be
   * mail that was not recovered, so the command reports an error.
   */
  invalid: number;
  /** SES's setup notifications, which carry no mail. */
  setup: number;
  foreign: number;
  /** Received outside `since`..`until`. */
  outsideWindow: number;
  notifications: number;
  alreadyArchived: number;
  /** Missing from the archive: written with `apply`, otherwise to write. */
  missing: number;
  written: number;
  /**
   * Entries holding content other than they are named after, or found
   * replaced by another writer during a fenced write.
   */
  changed: number;
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
  options: {
    prefix: string;
    since?: Date;
    until?: Date;
    apply: boolean;
    /** The operator stopped every other archive writer (see the runbook). */
    fenced?: boolean;
  },
): Promise<Result<FirehoseReport, Failure>> {
  // The Firehose prefix only: never read the buffered messages themselves.
  const overlaps = (prefix: string) =>
    prefix !== "" &&
    (options.prefix.startsWith(prefix) || prefix.startsWith(options.prefix));
  if (
    overlaps(scope.bufferPrefix) ||
    (scope.objectPrefixes ?? []).some(overlaps)
  )
    return err({ message: "Prefix is inside the message buffer" });
  const listed = await store.firehoseObjects(options.prefix);
  if (listed.isErr()) return err(listed.error);
  // An object is written after the records it holds, possibly much later
  // when Firehose retries, so only `since` can skip whole objects; records
  // are selected by their own receipt time.
  const objects = listed.value.filter(
    (item) => options.since === undefined || item.modified >= options.since,
  );
  const inWindow = (n: Notification) => {
    const at = Date.parse(n.mail.timestamp);
    return (
      (options.since === undefined || at >= options.since.getTime()) &&
      (options.until === undefined || at <= options.until.getTime())
    );
  };
  const report: FirehoseReport = {
    apply: options.apply,
    objects: objects.length,
    unreadable: 0,
    records: 0,
    invalid: 0,
    setup: 0,
    foreign: 0,
    outsideWindow: 0,
    notifications: 0,
    alreadyArchived: 0,
    missing: 0,
    written: 0,
    changed: 0,
    failed: 0,
    divergent: [],
  };
  const bodies = new Map<string, { body: string; n: Notification }>();
  await inTurn(objects, async (item) => {
    const read = await store.readFirehose(item.key);
    let text: string;
    try {
      if (read.isErr()) throw new Error(read.error.message);
      text = gunzipSync(read.value, {
        maxOutputLength: 512 * 1024 * 1024,
      }).toString("utf8");
    } catch {
      report.unreadable++;
      return;
    }
    // Firehose appends a newline to each record; the record itself is
    // the notification exactly as SNS delivered it.
    for (const line of text.split("\n")) {
      if (line === "") continue;
      report.records++;
      const marker = setupNotice(line, scope);
      if (marker === "setup") {
        report.setup++;
        continue;
      }
      if (marker === "foreign") {
        report.foreign++;
        continue;
      }
      const parsed = parseNotification(line);
      if (parsed.isErr()) report.invalid++;
      else if (!belongs(parsed.value, scope)) report.foreign++;
      else if (!inWindow(parsed.value)) report.outsideWindow++;
      else bodies.set(archiveKey(line), { body: line, n: parsed.value });
    }
  });
  report.notifications = bodies.size;
  const byMessage = new Map<string, Notification[]>();
  const texts = new Map<string, string[]>();
  for (const { body, n } of bodies.values()) {
    byMessage.set(n.mail.messageId, [
      ...(byMessage.get(n.mail.messageId) ?? []),
      n,
    ]);
    texts.set(n.mail.messageId, [...(texts.get(n.mail.messageId) ?? []), body]);
  }
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
      mergeable: mergeVariants(texts.get(messageId) ?? []).isOk(),
    });
  }
  await inTurn([...bodies], async ([key, { body }]) => {
    const state = await store.archiveState(key);
    if (state.isErr()) {
      report.failed++;
      return;
    }
    if (state.value === "changed") {
      report.changed++;
      return;
    }
    if (state.value === "present") {
      report.alreadyArchived++;
      return;
    }
    report.missing++;
    if (!options.apply) return;
    const written = await store.archiveIfAbsent(key, body, {
      fenced: options.fenced === true,
    });
    if (written.isErr()) {
      if (written.error.code === "ArchiveChanged") report.changed++;
      else report.failed++;
    } else if (written.value === "written") report.written++;
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
  /** Messages whose notifications disagree beyond their envelope. */
  divergent: string[];
  /**
   * Archived notifications this installation does not accept, usually an
   * object key prefix missing from the configuration.
   */
  foreign: number;
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
  const variants = new Map<string, string[]>();
  let failed = 0;
  let foreign = 0;
  await inTurn(keys.value, async (key) => {
    const body = await storage.readArchive(key);
    // A setup test carries no mail, archived or not.
    // An intact setup test carries no mail; a replaced entry is not skipped.
    if (
      body.isOk() &&
      namedAfter(key, body.value) &&
      isSetupNotice(body.value, scope)
    )
      return;
    const parsed =
      body.isOk() && namedAfter(key, body.value)
        ? parseNotification(body.value)
        : undefined;
    if (parsed === undefined || parsed.isErr()) {
      failed++;
      return;
    }
    if (body.isErr()) return;
    if (!belongs(parsed.value, scope)) {
      foreign++;
      return;
    }
    const id = parsed.value.mail.messageId;
    messages.set(id, parsed.value);
    variants.set(id, [...(variants.get(id) ?? []), body.value]);
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
    divergent: [],
    foreign,
    failed,
  };
  // An imported message is replayed again only if its notifications name
  // envelope recipients the ledger does not hold yet (see replay).
  const objects = new Map<string, string>();
  await inTurn([...messages], async ([messageId, n]) => {
    const bodies = variants.get(messageId) ?? [];
    if (bodies.length < 2) {
      if (!imported.has(messageId))
        objects.set(n.receipt.action.objectKey, messageId);
      return;
    }
    const merged = mergeVariants(bodies);
    if (merged.isErr()) {
      report.divergent.push(messageId);
      return;
    }
    if (imported.has(messageId)) {
      const recorded = await ledger.recordedAddresses(messageId);
      if (recorded.isErr()) {
        report.failed++;
        return;
      }
      if (covered(merged.value.recipients, recorded.value)) return;
    }
    objects.set(n.receipt.action.objectKey, messageId);
  });
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
