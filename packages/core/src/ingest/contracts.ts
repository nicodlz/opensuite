import type { Result } from "neverthrow";
import type { Notification, Recipient, Route } from "../domain/notification.ts";

export type Failure = {
  message: string;
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
  receive(): Outcome<QueueMessage[]>;
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
export type RecipientState =
  | "received"
  | "importing"
  | "imported"
  | "quarantined"
  | "failed"
  | "rejected"
  | "uncertain";
export interface LedgerRecipient {
  key: string;
  state: RecipientState;
  attempts: number;
  destination: string;
  known: boolean;
}
export interface Ledger {
  prepare(
    notification: Notification,
    recipients: Recipient[],
  ): Outcome<LedgerRecipient[]>;
  claim(key: string, owner: string): Outcome<boolean>;
  renew(key: string, owner: string): Outcome<boolean>;
  expireClaims(): Outcome<void>;
  finish(
    key: string,
    state: RecipientState,
    remoteId?: string,
    error?: string,
    owner?: string,
    chargeAttempt?: boolean,
  ): Outcome<void>;
  messageState(id: string, state: string): Outcome<void>;
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
  ): Outcome<string>;
  reconcile(
    destination: string,
    bytes: Uint8Array,
    quarantine: boolean,
    receivedAt: string,
    key: string,
  ): Outcome<string>;
}
export interface Events {
  emit(event: string, fields: Record<string, string | number>): void;
}
export interface IngestDependencies {
  storage: Storage;
  ledger: Ledger;
  delivery: Delivery;
  routes: Route[];
  events: Events;
  bucket: string;
  bufferPrefix: string;
  topic: string;
  maxAttempts: number;
}
