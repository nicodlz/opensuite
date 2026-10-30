import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCname, resolveMx, resolveTxt } from "node:dns/promises";
import { nodeDomainDns } from "../src/adapters/domain-dns.ts";

vi.mock("node:dns/promises", () => ({
  resolveTxt: vi.fn<typeof resolveTxt>(),
  resolveMx: vi.fn<typeof resolveMx>(),
  resolveCname: vi.fn<typeof resolveCname>(),
}));
beforeEach(() => vi.resetAllMocks());
describe("DNS verification", () => {
  it("joins TXT segments and rejects competing SPF policies", async () => {
    vi.mocked(resolveTxt)
      .mockResolvedValueOnce([["v=spf1 include:", "amazonses.com ~all"]])
      .mockResolvedValueOnce([
        ["v=spf1 include:amazonses.com ~all"],
        ["v=spf1 -all"],
      ]);
    const record = {
      type: "TXT",
      name: "example.test",
      value: "v=spf1 include:amazonses.com ~all",
      status: "pending",
    } satisfies Parameters<typeof nodeDomainDns.lookup>[0];
    const first = await nodeDomainDns.lookup(record);
    const second = await nodeDomainDns.lookup(record);
    expect(first.isOk() && first.value).toBe(true);
    expect(second.isOk() && second.value).toBe(false);
  });
  it("normalizes CNAME and MX case and final dots and reports lookup errors", async () => {
    vi.mocked(resolveCname).mockResolvedValueOnce([
      "TOKEN.DKIM.AMAZONSES.COM.",
    ]);
    const cname = await nodeDomainDns.lookup({
      type: "CNAME",
      name: "s._domainkey.example.test",
      value: "token.dkim.amazonses.com",
      status: "pending",
    });
    expect(cname.isOk() && cname.value).toBe(true);
    vi.mocked(resolveMx)
      .mockResolvedValueOnce([
        { exchange: "INBOUND-SMTP.EU-NORTH-1.AMAZONAWS.COM.", priority: 10 },
      ])
      .mockRejectedValueOnce(new Error("unavailable"));
    const record = {
      type: "MX",
      name: "example.test",
      value: "inbound-smtp.eu-north-1.amazonaws.com",
      priority: 10,
      status: "pending",
    } satisfies Parameters<typeof nodeDomainDns.lookup>[0];
    const mx = await nodeDomainDns.lookup(record);
    expect(mx.isOk() && mx.value).toBe(true);
    expect((await nodeDomainDns.lookup(record)).isErr()).toBe(true);
  });
});
