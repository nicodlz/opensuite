import { describe, expect, it } from "vitest";
import {
  parseNotification,
  verdictPolicy,
} from "../src/domain/notification.ts";
import { notification } from "./fixtures.ts";

type Status = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
const policy = (verdicts: {
  spam?: Status;
  virus?: Status;
  spf?: Status;
  dkim?: Status;
  dmarc?: Status;
  dmarcPolicy?: "none" | "quarantine" | "reject";
}) => {
  const base = notification(["alice@example.test"]);
  const receipt = {
    ...base.receipt,
    spamVerdict: { status: verdicts.spam ?? "PASS" },
    virusVerdict: { status: verdicts.virus ?? "PASS" },
    spfVerdict: { status: verdicts.spf ?? "PASS" },
    dkimVerdict: { status: verdicts.dkim ?? "PASS" },
    dmarcVerdict: { status: verdicts.dmarc ?? "PASS" },
    ...(verdicts.dmarcPolicy === undefined
      ? {}
      : { dmarcPolicy: verdicts.dmarcPolicy }),
  };
  const parsed = parseNotification(JSON.stringify({ ...base, receipt }));
  if (parsed.isErr()) throw new Error(parsed.error);
  return verdictPolicy(parsed.value);
};

describe("inbound verdict policy", () => {
  it("delivers mail whose authentication is only unproven, as SES reports real Gmail mail", () => {
    // Verdicts of the two real messages received on 2026-10-30.
    expect(policy({ spf: "GRAY", dkim: "GRAY", dmarc: "GRAY" })).toBe(
      "deliver",
    );
    expect(policy({})).toBe("deliver");
    expect(
      policy({
        spf: "PROCESSING_FAILED",
        dkim: "PROCESSING_FAILED",
        dmarc: "PROCESSING_FAILED",
      }),
    ).toBe("deliver");
  });

  it("quarantines any content scan that does not pass", () => {
    for (const status of ["FAIL", "GRAY", "PROCESSING_FAILED"] as const) {
      expect(policy({ spam: status })).toBe("quarantine");
      expect(policy({ virus: status })).toBe("quarantine");
      // Authentication never makes up for the content scans.
      expect(policy({ spam: status, dmarc: "PASS" })).toBe("quarantine");
    }
  });

  it("quarantines a DMARC failure whatever the requested policy", () => {
    expect(policy({ dmarc: "FAIL" })).toBe("quarantine");
    for (const requested of ["none", "quarantine", "reject"] as const)
      expect(policy({ dmarc: "FAIL", dmarcPolicy: requested })).toBe(
        "quarantine",
      );
  });

  it("quarantines an SPF or DKIM failure unless DMARC passed", () => {
    for (const dmarc of ["GRAY", "PROCESSING_FAILED"] as const) {
      expect(policy({ spf: "FAIL", dmarc })).toBe("quarantine");
      expect(policy({ dkim: "FAIL", dmarc })).toBe("quarantine");
      expect(policy({ spf: "FAIL", dkim: "GRAY", dmarc })).toBe("quarantine");
    }
    // Forwarding breaks SPF, a list footer breaks DKIM; DMARC still aligned.
    expect(policy({ spf: "FAIL", dmarc: "PASS" })).toBe("deliver");
    expect(policy({ dkim: "FAIL", dmarc: "PASS" })).toBe("deliver");
  });
});
