import { describe, expect, it } from "vitest";
import { AddressLocalPart } from "../src/addresses.ts";

describe("mailbox address names", () => {
  it("normalizes the alias prefix syntax and rejects unsafe names", () => {
    expect(AddressLocalPart.parse("  HELLO.World  ")).toBe("hello.world");
    for (const name of [
      ".bad",
      "bad..name",
      "bad_name",
      "bad+tag",
      "x".repeat(40),
    ])
      expect(AddressLocalPart.safeParse(name).success).toBe(false);
  });
});
