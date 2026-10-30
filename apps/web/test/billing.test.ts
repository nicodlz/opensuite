import { describe, expect, it } from "vitest";
import { bytes, price, statusText, usageState } from "../src/billing/model.ts";

describe("billing presentation", () => {
  it("formats prices and storage", () => {
    expect(price(349, "month")).toBe("€3.49/month");
    expect(price(3588, "year")).toBe("€2.99/month, billed €35.88 per year");
    expect(bytes(1_500_000_000)).toBe("1.5 GB");
  });
  it("maps measured usage at each boundary", () => {
    const storage = {
      quotaBytes: 100,
      usedBytes: 79,
      driveBytes: 40,
      mailBytes: 39,
      measured: true,
    };
    expect(usageState(storage)).toBe("normal");
    expect(usageState({ ...storage, usedBytes: 80 })).toBe("warning");
    expect(usageState({ ...storage, usedBytes: 95 })).toBe("critical");
    expect(usageState({ ...storage, usedBytes: 100 })).toBe("over");
    expect(usageState({ ...storage, usedBytes: 100, measured: false })).toBe(
      "normal",
    );
    expect(usageState({ ...storage, quotaBytes: null, usedBytes: 100 })).toBe(
      "normal",
    );
  });
  it("explains payment and read-only states", () => {
    expect(statusText("past_due")).toContain("update your payment method");
    for (const value of ["unpaid", "canceled", "expired"])
      expect(statusText(value)).toContain("read-only");
    expect(statusText("active")).toBe("Active");
  });
});
