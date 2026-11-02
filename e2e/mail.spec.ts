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
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
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
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    await expect(frame).toHaveAttribute("srcdoc", /default-src 'none'/);
    await expect(frame).not.toHaveAttribute("srcdoc", /src="https:\/\/images/);
    await expect(frame).toHaveAttribute("srcdoc", /src="blob:/);
    await expect(frame).toHaveCSS("min-height", /px/);
    await page.getByRole("button", { name: "Load images" }).click();
    await expect(frame).toHaveAttribute("srcdoc", /src="https:\/\/images/);
    await axe(page);
  });
}
test("mail folders keep Inbox first regardless of server order", async ({
  page,
}) => {
  await page.goto("/mail");
  const folders = page.getByRole("navigation", { name: "Mail folders" });
  await expect(folders.locator(".shell-nav-label")).toHaveText([
    "Inbox",
    "Drafts",
    "Sent",
    "Archive",
    "Junk Mail",
    "Trash",
    "Work",
  ]);
  await expect(folders.getByRole("button", { name: /Inbox/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await folders.getByRole("button", { name: "Junk Mail" }).click();
  await expect(page.getByRole("heading", { name: "Junk Mail" })).toBeVisible();
  await expect(folders.getByText("Labels")).toBeVisible();
});
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
  await expect(
    page.getByText("Message queued.", { exact: false }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Move to folder" }).click();
  await page.getByRole("menuitem", { name: "Sent" }).click();
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
  await page.getByRole("button", { name: "Back", exact: true }).click();
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
  expect(scripts.join("\n")).not.toContain("synthetic-password");
});

test("upstream error retries and failed actions roll back", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window === window.top)
      sessionStorage.setItem("mail-fixture-fail-list", "1");
  });
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
  await expect(
    first.getByRole("list", { name: "Attachments" }).getByText("note.txt"),
  ).toBeVisible();
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

test("reply-to and HTML-only forwarding", async ({ page }) => {
  await page.goto("/mail");
  await page.getByRole("button", { name: /Alex Rivera/ }).click();
  await page.keyboard.press("r");
  const composer = page.getByRole("region", { name: "Compose message" });
  await expect(composer.getByLabel("To", { exact: true })).toHaveValue(
    "replies@example.test",
  );
  await composer.getByRole("button", { name: "Save and close draft" }).click();
  await page.keyboard.press("f");
  await expect(
    composer.getByLabel("Message body", { exact: true }),
  ).toHaveValue(/Are you free to catch up this weekend\?/);
  await expect(
    composer.getByLabel("Message body", { exact: true }),
  ).not.toHaveValue(/<p>/);
});

test("plain-text messages preserve literal markup and line breaks", async ({
  page,
}) => {
  await page.goto("/mail");
  await page.getByRole("button", { name: /Studio Notes/ }).click();
  const body = page
    .frameLocator('iframe[title="Message from Studio Notes"]')
    .locator("body");
  await expect(body).toContainText("Plain text with <b>literal markup</b>");
  await expect(body.locator("b")).toHaveCount(0);
  await expect(body.locator("br")).toHaveCount(1);
});

test("bulk selection, quick row actions and the large composer", async ({
  page,
}) => {
  await page.goto("/mail");
  const list = page.getByRole("region", { name: "Conversations" });
  await expect(list.getByRole("button", { name: /Maya Chen/ })).toBeVisible();
  await list
    .getByRole("checkbox", { name: "Select all conversations" })
    .check();
  await expect(list.getByText("3 selected")).toBeVisible();
  await list.getByRole("button", { name: "Mark selected as read" }).click();
  await page.keyboard.press("Escape");
  await expect(list.getByText("3 selected")).toHaveCount(0);
  await expect(list.getByText("3 conversations")).toBeVisible();
  await list.getByRole("button", { name: /Alex Rivera/ }).hover();
  await list
    .getByRole("listitem")
    .filter({ hasText: "Alex Rivera" })
    .getByRole("button", { name: "Archive conversation" })
    .click();
  await expect(list.getByRole("button", { name: /Alex Rivera/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(list.getByRole("button", { name: /Alex Rivera/ })).toBeVisible();

  await page.keyboard.press("c");
  const composer = page.getByRole("region", { name: "Compose message" });
  await expect(composer.getByLabel("To", { exact: true })).toBeFocused();
  const box = await composer.boundingBox();
  expect(box?.width).toBeGreaterThan(600);
  expect(box?.height).toBeGreaterThan(600);
  await composer.getByLabel("To", { exact: true }).fill("not-an-address");
  await composer.getByRole("button", { name: /Send/ }).click();
  await expect(composer.getByText(/Check these addresses/)).toBeVisible();
  const drop = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "dropped.txt", { type: "text/plain" }));
    return data;
  });
  await composer.dispatchEvent("dragenter", { dataTransfer: drop });
  await composer.dispatchEvent("drop", { dataTransfer: drop });
  await expect(
    composer
      .getByRole("list", { name: "Attachments" })
      .getByText("dropped.txt"),
  ).toBeVisible();
  await composer.getByRole("button", { name: "Maximize draft" }).click();
  const expanded = await composer.boundingBox();
  expect(expanded?.width).toBeGreaterThan(1000);
  await composer.getByLabel("Message body").press("Escape");
  await composer.getByRole("button", { name: "Discard draft" }).click();
  await expect(composer).toHaveCount(0);
});

