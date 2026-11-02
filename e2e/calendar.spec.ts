import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

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

/** Text of the shared notification region. */
const notice = (page: Page) =>
  page.locator(".toast-viewport [aria-live='polite']");

/** Drags from 20 × 10 px inside `target` by `x` and `y` pixels. */
async function drag(page: Page, target: Locator, x: number, y: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The event is not visible");
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 20 + x / 2, box.y + 10 + y / 2, { steps: 4 });
  await page.mouse.move(box.x + 20 + x, box.y + 10 + y, { steps: 4 });
  await page.mouse.up();
}

async function deleteEvent(page: Page, title: string) {
  await chip(page, title).click();
  await page
    .getByRole("dialog", { name: title })
    .getByRole("button", { name: "Delete event" })
    .click();
  await page
    .getByRole("dialog", { name: "Delete event?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

/** The development calendar runs in the page; make its deletions fail. */
async function failDeletions(page: Page) {
  await page.route("**/src/dev-data/calendar.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /deleteEvent: api\.deleteEvent\.handler\(\(\{\s*input,\s*errors\s*\}\)\s*=>\s*\{/,
      (start) => `${start} throw errors.NOT_FOUND();`,
    );
    await route.fulfill({ response, body });
  });
}

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

test("keyboard changes are announced and focus stays on the event", async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press("c");
  const editor = page.getByRole("dialog", { name: "New event" });
  await expect(editor.getByLabel("Title")).toBeFocused();
  await page.keyboard.type("Planning");
  await page.keyboard.press("Control+Enter");
  await expect(notice(page)).toHaveText("Event created");
  await expect(chip(page, "Planning")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("dialog", { name: "Planning" })
      .getByRole("button", { name: "Edit event" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Edit event" }).getByLabel("Title"),
  ).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" review");
  await page.keyboard.press("Control+Enter");
  await expect(notice(page)).toHaveText("Event saved");
  const saved = chip(page, "Planning review");
  await expect(saved).toBeFocused();

  // Details, then Delete event and the Delete button of the confirmation.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Delete event" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "Delete event?" });
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    confirm.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    confirm.getByRole("button", { name: "Delete", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("Event deleted");
  await expect(saved).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: period("Week of 26 Oct – 1 Nov 2026") }),
  ).toBeFocused();

  await page.keyboard.press("F8");
  await expect(page.getByRole("button", { name: "Undo" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(saved).toBeFocused();
  await expect(notice(page)).toBeEmpty();
});

test("a creation from the Create button focuses the new event", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("button", { name: "Create C", exact: true })
    .first()
    .click();
  await page.keyboard.type("Offsite prep");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("Event created");
  await expect(chip(page, "Offsite prep")).toBeFocused();
});

test("a saved event outside the shown period leaves focus on its trigger", async ({
  page,
}) => {
  await open(page);
  const create = page
    .getByRole("button", { name: "Create C", exact: true })
    .first();
  await create.click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Title").fill("Next week plan");
  await editor.getByLabel("Start date").fill("2026-11-04");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(notice(page)).toHaveText("Event created");
  await expect(create).toBeFocused();
  await expect(chip(page, "Next week plan")).toHaveCount(0);
});

test("a deletion is sent only when its notification closes", async ({
  page,
}) => {
  await failDeletions(page);
  await open(page);
  const review = chip(page, "Design review");
  // Undo shows the original event again; nothing reaches the server.
  await deleteEvent(page, "Design review");
  await expect(notice(page)).toHaveText("Event deleted");
  await expect(review).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(review).toBeFocused();
  await review.click();
  await expect(
    page
      .getByRole("dialog", { name: "Design review" })
      .getByText("Walk through the new calendar views."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(notice(page)).toBeEmpty();
  // Dismissing the notification sends it; the failure brings it back.
  await deleteEvent(page, "Design review");
  await expect(notice(page)).toHaveText("Event deleted");
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(notice(page)).toHaveText(
    "The event could not be deleted. Your change was undone.",
  );
  await expect(review).toBeVisible();
});

test("leaving Calendar sends a waiting deletion", async ({ page }) => {
  await open(page);
  await deleteEvent(page, "Lunch with Sam");
  await expect(notice(page)).toHaveText("Event deleted");
  const products = page.getByRole("navigation", { name: "Products" });
  await products.getByRole("link", { name: "Drive" }).click();
  await expect(page).toHaveURL(/\/drive$/);
  // Its Undo would no longer be true.
  await expect(notice(page)).toBeEmpty();
  await products.getByRole("link", { name: "Calendar" }).click();
  await expect(chip(page, "Design review")).toBeVisible();
  await expect(chip(page, "Lunch with Sam")).toHaveCount(0);
});

test("moves are announced and can be undone", async ({ page }) => {
  await open(page);
  const review = chip(page, "Design review");
  const box = await review.boundingBox();
  if (!box) throw new Error("Design review is not visible");
  // One column to the right and half an hour later.
  await drag(page, review, box.width + 3, 24);
  await expect(notice(page)).toHaveText(
    /^Event moved to Tuesday,? 27 October · 10:30\s?–\s?11:30$/,
  );
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(review).toHaveAccessibleName(
    /Monday,? 26 October · 10:00\s?–\s?11:00/,
  );
  await expect(review).toBeFocused();
  await expect(notice(page)).toBeEmpty();

  const resized = await review.boundingBox();
  if (!resized) throw new Error("Design review is not visible");
  await page.mouse.move(resized.x + 20, resized.y + resized.height - 3);
  await page.mouse.down();
  await page.mouse.move(resized.x + 20, resized.y + resized.height + 24, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(notice(page)).toHaveText("Event now ends at 11:30");

  // A series moves back as a whole.
  const standUp = chip(page, "Team stand-up");
  await drag(page, standUp, 0, 48);
  await page
    .getByRole("dialog", { name: "Change recurring event?" })
    .getByRole("button", { name: "Change all occurrences" })
    .click();
  await expect(notice(page)).toHaveText("All occurrences moved");
  await expect(standUp).toHaveAccessibleName(/10:30\s?–\s?10:45/);
  await page.keyboard.press("F8");
  await page.keyboard.press("Enter");
  await expect(standUp).toHaveAccessibleName(
    /Wednesday,? 28 October · 09:30\s?–\s?09:45/,
  );
  await expect(standUp).toBeFocused();
  await page.keyboard.press("j");
  await expect(chip(page, "Team stand-up")).toHaveAccessibleName(
    /Wednesday,? 4 November · 09:30\s?–\s?09:45/,
  );
});

test("search lists matches from nearby months", async ({ page }) => {
  await open(page);
  const search = page.getByLabel("Search events");
  await search.fill("roadmap");
  await expect(
    page.getByText("No events match “roadmap” this week."),
  ).toBeVisible();
  await search.press("Enter");
  const results = page.getByRole("region", { name: "Results for “roadmap”" });
  await expect(results).toBeFocused();
  await expect(results.getByRole("status")).toHaveText(
    "1 event between April 2026 and April 2027.",
  );
  await page.keyboard.press("Escape");
  await expect(results).toHaveCount(0);
  await expect(search).toBeFocused();

  await page.getByRole("button", { name: "Search nearby months" }).click();
  await expect(results).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(
    results.getByRole("button", { name: /^Roadmap workshop, Monday,? 2/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: period("2 – 8 Nov 2026") }),
  ).toBeVisible();
  await expect(chip(page, "Roadmap workshop")).toBeFocused();
});

test("a cleared search does not interrupt typing the next one", async ({
  page,
}) => {
  await open(page);
  const search = page.getByLabel("Search events");
  const results = page.locator(".cal-results");
  await search.fill("design");
  await search.press("Enter");
  await expect(results).toBeFocused();
  await search.focus();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toBeFocused();
  await page.keyboard.type("roadmap");
  await expect(search).toHaveValue("roadmap");
  await expect(search).toBeFocused();
  await expect(results).toHaveCount(0);
  // Escape in the field clears it too.
  await search.press("Enter");
  await expect(results).toBeFocused();
  await search.focus();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await page.keyboard.type("lunch");
  await expect(search).toHaveValue("lunch");
  await expect(results).toHaveCount(0);
});

test.describe("on a phone", () => {
  // Touch emulation also makes the browser report that it cannot hover.
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("the week shows three days and no keyboard hints", async ({ page }) => {
    await page.clock.setFixedTime(now);
    await page.goto("/calendar");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    await page.getByRole("button", { name: "3 days", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: period("28 – 30 Oct 2026") }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Open day view$/ }),
    ).toHaveCount(3);
    await page.getByRole("button", { name: "Next 3 days" }).click();
    await expect(
      page.getByRole("heading", { name: period("31 Oct – 2 Nov 2026") }),
    ).toBeVisible();
    await expect(chip(page, "Roadmap workshop")).toBeVisible();

    await page.getByRole("button", { name: "Day", exact: true }).click();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(
      page.getByRole("heading", { name: /Sunday,? 1 November 2026/ }),
    ).toBeVisible();
    await expect(page.locator(".cal-empty output")).toHaveText(
      "Nothing scheduled this day. Select a time to add an event.",
      { useInnerText: true },
    );
    // The empty day still has a keyboard stop to scroll the hours.
    await axe(page);
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} notifications and search results are accessible`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
    await page.emulateMedia({ colorScheme: theme });
    await open(page);
    await deleteEvent(page, "Lunch with Sam");
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
    await axe(page);
    await page.getByLabel("Search events").fill("design");
    await page.getByLabel("Search events").press("Enter");
    const results = page.getByRole("region", { name: "Results for “design”" });
    await expect(
      results.getByRole("button", { name: /^Design conference,/ }),
    ).toBeVisible();
    await axe(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(results).toBeVisible();
    await axe(page);
  });
}
