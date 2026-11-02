import { describe, expect, it, vi } from "vitest";
import type * as Crypto from "node:crypto";
import { AliasPrefix, AliasWebsite, LocalPart } from "@opensuite/contracts";
import { generateAliasLocalPart } from "../src/services/aliases.ts";

const randomSource = vi.hoisted((): { bytes: Buffer | undefined } => ({
  bytes: undefined,
}));
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof Crypto>();
  return {
    ...crypto,
    randomBytes: (size: number) =>
      randomSource.bytes ?? crypto.randomBytes(size),
  };
});

describe("alias generation", () => {
  it("generates random, valid, normalized local parts with an optional prefix", () => {
    const values = new Set(
      Array.from({ length: 1000 }, () => generateAliasLocalPart("Shop")),
    );
    expect(values.size).toBe(1000);
    expect(
      [...values].every((value) => /^shop-[a-f0-9]{24}$/.test(value)),
    ).toBe(true);
  });
  it("makes readable random addresses with an optional website label", () => {
    const values = new Set(
      Array.from({ length: 1000 }, () =>
        generateAliasLocalPart(undefined, "www.Example.com"),
      ),
    );
    expect(values.size).toBe(1000);
    for (const value of values) {
      expect(value).toMatch(
        /^example-[a-z]+-[a-z]+-(?:[a-z0-9]{6}-){2}[a-z0-9]{6}$/,
      );
      expect(value.length).toBeLessThanOrEqual(64);
    }
    expect(generateAliasLocalPart()).toMatch(
      /^[a-z]+-[a-z]+-(?:[a-z0-9]{6}-){2}[a-z0-9]{6}$/,
    );
    expect(generateAliasLocalPart(undefined, "bad@host")).toMatch(
      /^[a-z]+-[a-z]+-(?:[a-z0-9]{6}-){2}[a-z0-9]{6}$/,
    );
    expect(generateAliasLocalPart(undefined, `${"a".repeat(63)}.test`)).toMatch(
      /^a{12}-/,
    );
    expect(generateAliasLocalPart("a".repeat(39)).length).toBe(64);
  });
  it("preserves the full random input in readable addresses", () => {
    try {
      const words = new Set<string>();
      for (let byte = 0; byte < 256; byte++) {
        randomSource.bytes = Buffer.alloc(12);
        randomSource.bytes[0] = byte;
        words.add(generateAliasLocalPart());
      }
      expect(words.size).toBe(256);
      const suffixes = new Set<string>();
      for (let bit = 0; bit < 88; bit++) {
        randomSource.bytes = Buffer.alloc(12);
        randomSource.bytes[1 + Math.floor(bit / 8)] = 1 << (bit % 8);
        suffixes.add(generateAliasLocalPart());
      }
      expect(suffixes.size).toBe(88);
      randomSource.bytes = Buffer.alloc(12, 0xff);
      const value = generateAliasLocalPart(undefined, `${"a".repeat(63)}.test`);
      expect(value).toMatch(/^a{12}-/);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
      expect(LocalPart.safeParse(value).success).toBe(true);
      expect(
        value.endsWith("-" + (2n ** 88n - 1n).toString(36).slice(-6)),
      ).toBe(true);
    } finally {
      randomSource.bytes = undefined;
    }
  });
  it("rejects invalid prefixes and websites", () => {
    for (const value of ["", "..", "bad@host", "a/b", "a".repeat(40)])
      expect(AliasPrefix.safeParse(value).success).toBe(false);
    for (const value of ["https://example.com", "a/b", "bad..test"])
      expect(AliasWebsite.safeParse(value).success).toBe(false);
  });
});
