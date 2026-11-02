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
function osFiles(page: Page, names: string[]) {
  return page.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const name of list)
      transfer.items.add(new File([name], name, { type: "text/plain" }));
    return transfer;
  }, names);
}
function row(page: Page, name: string) {
  return page.locator(".drive-item", {
    has: page.getByRole("button", { name, exact: true }),
  });
}
const themes: ("light" | "dark")[] = ["light", "dark"];
for (const theme of themes) {
  test(`${theme} Drive navigation and accessibility`, async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
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
  await expect(
    page.getByRole("button", { name: "renamed.txt, file" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Email address").fill("colleague@example.org");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    page.getByText("Shared with colleague@example.org."),
  ).toBeVisible();
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
  await page.addInitScript(() => {
    if (window === window.top)
      sessionStorage.setItem("drive-fixture-fail-list", "1");
  });
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
  const pdfViewer = page.getByRole("dialog", { name: "Welcome to Drive.pdf" });
  await expect(pdfViewer.getByLabel("Page 1")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pdfViewer).toHaveCount(0);
  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByText("File uploaded.")).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "image.png, file" }).dblclick();
  const imageViewer = page.getByRole("dialog", { name: "image.png" });
  await expect(
    imageViewer.getByRole("img", { name: "image.png" }),
  ).toBeVisible();
  await imageViewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(
    imageViewer.getByRole("button", { name: "Fit to screen" }),
  ).toHaveText("125%");
  // Arrow keys step through the files of the folder.
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("dialog", { name: "Welcome to Drive.pdf" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next file" }).waitFor({
    state: "detached",
  });
  await page.getByRole("button", { name: "Close preview" }).click();
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
  await page
    .getByRole("toolbar")
    .getByRole("button", { name: "Preview" })
    .click();
  const svgViewer = page.getByRole("dialog", { name: "unsafe.svg" });
  await expect(
    svgViewer.getByText(/No preview for this file type/),
  ).toBeVisible();
  await expect(svgViewer.locator("img, iframe")).toHaveCount(0);
});

