import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import {
  parseNotification,
  resolveRecipients,
  verdictPolicy,
} from "../src/domain/notification.ts";
import { IngestService } from "../src/ingest/service.ts";
import { synthetic } from "../src/synthetic/memory.ts";
import { notification } from "./fixtures.ts";

const routes = [
  { address: "alice@example.test", destination: "alice" },
  { address: "alias@other.test", destination: "alice" },
  { address: "hidden@example.test", destination: "bob" },
];
const create = () => {
  const memory = synthetic();
  const service = new IngestService({
    storage: memory.storage,
    ledger: memory.ledger,
    delivery: memory.delivery,
    events: memory.sink,
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  return { memory, service };
};
describe("SES ingestion", () => {
  it("validates documented receipt and resolves Bcc, aliases and unknown addresses", () => {
    const parsed = parseNotification(JSON.stringify(notification()));
    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) throw new Error(parsed.error);
    expect(verdictPolicy(parsed.value)).toBe("deliver");
    expect(
      resolveRecipients(
        [
          "Alice@example.test",
          "alias@other.test",
          "hidden@example.test",
          "missing@example.test",
        ],
        routes,
      ),
    ).toEqual([
      {
        destination: "alice",
        addresses: ["alice@example.test", "alias@other.test"],
        known: true,
      },
      { destination: "bob", addresses: ["hidden@example.test"], known: true },
      {
        destination: "missing@example.test",
        addresses: ["missing@example.test"],
        known: false,
      },
    ]);
    expect(parseNotification("{}").isErr()).toBe(true);
  });
  it("resolves newly added addresses without restarting and retains mail if routing fails", async () => {
    const memory = synthetic();
    memory.buffers.set("ses-1", new Uint8Array([1]));
    let available = false;
    const service = new IngestService({
      storage: memory.storage,
      ledger: memory.ledger,
      delivery: memory.delivery,
      events: memory.sink,
      routes: [],
      bucket: "inbound",
      bufferPrefix: "",
      topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
      maxAttempts: 3,
      resolveRoutes: () =>
        Promise.resolve(
          available
            ? ok([{ address: "sales@example.test", destination: "account" }])
            : err({ message: "database unavailable" }),
        ),
    });
    const body = JSON.stringify(notification(["Sales@Example.Test"]));
    expect((await service.process(body)).isErr()).toBe(true);
    expect(memory.buffers.has("ses-1")).toBe(true);
    available = true;
    expect((await service.process(body)).isOk()).toBe(true);
    expect(memory.imports.map((item) => item.destination)).toEqual(["account"]);
  });
  it("archives before delivery, imports unchanged once per mailbox and deduplicates redelivery", async () => {
    const { memory, service } = create();
    const bytes = new Uint8Array([0, 13, 10, 255]);
    memory.buffers.set("ses-1", bytes);
    const body = JSON.stringify(
      notification([
        "alice@example.test",
        "alias@other.test",
        "hidden@example.test",
      ]),
    );
    expect((await service.process(body)).isOk()).toBe(true);
    expect((await service.process(body)).isOk()).toBe(true);
    expect(memory.imports).toHaveLength(2);
    expect(memory.imports[0]?.bytes).toEqual(bytes);
    expect(memory.archives.size).toBe(1);
    expect(memory.buffers.size).toBe(0);
  });
  it("quarantines failures and holds unknown recipients with their message", async () => {
    const { memory, service } = create();
    memory.buffers.set("ses-1", new Uint8Array([1]));
    expect(
      (
        await service.process(
          JSON.stringify(
            notification(
              ["alice@example.test", "unknown@example.test"],
              "FAIL",
            ),
          ),
        )
      ).isOk(),
    ).toBe(true);
    expect(memory.imports[0]?.quarantine).toBe(true);
    // The unknown recipient keeps the message: nothing is deleted.
    expect(memory.buffers.has("ses-1")).toBe(true);
    expect([...memory.records.values()].map((r) => r.state)).toEqual([
      "quarantined",
      "held",
    ]);
    expect(memory.messageStates.get("ses-1")).toBe("held");
    expect(memory.events).toContain("ingest_held");
    expect(memory.events).not.toContain("ingest_rejected");
  });
  it("replays archived notifications and reports orphan objects", async () => {
    const { memory, service } = create();
    memory.archives.set("saved", JSON.stringify(notification()));
    memory.buffers.set("ses-1", new Uint8Array([1]));
    memory.buffers.set("orphan", new Uint8Array([2]));
    expect((await service.reconcile(1)).isOk()).toBe(true);
    expect(memory.imports).toHaveLength(2);
    expect(memory.events).toContain("ingest_buffer_without_notification");
    expect(memory.events).toContain("ingest_notification_old");
  });
});

it("retains an ambiguous import without repeating it or deleting its source", async () => {
  const memory = synthetic();
  memory.buffers.set("ses-1", new Uint8Array([1]));
  let attempts = 0;
  const service = new IngestService({
    storage: memory.storage,
    ledger: memory.ledger,
    delivery: {
      reconcile: (...args) => memory.delivery.reconcile(...args),
      import() {
        attempts++;
        return Promise.resolve(
          err({ message: "response lost", ambiguous: true }),
        );
      },
    },
    events: memory.sink,
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  const body = JSON.stringify(notification(["alice@example.test"]));
  expect((await service.process(body)).isErr()).toBe(true);
  expect((await service.process(body)).isErr()).toBe(true);
  expect((await service.reconcile(1)).isErr()).toBe(true);
  expect(attempts).toBe(1);
  expect([...memory.records.values()][0]?.state).toBe("uncertain");
  expect(memory.buffers.has("ses-1")).toBe(true);
});

it("keeps uncertain queue items unacknowledged, then reconciles a confirmed import", async () => {
  const { memory } = create();
  memory.buffers.set("ses-1", new Uint8Array([1]));
  let imports = 0;
  let confirmed = false;
  const service = new IngestService({
    storage: memory.storage,
    ledger: memory.ledger,
    delivery: {
      import() {
        imports++;
        return Promise.resolve(
          err({ message: "lost response", ambiguous: true }),
        );
      },
      reconcile() {
        return Promise.resolve(
          confirmed
            ? ok(["confirmed"])
            : err({ message: "not yet visible", ambiguous: true }),
        );
      },
    },
    events: memory.sink,
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  const deleted: string[] = [];
  const delays: number[] = [];
  const queue = {
    receive: () => Promise.resolve(ok([])),
    delete: (receipt: string) => {
      deleted.push(receipt);
      return Promise.resolve(ok(undefined));
    },
    defer: (_receipt: string, seconds: number) => {
      delays.push(seconds);
      return Promise.resolve(ok(undefined));
    },
  };
  const item = {
    body: JSON.stringify(notification(["alice@example.test"])),
    receipt: "r",
    attempts: 1,
  };
  expect((await service.handle(queue, item)).isErr()).toBe(true);
  expect((await service.handle(queue, item)).isErr()).toBe(true);
  expect(deleted).toEqual([]);
  expect(delays).toEqual([60, 60]);
  expect((await service.reconcile(1)).isErr()).toBe(true);
  confirmed = true;
  expect((await service.reconcile(1)).isOk()).toBe(true);
  expect((await service.handle(queue, item)).isOk()).toBe(true);
  expect(deleted).toEqual(["r"]);
  expect(imports).toBe(1);
  expect(memory.buffers.size).toBe(0);
});

it("reads once and serializes recipient imports without charging infrastructure failures", async () => {
  const { memory } = create();
  memory.buffers.set("ses-1", new Uint8Array([1]));
  let reads = 0;
  let active = 0;
  let peak = 0;
  let failed = false;
  const service = new IngestService({
    storage: {
      ...memory.storage,
      readBuffer(bucket, key) {
        reads++;
        return memory.storage.readBuffer(bucket, key);
      },
    },
    ledger: memory.ledger,
    delivery: {
      ...memory.delivery,
      async import() {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        if (!failed) {
          failed = true;
          return err({ message: "offline" });
        }
        return ok("id");
      },
    },
    events: memory.sink,
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 1,
  });
  const body = JSON.stringify(notification());
  expect((await service.process(body)).isErr()).toBe(true);
  expect(reads).toBe(1);
  expect(peak).toBe(1);
  expect([...memory.records.values()].map((r) => r.attempts)).toEqual([0, 0]);
  expect((await service.process(body)).isOk()).toBe(true);
});

it("replays archives when listing the buffer fails and reports the listing failure", async () => {
  const { memory } = create();
  memory.archives.set(
    "saved",
    JSON.stringify(notification(["alice@example.test"])),
  );
  memory.buffers.set("ses-1", new Uint8Array([1]));
  const service = new IngestService({
    storage: {
      ...memory.storage,
      bufferKeys: () => Promise.resolve(err({ message: "denied" })),
    },
    ledger: memory.ledger,
    delivery: memory.delivery,
    events: memory.sink,
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  expect((await service.reconcile(1)).isErr()).toBe(true);
  expect(memory.imports).toHaveLength(1);
  expect(memory.buffers.size).toBe(0);
});

it("renews the recipient lease and queue visibility during a long import", async () => {
  vi.useFakeTimers();
  try {
    const { memory } = create();
    memory.buffers.set("ses-1", new Uint8Array([1]));
    let finish: (() => void) | undefined;
    let renewals = 0;
    let extensions = 0;
    const service = new IngestService({
      storage: memory.storage,
      ledger: {
        ...memory.ledger,
        renew(key, owner) {
          renewals++;
          return memory.ledger.renew(key, owner);
        },
      },
      delivery: {
        ...memory.delivery,
        import() {
          return new Promise((resolve) => {
            finish = () => resolve(ok("id"));
          });
        },
      },
      events: memory.sink,
      routes,
      bucket: "inbound",
      bufferPrefix: "",
      topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
      maxAttempts: 3,
    });
    const queue = {
      receive: () => Promise.resolve(ok([])),
      delete: () => Promise.resolve(ok(undefined)),
      defer: (_receipt: string, seconds: number) => {
        if (seconds === 300) extensions++;
        return Promise.resolve(ok(undefined));
      },
    };
    const pending = service.handle(queue, {
      body: JSON.stringify(notification(["alice@example.test"])),
      receipt: "r",
      attempts: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewals).toBe(1);
    expect(extensions).toBe(1);
    if (finish === undefined) throw new Error("Import did not start");
    finish();
    expect((await pending).isOk()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("continues processing the original durable destination after routes change", async () => {
  const { memory, service } = create();
  const body = JSON.stringify(notification(["alice@example.test"]));
  expect((await service.process(body)).isErr()).toBe(true);
  memory.buffers.set("ses-1", new Uint8Array([1]));
  const changed = new IngestService({
    storage: memory.storage,
    ledger: memory.ledger,
    delivery: memory.delivery,
    events: memory.sink,
    routes: [{ address: "alice@example.test", destination: "different" }],
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  expect((await changed.process(body)).isOk()).toBe(true);
  expect(memory.imports.map((item) => item.destination)).toEqual(["alice"]);
});

it("retries a zero-match uncertainty only after the grace period and detects duplicates", async () => {
  vi.useFakeTimers();
  try {
    const { memory } = create();
    memory.buffers.set("ses-1", new Uint8Array([1]));
    let imports = 0;
    let matches: string[] = [];
    const service = new IngestService({
      storage: memory.storage,
      ledger: memory.ledger,
      events: memory.sink,
      delivery: {
        async import(_d, _b, _q, _t, _k, _u, start) {
          const result = await start();
          if (result.isErr()) return err(result.error);
          imports++;
          return err({ message: "response lost", ambiguous: true });
        },
        reconcile: () => Promise.resolve(ok(matches)),
      },
      routes,
      bucket: "inbound",
      bufferPrefix: "",
      topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
      maxAttempts: 3,
    });
    const body = JSON.stringify(notification(["alice@example.test"]));
    expect((await service.process(body)).isErr()).toBe(true);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect((await service.process(body)).isErr()).toBe(true);
    expect(imports).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await service.process(body)).isErr()).toBe(true);
    expect(imports).toBe(2);
    matches = ["one", "two"];
    expect((await service.process(body)).isOk()).toBe(true);
    expect(memory.events).toContain("ingest_duplicate");
    expect([...memory.records.values()][0]?.state).toBe("imported");
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry permanent rejections during replay", async () => {
  const { memory } = create();
  memory.buffers.set("ses-1", new Uint8Array([1]));
  let imports = 0;
  const service = new IngestService({
    storage: memory.storage,
    ledger: memory.ledger,
    events: memory.sink,
    delivery: {
      ...memory.delivery,
      import() {
        imports++;
        return Promise.resolve(
          err({ message: "invalidEmail", permanent: true }),
        );
      },
    },
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  const body = JSON.stringify(notification(["alice@example.test"]));
  expect((await service.process(body)).isErr()).toBe(true);
  await memory.ledger.resetFailures();
  expect((await service.reconcile(1)).isErr()).toBe(true);
  expect(imports).toBe(1);
  expect([...memory.records.values()][0]?.attempts).toBe(1);
});

it("skips completed archives and never rewrites archives during replay", async () => {
  const { memory } = create();
  memory.buffers.set("ses-1", new Uint8Array([1]));
  let writes = 0;
  let preparations = 0;
  const service = new IngestService({
    storage: {
      ...memory.storage,
      archive(key, body) {
        writes++;
        return memory.storage.archive(key, body);
      },
    },
    ledger: {
      ...memory.ledger,
      prepare(n, recipients) {
        preparations++;
        return memory.ledger.prepare(n, recipients);
      },
    },
    delivery: memory.delivery,
    events: memory.sink,
    routes,
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  const body = JSON.stringify(notification(["alice@example.test"]));
  expect((await service.process(body)).isOk()).toBe(true);
  writes = 0;
  preparations = 0;
  expect((await service.reconcile(1)).isOk()).toBe(true);
  expect(writes).toBe(0);
  expect(preparations).toBe(0);
});

// Held mail is routed only within the hold window, so these tests use the
// current time; the fixture date is older than the default 14 days.
const fresh = (recipients: string[], messageId = "ses-1") => {
  const body = notification(recipients, "PASS", messageId);
  const now = new Date().toISOString();
  return JSON.stringify({
    ...body,
    mail: { ...body.mail, timestamp: now },
    receipt: { ...body.receipt, timestamp: now },
  });
};
const routed = (extra: { address: string; destination: string }[]) => {
  const memory = synthetic();
  const known = [...routes];
  const service = new IngestService({
    storage: memory.storage,
    ledger: memory.ledger,
    delivery: memory.delivery,
    events: memory.sink,
    routes: [],
    resolveRoutes: () => Promise.resolve(ok([...known])),
    bucket: "inbound",
    bufferPrefix: "",
    topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
    maxAttempts: 3,
  });
  return { memory, service, provision: () => known.push(...extra) };
};

describe("held unknown recipients", () => {
  it("imports a held recipient once its address is provisioned, then deletes the object", async () => {
    const { memory, service, provision } = routed([
      { address: "late@example.test", destination: "carol" },
    ]);
    const bytes = new Uint8Array([7, 8, 9]);
    memory.buffers.set("ses-1", bytes);
    const body = fresh(["late@example.test"]);
    expect((await service.process(body)).isOk()).toBe(true);
    expect(memory.imports).toHaveLength(0);
    expect(memory.buffers.get("ses-1")).toEqual(bytes);
    // A replay before provisioning changes nothing.
    expect((await service.reconcile(86_400)).isOk()).toBe(true);
    expect(memory.imports).toHaveLength(0);
    provision();
    expect((await service.reconcile(86_400)).isOk()).toBe(true);
    expect(memory.imports.map((item) => item.destination)).toEqual(["carol"]);
    expect(memory.imports[0]?.bytes).toEqual(bytes);
    expect([...memory.records.values()].map((r) => r.state)).toEqual([
      "rerouted",
      "imported",
    ]);
    expect(memory.buffers.has("ses-1")).toBe(false);
    expect(memory.messageStates.get("ses-1")).toBe("imported");
    // Later replays never import it again.
    expect((await service.reconcile(86_400)).isOk()).toBe(true);
    expect(memory.imports).toHaveLength(1);
  });

  it("delivers Bcc and aliases once per mailbox and never twice when a held address joins one", async () => {
    const { memory, service, provision } = routed([
      { address: "late@example.test", destination: "alice" },
    ]);
    memory.buffers.set("ses-1", new Uint8Array([1]));
    // alice@ and alias@ reach alice; hidden@ is a Bcc to bob; late@ is unknown.
    const body = fresh([
      "alice@example.test",
      "alias@other.test",
      "hidden@example.test",
      "late@example.test",
    ]);
    expect((await service.process(body)).isOk()).toBe(true);
    expect(memory.imports.map((item) => item.destination).toSorted()).toEqual([
      "alice",
      "bob",
    ]);
    expect(memory.buffers.has("ses-1")).toBe(true);
    provision();
    expect((await service.reconcile(86_400)).isOk()).toBe(true);
    // late@ now routes to alice, who already has the message.
    expect(memory.imports).toHaveLength(2);
    expect(
      [...memory.records.values()].map((r) => [r.destination, r.state]),
    ).toEqual([
      ["alice", "imported"],
      ["bob", "imported"],
      ["late@example.test", "rerouted"],
    ]);
    expect(memory.buffers.has("ses-1")).toBe(false);
  });

  it("rejects held mail after the hold window and never routes it late", async () => {
    const { memory, service, provision } = routed([
      { address: "late@example.test", destination: "carol" },
    ]);
    memory.buffers.set("ses-1", new Uint8Array([1]));
    // The fixture is dated January 2026, beyond the 14-day window.
    const body = JSON.stringify(notification(["late@example.test"]));
    expect((await service.process(body)).isOk()).toBe(true);
    expect([...memory.records.values()].map((r) => r.state)).toEqual(["held"]);
    provision();
    expect((await service.reconcile(86_400)).isOk()).toBe(true);
    expect(memory.imports).toHaveLength(0);
    expect([...memory.records.values()].map((r) => r.state)).toEqual([
      "rejected",
    ]);
    expect(memory.events).toContain("ingest_held_expired");
    expect(memory.buffers.has("ses-1")).toBe(false);
    expect(memory.messageStates.get("ses-1")).toBe("imported");
  });

  it("keeps a completed message for replay when deleting its object fails", async () => {
    const memory = synthetic();
    let failures = 1;
    const seen: Record<string, string | number>[] = [];
    const service = new IngestService({
      storage: {
        ...memory.storage,
        deleteBuffer: (bucket, key) => {
          // Completion must not be recorded before the object is gone.
          expect(memory.messageStates.get("ses-1")).not.toBe("imported");
          return failures-- > 0
            ? Promise.resolve(
                err({ message: "Access denied to key", code: "AccessDenied" }),
              )
            : memory.storage.deleteBuffer(bucket, key);
        },
      },
      ledger: memory.ledger,
      delivery: memory.delivery,
      events: {
        emit(event, fields) {
          seen.push({ event, ...fields });
        },
      },
      routes,
      bucket: "inbound",
      bufferPrefix: "",
      topic: "arn:aws:sns:eu-north-1:123456789012:inbound",
      maxAttempts: 3,
    });
    memory.buffers.set("ses-1", new Uint8Array([1]));
    const body = JSON.stringify(notification(["alice@example.test"]));
    // process() archives the notification; replay finds it there.
    expect((await service.process(body)).isErr()).toBe(true);
    expect(memory.messageStates.get("ses-1")).toBe("failed");
    expect(memory.buffers.has("ses-1")).toBe(true);
    // The cause is logged without the object key.
    expect(seen).toContainEqual({
      event: "ingest_failure",
      stage: "buffer_delete",
      code: "AccessDenied",
    });
    expect((await service.reconcile(86_400)).isOk()).toBe(true);
    expect(memory.buffers.has("ses-1")).toBe(false);
    expect(memory.messageStates.get("ses-1")).toBe("imported");
    expect(memory.imports).toHaveLength(1);
  });
});
