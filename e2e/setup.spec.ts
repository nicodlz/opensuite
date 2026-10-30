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
