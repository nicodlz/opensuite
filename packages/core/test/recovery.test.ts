import { gzipSync } from "node:zlib";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { RecoveryStore, Storage } from "../src/ingest/contracts.ts";
import {
  archiveKey,
  belongs,
  recoverFirehose,
  recoverObjects,
} from "../src/ingest/recovery.ts";
import { parseNotification } from "../src/domain/notification.ts";
import { synthetic } from "../src/synthetic/memory.ts";
import { notification } from "./fixtures.ts";

const scope = {
  bucket: "inbound",
  topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
  bufferPrefix: "",
};
const body = (
  recipients: string[],
  id: string,
  options: {
    bucket?: string;
    at?: string;
    status?: string;
    object?: string;
  } = {},
) => {
  const n = notification(recipients, options.status ?? "PASS", id);
  const at = options.at ?? "2026-10-30T09:00:00.000Z";
  return JSON.stringify({
    ...n,
    mail: { ...n.mail, timestamp: at },
    receipt: {
      ...n.receipt,
      timestamp: at,
      action: {
        ...n.receipt.action,
        bucketName: options.bucket ?? "inbound",
        objectKey: options.object ?? id,
      },
    },
  });
};
const firehose = (...records: string[]) =>
  gzipSync(records.map((record) => `${record}\n`).join(""));

function fakeStore(objects: Record<string, { bytes: Uint8Array; at: Date }>) {
  const archive = new Map<string, string>();
  const buffer = new Set<string>();
  const versions = new Map<string, string>();
  const store: RecoveryStore = {
    firehoseObjects: (prefix) =>
      Promise.resolve(
        ok(
          Object.entries(objects)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, item]) => ({ key, modified: item.at })),
        ),
      ),
    readFirehose: (key) => {
      const item = objects[key];
      return Promise.resolve(
        item === undefined ? err({ message: "missing" }) : ok(item.bytes),
      );
    },
    archiveExists: (key) => Promise.resolve(ok(archive.has(key))),
    archiveIfAbsent: (key, text) => {
      if (archive.has(key)) return Promise.resolve(ok("present" as const));
      archive.set(key, text);
      return Promise.resolve(ok("written" as const));
    },
    bufferExists: (_bucket, key) => Promise.resolve(ok(buffer.has(key))),
    latestVersion: (_bucket, key) =>
      Promise.resolve(ok(versions.get(key) ?? null)),
    restoreIfAbsent: (_bucket, key) => {
      if (buffer.has(key)) return Promise.resolve(ok("present" as const));
      buffer.add(key);
      return Promise.resolve(ok("restored" as const));
    },
  };
  return { store, archive, buffer, versions };
}

const owned = (id: string, object: string, prefixes?: string[]) => {
  const parsed = parseNotification(
    body(["alice@example.test"], id, { object }),
  );
  if (parsed.isErr()) throw new Error(parsed.error);
  return belongs(parsed.value, {
    ...scope,
    bufferPrefix: "messages/",
    objectPrefixes: prefixes,
  });
};
describe("notification ownership", () => {
  it("accepts every configured rule prefix exactly, and nothing else", () => {
    const prefixes = ["messages/", "messages/esuno/"];
    // The current rule and an earlier one.
    expect(owned("abc", "messages/esuno/abc", prefixes)).toBe(true);
    expect(owned("abc", "messages/abc", prefixes)).toBe(true);
    expect(owned("abc", "messages/other/abc", prefixes)).toBe(false);
    expect(owned("abc", "messages/esuno/abd", prefixes)).toBe(false);
    // A slash in the message ID would reach into the nested prefix.
    expect(owned("esuno/abc", "messages/esuno/abc", prefixes)).toBe(false);
    // Without a list, or an empty one, the buffer prefix alone.
    expect(owned("abc", "messages/abc")).toBe(true);
    expect(owned("abc", "messages/abc", [])).toBe(true);
    expect(owned("abc", "messages/esuno/abc")).toBe(false);
  });
});

