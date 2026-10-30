import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ready = {
  status: "ready",
  checkedAt: "2026-01-01T00:00:00.000Z",
  dependencies: [],
};
async function mockHealthy(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok", uptimeSeconds: 42 } }),
  );
  await page.route("**/api/ready", (route) => route.fulfill({ json: ready }));
}
async function checkAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

for (const theme of ["light", "dark"]) {
  test(`${theme} theme: keyboard controls, focus and accessibility`, async ({
    page,
  }) => {
    await page.emulateMedia({
      colorScheme: theme === "light" ? "light" : "dark",
    });
    await mockHealthy(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "All checks operational" }),
    ).toBeVisible();
    await checkAxe(page);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    const outline = await page
      .getByRole("link", { name: "Skip to content" })
      .evaluate((element) => getComputedStyle(element).outlineWidth);
    expect(outline).toBe("3px");
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog", { name: "Workspace settings" });
    await expect(dialog).toBeVisible();
    await checkAxe(page);
    const field = page.getByRole("textbox", { name: "Workspace label" });
    await field.fill("");
    await page.getByRole("button", { name: "Save label" }).click();
    await expect(page.getByText("Enter a workspace label.")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("Test workspace");
    await field.press("Tab");
    await expect(
      page.getByRole("button", { name: "Save label" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("Workspace label saved on this device", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Test workspace")).toBeVisible();
    const menu = page.getByRole("button", {
      name: "Account and appearance menu",
    });
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(
      page.getByRole("menuitemradio", { name: "Use system theme" }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "Light theme" }),
    ).toBeFocused();
    if (theme === "light") await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "dark" : "light",
    );
    await checkAxe(page);
    await page.reload();
    await expect(page.getByText("Test workspace")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "dark" : "light",
    );
    await page.getByRole("link", { name: "Calendar" }).click();
    await expect(page).toHaveURL(/\/calendar$/);
  });
}

test("loading, degraded readiness and dependency detail", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok", uptimeSeconds: 9 } }),
  );
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ready", async (route) => {
    await wait;
    await route.fulfill({
      status: 503,
      json: {
        defined: true,
        code: "NOT_READY",
        status: 503,
        message: "One or more dependencies are unavailable",
        data: {
          status: "not_ready",
          checkedAt: "2026-01-01T00:00:00.000Z",
          dependencies: [{ name: "database", status: "down", durationMs: 5 }],
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Checking services" }),
  ).toBeVisible();
  if (release) release();
  await expect(
    page.getByRole("heading", { name: "Attention needed" }),
  ).toBeVisible();
  await expect(page.getByText("database")).toBeVisible();
  await expect(page.getByText("Degraded").first()).toBeVisible();
  await checkAxe(page);
});

test("network failures are reported and refresh recovers", async ({ page }) => {
  await page.route("**/api/*", (route) => route.abort("failed"));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Some checks are unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("Unable to reach or validate the API"),
  ).toHaveCount(2);
  await page.unrouteAll();
  await mockHealthy(page);
  await page.getByRole("button", { name: "Refresh checks" }).click();
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
});

test("live API probes reach the status page through the preview proxy", async ({
  page,
}) => {
  const healthResponse = page.waitForResponse("**/api/health");
  const readyResponse = page.waitForResponse("**/api/ready");
  await page.goto("/");
  expect((await healthResponse).status()).toBe(200);
  expect((await readyResponse).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
  await expect(page.getByText(/Uptime: \d+ seconds/)).toBeVisible();
  await expect(page.getByText("No dependencies declared")).toBeVisible();
});

test("a script that fails to load is retried instead of leaving a blank page", async ({
  page,
}) => {
  await mockHealthy(page);
  let aborted = 0;
  // A module of the initial graph fails on two loads in a row, as during a
  // burst of network changes.
  await page.route("**/src/ui/toast.tsx*", async (route) => {
    if (aborted < 2) {
      aborted += 1;
      await route.abort("internetdisconnected");
    } else await route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
  expect(aborted).toBe(2);
});

test("a script that keeps failing stops after three reloads", async ({
  page,
}) => {
  await mockHealthy(page);
  let attempts = 0;
  await page.route("**/src/ui/toast.tsx*", async (route) => {
    attempts += 1;
    await route.abort("internetdisconnected");
  });
  await page.goto("/");
  // Reloads wait 0.5 s, 2 s and 4.5 s; allow them all, then confirm no more.
  await expect.poll(() => attempts, { timeout: 20_000 }).toBe(4);
  await page.waitForTimeout(6000);
  expect(attempts).toBe(4);
});
