import type { Result } from "neverthrow";
import type { Notification, Recipient, Route } from "../domain/notification.ts";

export type Failure = {
  message: string;
  /** Provider error name, safe to log (no keys or addresses). */
  code?: string;
  ambiguous?: boolean;
  permanent?: boolean;
};
export type Outcome<T> = PromiseLike<Result<T, Failure>>;
export interface QueueMessage {
  body: string;
  receipt: string;
  attempts: number;
}
export interface Queue {
  receive(signal?: AbortSignal): Outcome<QueueMessage[]>;
  delete(receipt: string): Outcome<void>;
  defer(receipt: string, seconds: number): Outcome<void>;
}
export interface Storage {
  archive(key: string, body: string): Outcome<void>;
  readArchive(key: string): Outcome<string>;
  archives(): Outcome<string[]>;
  bufferKeys(): Outcome<string[]>;
  readBuffer(bucket: string, key: string): Outcome<Uint8Array>;
  deleteBuffer(bucket: string, key: string): Outcome<void>;
}
/** Storage operations used only by operator recovery from the archives. */
export interface RecoveryStore {
  /** Objects written by Firehose under a prefix of the buffer bucket. */
  firehoseObjects(prefix: string): Outcome<{ key: string; modified: Date }[]>;
  readFirehose(key: string): Outcome<Uint8Array>;
  archiveExists(key: string): Outcome<boolean>;
  /**
   * Creates an archive entry unless one exists, as a conditional write. A
   * provider without conditional writes refuses it (`NotImplemented`);
   * `fenced` then checks for the entry and writes it, which the operator
   * may only ask for when no other writer of the archive can run, and reads
   * it back to compare.
   */
  archiveIfAbsent(
    key: string,
    body: string,
    options?: { fenced?: boolean },
  ): Outcome<"written" | "present">;
  bufferExists(bucket: string, key: string): Outcome<boolean>;
  /** Newest stored version of an object, ignoring deletion markers. */
  latestVersion(bucket: string, key: string): Outcome<string | null>;
  /** Copies a version back as the current object unless one exists. */
  restoreIfAbsent(
    bucket: string,
    key: string,
    versionId: string,
  ): Outcome<"restored" | "present">;
}
export type RecipientState =
  | "received"
  | "importing"
  | "imported"
  | "quarantined"
  | "failed"
  | "rejected"
  | "uncertain"
  // An unknown envelope recipient waiting for its address to be provisioned
  // or for an operator decision; its message and object are kept.
  | "held"
  // Addresses that became known were moved to a mailbox recipient.
  | "rerouted";
export interface LedgerRecipient {
  key: string;
  state: RecipientState;
  attempts: number;
  destination: string;
  known: boolean;
  permanent: boolean;
  legacy: boolean;
  importStartedAt: Date | null;
}
export interface Ledger {
  /**
   * Records the message and its recipients. Held addresses that now resolve
   * to a mailbox move to that mailbox recipient, but only while the time,
   * read under the message lock, is before `rerouteUntil` (epoch ms).
   */
  prepare(
    notification: Notification,
    recipients: Recipient[],
    options?: { rerouteUntil?: number },
  ): Outcome<LedgerRecipient[]>;
  /** Rejects a held recipient whose hold window elapsed, with an audit row. */
  expireHeld(key: string, reason: string): Outcome<boolean>;
  claim(key: string, owner: string): Outcome<boolean>;
  renew(key: string, owner: string): Outcome<boolean>;
  startImport(key: string, owner: string): Outcome<boolean>;
  expireClaims(): Outcome<void>;
  retryUncertain(key: string, before: Date): Outcome<boolean>;
  finish(
    key: string,
    state: RecipientState,
    remoteId?: string,
    error?: string,
    owner?: string,
    chargeAttempt?: boolean,
  ): Outcome<void>;
  messageState(id: string, state: string): Outcome<void>;
  importedMessages(ids: string[]): Outcome<string[]>;
  /** Envelope addresses already recorded for a message, in any state. */
  recordedAddresses(messageId: string): Outcome<string[]>;
  resetFailures(): Outcome<void>;
}
export interface Delivery {
  import(
    destination: string,
    bytes: Uint8Array,
    quarantine: boolean,
    receivedAt: string,
    key: string,
    uploads: Map<string, string>,
    beforeImport: () => Outcome<void>,
  ): Outcome<string>;
  reconcile(
    destination: string,
    bytes: Uint8Array,
    quarantine: boolean,
    receivedAt: string,
    key: string,
    legacy?: boolean,
  ): Outcome<string[]>;
}
export interface Events {
  emit(event: string, fields: Record<string, string | number>): void;
}
export interface IngestDependencies {
  storage: Storage;
  ledger: Ledger;
  delivery: Delivery;
  routes: Route[];
  resolveRoutes?: (addresses: string[]) => Outcome<Route[]>;
  events: Events;
  bucket: string;
  bufferPrefix: string;
  /** Receipt rules' object key prefixes; see `RecoveryScope`. */
  objectPrefixes?: string[] | undefined;
  topic: string;
  maxAttempts: number;
  /**
   * Days an unknown recipient is held. Older held recipients are never
   * routed and are rejected automatically; defaults to 14.
   */
  holdDays?: number;
}