describe("recovery from the Firehose archive", () => {
  const b1 = body(["alice@example.test"], "ses-b1");
  const b2 = body(["bcc@example.test"], "ses-b2");
  const c1 = body(["alice@example.test"], "ses-c");
  const c2 = body(["bob@example.test"], "ses-c");
  const foreign = body(["alice@example.test"], "ses-x", {
    bucket: "elsewhere",
  });
  // Names another message's object: never this installation's record.
  const misdirected = body(["alice@example.test"], "ses-y", {
    object: "ses-b1",
  });
  const objects = {
    "metadata/2026/10/30/a.gz": {
      bytes: firehose(
        b1,
        b1,
        b2,
        c1,
        "not json",
        foreign,
        misdirected,
        // SES publishes this when a topic is attached to a rule: no mail.
        JSON.stringify({
          notificationType: "AMAZON_SES_SETUP_NOTIFICATION",
          receipt: {},
        }),
      ),
      at: new Date("2026-10-30T10:00:00Z"),
    },
    "metadata/2026/10/30/b.gz": {
      bytes: firehose(c2),
      at: new Date("2026-10-30T11:00:00Z"),
    },
    "metadata/2026/10/30/broken.gz": {
      bytes: new TextEncoder().encode("not gzip"),
      at: new Date("2026-10-30T12:00:00Z"),
    },
    "metadata/2026/10/29/old.gz": {
      bytes: firehose(
        body(["alice@example.test"], "ses-old", {
          at: "2026-10-29T09:00:00.000Z",
        }),
      ),
      at: new Date("2026-10-29T10:00:00Z"),
    },
  };

  it("reports without writing, keeps every variant and is idempotent", async () => {
    const fake = fakeStore(objects);
    fake.archive.set(archiveKey(b2), b2);
    const options = {
      prefix: "metadata/",
      since: new Date("2026-10-30T00:00:00Z"),
    };
    const dry = await recoverFirehose(fake.store, scope, {
      ...options,
      apply: false,
    });
    expect(dry.isOk() && dry.value).toMatchObject({
      objects: 3,
      unreadable: 1,
      records: 9,
      invalid: 1,
      setup: 1,
      foreign: 2,
      notifications: 4,
      alreadyArchived: 1,
      missing: 3,
      written: 0,
      failed: 0,
      divergent: [
        {
          messageId: "ses-c",
          variants: 2,
          recipients: ["alice@example.test", "bob@example.test"],
          recipientsDiffer: true,
          mergeable: true,
        },
      ],
    });
    expect(fake.archive.size).toBe(1);
    const applied = await recoverFirehose(fake.store, scope, {
      ...options,
      apply: true,
    });
    expect(applied.isOk() && applied.value.written).toBe(3);
    // Byte-for-byte copies under the name the worker would have used.
    expect(fake.archive.get(archiveKey(b1))).toBe(b1);
    expect(fake.archive.get(archiveKey(c2))).toBe(c2);
    const again = await recoverFirehose(fake.store, scope, {
      ...options,
      apply: true,
    });
    expect(again.isOk() && again.value).toMatchObject({
      alreadyArchived: 4,
      missing: 0,
      written: 0,
    });
  });

  it("selects records by their receipt time, not their object's", async () => {
    const fake = fakeStore(objects);
    // A record received before `until` can sit in a later object.
    const report = await recoverFirehose(fake.store, scope, {
      prefix: "metadata/",
      until: new Date("2026-10-29T23:59:59Z"),
      apply: false,
    });
    expect(report.isOk() && report.value).toMatchObject({
      objects: 4,
      notifications: 1,
      outsideWindow: 5,
      setup: 1,
      missing: 1,
    });
  });

  it("reports variants that disagree beyond their envelope as not mergeable", async () => {
    const fake = fakeStore({
      "metadata/x.gz": {
        bytes: firehose(
          body(["alice@example.test"], "ses-d"),
          body(["bob@example.test"], "ses-d", { status: "FAIL" }),
        ),
        at: new Date("2026-10-30T10:00:00Z"),
      },
    });
    const report = await recoverFirehose(fake.store, scope, {
      prefix: "metadata/",
      apply: false,
    });
    expect(report.isOk() && report.value.divergent).toMatchObject([
      { messageId: "ses-d", recipientsDiffer: true, mergeable: false },
    ]);
  });

  it("refuses to read the message buffer as Firehose output", async () => {
    const fake = fakeStore({});
    const report = await recoverFirehose(
      fake.store,
      { ...scope, bufferPrefix: "messages/" },
      { prefix: "messages/2026/", apply: false },
    );
    expect(report.isErr() && report.error.message).toBe(
      "Prefix is inside the message buffer",
    );
    // Nor one overlapping an object prefix outside an empty buffer prefix.
    const nested = await recoverFirehose(
      fake.store,
      { ...scope, bufferPrefix: "", objectPrefixes: ["messages/esuno/"] },
      { prefix: "messages/", apply: false },
    );
    expect(nested.isErr()).toBe(true);
    // Nor a parent of it, which would list every buffered message.
    const parent = await recoverFirehose(
      fake.store,
      { ...scope, bufferPrefix: "messages/" },
      { prefix: "m", apply: false },
    );
    expect(parent.isErr()).toBe(true);
  });
});

