import { mkdir } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const appOrigin =
  process.env["VITE_ESUNO_APP_ORIGIN"] || "https://mail.esuno.net";
const screenshots = "node_modules/.cache/landing-screenshots";

async function checkAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (item) => item.impact === "serious" || item.impact === "critical",
    ),
  ).toEqual([]);
}

async function checkPlan(
  page: Page,
  plan: "plus" | "pro",
  interval: "month" | "year",
  price: string,
) {
  const card = page.locator(`[data-plan="${plan}"]`);
  await expect(card.locator(`[data-price="${interval}"]`)).toBeVisible();
  await expect(card.locator(`[data-price="${interval}"]`)).toHaveText(price);
  await expect(card.locator("[data-subscribe]")).toHaveAttribute(
    "href",
    `${new URL(appOrigin).origin}/subscribe?plan=${plan}&interval=${interval}`,
  );
}

test("billing intervals, links, keyboard, accessibility and same-origin requests", async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL ?? "").origin)
      external.push(request.url());
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Everything you need",
  );
  await expect(
    page.locator(".hero__actions").getByRole("link", { name: "Get started" }),
  ).toHaveAttribute("href", "#pricing");
  await expect(
    page
      .locator(".hero__actions")
      .getByRole("link", { name: "Self-host Esuno" }),
  ).toHaveAttribute("href", "#self-host");
  await expect(
    page.locator("#deployment").getByRole("link", { name: "Get started" }),
  ).toHaveAttribute("href", "#pricing");
  await expect(
    page.locator("#deployment").getByRole("link", { name: "Self-host Esuno" }),
  ).toHaveAttribute("href", "#self-host");
  await expect(page.locator('[data-plan="free"] a')).toHaveAttribute(
    "href",
    "#self-host",
  );
  await expect(
    page.getByRole("link", { name: "Read the production runbook" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/nicodlz/opensuite/blob/main/docs/deployment/production.md",
  );
  await checkPlan(page, "plus", "month", "€3.49");
  await checkPlan(page, "pro", "month", "€9.99");
  await checkAxe(page);
  const monthly = page.getByRole("radio", { name: "Monthly" });
  const annual = page.getByRole("radio", { name: "Annual" });
  await monthly.focus();
  await page.keyboard.press("ArrowRight");
  await expect(annual).toBeChecked();
  await checkPlan(page, "plus", "year", "€2.99");
  await checkPlan(page, "pro", "year", "€7.99");
  await expect(page.getByText(/Billed €35.88 per year/)).toBeVisible();
  await expect(page.getByText(/Billed €95.88 per year/)).toBeVisible();
  await checkAxe(page);
  await monthly.check();
  await checkPlan(page, "plus", "month", "€3.49");
  await checkPlan(page, "pro", "month", "€9.99");
  expect(external).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
});

test("monthly checkout links work without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL: baseURL ?? "",
    javaScriptEnabled: false,
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.goto("/");
  await checkPlan(page, "plus", "month", "€3.49");
  await checkPlan(page, "pro", "month", "€9.99");
  await expect(
    page.getByRole("group", { name: "Billing interval" }),
  ).toBeHidden();
  await context.close();
});

for (const width of [320, 375, 768, 1280, 1440]) {
  test(`fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    if (width === 375 || width === 1440) {
      await mkdir(screenshots, { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `${screenshots}/${width}-monthly.png`,
        fullPage: true,
        animations: "disabled",
      });
      await page.getByRole("radio", { name: "Annual" }).check();
      await page.screenshot({
        path: `${screenshots}/${width}-annual.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
  });
}

test("capture the updated social preview", async ({ page }) => {
  await mkdir(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${screenshots}/og.png`,
    animations: "disabled",
  });
});
