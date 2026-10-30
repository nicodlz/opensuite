import { expect, it } from "vitest";
import { reserveQuota } from "../src/services/quota.ts";

it("reserves bytes including pending and trashed files without exceeding quota", () => {
  expect(reserveQuota(70n, 30n, 100n).isOk()).toBe(true);
  expect(reserveQuota(70n, 31n, 100n).isErr()).toBe(true);
  expect(reserveQuota(70n, -1n, 100n).isErr()).toBe(true);
});