test("previews text, resolves upload name conflicts and trashes whole folders", async ({
  page,
}) => {
  await page.goto("/drive");
  await page.getByRole("button", { name: "Projects, folder" }).dblclick();
  await page.getByRole("button", { name: "Ideas.txt, file" }).dblclick();
  await expect(
    page.getByRole("dialog", { name: "Ideas.txt" }).getByText("Project ideas"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const upload = (text: string) =>
    page.getByLabel("Choose files to upload").setInputFiles([
      { name: "Ideas.txt", mimeType: "text/plain", buffer: Buffer.from(text) },
      { name: "fresh.txt", mimeType: "text/plain", buffer: Buffer.from(text) },
    ]);
  await upload("New ideas");
  const conflict = page.getByRole("dialog", {
    name: "File already exists",
  });
  await expect(conflict.getByText(/“Ideas.txt” already exists/)).toBeVisible();
  await conflict.getByRole("button", { name: "Replace" }).click();
  await expect(page.getByText(/Files uploaded/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ideas.txt, file" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Ideas.txt, file" }).dblclick();
  await expect(
    page.getByRole("dialog", { name: "Ideas.txt" }).getByText("New ideas"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "Ideas.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Second copy"),
  });
  await conflict.getByRole("button", { name: "Keep both" }).click();
  await expect(
    page.getByRole("button", { name: "Ideas (1).txt, file" }),
  ).toBeVisible();
  // One answer can cover every conflict of the upload.
  await upload("Ignored");
  await conflict
    .getByLabel("Do this for every conflict in this upload")
    .check();
  await conflict.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText("2 existing files skipped.")).toBeVisible();
  await expect(conflict).toHaveCount(0);
  // A folder goes to the trash with everything inside it.
  await page
    .getByRole("button", { name: "My drive", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Projects, folder" }).click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByText("Moved to trash.")).toBeVisible();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Projects, folder" }).dblclick();
  await expect(
    page.getByRole("button", { name: "fresh.txt, file" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Trash", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Projects, folder" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Item restored.")).toBeVisible();
  await page
    .getByRole("button", { name: "My drive", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Projects, folder" }).dblclick();
  await expect(
    page.getByRole("button", { name: "fresh.txt, file" }),
  ).toBeVisible();
});

test("OS files dropped on the page, a folder row or a breadcrumb upload there", async ({
  page,
}) => {
  await page.goto("/drive");
  await expect(
    page.getByRole("button", { name: "Projects, folder" }),
  ).toBeVisible();
  const files = await osFiles(page, ["dropped.txt", "second.txt"]);
  const heading = page.getByRole("heading", { name: "My drive" });
  await heading.dispatchEvent("dragenter", { dataTransfer: files });
  await heading.dispatchEvent("dragover", { dataTransfer: files });
  await expect(
    page.getByText("Drop files to upload to My drive"),
  ).toBeVisible();
  await heading.dispatchEvent("drop", { dataTransfer: files });
  await expect(page.getByText("Drop files to upload to My drive")).toHaveCount(
    0,
  );
  await expect(page.getByText("Files uploaded.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "second.txt, file" }),
  ).toBeVisible();

  const single = await osFiles(page, ["into-folder.txt"]);
  const projects = row(page, "Projects, folder");
  await projects.dispatchEvent("dragenter", { dataTransfer: single });
  await projects.dispatchEvent("dragover", { dataTransfer: single });
  await expect(projects).toHaveClass(/drop-target/);
  await expect(
    page.getByText("Drop files to upload to Projects"),
  ).toBeVisible();
  await projects.dispatchEvent("drop", { dataTransfer: single });
  await expect(page.getByText("File uploaded to Projects.")).toBeVisible();
  await expect(projects).not.toHaveClass(/drop-target/);
  await expect(
    page.getByRole("button", { name: "into-folder.txt, file" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Projects, folder" }).dblclick();
  await expect(
    page.getByRole("button", { name: "into-folder.txt, file" }),
  ).toBeVisible();

  const up = await osFiles(page, ["to-root.txt"]);
  const crumb = page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("button", { name: "My drive" });
  await crumb.dispatchEvent("dragenter", { dataTransfer: up });
  await crumb.dispatchEvent("dragover", { dataTransfer: up });
  await expect(crumb).toHaveClass(/drop-target/);
  await crumb.dispatchEvent("drop", { dataTransfer: up });
  await expect(page.getByText("File uploaded to My drive.")).toBeVisible();
  await crumb.click();
  await expect(
    page.getByRole("button", { name: "to-root.txt, file" }),
  ).toBeVisible();
});

test("dragging items moves them, trashes them and refuses invalid drops", async ({
  page,
}) => {
  await page.goto("/drive");
  const pdf = page.getByRole("button", { name: "Welcome to Drive.pdf, file" });
  await pdf.dragTo(page.getByRole("button", { name: "Photos, folder" }));
  await expect(
    page.getByText("Moved Welcome to Drive.pdf to Photos."),
  ).toBeVisible();
  await expect(pdf).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Move undone.")).toBeVisible();
  await expect(pdf).toBeVisible();

  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(page.getByText("File uploaded.")).toBeVisible();
  await pdf.click();
  await page
    .getByRole("button", { name: "notes.txt, file" })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(
    page.getByRole("toolbar", { name: "Actions for 2 items" }),
  ).toBeVisible();
  await expect(page.getByLabel("Select notes.txt")).toBeChecked();
  await checkAxe(page);
  await page
    .getByRole("button", { name: "notes.txt, file" })
    .dragTo(page.getByRole("button", { name: "Projects", exact: true }));
  await expect(page.getByText("Moved 2 items to Projects.")).toBeVisible();
  await expect(pdf).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(pdf).toBeVisible();

  await pdf.dragTo(page.getByRole("button", { name: "Trash", exact: true }));
  await expect(page.getByText("Moved to trash.")).toBeVisible();
  await expect(pdf).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Item restored.")).toBeVisible();
  await expect(pdf).toBeVisible();

  const drag = await page.evaluateHandle(() => new DataTransfer());
  const projects = row(page, "Projects, folder");
  await projects.dispatchEvent("dragstart", { dataTransfer: drag });
  await projects.dispatchEvent("dragover", { dataTransfer: drag });
  await expect(projects).toHaveClass(/drop-refused/);
  await projects.dispatchEvent("drop", { dataTransfer: drag });
  await expect(
    page.getByText("A folder cannot be moved into itself"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Projects, folder" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "New folder" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "My drive", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await checkAxe(page);
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await expect(page.getByRole("dialog", { name: "New folder" })).toBeVisible();
});

test("download a folder or selection as ZIP and show preparation errors", async ({
  page,
}) => {
  await page.goto("/drive");
  await page.getByRole("button", { name: "Projects, folder" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as ZIP" }).click();
  expect((await download).suggestedFilename()).toBe("Drive.zip");
  await expect(page.getByText("ZIP download started.")).toBeVisible();
  await page
    .getByRole("button", { name: "Photos, folder" })
    .click({ modifiers: ["Control"] });
  await expect(
    page
      .getByRole("toolbar", { name: "Actions for 2 items" })
      .getByRole("button", { name: "Download as ZIP" }),
  ).toBeVisible();
  const selectionDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as ZIP" }).click();
  expect((await selectionDownload).suggestedFilename()).toBe("Drive.zip");
  await page.evaluate(() =>
    sessionStorage.setItem("drive-fixture-fail-action", "1"),
  );
  await page.getByRole("button", { name: "Download as ZIP" }).click();
  await expect(page.getByText("Could not prepare ZIP download.")).toBeVisible();
});

test("shares by email address and lists access with Copy and Revoke", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await page.goto("/drive");
  await page
    .getByRole("button", { name: "Welcome to Drive.pdf, file" })
    .click();
  const share = page
    .getByRole("toolbar", { name: "Actions for Welcome to Drive.pdf" })
    .getByRole("button", { name: "Share" });
  await share.click();
  const dialog = page.getByRole("dialog", {
    name: "Share Welcome to Drive.pdf",
  });
  const people = dialog.getByRole("region", { name: "People with access" });
  const links = dialog.getByRole("region", { name: "Public links" });
  const address = dialog.getByLabel("Email address");
  await expect(people.getByText("Only you have access.")).toBeVisible();
  await expect(links.getByText("No active links.")).toBeVisible();
  await expect(address).toBeFocused();

  await address.fill("someone");
  await page.keyboard.press("Enter");
  await expect(dialog.getByText(/Enter an email address/)).toBeVisible();
  await address.fill("nobody@example.org");
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByText("No account on this server uses this address."),
  ).toBeVisible();
  await expect(address).toBeFocused();
  await expect(people.getByText("Only you have access.")).toBeVisible();

  await address.fill("colleague@example.org");
  await dialog.getByLabel("Access", { exact: true }).selectOption("write");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    page.getByText("Shared with colleague@example.org."),
  ).toBeVisible();
  await expect(address).toHaveValue("");
  await expect(people.getByText("colleague@example.org")).toBeVisible();
  await expect(people.getByText("Can edit")).toBeVisible();
  await people
    .getByRole("button", { name: "Copy colleague@example.org" })
    .click();
  await expect(page.getByText("Address copied.")).toBeVisible();
  expect(await clipboard()).toBe("colleague@example.org");

  await links.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByText("Public link created.")).toBeVisible();
  const copyLink = links.getByRole("button", { name: /^Copy Public link/ });
  await expect(copyLink).toBeFocused();
  await copyLink.click();
  await expect(page.getByText("Link copied.")).toBeVisible();
  expect(await clipboard()).toMatch(/\/drive\/api\/v1\/public\/[\w-]+$/);
  await checkAxe(page);

  // Revoking needs no identifier and focus stays in the dialog.
  await links.getByRole("button", { name: /^Revoke Public link/ }).click();
  await expect(page.getByText("Link revoked.")).toBeVisible();
  await expect(links.getByText("No active links.")).toBeVisible();
  await expect(
    links.getByRole("button", { name: "Create link" }),
  ).toBeFocused();
  await people
    .getByRole("button", { name: "Remove access for colleague@example.org" })
    .click();
  await expect(
    page.getByText("Access removed for colleague@example.org."),
  ).toBeVisible();
  await expect(people.getByText("Only you have access.")).toBeVisible();
  await expect(address).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(share).toBeFocused();
});

test("focus follows new folder, rename, trash and restore", async ({
  page,
}) => {
  await page.goto("/drive");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Archive");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Folder created.")).toBeVisible();
  const archive = page.getByRole("button", { name: "Archive, folder" });
  await expect(archive).toBeFocused();

  await page.keyboard.press("Space");
  await page
    .getByRole("toolbar", { name: "Actions for Archive" })
    .getByRole("button", { name: "Rename" })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Archives");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Item renamed.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archives, folder" }),
  ).toBeFocused();

  // A dismissed dialog gives focus back to the button that opened it.
  const rename = page
    .getByRole("toolbar", { name: "Actions for Archives" })
    .getByRole("button", { name: "Rename" });
  await rename.click();
  await page.keyboard.press("Escape");
  await expect(rename).toBeFocused();

  // The next item takes the place of the trashed one.
  await page
    .getByRole("toolbar", { name: "Actions for Archives" })
    .getByRole("button", { name: "Move to trash" })
    .click();
  await expect(page.getByText("Moved to trash.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Photos, folder" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Photos, folder" }).click();
  await page
    .getByRole("toolbar", { name: "Actions for Photos" })
    .getByRole("button", { name: "Move to trash" })
    .click();
  await expect(
    page.getByRole("button", { name: "Projects, folder" }),
  ).toBeFocused();

  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Archives, folder" }).click();
  await page
    .getByRole("toolbar", { name: "Actions for Archives" })
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(page.getByText("Item restored.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Photos, folder" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Photos, folder" }).click();
  await page
    .getByRole("toolbar", { name: "Actions for Photos" })
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeFocused();
});
