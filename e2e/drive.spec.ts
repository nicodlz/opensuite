import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function checkAxe(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}
const themes: ("light" | "dark")[] = ["light", "dark"];
for (const theme of themes) {
  test(`${theme} Drive navigation and accessibility`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/drive");
    await expect(page.getByRole("heading", { name: "My drive" })).toBeVisible();
    await checkAxe(page);
    await page.getByRole("button", { name: "Grid view" }).click();
    await expect(
      page.getByRole("button", { name: "Grid view" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Projects, folder" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Ideas.txt, file" }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "My drive" })
      .click();
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await checkAxe(page);
    await page.getByLabel("Name", { exact: true }).fill("Design");
    await page.getByRole("button", { name: "Create folder" }).click();
    await expect(
      page.getByRole("button", { name: "Design, folder" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Shared with me", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Shared roadmap.txt, file" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await expect(page.getByText("Trash is empty")).toBeVisible();
  });
}
test("upload, rename, move, share, download, trash and restore", async ({
  page,
}) => {
  await page.goto("/drive");
  await page.getByLabel("Choose files to upload").setInputFiles([
    {
      name: "sample.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello drive"),
    },
    {
      name: "large.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 7),
    },
  ]);
  await expect(page.getByText("Files uploaded.")).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "sample.txt, file" }).click();
  const toolbar = page.getByRole("toolbar", { name: "Actions for sample.txt" });
  const download = page.waitForEvent("download");
  await toolbar.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("sample.txt");
  await toolbar.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Name", { exact: true }).fill("renamed.txt");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByRole("button", { name: "renamed.txt, file" }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("User ID").fill("colleague-id");
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("User access saved.")).toBeVisible();
  await page.getByRole("button", { name: "Create public link" }).click();
  await expect(page.getByLabel("Public link", { exact: true })).toHaveValue(
    /synthetic_token_shown_once/,
  );
  const id = await page.getByLabel("Link ID", { exact: true }).inputValue();
  await page.getByLabel("Link ID to revoke").fill(id);
  await page.getByRole("button", { name: "Revoke link" }).click();
  await expect(page.getByText("Link revoked.")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: "Move here" }).click();
  await page.getByRole("button", { name: "Projects, folder" }).dblclick();
  await page.getByRole("button", { name: "renamed.txt, file" }).click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "renamed.txt, file" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Item restored.")).toBeVisible();
});
test("errors can be retried and failed mutations leave files intact", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("drive-fixture-fail-list", "1"),
  );
  await page.goto("/drive");
  await expect(page.getByText("Drive is unavailable")).toBeVisible();
  await page.evaluate(() =>
    sessionStorage.removeItem("drive-fixture-fail-list"),
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("button", { name: "Projects, folder" }).click();
  await page.evaluate(() =>
    sessionStorage.setItem("drive-fixture-fail-action", "1"),
  );
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByText(/Could not complete this action/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Projects, folder" }),
  ).toBeVisible();
});

test("guarded preview, permanent deletion and cancellation", async ({
  page,
}) => {
  await page.goto("/drive");
  await page
    .getByRole("button", { name: "Welcome to Drive.pdf, file" })
    .dblclick();
  await expect(page.getByRole("dialog").locator("iframe")).toHaveAttribute(
    "sandbox",
    "",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Photos, folder" }).click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Photos, folder" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(page.getByText("Item permanently deleted.")).toBeVisible();
  await page
    .getByRole("button", { name: "My drive", exact: true })
    .first()
    .click();
  await page.evaluate(() =>
    sessionStorage.setItem("drive-fixture-hold-upload", "1"),
  );
  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "cancel.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("cancel me"),
  });
  await page.waitForFunction(
    () => sessionStorage.getItem("drive-fixture-upload-started") === "1",
  );
  await page.getByRole("button", { name: "Cancel upload" }).click();
  await expect(page.getByText("Upload cancelled.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /cancel.txt, file/ }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    sessionStorage.removeItem("drive-fixture-hold-upload"),
  );
  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg onload='alert(1)'></svg>"),
  });
  await expect(page.getByText("File uploaded.")).toBeVisible();
  await page.getByRole("button", { name: "unsafe.svg, file" }).click();
  await expect(
    page.getByRole("toolbar").getByRole("button", { name: "Preview" }),
  ).toBeDisabled();
});
