import { describe, expect, it } from "vitest";
import {
  downProbe,
  hangingProbe,
  throwingProbe,
  upProbe,
} from "../../../test-support/probes.ts";
import {
  createReadinessService,
  type DependencyProbe,
} from "../src/services/readiness.ts";

const fixedNow = new Date("2026-10-29T12:00:00.000Z");

const service = (probes: DependencyProbe[], timeoutMs = 1000) =>
  createReadinessService({
    probes,
    timeoutMs,
    now: () => fixedNow,
    monotonicMs: () => performance.now(),
  });

describe("readiness service", () => {
  it("is ready when no dependency is declared", async () => {
    const { readiness, failures } = await service([]).check();
    expect(readiness).toEqual({
      status: "ready",
      checkedAt: fixedNow.toISOString(),
      dependencies: [],
    });
    expect(failures).toEqual([]);
  });

  it("is not ready when any declared dependency is down", async () => {
    const { readiness, failures } = await service([
      upProbe("database"),
      downProbe("mail-server", "connection refused"),
    ]).check();
    expect(readiness.status).toBe("not_ready");
    expect(
      readiness.dependencies.map(({ name, status }) => ({ name, status })),
    ).toEqual([
      { name: "database", status: "up" },
      { name: "mail-server", status: "down" },
    ]);
    expect(failures).toEqual([
      {
        name: "mail-server",
        failure: { kind: "unavailable", message: "connection refused" },
      },
    ]);
  });

  it("reports a probe that does not answer in time as a timeout", async () => {
    const { readiness, failures } = await service(
      [hangingProbe("database")],
      50,
    ).check();
    expect(readiness.status).toBe("not_ready");
    expect(failures[0]?.failure.kind).toBe("timeout");
  });

  it("reports a probe that throws as down instead of failing the check", async () => {
    const { readiness, failures } = await service([
      throwingProbe("database"),
    ]).check();
    expect(readiness.dependencies[0]?.status).toBe("down");
    expect(failures[0]?.failure).toEqual({
      kind: "unavailable",
      message: "driver crashed",
    });
  });

  it("refuses a probe name the readiness contract cannot carry", () => {
    expect(() => service([upProbe("Mail_Server")])).toThrow(
      "invalid readiness probe name: Mail_Server",
    );
  });

  it("refuses two probes with the same name", () => {
    expect(() => service([upProbe("database"), upProbe("database")])).toThrow(
      "duplicate readiness probe: database",
    );
  });
});
