import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Wednesday 28 October 2026, 10:00 in Paris. The synthetic calendar places
// its events relative to the current week, so the clock fixes the layout.
const now = new Date("2026-10-28T09:00:00Z");
test.use({ locale: "en-GB", timezoneId: "Europe/Paris" });

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

async function open(page: Page) {
  await page.clock.setFixedTime(now);
  await page.goto("/calendar");
  await expect(
    page.getByRole("heading", { name: period("26 Oct – 1 Nov 2026") }),
  ).toBeVisible();
}

/** Period titles use thin or no spaces around the dash depending on ICU. */
function period(title: string) {
  const [from = "", to = ""] = title.split(" – ");
  return new RegExp(`^${from}\\s?–\\s?${to}$`, "u");
}

const chip = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${title},`) });

test("a reminder link opens its event", async ({ page }) => {
  await page.clock.setFixedTime(now);
  await page.goto(
    `/calendar?event=design-review&start=${encodeURIComponent(now.toISOString())}`,
  );
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await expect(editor.getByLabel("Title")).toHaveValue("Design review");
});

test("the event editor saves and reloads a reminder", async ({ page }) => {
  await open(page);
  await page
    .getByRole("button", { name: "Create C", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Title").fill("Reminder test");
  await editor.getByLabel("Reminder").selectOption("10m");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(chip(page, "Reminder test")).toBeVisible();
  await chip(page, "Reminder test").click();
  await page
    .getByRole("dialog", { name: "Reminder test" })
    .getByRole("button", { name: "Edit event" })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit event" });
  await expect(edit.getByLabel("Reminder")).toHaveValue("10m");
  await edit.getByLabel("Reminder").selectOption("none");
  await edit.getByRole("button", { name: "Save" }).click();
  await chip(page, "Reminder test").click();
  await page
    .getByRole("dialog", { name: "Reminder test" })
    .getByRole("button", { name: "Edit event" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit event" }).getByLabel("Reminder"),
  ).toHaveValue("none");
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} week, month and popovers are accessible`, async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
    await page.emulateMedia({ colorScheme: theme });
    await open(page);
    await expect(chip(page, "Design review")).toBeVisible();
    await expect(chip(page, "Design conference")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Wednesday,? 28 October, today/ }),
    ).toHaveAttribute("aria-current", "date");
    await axe(page);
    await chip(page, "Lunch with Sam").click();
    const details = page.getByRole("dialog", { name: "Lunch with Sam" });
    await expect(details.getByText("Café Lumen")).toBeVisible();
    await axe(page);
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "October 2026" }),
    ).toBeVisible();
    await expect(chip(page, "Roadmap workshop")).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: "Day", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /Wednesday,? 28 October 2026/ }),
    ).toBeVisible();
    await axe(page);
  });
}

test("keyboard shortcuts switch views and periods", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j");
  await expect(
    page.getByRole("heading", { name: period("2 – 8 Nov 2026") }),
  ).toBeVisible();
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await expect(
    page.getByRole("heading", { name: period("19 – 25 Oct 2026") }),
  ).toBeVisible();
  await page.keyboard.press("t");
  await expect(
    page.getByRole("heading", { name: period("26 Oct – 1 Nov 2026") }),
  ).toBeVisible();
  await page.keyboard.press("m");
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  await page.keyboard.press("n");
  await expect(
    page.getByRole("heading", { name: "November 2026" }),
  ).toBeVisible();
  await page.keyboard.press("d");
  await expect(
    page.getByRole("button", { name: "Day", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // The last view is remembered.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Day", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("w");
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help.getByText("Create an event")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  // Shortcuts are ignored while typing.
  await page.getByLabel("Search events").fill("dentist");
  await expect(chip(page, "Dentist")).toBeVisible();
  await expect(chip(page, "Design review")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: period("26 Oct – 1 Nov 2026") }),
  ).toBeVisible();
});

