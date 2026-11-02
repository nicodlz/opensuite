import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("navigates from Mail and exports sample data without calling live APIs", async ({
  page,
}) => {
  const liveCalls: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(portable-export|contacts\/(list|export))$/.test(request.url()))
      liveCalls.push(request.url());
  });
  await page.addInitScript(() =>
    sessionStorage.setItem("export-fixture-missing", "m2"),
  );
  await page.goto("/mail");
  const entry = page.getByRole("navigation", { name: "Data export" });
  await expect(entry.getByRole("link", { name: "Export data" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  const shell = await page.locator(".shell").boundingBox();
  expect(shell?.y).toBe(0);
  expect(shell?.height).toBe(page.viewportSize()?.height);
  await entry.getByRole("link", { name: "Export data" }).click();
  await expect(
    page.getByRole("heading", { name: "Export your data" }),
  ).toBeVisible();
  await page.getByLabel("Mailbox").selectOption("inbox");
  await page
    .getByRole("button", { name: "A little update for Friday" })
    .click();
  await page
    .getByRole("checkbox", { name: /A little update for Friday/ })
    .check();
  await page.getByRole("button", { name: "Weekend plans" }).click();
  await page.getByRole("checkbox", { name: /Weekend plans/ }).check();
  await expect(
    page.getByRole("list", { name: "Selected messages" }),
  ).toContainText("A little update for Friday");
  await page
    .getByRole("button", {
      name: "Remove A little update for Friday from export",
    })
    .click();
  await expect(
    page.getByRole("list", { name: "Selected messages" }),
  ).not.toContainText("A little update for Friday");
  await page
    .getByRole("button", { name: "A little update for Friday", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: /A little update for Friday/ })
    .check();
  const mailDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download mbox" }).click();
  expect((await mailDownload).suggestedFilename()).toBe("messages.mbox");
  await expect(page.getByRole("status")).toContainText(
    "From lines were quoted",
  );
  await expect(page.getByRole("status")).toContainText(
    "Sample message not found",
  );

  await page.getByRole("button", { name: "Load contacts" }).click();
  await page.getByRole("checkbox", { name: "Maya Chen" }).check();
  const contactsDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download vCard" }).click();
  expect((await contactsDownload).suggestedFilename()).toBe("contacts.vcf");
  await expect(page.getByRole("status")).toContainText("Example data only.");
  expect(liveCalls).toEqual([]);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ),
  ).toEqual([]);
});

test("offers export in the mobile Mail navigation drawer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/mail");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Data export" })
    .getByRole("link", { name: "Export data" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Export your data" }),
  ).toBeVisible();
});
