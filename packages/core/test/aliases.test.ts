import { describe, expect, it } from "vitest";
import { AliasPrefix, AliasWebsite } from "@opensuite/contracts";
import { generateAliasLocalPart } from "../src/services/aliases.ts";

describe("alias generation", () => {
  it("generates random, valid, normalized local parts with an optional prefix", () => {
    const values = new Set(
      Array.from({ length: 1000 }, () => generateAliasLocalPart("Shop")),
    );
    expect(values.size).toBe(1000);
    expect(
      [...values].every((value) => /^shop-[a-f0-9]{24}$/.test(value)),
    ).toBe(true);
    expect(generateAliasLocalPart()).toMatch(/^[a-f0-9]{24}$/);
  });
  it("rejects invalid prefixes and websites", () => {
    for (const value of ["", "..", "bad@host", "a/b", "a".repeat(40)])
      expect(AliasPrefix.safeParse(value).success).toBe(false);
    for (const value of ["https://example.com", "a/b", "bad..test"])
      expect(AliasWebsite.safeParse(value).success).toBe(false);
  });
});
