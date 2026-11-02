import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function origins(page: Page, enabled: boolean) {
  await page.route("**/api/origins", (route) =>
    route.fulfill({
      json: enabled ? { vault: "https://vault.example.test" } : {},
    }),
  );
  await page.route("**/api/vault/status", (route) =>
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
test("Vault navigation and disabled state", async ({ page }) => {
  await origins(page, false);
  await page.goto("/mail");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Vault" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Vault is not enabled" }),
  ).toBeVisible();
  // The development account is an administrator.
  await expect(
    page.getByRole("heading", { name: "For administrators" }),
  ).toBeVisible();
  await expect(page.getByText(/Set VAULT_PUBLIC_HOST/)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});
test("a regular user is told whom to ask, without server instructions", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("setup-fixture-role", "user");
  });
  await origins(page, false);
  await page.goto("/vault");
  await expect(
    page.getByRole("heading", { name: "Vault is not enabled" }),
  ).toBeVisible();
  await expect(page.getByText(/Contact your administrator/)).toBeVisible();
  await expect(
    page.getByText(/VAULT_PUBLIC_HOST|AUTH_PRODUCT_ORIGINS/),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "For administrators" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Open the generator" }).click();
  await expect(
    page.getByRole("heading", { name: "Generator", level: 1 }),
  ).toBeVisible();
});
test("server instructions disappear when the role check fails again", async ({
  page,
}) => {
  await page.clock.install();
  await origins(page, false);
  await page.goto("/vault");
  await expect(page.getByText(/Set VAULT_PUBLIC_HOST/)).toBeVisible();
  // Coming back to the tab later re-checks the role, which now fails.
  await page.evaluate(() => {
    sessionStorage.setItem("setup-fixture-role", "error");
  });
  await page.clock.fastForward(31_000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText(/Contact your administrator/)).toBeVisible();
  await expect(page.getByText(/VAULT_PUBLIC_HOST/)).toHaveCount(0);
});
test("an unavailable status check shows no stale details", async ({ page }) => {
  await origins(page, true);
  await page.route("**/api/vault/status", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/vault");
  await expect(
    page.getByRole("heading", { name: "Status unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Could not check the vault server/),
  ).toBeVisible();
  await expect(page.getByText(/^Version:/)).toHaveCount(0);
  await expect(page.getByText(/^Last checked:/)).toHaveCount(0);
  await expect(page.getByText("Check connection")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Open your vault/ }),
  ).toBeVisible();
});
test("Generate explains why it is unavailable", async ({ page }) => {
  await page.goto("/vault/generator");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await page.getByLabel("Uppercase").uncheck();
  await page.getByLabel("Lowercase").uncheck();
  await page.getByLabel("Numbers").uncheck();
  await page.getByLabel("Symbols").uncheck();
  await expect(generate).toBeDisabled();
  await expect(generate).toHaveAccessibleDescription(
    "Select at least one character class.",
  );
  await page.getByLabel("Lowercase").check();
  await page.getByLabel("Length").fill("4");
  await expect(generate).toHaveAccessibleDescription(
    "Choose a length between 8 and 128.",
  );
  await page.getByLabel("Length").fill("16");
  await expect(generate).toBeEnabled();
  await page.getByLabel("Passphrase").check();
  await page.getByLabel("Words").fill("20");
  await expect(generate).toHaveAccessibleDescription(
    "Choose between 3 and 12 words.",
  );
});
test("launcher, text-only status and generator copy", async ({
  page,
  context,
}) => {
  await origins(page, true);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/vault");
  const launcher = page.getByRole("link", { name: /Open your vault/ });
  await expect(launcher).toHaveAttribute("href", "https://vault.example.test");
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
  await expect(page.getByText("https://vault.example.test")).toBeVisible();
});
for (const theme of ["light", "dark"] as const)
  test(`${theme} Vault is accessible on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
    await page.emulateMedia({ colorScheme: theme });
    await origins(page, true);
    await page.goto("/vault");
    await expect(
      page.getByRole("heading", { name: "Esuno Vault", exact: true }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: "Generator", exact: true }).click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("link", { name: "Apps and extensions" }).click();
    await expect(page.getByText("https://vault.example.test")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await origins(page, false);
    await page.goto("/vault");
    await expect(
      page.getByRole("heading", { name: "Vault is not enabled" }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
test("clipboard clear does not read and only runs while focused", async ({
  page,
}) => {
  await origins(page, true);
  await page.clock.install();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (value: string) => {
          document.documentElement.dataset["clipboard"] = value;
          return Promise.resolve();
        },
        readText: () => {
          document.documentElement.dataset["clipboardRead"] = "called";
          return Promise.reject(new Error("read not permitted"));
        },
      },
    });
    document.hasFocus = () =>
      document.documentElement.dataset["focused"] !== "no";
  });
  await page.goto("/vault/generator");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByRole("button", { name: "Copy generated value" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied");
  const copied = await page.getByLabel("Generated password").inputValue();
  await page.evaluate(() => {
    document.documentElement.dataset["focused"] = "no";
  });
  await page.clock.fastForward(30_000);
  await expect(page.locator("html")).toHaveAttribute("data-clipboard", copied);
  await page.evaluate(() => {
    document.documentElement.dataset["focused"] = "yes";
  });
  await page.getByRole("button", { name: "Copy generated value" }).click();
  await page.clock.fastForward(30_000);
  await expect(page.locator("html")).toHaveAttribute("data-clipboard", "");
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-clipboard-read",
    "called",
  );
});