describe("recovery of buffered MIME objects", () => {
  it("skips an imported message whose variants add no recipient", async () => {
    const fake = fakeStore({});
    const archived = new Map([
      ["notifications/a.json", body(["alice@example.test"], "ses-v")],
      ["notifications/b.json", body(["hidden@example.test"], "ses-v")],
    ]);
    const storage: Storage = {
      archive: () => Promise.resolve(ok(undefined)),
      archives: () => Promise.resolve(ok([...archived.keys()])),
      readArchive: (key) => Promise.resolve(ok(archived.get(key) ?? "")),
      bufferKeys: () => Promise.resolve(ok([])),
      readBuffer: () => Promise.resolve(err({ message: "unused" })),
      deleteBuffer: () => Promise.resolve(ok(undefined)),
    };
    const memory = synthetic();
    memory.messageStates.set("ses-v", "imported");
    fake.versions.set("ses-v", "v1");
    const report = (recorded: string[]) =>
      recoverObjects(
        fake.store,
        storage,
        {
          ...memory.ledger,
          recordedAddresses: () => Promise.resolve(ok(recorded)),
        },
        scope,
        { apply: false },
      );
    const all = await report(["alice@example.test", "HIDDEN@example.test"]);
    expect(all.isOk() && all.value).toMatchObject({
      pending: 0,
      restorable: 0,
    });
    const partial = await report(["alice@example.test"]);
    expect(partial.isOk() && partial.value).toMatchObject({
      pending: 1,
      restorable: 1,
    });
  });

  it("restores only missing objects of unfinished messages that have a version", async () => {
    const fake = fakeStore({});
    const archived = new Map([
      ["notifications/a.json", body(["alice@example.test"], "ses-done")],
      ["notifications/b.json", body(["alice@example.test"], "ses-present")],
      ["notifications/c.json", body(["alice@example.test"], "ses-restore")],
      ["notifications/d.json", body(["alice@example.test"], "ses-lost")],
      [
        "notifications/e.json",
        body(["alice@example.test"], "ses-far", { bucket: "far" }),
      ],
      ["notifications/f.json", "corrupt"],
    ]);
    const storage: Storage = {
      archive: () => Promise.resolve(ok(undefined)),
      archives: () => Promise.resolve(ok([...archived.keys()])),
      readArchive: (key) => Promise.resolve(ok(archived.get(key) ?? "")),
      bufferKeys: () => Promise.resolve(ok([])),
      readBuffer: () => Promise.resolve(err({ message: "unused" })),
      deleteBuffer: () => Promise.resolve(ok(undefined)),
    };
    const memory = synthetic();
    memory.messageStates.set("ses-done", "imported");
    const ledger = memory.ledger;
    fake.buffer.add("ses-present");
    fake.versions.set("ses-restore", "v1");
    const dry = await recoverObjects(fake.store, storage, ledger, scope, {
      apply: false,
    });
    expect(dry.isOk() && dry.value).toEqual({
      apply: false,
      pending: 3,
      present: 1,
      restorable: 1,
      restored: 0,
      unrecoverable: [{ messageId: "ses-lost", objectKey: "ses-lost" }],
      divergent: [],
      foreign: 1,
      failed: 1,
    });
    expect(fake.buffer.has("ses-restore")).toBe(false);
    const applied = await recoverObjects(fake.store, storage, ledger, scope, {
      apply: true,
    });
    expect(applied.isOk() && applied.value.restored).toBe(1);
    expect(fake.buffer.has("ses-restore")).toBe(true);
    const again = await recoverObjects(fake.store, storage, ledger, scope, {
      apply: true,
    });
    expect(again.isOk() && again.value).toMatchObject({
      present: 2,
      restored: 0,
    });
  });
});
