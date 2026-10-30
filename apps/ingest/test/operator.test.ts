import { describe, expect, it } from "vitest";
import { recoveryIncomplete } from "../src/operator.ts";

describe("recovery exit status", () => {
  it("fails while anything is left for an operator", () => {
    const clean = {
      failed: 0,
      unreadable: 0,
      unrecoverable: [],
      divergent: [],
    };
    expect(recoveryIncomplete(clean)).toBe(false);
    expect(recoveryIncomplete({ ...clean, failed: 1 })).toBe(true);
    expect(recoveryIncomplete({ ...clean, unreadable: 2 })).toBe(true);
    expect(
      recoveryIncomplete({ ...clean, unrecoverable: [{ messageId: "m" }] }),
    ).toBe(true);
    // Object recovery lists divergent message IDs; Firehose recovery lists
    // variant groups, only unmergeable ones being left undone.
    expect(recoveryIncomplete({ ...clean, divergent: ["m"] })).toBe(true);
    expect(
      recoveryIncomplete({ ...clean, divergent: [{ mergeable: true }] }),
    ).toBe(false);
    expect(
      recoveryIncomplete({ ...clean, divergent: [{ mergeable: false }] }),
    ).toBe(true);
    // Other commands' output is not a recovery report.
    expect(recoveryIncomplete({ rows: [] })).toBe(false);
  });
});