const devices = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const;
const conversation = (page: Page, name: string) =>
  page
    .getByRole("region", { name: "Conversations" })
    .getByRole("button", { name: new RegExp(name) });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications (F8)" });

for (const theme of themes)
  for (const [device, viewport] of devices)
    test(`${theme} ${device}: keyboard triage keeps focus on the next conversation`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(() =>
        localStorage.setItem("opensuite-theme", "system"),
      );
      await page.clock.install();
      await page.goto("/mail");
      await expect(conversation(page, "Maya Chen")).toBeVisible();
      await page.keyboard.press("j");
      await expect(conversation(page, "Maya Chen")).toBeFocused();
      await page.keyboard.press("Enter");
      const subject = page.getByRole("heading", {
        name: "A little update for Friday",
      });
      await expect(subject).toBeVisible();
      // On a phone the reader covers the list, and focus follows it.
      await expect(
        device === "mobile" ? subject : conversation(page, "Maya Chen"),
      ).toBeFocused();

      await page.keyboard.press("e");
      await expect(conversation(page, "Maya Chen")).toHaveCount(0);
      await expect(conversation(page, "Alex Rivera")).toBeFocused();
      const toast = notifications(page);
      await expect(toast).toContainText("Conversation archived.");
      // Focus on Undo holds the offer well past its ten seconds.
      await page.keyboard.press("F8");
      const undo = toast.getByRole("button", { name: "Undo" });
      await expect(undo).toBeFocused();
      await page.clock.runFor(30_000);
      await expect(undo).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(toast).toContainText("Conversation restored.");
      await expect(conversation(page, "Maya Chen")).toBeFocused();
      await expect(conversation(page, "Maya Chen")).toHaveAttribute(
        "aria-current",
        "true",
      );
      await axe(page);

      // # moves to trash and Z undoes it.
      await page.keyboard.press("#");
      await expect(conversation(page, "Alex Rivera")).toBeFocused();
      await expect(toast).toContainText("Conversation moved to trash.");
      await page.keyboard.press("z");
      await expect(toast).toContainText("Conversation restored.");
      await expect(conversation(page, "Maya Chen")).toBeFocused();

      // Moving from the reader's menu.
      await page.keyboard.press("Enter");
      await expect(subject).toBeVisible();
      await page.getByRole("button", { name: "Move to folder" }).focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "Junk Mail" }),
      ).toBeVisible();
      await page.keyboard.type("j");
      await expect(
        page.getByRole("menuitem", { name: "Junk Mail" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toast).toContainText("Conversation moved.");
      await expect(conversation(page, "Maya Chen")).toHaveCount(0);
      await expect(conversation(page, "Alex Rivera")).toBeFocused();

      // X selects; archiving everything leaves focus on the list heading,
      // and Undo brings it to the restored conversation.
      await page.keyboard.press("x");
      await page.keyboard.press("j");
      await expect(conversation(page, "Studio Notes")).toBeFocused();
      await page.keyboard.press("x");
      await expect(
        page.getByRole("region", { name: "Conversations" }),
      ).toContainText("2 selected");
      await page.keyboard.press("e");
      await expect(toast).toContainText("2 conversations archived.");
      await expect(page.getByRole("heading", { name: "Inbox" })).toBeFocused();
      await page.keyboard.press("z");
      await expect(toast).toContainText("Conversations restored.");
      await expect(conversation(page, "Alex Rivera")).toBeFocused();
    });

