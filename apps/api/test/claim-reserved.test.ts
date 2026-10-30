/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import { createClaimService } from "../src/billing/claims.ts";

it("rejects role addresses before calling the database, Stripe or signup", async () => {
  const signUp = vi.fn<() => Promise<string>>();
  const claims = createClaimService(
    {} as PrismaClient,
    {} as Stripe,
    "example.test",
    signUp,
  );
  /* oxlint-disable eslint/no-await-in-loop */
  for (const localPart of ["postmaster", "ssladmin", "dmarc", "billing"]) {
    await expect(
      claims.claim({
        sessionId: "cs_test_foo",
        name: "User",
        localPart,
        password: "a-valid-password",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This address is reserved",
    });
  }
  /* oxlint-enable eslint/no-await-in-loop */
  expect(signUp).not.toHaveBeenCalled();
});

it("rejects an unknown local claim before retrieving Stripe", async () => {
  const retrieve = vi.fn<() => Promise<never>>();
  const db = {
    checkoutClaim: { findUnique: () => Promise.resolve(null) },
  } as unknown as PrismaClient;
  const stripe = { checkout: { sessions: { retrieve } } } as unknown as Stripe;
  const claims = createClaimService(db, stripe, "example.test", () =>
    Promise.resolve("u"),
  );
  await expect(
    claims.claim({
      sessionId: "cs_test_foo",
      name: "User",
      localPart: "member",
      password: "a-valid-password",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(retrieve).not.toHaveBeenCalled();
});
