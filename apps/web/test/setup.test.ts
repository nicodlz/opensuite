import { describe, expect, it } from "vitest";
import type { ManagedDomain, SetupStatus } from "@opensuite/contracts";
import { dkimStatus, stepStatuses } from "../src/setup/model.ts";

const status: SetupStatus = {
  database: "ready",
  stalwart: "ready",
  drive: "ready",
  objectStorage: "ready",
  relay: "ready",
  backup: "unknown",
  backupAgeSeconds: null,
  mailDomain: "example.test",
};
const domain: ManagedDomain = {
  id: "d",
  name: "example.test",
  status: "verified",
  checkedAt: "2026-01-01T00:00:00Z",
  addresses: [],
  records: [
    {
      type: "TXT",
      name: "s._domainkey.example.test",
      value: "key",
      status: "verified",
    },
    {
      type: "CNAME",
      name: "ses._domainkey.example.test",
      value: "key",
      status: "verified",
    },
  ],
};
describe("setup progress", () => {
  it("does not treat missing checks or untested delivery as complete", () => {
    expect(stepStatuses(status, domain, 0, false)).toEqual([
      "Unknown",
      "Complete",
      "Pending",
      "Pending",
      "Pending",
    ]);
    expect(
      stepStatuses({ ...status, backup: "ready" }, domain, 1, true),
    ).toEqual(["Complete", "Complete", "Complete", "Complete", "Complete"]);
    expect(
      stepStatuses(
        { ...status, database: "attention" },
        undefined,
        undefined,
        false,
      )[0],
    ).toBe("Attention");
  });
  it("requires checked Stalwart and SES DKIM records", () => {
    expect(dkimStatus({ ...domain, checkedAt: null })).toBe("Pending");
    expect(dkimStatus({ ...domain, records: domain.records.slice(0, 1) })).toBe(
      "Unknown",
    );
    expect(
      dkimStatus({
        ...domain,
        records: domain.records.map((record) => ({
          ...record,
          status: "failing",
        })),
      }),
    ).toBe("Attention");
    expect(dkimStatus(domain)).toBe("Complete");
  });
});
