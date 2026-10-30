/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@opensuite/db";
import type Stripe from "stripe";
import type { Entitlements } from "../src/billing/entitlements.ts";
import { createStripeBilling } from "../src/billing/stripe.ts";

it("rejects concurrent billing actions without holding a database transaction", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = vi.fn<() => Promise<void>>();
  const db = {
    $transaction: transaction,
    billingCustomer: {
      findUnique: async () => {
        await gate;
        return null;
      },
    },
  } as unknown as PrismaClient;
  const service = createStripeBilling(
    db,
    {
      mode: "cloud",
      stripeSecretKey: "sk_test_x",
      webhookSecret: "whsec_x",
      internalToken: "x".repeat(32),
      automaticTax: false,
    },
    "https://example.test",
    {} as Entitlements,
    {} as Stripe,
  );
  const actor = { id: "u", email: "u@example.test", role: "user" as const };
  const first = service.portal(actor);
  await expect(service.portal(actor)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  release();
  await expect(first).rejects.toMatchObject({ code: "CONFLICT" });
  expect(transaction).not.toHaveBeenCalled();
});
