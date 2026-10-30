import { describe, expect, it } from "vitest";
import { Config, inspect, type Sources } from "../src/checks.ts";

const config = Config.parse({
  OBSERVE_INGEST_ENABLED: "true",
  OBSERVE_QUEUE_URL: "https://queue.example/main",
  OBSERVE_DLQ_URL: "https://queue.example/dead",
});
const healthy: Sources = {
  ready: () => Promise.resolve(true),
  backupAge: () => Promise.resolve(100),
  diskPercent: () => Promise.resolve(50),
  certificateDays: () => Promise.resolve(60),
  queue: () =>
    Promise.resolve({
      visible: 0,
      inFlight: 0,
      delayed: 0,
      oldestSeconds: null,
      ageAvailable: true,
    }),
};
const run = (sources: Sources) =>
  inspect(config, sources, new Date("2026-01-01T00:00:00Z"));

describe("observations", () => {
  it("returns metrics and no alerts for healthy dependencies", async () => {
    const report = await run(healthy);
    expect(report.alerts).toEqual([]);
    expect(report.metrics).toMatchObject({
      api_readiness: 1,
      drive_readiness: 1,
      ingest_readiness: 1,
      queue_depth: 0,
      dlq_depth: 0,
    });
  });
  it("reports independent failures and thresholds without exception details", async () => {
    const report = await run({
      ...healthy,
      ready: (service) => Promise.resolve(service !== "drive"),
      backupAge: () => Promise.reject(new Error("secret file path")),
      diskPercent: () => Promise.resolve(90),
      certificateDays: () => Promise.resolve(2),
      queue: (url) =>
        Promise.resolve(
          url.endsWith("main")
            ? {
                visible: 2,
                inFlight: 1,
                delayed: 0,
                oldestSeconds: 4000,
                ageAvailable: true,
              }
            : {
                visible: 1,
                inFlight: 0,
                delayed: 0,
                oldestSeconds: 400,
                ageAvailable: true,
              },
        ),
    });
    expect(report.alerts.map((alert) => alert.code)).toEqual([
      "backup_age_seconds_unavailable",
      "certificate_days",
      "disk_used_percent",
      "dlq_age_seconds",
      "dlq_messages",
      "drive_readiness",
      "queue_age_seconds",
    ]);
    expect(JSON.stringify(report)).not.toContain("secret file path");
  });
  it("flags missing queue configuration and missing age measurements", async () => {
    const missing = await inspect(
      Config.parse({ OBSERVE_INGEST_ENABLED: "true" }),
      healthy,
      new Date(),
    );
    expect(missing.alerts.map((alert) => alert.code)).toEqual([
      "dlq_configuration",
      "queue_configuration",
    ]);
    const report = await run({
      ...healthy,
      queue: () =>
        Promise.resolve({
          visible: 1,
          inFlight: 0,
          delayed: 0,
          oldestSeconds: null,
          ageAvailable: true,
        }),
    });
    expect(report.alerts.map((alert) => alert.code)).toEqual([
      "dlq_age_unavailable",
      "dlq_messages",
      "queue_age_unavailable",
    ]);
  });
  it("reports CloudWatch failures even for an empty queue", async () => {
    const report = await run({
      ...healthy,
      queue: () =>
        Promise.resolve({
          visible: 0,
          inFlight: 0,
          delayed: 0,
          oldestSeconds: null,
          ageAvailable: false,
        }),
    });
    expect(report.alerts.map((alert) => alert.code)).toEqual([
      "dlq_age_unavailable",
      "queue_age_unavailable",
    ]);
  });
  it("ignores stale age samples for an empty queue", async () => {
    const report = await run({
      ...healthy,
      queue: () =>
        Promise.resolve({
          visible: 0,
          inFlight: 0,
          delayed: 0,
          oldestSeconds: 5000,
          ageAvailable: true,
        }),
    });
    expect(report.alerts).toEqual([]);
  });
});

it("retries failed webhook delivery and reports recovery only after delivery", async () => {
  const { createPublisher } = await import("../src/publisher.ts");
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let attempts = 0;
  const send: typeof fetch = (_url, options) => {
    calls.push(typeof options?.body === "string" ? options.body : "");
    attempts += 1;
    return Promise.resolve(
      new Response(null, { status: attempts === 1 ? 500 : 200 }),
    );
  };
  const publish = createPublisher(
    "https://example.test/hook-secret",
    1000,
    send,
    (entry) => logs.push(entry),
  );
  const broken = await run({
    ...healthy,
    diskPercent: () => Promise.resolve(90),
  });
  await publish(broken);
  await publish(broken);
  await publish(await run(healthy));
  expect(calls).toHaveLength(3);
  expect(JSON.parse(calls[2] ?? "{}")).toMatchObject({
    recovered: ["disk_used_percent"],
  });
  expect(JSON.stringify(logs)).not.toContain("hook-secret");
  expect(
    logs.some((entry) => entry["event"] === "webhook_delivery_failed"),
  ).toBe(true);
});
