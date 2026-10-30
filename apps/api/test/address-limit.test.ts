import { describe, expect, it } from "vitest";
import { plans } from "@opensuite/contracts";
import { entitledAddressLimit } from "../src/address-limit.ts";

const actor = {
  id: "user-1",
  email: "user@example.test",
  role: "user" as const,
};
const limit = (addressLimit: number | null, cap = 50) =>
  entitledAddressLimit(
    { get: () => Promise.resolve({ addressLimit }) },
    cap,
  )(actor);

describe("entitled address limit", () => {
  it("applies the Plus and Pro allowances", async () => {
    await expect(limit(plans.plus.addressLimit)).resolves.toBe(5);
    await expect(limit(plans.pro.addressLimit)).resolves.toBe(15);
  });
  it("blocks new addresses without a plan", async () => {
    await expect(limit(0)).resolves.toBe(0);
  });
  it("keeps the operator cap when no plan limit applies", async () => {
    await expect(limit(null)).resolves.toBe(50);
    await expect(limit(15, 10)).resolves.toBe(10);
  });
});