test("deleting forever from the trash keeps focus in the list", async ({
  page,
}) => {
  await page.goto("/mail");
  await expect(conversation(page, "Maya Chen")).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("#");
  await expect(conversation(page, "Alex Rivera")).toBeFocused();
  await page.keyboard.press("#");
  await page
    .getByRole("navigation", { name: "Mail folders" })
    .getByRole("button", { name: "Trash" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await expect(conversation(page, "Alex Rivera")).toBeVisible();
  await page.keyboard.press("j");
  await expect(conversation(page, "Maya Chen")).toBeFocused();
  await page.keyboard.press("#");
  const dialog = page.getByRole("dialog", { name: "Delete permanently?" });
  await expect(dialog).toContainText(
    "This conversation will be deleted forever.",
  );
  await dialog.getByRole("button", { name: "Delete forever" }).focus();
  await page.keyboard.press("Enter");
  // Permanent deletion offers no Undo, only the dismiss button.
  await expect(notifications(page)).toContainText("Conversation deleted.");
  await expect(notifications(page).getByRole("button")).toHaveCount(1);
  await expect(conversation(page, "Alex Rivera")).toBeFocused();

  await page.keyboard.press("x");
  await page.keyboard.press("#");
  await dialog.getByRole("button", { name: "Delete forever" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Nothing in Trash.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeFocused();
});

for (const [device, viewport] of devices)
  test(`${device}: sending and discarding return focus, and a discarded draft can be restored`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.goto("/mail");
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    const subject = page.getByRole("heading", {
      name: "A little update for Friday",
    });
    await expect(subject).toBeVisible();
    const back =
      device === "mobile" ? subject : conversation(page, "Maya Chen");
    await expect(back).toBeFocused();

    await page.keyboard.press("r");
    const composer = page.getByRole("region", { name: "Compose message" });
    const body = composer.getByLabel("Message body");
    await expect(body).toBeFocused();
    // A reply without text asks before sending.
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(composer.getByRole("alert")).toHaveText(
      "This message has no text. Send it anyway?",
    );
    await expect(
      composer.getByRole("button", { name: "Send anyway" }),
    ).toBeVisible();
    await page.keyboard.type("Thanks for the update!");
    await expect(composer.getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(composer).toHaveCount(0);
    await expect(notifications(page)).toContainText("Message queued.");
    await expect(back).toBeFocused();
    // A reply opened with its button also returns to the conversation.
    await page.getByRole("button", { name: "Reply", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(body).toBeFocused();
    await page.keyboard.type("One more thing.");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(composer).toHaveCount(0);
    await expect(back).toBeFocused();

    await page.keyboard.press("c");
    await expect(composer.getByLabel("To", { exact: true })).toBeFocused();
    await page.keyboard.type("friend@example.test");
    await composer.getByLabel("Subject").focus();
    await page.keyboard.type("Keep me");
    await page.keyboard.press("Tab");
    await expect(body).toBeFocused();
    await page.keyboard.type("Some words worth keeping");
    await page.clock.runFor(2000);
    await expect(composer.getByText("Draft saved")).toBeVisible();
    await composer.getByRole("button", { name: "Discard draft" }).focus();
    await page.keyboard.press("Enter");
    await expect(composer).toHaveCount(0);
    const toast = notifications(page);
    await expect(toast).toContainText("Draft discarded.");
    await expect(back).toBeFocused();
    const savedDraft = page.getByRole("button", { name: /Keep me/ });
    if (device === "desktop") {
      // The saved copy is deleted at once, not when the offer ends.
      await page
        .getByRole("navigation", { name: "Mail folders" })
        .getByRole("button", { name: /Drafts/ })
        .focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("No drafts")).toBeVisible();
    }
    // Z restores the draft and saves it again.
    await page.keyboard.press("z");
    await expect(body).toHaveValue("Some words worth keeping");
    await expect(body).toBeFocused();
    if (device === "desktop") await expect(savedDraft).toBeVisible();

    // So does the notification's Undo; without Undo it stays deleted.
    await composer.getByRole("button", { name: "Discard draft" }).focus();
    await page.keyboard.press("Enter");
    await expect(composer).toHaveCount(0);
    await page.keyboard.press("F8");
    await page.keyboard.press("Enter");
    await expect(body).toHaveValue("Some words worth keeping");
    await expect(body).toBeFocused();
    await composer.getByRole("button", { name: "Discard draft" }).focus();
    await page.keyboard.press("Enter");
    await expect(toast).toContainText("Draft discarded.");
    await page.clock.runFor(11_000);
    await expect(toast).not.toContainText("Draft discarded.");
    await expect(composer).toHaveCount(0);
    if (device === "desktop") {
      await expect(savedDraft).toHaveCount(0);
      await expect(page.getByText("No drafts")).toBeVisible();
    }
  });

for (const [device, viewport] of devices)
  test(`${device}: search filters take focus and close with Escape, outside clicks and Tab`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/mail");
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    const search = page.getByLabel("Search mail");
    const trigger = page.getByRole("button", { name: "Search filters" });
    const panel = page.getByRole("group", { name: "Search filters" });
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAttribute(
      "aria-controls",
      "mail-search-filters",
    );
    await expect(panel.getByLabel("From")).toBeFocused();
    await axe(page);
    await page.keyboard.type("alex");
    await expect(conversation(page, "Maya Chen")).toHaveCount(0);
    await expect(conversation(page, "Alex Rivera")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Escape closed only the panel: the filter and the list stay.
    await expect(conversation(page, "Alex Rivera")).toBeVisible();

    // A click on empty space outside closes it and focus goes back to the
    // button.
    await page.keyboard.press("Enter");
    await expect(panel.getByLabel("From")).toBeFocused();
    await page.mouse.click(20, viewport.height - 120);
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Done gives focus back; Tab past the panel closes it.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Clear filters" }).focus();
    await page.keyboard.press("Enter");
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await panel.getByRole("button", { name: "Done" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Done" }).focus();
    await page.keyboard.press("Tab");
    await expect(panel).toHaveCount(0);

    // In the search box, Escape first closes the panel, then clears the
    // search and hands focus to the list.
    await search.focus();
    await page.keyboard.type("Weekend");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await search.focus();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(search).toHaveValue("Weekend");
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeFocused();
    if (device === "desktop") {
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toBeVisible();
      await page
        .getByRole("navigation", { name: "Mail folders" })
        .getByRole("button", { name: "Work" })
        .click();
      await expect(page.getByRole("heading", { name: "Work" })).toBeVisible();
      await expect(panel).toHaveCount(0);
    }
  });

test("attachments are announced and long names keep a tooltip", async ({
  page,
}) => {
  await page.goto("/mail");
  await expect(conversation(page, "Maya Chen")).toBeVisible();
  await page.keyboard.press("c");
  const composer = page.getByRole("region", { name: "Compose message" });
  const name = `${"quarterly-report-".repeat(4)}final.txt`;
  await composer.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("example attachment"),
  });
  await expect(composer.locator(".compose-status")).toHaveText(
    `${name} attached (18 B)`,
  );
  await expect(
    composer.getByRole("list", { name: "Attachments" }).getByText(name),
  ).toHaveAttribute("title", name);
});
