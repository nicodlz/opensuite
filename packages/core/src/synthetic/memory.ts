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
  const messageStates = new Map<string, string>();
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
            permanent: false,
            legacy: false,
            importStartedAt: null,
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
      r.importStartedAt = null;
      return Promise.resolve(ok(true));
    },
    renew(key) {
      return Promise.resolve(ok(records.get(key)?.state === "importing"));
    },
    startImport(key) {
      const record = records.get(key);
      if (record?.state !== "importing") return Promise.resolve(ok(false));
      record.importStartedAt = new Date();
      return Promise.resolve(ok(true));
    },
    expireClaims() {
      return Promise.resolve(ok(undefined));
    },
    retryUncertain(key, before) {
      const r = records.get(key);
      if (
        r?.state !== "uncertain" ||
        r.legacy ||
        r.importStartedAt === null ||
        r.importStartedAt > before
      )
        return Promise.resolve(ok(false));
      r.state = "failed";
      return Promise.resolve(ok(true));
    },
    finish(key, state, _remoteId, _error, _owner, chargeAttempt) {
      const r = records.get(key);
      if (r === undefined)
        return Promise.resolve(err({ message: "Missing recipient" }));
      r.state = state;
      if (chargeAttempt === true) r.attempts++;
      r.permanent = chargeAttempt === true;
      return Promise.resolve(ok(undefined));
    },
    resetFailures() {
      for (const record of records.values())
        if (record.state === "failed" && !record.permanent) record.attempts = 0;
      return Promise.resolve(ok(undefined));
    },
    messageState(id, state) {
      messageStates.set(id, state);
      return Promise.resolve(ok(undefined));
    },
    importedMessages(ids) {
      return Promise.resolve(
        ok(ids.filter((id) => messageStates.get(id) === "imported")),
      );
    },
  };
  const delivery: Delivery = {
    reconcile() {
      return Promise.resolve(ok([]));
    },
    async import(
      destination,
      bytes,
      quarantine,
      _receivedAt,
      _key,
      _uploads,
      beforeImport,
    ) {
      const started = await beforeImport();
      if (started.isErr()) return err(started.error);
      imports.push({ destination, bytes, quarantine });
      return ok(`email-${String(imports.length)}`);
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
