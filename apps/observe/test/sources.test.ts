import { describe, expect, it } from "vitest";
import { captureAge } from "../src/sources.ts";

describe("ingest capture time", () => {
  it("uses the recorded time and rejects malformed or impossible dates", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    expect(captureAge("2026-11-02T11:00:00Z\n", now)).toBe(3600);
    expect(captureAge("2026-11-02T13:00:00Z", now)).toBe(-3600);
    for (const invalid of [
      "",
      "2026-02-30T12:00:00Z",
      "not a date",
      "2026-11-02T11:00:00+00:00",
    ])
      expect(() => captureAge(invalid, now)).toThrow("Invalid capture time");
  });
});
