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
      for (const recipient of recipients) {
        const key = recipientKey(
          n.mail.messageId,
          recipient.destination,
          recipient.known,
        );
        if (!records.has(key))
          records.set(key, { key, state: "received", attempts: 0 });
      }
      const keys = new Set(
        recipients.map((r) =>
          recipientKey(n.mail.messageId, r.destination, r.known),
        ),
      );
      return Promise.resolve(
        ok([...records.values()].filter((r) => keys.has(r.key))),
      );
    },
    claim(key) {
      const r = records.get(key);
      if (r === undefined || !["received", "failed"].includes(r.state))
        return Promise.resolve(ok(false));
      r.state = "importing";
      r.attempts++;
      return Promise.resolve(ok(true));
    },
    finish(key, state) {
      const r = records.get(key);
      if (r === undefined)
        return Promise.resolve(err({ message: "Missing recipient" }));
      r.state = state;
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
