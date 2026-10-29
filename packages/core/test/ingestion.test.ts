import { err } from "neverthrow";
import { describe, expect, it } from "vitest";
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
  it("quarantines failures and preserves buffer for unknown recipients", async () => {
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
    expect(memory.buffers.has("ses-1")).toBe(true);
    expect([...memory.records.values()].map((r) => r.state)).toEqual([
      "quarantined",
      "rejected",
    ]);
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
  expect((await service.process(body)).isOk()).toBe(true);
  expect((await service.process(body)).isOk()).toBe(true);
  expect(attempts).toBe(1);
  expect([...memory.records.values()][0]?.state).toBe("uncertain");
  expect(memory.buffers.has("ses-1")).toBe(true);
});
