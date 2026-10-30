import { err, ok } from "neverthrow";
import { recipientKey } from "../ingest/service.ts";
import type {
  Delivery,
  Events,
  Ledger,
  LedgerRecipient,
  Storage,
} from "../ingest/contracts.ts";

export function synthetic() {
  const archives = new Map<string, string>();
  const buffers = new Map<string, Uint8Array>();
  const records = new Map<string, LedgerRecipient>();
  const recordMessages = new Map<string, string>();
  const recordAddresses = new Map<string, string[]>();
  const imports: {
    destination: string;
    bytes: Uint8Array;
    quarantine: boolean;
  }[] = [];
  const events: string[] = [];
  const storage: Storage = {
    archive(key, body) {
      archives.set(key, body);
      return Promise.resolve(ok(undefined));
    },
    readArchive(key) {
      const body = archives.get(key);
      return Promise.resolve(
        body === undefined ? err({ message: "Missing archive" }) : ok(body),
      );
    },
    archives() {
      return Promise.resolve(ok([...archives.keys()]));
    },
    bufferKeys() {
      return Promise.resolve(ok([...buffers.keys()]));
    },
    readBuffer(_bucket, key) {
      const body = buffers.get(key);
      return Promise.resolve(
        body === undefined ? err({ message: "Missing buffer" }) : ok(body),
      );
    },
    deleteBuffer(_bucket, key) {
      buffers.delete(key);
      return Promise.resolve(ok(undefined));
    },
  };
  const ledger: Ledger = {
    prepare(n, recipients) {
      const existingKeys = [...recordMessages.entries()]
        .filter(([, id]) => id === n.mail.messageId)
        .map(([key]) => key);
      const recorded = new Set(
        existingKeys.flatMap((key) => recordAddresses.get(key) ?? []),
      );
      for (const recipient of recipients) {
        const addresses = recipient.addresses.filter(
          (address) => !recorded.has(address),
        );
        if (addresses.length === 0) continue;
        const key = recipientKey(
          n.mail.messageId,
          recipient.destination,
          recipient.known,
        );
        recordMessages.set(key, n.mail.messageId);
        recordAddresses.set(key, [
          ...(recordAddresses.get(key) ?? []),
          ...addresses,
        ]);
        if (!records.has(key))
          records.set(key, {
            key,
            state: "received",
            attempts: 0,
            destination: recipient.destination,
            known: recipient.known,
          });
      }
      return Promise.resolve(
        ok(
          [...records.values()].filter(
            (r) => recordMessages.get(r.key) === n.mail.messageId,
          ),
        ),
      );
    },
    claim(key) {
      const r = records.get(key);
      if (r === undefined || !["received", "failed"].includes(r.state))
        return Promise.resolve(ok(false));
      r.state = "importing";
      return Promise.resolve(ok(true));
    },
    renew(key) {
      return Promise.resolve(ok(records.get(key)?.state === "importing"));
    },
    expireClaims() {
      return Promise.resolve(ok(undefined));
    },
    finish(key, state, _remoteId, _error, _owner, chargeAttempt) {
      const r = records.get(key);
      if (r === undefined)
        return Promise.resolve(err({ message: "Missing recipient" }));
      r.state = state;
      if (chargeAttempt === true) r.attempts++;
      return Promise.resolve(ok(undefined));
    },
    resetFailures() {
      for (const record of records.values())
        if (record.state === "failed") record.attempts = 0;
      return Promise.resolve(ok(undefined));
    },
    messageState() {
      return Promise.resolve(ok(undefined));
    },
  };
  const delivery: Delivery = {
    reconcile() {
      return Promise.resolve(
        err({ message: "No matching message", ambiguous: true }),
      );
    },
    import(destination, bytes, quarantine) {
      imports.push({ destination, bytes, quarantine });
      return Promise.resolve(ok(`email-${String(imports.length)}`));
    },
  };
  const sink: Events = {
    emit(event) {
      events.push(event);
    },
  };
  return {
    storage,
    ledger,
    delivery,
    sink,
    archives,
    buffers,
    records,
    imports,
    events,
  };
}