test("quick create, edit and delete an event", async ({ page }) => {
  await open(page);
  // Tuesday 27 October at 16:00: one hour below the 15:00 line.
  const columns = page.locator(".cal-columns");
  await page.locator(".cal-scroll").evaluate((element) => {
    element.scrollTop = 12 * 48;
  });
  const grid = await columns.boundingBox();
  if (!grid) throw new Error("Time grid is not visible");
  await page.mouse.click(
    grid.x + (grid.width / 7) * 1.5,
    grid.y + 16 * 48 + 10,
  );
  const quick = page.getByRole("dialog", { name: "New event" });
  await expect(
    quick.getByText(/Tuesday,? 27 October · 16:00\s?–\s?17:00/),
  ).toBeVisible();
  await expect(quick.getByLabel("Title")).toBeFocused();
  await page.keyboard.type("Budget sync");
  await page.keyboard.press("Enter");
  await expect(quick).toHaveCount(0);
  await expect(chip(page, "Budget sync")).toContainText("16:00");

  await chip(page, "Budget sync").click();
  await page
    .getByRole("dialog", { name: "Budget sync" })
    .getByRole("button", { name: "Edit event" })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await expect(editor.getByLabel("Title")).toBeFocused();
  await editor.getByLabel("Title").fill("Budget review");
  await editor.getByLabel("Location").fill("Room 4");
  await editor.getByLabel("End time").fill("15:00");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByText("End must be after start.")).toBeVisible();
  await editor.getByLabel("End time").fill("17:30");
  await editor.getByLabel("Title").press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect(chip(page, "Budget review")).toContainText("16:00 – 17:30");
  await expect(chip(page, "Budget review")).toHaveAccessibleName(
    /Room 4, Personal$/,
  );

  await chip(page, "Budget review").click();
  await page.getByRole("button", { name: "Delete event" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete event?" });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(chip(page, "Budget review")).toHaveCount(0);
});

test("full editor creates an all-day event from the month grid", async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press("m");
  const cell = page.locator(".cal-month-cell").nth(18); // Friday 16 October
  const cellBox = await cell.boundingBox();
  if (!cellBox) throw new Error("Month grid is not visible");
  await cell.click({ position: { x: 20, y: cellBox.height - 12 } });
  const quick = page.getByRole("dialog", { name: "New event" });
  await expect(quick.getByText(/Friday,? 16 October/)).toBeVisible();
  await quick.getByLabel("Title").fill("Team offsite");
  await quick.getByRole("button", { name: "More options" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await expect(editor.getByLabel("All day")).toBeChecked();
  await expect(editor.getByLabel("Title")).toHaveValue("Team offsite");
  await editor.getByLabel("End date").fill("2026-10-17");
  await editor.getByLabel("Calendar").selectOption({ label: "Work" });
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(chip(page, "Team offsite")).toHaveAccessibleName(
    /Friday,? 16( October)?\s?–\s?Saturday,? 17 October, Work$/,
  );
});

test("recurring events confirm changes to every occurrence", async ({
  page,
}) => {
  await open(page);
  await chip(page, "Team stand-up").click();
  const details = page.getByRole("dialog", { name: "Team stand-up" });
  await expect(details.getByText("Every week")).toBeVisible();
  await details.getByRole("button", { name: "Delete all occurrences" }).click();
  await expect(
    page.getByText("This deletes every occurrence of “Team stand-up”."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  const standUp = chip(page, "Team stand-up");
  const box = await standUp.boundingBox();
  if (!box) throw new Error("Stand-up is not visible");
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, box.y + box.height / 2 + 24, { steps: 4 });
  await page.mouse.move(box.x + 10, box.y + box.height / 2 + 48, { steps: 4 });
  await page.mouse.up();
  const confirm = page.getByRole("dialog", { name: "Change recurring event?" });
  await expect(
    confirm.getByText("This changes every occurrence of “Team stand-up”."),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Change all occurrences" }).click();
  await expect(standUp).toHaveAccessibleName(/10:30\s?–\s?10:45/);
  await page.keyboard.press("j");
  await expect(chip(page, "Team stand-up")).toHaveAccessibleName(
    /Wednesday,? 4 November · 10:30\s?–\s?10:45/,
  );
});

test("drag moves and resizes events, Escape cancels", async ({ page }) => {
  await open(page);
  const review = chip(page, "Design review");
  let box = await review.boundingBox();
  if (!box) throw new Error("Design review is not visible");
  // One column to the right and half an hour later.
  const column = box.width + 3;
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 20 + column / 2, box.y + 22, { steps: 4 });
  await page.mouse.move(box.x + 20 + column, box.y + 34, { steps: 4 });
  await page.mouse.up();
  await expect(review).toHaveAccessibleName(
    /Tuesday,? 27 October · 10:30\s?–\s?11:30/,
  );

  box = await review.boundingBox();
  if (!box) throw new Error("Design review is not visible");
  await page.mouse.move(box.x + 20, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height + 24, { steps: 4 });
  await page.mouse.up();
  await expect(review).toHaveAccessibleName(/10:30\s?–\s?12:00/);

  box = await review.boundingBox();
  if (!box) throw new Error("Design review is not visible");
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 120, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(review).toHaveAccessibleName(/10:30\s?–\s?12:00/);
});

test("calendars can be hidden and created", async ({ page }) => {
  await open(page);
  await page.getByRole("checkbox", { name: "Work" }).uncheck();
  await expect(chip(page, "Design review")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Work" })).not.toBeChecked();
  await expect(chip(page, "Lunch with Sam")).toBeVisible();
  await expect(chip(page, "Design review")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Work" }).check();
  await expect(chip(page, "Design review")).toBeVisible();

  await page.getByRole("button", { name: "Create calendar" }).click();
  const dialog = page.getByRole("dialog", { name: "New calendar" });
  await dialog.getByLabel("Name").fill("Family");
  await dialog.getByRole("radio", { name: "Coral" }).check();
  await dialog.getByRole("button", { name: "Create calendar" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Family" })).toBeChecked();
});

test("mobile defaults to the day view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(now);
  await page.goto("/calendar");
  await expect(
    page.getByRole("button", { name: "Day", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "Design conference")).toBeVisible();
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(
    page.getByRole("heading", { name: /Thursday,? 29 October 2026/ }),
  ).toBeVisible();
  await expect(chip(page, "Hiring panel")).toBeVisible();
  await axe(page);
});

test("navigation from the month grid, mini month and empty weeks", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page
    .getByRole("button", { name: /Friday,? 30 October\. Open day view/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /Friday,? 30 October 2026/ }),
  ).toBeVisible();
  await expect(chip(page, "Morning run")).toBeVisible();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await page.getByRole("button", { name: /Monday,? 16 November 2026/ }).click();
  await expect(
    page.getByRole("heading", { name: period("16 – 22 Nov 2026") }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Work" }).uncheck();
  await expect(page.getByText(/Nothing scheduled this week/)).toBeVisible();
});
