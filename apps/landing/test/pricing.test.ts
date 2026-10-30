import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plans } from "../../../packages/contracts/src/billing.ts";

const html = readFileSync("apps/landing/index.html", "utf8");
const euros = (cents: number) => `€${(cents / 100).toFixed(2)}`;

// Extract the content of a uniquely marked HTML element, failing if a marker
// disappears or is duplicated. The price and storage markers contain text only.
function content(source: string, attribute: string): string {
  const matches = [
    ...source.matchAll(
      new RegExp(
        `<([a-z]+)\\b[^>]*\\b${attribute}(?=[\\s=>])[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`,
        "g",
      ),
    ),
  ];
  expect(matches).toHaveLength(1);
  return matches[0]?.[2]?.trim() ?? "";
}

describe("landing catalogue", () => {
  it("matches every displayed price, annual saving, storage and address figure", () => {
    const pricing = content(html, 'id="pricing"');
    // Guard against new, untested monetary or storage figures in pricing.
    expect(pricing.match(/€\d+(?:\.\d{2})?/g)).toHaveLength(8);
    expect(pricing.match(/\d+\s*GB/g)).toHaveLength(2);
    expect(
      content(
        content(pricing, 'data-plan="free"'),
        'class="price-card__price"',
      ),
    ).toContain("Free");
    for (const [id, plan] of Object.entries(plans)) {
      const card = content(pricing, `data-plan="${id}"`);
      expect(content(card, 'data-price="month"')).toBe(
        euros(plan.prices.month.monthly),
      );
      expect(content(card, 'data-price="year"')).toBe(
        euros(plan.prices.year.monthly),
      );
      expect(content(card, "data-annual-total")).toBe(
        euros(plan.prices.year.amount),
      );
      expect(content(card, "data-annual-saving")).toBe(
        euros(plan.prices.month.amount * 12 - plan.prices.year.amount),
      );
      expect(content(card, "data-storage")).toBe(
        `${plan.storageBytes / 1_000_000_000} GB`,
      );
      expect(content(card, "data-addresses")).toBe(String(plan.addressLimit));
    }
  });
});
