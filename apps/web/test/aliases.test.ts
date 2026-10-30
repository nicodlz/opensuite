import { describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/client";
import type { Alias } from "../src/aliases/client.ts";
import {
  aliasError,
  aliasState,
  canSendFrom,
  filterAliases,
  recipientAddresses,
} from "../src/aliases/model.ts";

const alias: Alias = {
  id: "1",
  address: "shop@example.test",
  localPart: "shop",
  domainId: "d",
  website: null,
  note: null,
  enabled: true,
  ready: true,
  detachedByDomain: false,
  suspended: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
describe("alias view model", () => {
  it("distinguishes provisioning and suspension from enabled state", () => {
    const pending = { ...alias, id: "2", ready: false };
    const disabled = { ...alias, id: "3", enabled: false };
    const suspended = { ...alias, id: "4", detachedByDomain: true };
    expect([alias, pending, disabled, suspended].map(aliasState)).toEqual([
      "Ready",
      "Pending",
      "Ready",
      "Suspended",
    ]);
    expect([alias, pending, disabled, suspended].map(canSendFrom)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(
      filterAliases([alias, pending, disabled, suspended], "enabled").map(
        (item) => item.id,
      ),
    ).toEqual(["1", "2"]);
    expect(
      filterAliases([alias, pending, disabled, suspended], "disabled").map(
        (item) => item.id,
      ),
    ).toEqual(["3"]);
    expect(
      filterAliases([alias, pending, disabled, suspended], "suspended").map(
        (item) => item.id,
      ),
    ).toEqual(["4"]);
  });
  it("extracts and deduplicates only recipient headers", () => {
    const message = {
      to: [{ email: "SHOP@example.test" }],
      cc: [{ email: "friend@example.test" }],
      headers: [
        { name: "Delivered-To", value: "Shop <shop@example.test>" },
        { name: "X-Original-To", value: "other@example.test" },
        {
          name: "Cc",
          value: "Person <third@example.test>, Fourth <fourth@example.test>",
        },
        { name: "From", value: "ignore@example.test" },
      ],
    };
    expect(recipientAddresses(message)).toEqual([
      "shop@example.test",
      "friend@example.test",
      "other@example.test",
      "third@example.test",
      "fourth@example.test",
    ]);
  });
  it("maps declared errors without exposing arbitrary server messages", () => {
    expect(aliasError(new ORPCError("ALIAS_CAP_REACHED"))).toBe(
      "Alias limit reached.",
    );
    expect(aliasError(new ORPCError("SERVICE_UNAVAILABLE"))).toMatch(
      /unavailable/i,
    );
    expect(aliasError(new Error("secret"))).not.toContain("secret");
  });
});
