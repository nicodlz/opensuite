/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { describe, expect, it, vi } from "vitest";
import { ok } from "neverthrow";
import type { AddressStore } from "@opensuite/db";
import type { AliasMail } from "../src/services/aliases.ts";
import { createAddressService } from "../src/services/addresses.ts";
import { isReservedMailLocalPart } from "../src/reserved-mail-local-parts.ts";

describe("reserved mailbox names", () => {
  it("recognizes the shared role-address superset case insensitively", () => {
    for (const name of [
      "Postmaster",
      "ssl-admin",
      "ssladmin",
      "DMARC",
      "dkim",
      "support",
      "legal",
      "mailer-daemon",
      "noc",
      "marketing",
      "usenet",
      "news",
      "uucp",
      "autoconfig",
      "autodiscover",
      `os-${"a".repeat(32)}`,
    ])
      expect(isReservedMailLocalPart(name)).toBe(true);
    expect(isReservedMailLocalPart("member")).toBe(false);
  });
  it("rejects reserved names before reserving an extra address", async () => {
    const reserve = vi.fn<() => void>();
    const audit = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const service = createAddressService(
      { reserve, audit } as unknown as AddressStore,
      {} as AliasMail,
      () => Promise.resolve(5),
      () => Promise.resolve(ok(undefined)),
      [],
    );
    const result = await service.create(
      { id: "u", email: "u@example.test", role: "user" },
      { localPart: "DMARC", domainId: "d" },
    );
    expect(result.isErr() && result.error.kind).toBe("reserved");
    expect(reserve).not.toHaveBeenCalled();
  });
});
