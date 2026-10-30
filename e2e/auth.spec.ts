import { expect, test } from "@playwright/test";

test("sign-in, MFA setup, backup challenge, disable and sign-out", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === window.top)
      sessionStorage.setItem("auth-fixture-signed-out", "1");
  });
  await page.goto("/mail");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill("you@example.test");
  await page.getByLabel("Password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Incorrect email or password",
  );
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  await page.getByLabel("Current password").fill("synthetic-password");
  await page
    .getByRole("button", { name: "Set up two-factor authentication" })
    .click();
  await expect(
    page.locator('svg[aria-label="Authenticator setup QR code"]'),
  ).toBeVisible();
  await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
  await expect(page.getByText("backup-code")).toBeVisible();
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Confirm setup" }).click();
  await expect(page.getByRole("status")).toContainText("enabled");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill("you@example.test");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill("backup-code");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  await page.getByLabel("Current password").fill("synthetic-password");
  await page.getByRole("button", { name: "Regenerate backup codes" }).click();
  await expect(page.getByText(/previous codes no longer work/i)).toBeVisible();
  await expect(page.getByText("new-backup-code")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Current password").fill("synthetic-password");
  await page
    .getByRole("button", { name: "Disable two-factor authentication" })
    .click();
  await expect(page.getByRole("status")).toContainText("disabled");
});

test("an unauthorized query clears the session and explains expiry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === window.top)
      sessionStorage.setItem("mail-fixture-unauthorized", "1");
  });
  await page.goto("/mail");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByText("Your session expired. Sign in again to continue."),
  ).toBeVisible();
});
