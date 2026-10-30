import { describe, expect, it } from "vitest";
import { AddressLocalPart } from "../src/addresses.ts";
import { isReservedMailLocalPart } from "../../core/src/reserved-mail-local-parts.ts";

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
    for (const name of [
      "Postmaster",
      "abuse",
      "ADMIN",
      "no-reply",
      "mailer-daemon",
      "billing",
      "noc",
      "marketing",
      "usenet",
      "news",
      "uucp",
      "dmarc",
      "autoconfig",
      "autodiscover",
      "ssl-admin",
      "ssladmin",
      `os-${"a".repeat(32)}`,
    ])
      expect(isReservedMailLocalPart(name)).toBe(true);
    expect(isReservedMailLocalPart("member")).toBe(false);
  });
});

it("uses the same mailbox syntax for paid claims", async () => {
  const { ClaimLocalPart } = await import("../src/billing.ts");
  for (const name of ["person_name", "x".repeat(40)])
    expect(ClaimLocalPart.safeParse(name).success).toBe(false);
  for (const name of ["x", "a".repeat(39), "First.Last"])
    expect(ClaimLocalPart.parse(name)).toBe(AddressLocalPart.parse(name));
});
