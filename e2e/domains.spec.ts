import { expect, test } from "@playwright/test";

test("shows synthetic DNS records and rechecks their status", async ({
  page,
}) => {
  await page.goto("/domains");
  await expect(page.getByRole("heading", { name: "Domains" })).toBeVisible();
  await expect(
    page.getByText("inbound-smtp.eu-north-1.amazonaws.com"),
  ).toBeVisible();
  await expect(
    page.getByText("Status: pending", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Recheck DNS" }).click();
  await expect(
    page.getByText("Status: verified", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("DNS check completed");
});
