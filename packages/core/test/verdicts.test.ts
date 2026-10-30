import { describe, expect, it } from "vitest";
import {
  parseNotification,
  quarantineReason,
  verdictPolicy,
} from "../src/domain/notification.ts";
import { notification } from "./fixtures.ts";

type Status = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
const parse = (verdicts: {
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
  return parsed.value;
};
const policy = (verdicts: Parameters<typeof parse>[0]) =>
  verdictPolicy(parse(verdicts));
const reason = (verdicts: Parameters<typeof parse>[0]) =>
  quarantineReason(parse(verdicts));

describe("inbound verdict policy", () => {
  it("delivers mail whose authentication is only unproven, as SES reports real Gmail mail", () => {
    // Verdicts of the two real messages received on 2026-10-30.
    expect(policy({ spf: "GRAY", dkim: "GRAY", dmarc: "GRAY" })).toBe(
      "deliver",
    );
    expect(policy({})).toBe("deliver");
    expect(
      policy({ spf: "PROCESSING_FAILED", dkim: "PROCESSING_FAILED" }),
    ).toBe("deliver");
    // DMARC passed: broken SPF and DKIM come from forwarding or lists.
    expect(policy({ spf: "FAIL", dkim: "FAIL", dmarc: "PASS" })).toBe(
      "deliver",
    );
  });

  it("quarantines unchecked DMARC unless SPF or DKIM passed", () => {
    // A spoof with SPF softfail and a malformed signature.
    expect(
      reason({
        spf: "GRAY",
        dkim: "PROCESSING_FAILED",
        dmarc: "PROCESSING_FAILED",
      }),
    ).toBe("dmarc_unchecked");
    expect(
      reason({
        spf: "PROCESSING_FAILED",
        dkim: "PROCESSING_FAILED",
        dmarc: "PROCESSING_FAILED",
      }),
    ).toBe("dmarc_unchecked");
    expect(
      policy({ spf: "PASS", dkim: "GRAY", dmarc: "PROCESSING_FAILED" }),
    ).toBe("deliver");
    expect(
      policy({ spf: "GRAY", dkim: "PASS", dmarc: "PROCESSING_FAILED" }),
    ).toBe("deliver");
  });

  it("names the first reason for quarantine", () => {
    expect(reason({ spf: "GRAY", dkim: "GRAY", dmarc: "GRAY" })).toBeNull();
    expect(reason({ spam: "GRAY", virus: "FAIL" })).toBe("spam");
    expect(reason({ virus: "PROCESSING_FAILED" })).toBe("virus");
    expect(reason({ dmarc: "FAIL", spf: "FAIL" })).toBe("dmarc_fail");
    expect(reason({ spf: "FAIL", dmarc: "GRAY" })).toBe("spf_fail");
    expect(reason({ dkim: "FAIL", dmarc: "GRAY" })).toBe("dkim_fail");
    expect(
      reason({ spf: "PROCESSING_FAILED", dkim: "FAIL", dmarc: "FAIL" }),
    ).toBe("dmarc_fail");
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
