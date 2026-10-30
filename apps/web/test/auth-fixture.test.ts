// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { fakeAuth } from "../src/dev-data/auth.ts";

beforeEach(() => sessionStorage.clear());

it("keeps synthetic factor operations consistent with the live API", async () => {
  expect((await fakeAuth.methods()).backup).toBe(false);
  await fakeAuth.enable("synthetic-password");
  await fakeAuth.verify("123456", false);
  expect((await fakeAuth.methods()).backup).toBe(true);
  await expect(fakeAuth.enable("synthetic-password")).rejects.toThrow(
    "already enabled",
  );
  await expect(
    fakeAuth.removeKey("missing", "synthetic-password"),
  ).rejects.toThrow("not found");
});
