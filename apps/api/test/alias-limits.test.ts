import { describe, expect, it } from "vitest";
import { createAliasLimiter, networkBucket } from "../src/auth/alias-limits.ts";

describe("alias limits", () => {
  it("groups IPv6 addresses by /64 and normalizes mapped IPv4", () => {
    expect(networkBucket("2001:db8:1:2::1")).toBe(
      networkBucket("2001:0db8:0001:0002:abcd::2"),
    );
    expect(networkBucket("2001:db8:1:3::1")).not.toBe(
      networkBucket("2001:db8:1:2::1"),
    );
    expect(networkBucket("::ffff:192.0.2.1")).toBe("192.0.2.1");
  });
  it("evicts old anonymous buckets without blocking authenticated users", () => {
    let now = 0;
    const limits = createAliasLimiter(() => now, 8);
    expect(limits.user("victim")).toBe(true);
    for (let i = 0; i < 10_100; i++) limits.ip(`2001:db8:${i.toString(16)}::1`);
    expect(limits.user("victim")).toBe(true);
    expect(limits.key("legitimate")).toBe(true);
    for (let i = 0; i < 58; i++)
      expect(limits.ip("2001:db8:ffff:1::1")).toBe(true);
    expect(limits.ip("2001:db8:ffff:1::2")).toBe(true);
    expect(limits.ip("2001:db8:ffff:1::3")).toBe(true);
    expect(limits.ip("2001:db8:ffff:1::4")).toBe(false);
    now = 60_001;
    expect(limits.ip("2001:db8:ffff:1::4")).toBe(true);
  });
  it("does not evict a live user's limit when other buckets fill", () => {
    let now = 0;
    const limits = createAliasLimiter(() => now, 2);
    for (let i = 0; i < 20; i++) expect(limits.user("victim")).toBe(true);
    expect(limits.user("attacker")).toBe(true);
    for (let i = 0; i < 100; i++) limits.user(`other-${i}`);
    expect(limits.user("victim")).toBe(false);
    now = 60_001;
    expect(limits.user("victim")).toBe(true);
  });
  it("limits alias lifecycle changes per user", () => {
    const limits = createAliasLimiter();
    for (let i = 0; i < 60; i++) expect(limits.mutate("user")).toBe(true);
    expect(limits.mutate("user")).toBe(false);
    expect(limits.mutate("another")).toBe(true);
  });
});
