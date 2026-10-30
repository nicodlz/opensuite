import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function origins(page: Page, enabled: boolean) {
  await page.route("**/api/origins", (route) =>
    route.fulfill({
      json: enabled ? { pass: "https://pass.example.test" } : {},
    }),
  );
  await page.route("**/api/pass/status", (route) =>
    route.fulfill({
      json: enabled
        ? {
            enabled: true,
            reachable: true,
            version: "<img src=x onerror=alert(1)>",
            checkedAt: "2026-10-30T12:00:00.000Z",
          }
        : { enabled: false, reachable: false, version: null, checkedAt: null },
    }),
  );
}
test("Pass navigation and disabled state", async ({ page }) => {
  await origins(page, false);
  await page.goto("/mail");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Pass" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pass is not enabled" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /operator instructions/ }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});
test("launcher, text-only status and generator copy", async ({
  page,
  context,
}) => {
  await origins(page, true);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/pass");
  const launcher = page.getByRole("link", { name: /Open your vault/ });
  await expect(launcher).toHaveAttribute("href", "https://pass.example.test");
  await expect(launcher).toHaveAttribute("target", "_blank");
  await expect(launcher).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page.getByText("Version: <img src=x onerror=alert(1)>"),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("link", { name: "Generator", exact: true }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const generated = await page.getByLabel("Generated password").inputValue();
  await page.getByRole("button", { name: "Copy generated value" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    generated,
  );
  await page.getByRole("link", { name: "Apps and extensions" }).click();
  await expect(page.getByText("https://pass.example.test")).toBeVisible();
});
for (const theme of ["light", "dark"] as const)
  test(`${theme} Pass is accessible on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await origins(page, true);
    await page.goto("/pass");
    await expect(
      page.getByRole("heading", { name: "Pass", exact: true }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: "Generator", exact: true }).click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
