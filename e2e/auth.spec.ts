import { readFile } from "node:fs/promises";
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
  await expect(page.getByText(/backup-[0-9a-f-]{36}/)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Current password").fill("synthetic-password");
  await page.getByRole("button", { name: "Disable authenticator app" }).click();
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

test("sign-in explains each step and focuses the code field", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== window.top || sessionStorage.getItem("fixture-ready"))
      return;
    sessionStorage.setItem("fixture-ready", "1");
    sessionStorage.setItem("auth-fixture-signed-out", "1");
    sessionStorage.setItem("auth-fixture-mfa", "1");
    sessionStorage.setItem("auth-fixture-backup-code", "backup-code");
  });
  await page.goto("/login");
  await expect(
    page.getByText("Forgot your password? Contact your administrator."),
  ).toBeVisible();
  await page.getByLabel("Email").fill("you@example.test");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("synthetic-password");
  const reveal = page.getByRole("button", { name: "Show password" });
  await reveal.press("Enter");
  await expect(password).toHaveAttribute("type", "text");
  await expect(
    page.getByRole("button", { name: "Hide password" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Hide password" }).press("Enter");
  await expect(password).toHaveAttribute("type", "password");
  await password.press("Enter");

  await expect(
    page.getByRole("heading", { name: "Verify your identity" }),
  ).toBeVisible();
  await expect(
    page.getByText("Enter the 6-digit code from your authenticator app."),
  ).toBeVisible();
  const totp = page.getByLabel("Authenticator code");
  await expect(totp).toBeFocused();
  await expect(totp).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in with a different account" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Use a backup code" }).press("Enter");
  const backup = page.getByLabel("Backup code");
  await expect(backup).toBeFocused();
  await expect(backup).not.toHaveAttribute("inputmode");
  await expect(page.getByText("Enter one of your backup codes.")).toBeVisible();
  await page
    .getByRole("button", { name: "Use an authenticator code" })
    .press("Enter");
  await expect(totp).toBeFocused();
  // Codes copied from an authenticator often contain a space.
  await totp.fill("123 456");
  await totp.press("Enter");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("account security says why actions wait and keeps backup codes", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/mail");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  const current = page.getByLabel("Current password");
  await expect(current).toHaveAccessibleDescription(
    "Enter your current password to change the settings below.",
  );
  const setup = page.getByRole("button", {
    name: "Set up two-factor authentication",
  });
  await expect(setup).toBeDisabled();
  await current.fill("synthetic-password");
  await setup.click();
  await page.getByRole("button", { name: "Copy codes" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "backup-code\n",
  );
  await expect(page.getByText("Backup codes copied.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download (.txt)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("esuno-backup-codes.txt");
  expect(await readFile(await file.path(), "utf8")).toBe("backup-code\n");
  await expect(page.getByLabel("Authenticator code")).toHaveAttribute(
    "inputmode",
    "numeric",
  );
});
