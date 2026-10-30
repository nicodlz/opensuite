import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadinessService } from "@opensuite/core";
import { describe, expect, it } from "vitest";
import { upProbe, downProbe } from "../../../test-support/probes.ts";
import { createSetupStatus } from "../src/routes/setup-status.ts";

const now = new Date("2026-10-30T12:00:00Z");
const readiness = createReadinessService({
  probes: [upProbe("database"), downProbe("mail-server", "down")],
  timeoutMs: 500,
  now: () => now,
  monotonicMs: () => performance.now(),
});
const options = {
  readiness,
  mailDomain: "example.test",
  backupMaxAgeSeconds: 93600,
  now: () => now.getTime(),
};
const driveReport = {
  status: "not_ready",
  checkedAt: now.toISOString(),
  dependencies: [
    { name: "database", status: "up", durationMs: 1 },
    { name: "object-storage", status: "down", durationMs: 1 },
  ],
};
const fetcher: typeof fetch = (input) =>
  Promise.resolve(
    (typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    ).startsWith("http://drive:")
      ? Response.json(driveReport, { status: 503 })
      : new Response(null, { status: 503 }),
  );

describe("setup readiness", () => {
  it("preserves degraded Drive details and does not invent missing signals", async () => {
    const result = await createSetupStatus({ ...options, fetcher })();
    expect(result).toMatchObject({
      database: "ready",
      stalwart: "attention",
      drive: "attention",
      objectStorage: "attention",
      relay: "unknown",
      backup: "unknown",
      backupAgeSeconds: null,
    });
  });
  it("reports fresh, stale, future and missing backup markers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setup-marker-"));
    const marker = join(dir, "last-success");
    try {
      await writeFile(marker, "");
      const check = createSetupStatus({
        ...options,
        fetcher,
        backupMarker: marker,
      });
      await utimes(
        marker,
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() - 3600000),
      );
      expect(await check()).toMatchObject({
        backup: "ready",
        backupAgeSeconds: 3600,
      });
      await utimes(
        marker,
        new Date(now.getTime() - 100000000),
        new Date(now.getTime() - 100000000),
      );
      expect((await check()).backup).toBe("attention");
      await utimes(
        marker,
        new Date(now.getTime() + 1000),
        new Date(now.getTime() + 1000),
      );
      expect(await check()).toMatchObject({
        backup: "attention",
        backupAgeSeconds: null,
      });
      await rm(marker);
      expect((await check()).backup).toBe("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
