import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}
const themes: ("light" | "dark")[] = ["light", "dark"];
for (const theme of themes) {
  test(`${theme} mail, safe images and accessibility`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("https://images.example.test/**", (route) =>
      route.abort(),
    );
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/mail");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: /Maya Chen/ }).click();
    await expect(
      page.getByRole("heading", { name: "A little update for Friday" }),
    ).toBeVisible();
    const frame = page.locator('iframe[title="Message from Maya Chen"]');
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-popups allow-popups-to-escape-sandbox",
    );
    await expect(frame).toHaveAttribute("srcdoc", /default-src 'none'/);
    await expect(frame).not.toHaveAttribute("srcdoc", /src="https:\/\/images/);
    await page.getByRole("button", { name: "Load images" }).click();
    await expect(frame).toHaveAttribute("srcdoc", /src="https:\/\/images/);
    await axe(page);
  });
}
test("keyboard navigation, compose, send, reply and search", async ({
  page,
}) => {
  await page.goto("/mail");
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "A little update for Friday" }),
  ).toBeVisible();
  await page.keyboard.press("r");
  const reply = page.getByRole("region", { name: "Compose message" });
  await expect(reply.getByLabel("To", { exact: true })).toHaveValue(
    "maya@example.test",
  );
  await reply.getByLabel("Message body").fill("Thanks for the update!");
  await reply.getByRole("button", { name: /Send/ }).click();
  await expect(page.getByText("Message sent.")).toBeVisible();
  await page.keyboard.press("c");
  const compose = page.getByRole("region", { name: "Compose message" });
  await compose.getByLabel("To", { exact: true }).fill("friend@example.test");
  await compose.getByLabel("Subject").fill("A new note");
  await compose.getByLabel("Message body").fill("Hello there");
  await compose.getByRole("button", { name: /Send/ }).click();
  await page.getByRole("button", { name: /Sent/ }).click();
  await expect(page.getByRole("button", { name: /A new note/ })).toBeVisible();
  await page.getByRole("button", { name: /Inbox/ }).click();
  await page.keyboard.press("/");
  await page.getByLabel("Search mail").fill("Weekend");
  await expect(page.getByRole("button", { name: /Alex Rivera/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toHaveCount(0);
});
test("archive, delete and move support undo", async ({ page }) => {
  await page.goto("/mail");
  await page.getByRole("button", { name: /Maya Chen/ }).click();
  await page
    .getByRole("region", { name: "Reading pane" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
  await page.getByRole("button", { name: /Maya Chen/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
  await page.getByRole("button", { name: /Maya Chen/ }).click();
  await page.getByLabel("Move to folder").selectOption("sent");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
});
test("mobile reading and back navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mail");
  await page.getByRole("button", { name: /Maya Chen/ }).click();
  await expect(
    page.getByRole("heading", { name: "A little update for Friday" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "← Back" }).click();
  await expect(page.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
  await axe(page);
});
test("production bundle excludes synthetic mail", async () => {
  const dir = "apps/web/dist/assets";
  const files = await readdir(dir);
  const scripts = await Promise.all(
    files
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(join(dir, file), "utf8")),
  );
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.join("\n")).not.toContain("OPENMAIL_SYNTHETIC_FIXTURE_ONLY");
  expect(scripts.join("\n")).not.toContain("maya@example.test");
});

test("upstream error retries and failed actions roll back", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("mail-fixture-fail-list", "1"),
  );
  await page.goto("/mail");
  await expect(page.getByText("Mail is unavailable")).toBeVisible();
  await page.evaluate(() =>
    sessionStorage.removeItem("mail-fixture-fail-list"),
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("button", { name: /Alex Rivera/ }).click();
  await page.evaluate(() =>
    sessionStorage.setItem("mail-fixture-fail-action", "1"),
  );
  await page
    .getByRole("region", { name: "Reading pane" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.getByText("Could not update the conversation. Please try again."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Alex Rivera/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});

test("multiple drafts can be saved, reopened and sent with an attachment", async ({
  page,
}) => {
  await page.goto("/mail");
  await page
    .getByRole("button", { name: /New message/ })
    .first()
    .click();
  const first = page.getByRole("region", { name: "Compose message" }).first();
  await first.getByLabel("To", { exact: true }).fill("friend@example.test");
  await first.getByLabel("Subject").fill("A saved draft");
  await first.getByLabel("Message body").fill("Here is the file.");
  await first.locator('input[type="file"]').setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("example attachment"),
  });
  await expect(first.getByText("1 attachment(s)")).toBeVisible();
  await first.getByRole("button", { name: "Minimize draft" }).click();
  await expect(
    first.getByRole("button", { name: "Restore draft" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /New message/ })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Compose message" }),
  ).toHaveCount(2);
  await first.getByRole("button", { name: "Save and close draft" }).click();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: /Drafts/ }).click();
  await page.getByRole("button", { name: /A saved draft/ }).click();
  const restored = page.getByRole("region", { name: "Compose message" });
  await expect(restored.getByLabel("Message body")).toHaveValue(
    "Here is the file.",
  );
  await restored.getByRole("button", { name: "Maximize draft" }).click();
  await restored.getByRole("button", { name: /Send/ }).click();
  await page.getByRole("button", { name: /Sent/ }).click();
  await page.getByRole("button", { name: /A saved draft/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /note.txt/ }).click();
  expect((await download).suggestedFilename()).toBe("note.txt");
});
