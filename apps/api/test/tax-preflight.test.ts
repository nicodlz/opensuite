/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { expect, it } from "vitest";
import type Stripe from "stripe";
import { checkTaxReadiness } from "../src/billing/tax-preflight.ts";

it("blocks missing tax registrations unless the operator explicitly overrides", async () => {
  let registrations: object[] = [];
  let status = "active";
  const stripe = {
    tax: {
      settings: {
        retrieve: () =>
          Promise.resolve({
            status,
            head_office: { address: { country: "PT" } },
          }),
      },
      registrations: { list: () => Promise.resolve({ data: registrations }) },
    },
  } as unknown as Stripe;
  const warnings: string[] = [];
  await expect(
    checkTaxReadiness(stripe, false, (warning) => warnings.push(warning)),
  ).rejects.toThrow("Add tax registrations");
  expect(warnings).toContain(
    "no tax registrations: Stripe Tax will compute 0 VAT",
  );
  await expect(
    checkTaxReadiness(stripe, true, () => {}),
  ).resolves.toBeUndefined();
  registrations = [{}];
  await expect(
    checkTaxReadiness(stripe, false, () => {}),
  ).resolves.toBeUndefined();
  status = "pending";
  await expect(checkTaxReadiness(stripe, true, () => {})).rejects.toThrow(
    "Stripe Tax is not active",
  );
});
