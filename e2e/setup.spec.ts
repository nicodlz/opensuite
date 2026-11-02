import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("administrator can resume setup, check DNS, send a test and create a user", async ({
  page,
}) => {
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { name: "Setup wizard" }),
  ).toBeVisible();
  await expect(page.getByText("Drive object storage")).toBeVisible();
  const checkStep = async (step: string) => {
    await page.getByRole("button", { name: new RegExp(step) }).click();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      ),
    ).toEqual([]);
  };
  await checkStep("System check");
  await checkStep("Mail domain");
  await checkStep("Outbound relay");
  await checkStep("Create users");
  await checkStep("Finish");
  await page.getByRole("button", { name: /Mail domain/ }).click();
  await expect(page.getByText(/manual, owner-approved cutover/)).toBeVisible();
  await page
    .getByRole("button", { name: "Register administrator address" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Administrator address registered",
  );
  await page.getByRole("button", { name: "Recheck DNS" }).click();
  await expect(
    page.getByText("Status: verified", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Outbound relay/ }).click();
  await page.getByLabel("Test recipient").fill("recipient@example.test");
  await page.getByRole("button", { name: "Send test message" }).click();
  await expect(page.getByRole("status")).toContainText("submitted");
  await page.getByRole("button", { name: /Create users/ }).click();
  await page.getByLabel("Email address").fill("new@example.test");
  await page.getByLabel("Display name").fill("New User");
  await page.getByLabel("Initial password").fill("a-long-password");
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("User created");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Create users" }),
  ).toBeVisible();
});

test("setup marks each invalid field and focuses the first one", async ({
  page,
}) => {
  await page.goto("/setup");
  await expect(
    page.getByText("Last success marker: 1 hour ago.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Create users/ }).click();
  const create = page.getByRole("button", { name: "Create user", exact: true });
  await create.focus();
  await page.keyboard.press("Enter");
  const email = page.getByLabel("Email address");
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAccessibleDescription(
    "Enter a valid email address.",
  );
  await expect(page.getByLabel("Display name")).toHaveAccessibleDescription(
    "Enter a display name.",
  );
  await expect(page.getByLabel("Initial password")).toHaveAccessibleDescription(
    /Use 12 to 128 characters\./,
  );
  await email.fill("new@elsewhere.test");
  await page.getByLabel("Display name").fill("New User");
  await page.getByLabel("Initial password").fill("a-long-password");
  await page.keyboard.press("Enter");
  await expect(email).toBeFocused();
  await expect(email).toHaveAccessibleDescription(
    /Use an address in a managed domain: .*example\.test/,
  );
  await expect(page.getByLabel("Display name")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await email.fill("second@example.test");
  // Drafts survive moving to another step and back.
  await page.getByRole("button", { name: /Mail domain/ }).click();
  await page.getByRole("button", { name: /Create users/ }).click();
  await expect(email).toHaveValue("second@example.test");
  await expect(page.getByLabel("Display name")).toHaveValue("New User");
  await email.press("Enter");
  await expect(page.getByRole("status")).toContainText("User created");
  await expect(email).toHaveValue("");
  await expect(email).toHaveAttribute("aria-invalid", "false");

  await page.getByRole("button", { name: /Outbound relay/ }).click();
  const recipient = page.getByLabel("Test recipient");
  await recipient.fill("not-an-address");
  await recipient.press("Enter");
  await expect(recipient).toBeFocused();
  await expect(recipient).toHaveAccessibleDescription(
    "Enter a valid email address.",
  );
  await page.getByRole("button", { name: /Finish/ }).click();
  await page.getByRole("button", { name: /Outbound relay/ }).click();
  await expect(recipient).toHaveValue("not-an-address");
});

test("setup is refused to a regular account", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("setup-fixture-role", "user");
  });
  await page.goto("/setup");
  await expect(page.getByRole("alert")).toContainText(
    "Administrator access is required",
  );
  await expect(
    page.getByRole("navigation", { name: "Setup steps" }),
  ).toHaveCount(0);
});

test("setup remains accessible in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { name: "Setup wizard" }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ),
  ).toEqual([]);
});
