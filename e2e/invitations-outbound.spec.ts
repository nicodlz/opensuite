import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// The organizer side of invitations, sent through the local organizer
// service of the development server: messages land in the synthetic Sent
// folder and synthetic guests answer a minute later. This shows the browser
// behaviour only; it proves nothing about delivery by a real mail server.
// Wednesday 28 October 2026, 10:00 in Paris.
const now = new Date("2026-10-28T09:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const sam = "sam@studio.example.test";
const ana = "ana@partner.example.test";
const lena = "lena@studio.example.test";
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
/** Opens Calendar with an extra sending address, team@esuno.net. */
async function open(page: Page, time = now) {
  await page.clock.setFixedTime(time);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("address-fixture-items"))
      sessionStorage.setItem(
        "address-fixture-items",
        JSON.stringify([{ id: "team", address: "team@esuno.net" }]),
      );
  });
  await page.goto("/calendar");
  const surface = page.locator(".cal-surface");
  // Under heavy parallel load the development server sometimes fails the
  // first fetch of the lazily loaded Calendar module; only then reload once.
  const failed = page.getByText("Failed to fetch dynamically imported module");
  await expect(surface.or(failed)).toBeVisible();
  if (await failed.isVisible()) await page.reload();
  await expect(surface).toHaveAttribute("aria-busy", "false");
}
const notice = (page: Page) =>
  page.locator(".toast-viewport [aria-live='polite']");
const chip = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${title},`) }).first();
const editorOf = (page: Page, name: "New event" | "Edit event") =>
  page.getByRole("dialog", { name });
const guestRow = (editor: Locator, email: string) =>
  editor.locator(".cal-guest", { hasText: email });

async function addGuests(editor: Locator, text: string) {
  const field = editor.getByLabel("Add guests");
  await field.fill(text);
  await field.press("Enter");
  await expect(field).toHaveValue("");
}
/** Starts a new event on Thursday 29 October at 14:00 with `guests`. */
async function draft(page: Page, title: string, guests: string[]) {
  await page.getByRole("button", { name: "Create C", exact: true }).click();
  const editor = editorOf(page, "New event");
  await editor.getByLabel("Title").fill(title);
  await editor.getByLabel("Start date").fill("2026-10-29");
  await editor.getByLabel("Start time").fill("14:00");
  await editor.getByLabel("End time").fill("15:00");
  if (guests.length) await addGuests(editor, guests.join(", "));
  return editor;
}
async function send(page: Page, title: string, action: string) {
  const review = page.getByRole("dialog", { name: title });
  await review.getByRole("button", { name: action, exact: true }).click();
  return review;
}
async function editEvent(page: Page, title: string) {
  await chip(page, title).click();
  await page
    .getByRole("dialog", { name: title })
    .getByRole("button", { name: "Edit event" })
    .click();
  return editorOf(page, "Edit event");
}

test("an organizer invites guests and follows their answers", async ({
  page,
}) => {
  await open(page);
  const editor = await draft(page, "Launch review", [sam, ana]);
  await editor.getByLabel("Add guests").fill(lena);
  await editor.getByRole("button", { name: "Add", exact: true }).click();
  await expect(editor.getByRole("list", { name: "Guest list" })).toContainText(
    lena,
  );
  await editor.getByRole("button", { name: `Remove ${lena}` }).click();
  await expect(guestRow(editor, lena)).toHaveCount(0);
  const from = editor.getByLabel("Send invitations from");
  await expect(from.locator("option")).toHaveText([
    "you@example.test",
    "team@esuno.net",
  ]);
  await from.selectOption("team@esuno.net");
  await expect(editor.getByLabel("Reminder")).toBeDisabled();
  await editor.getByRole("button", { name: "Save" }).click();

  const review = page.getByRole("dialog", { name: "Send invitations?" });
  await expect(review).toContainText("“Launch review”");
  await expect(review).toContainText(
    "Messages are sent from team@esuno.net to 2 guests. Esuno hands them to your mail server and can't confirm that they arrive.",
  );
  await expect(review.locator("dt")).toHaveText(["Invitation (2)"]);
  await expect(review.locator("dd li")).toHaveText([sam, ana]);
  await axe(page);
  await send(page, "Send invitations?", "Send invitations");
  await expect(notice(page)).toHaveText(
    "Invitations handed to your mail server for 2 guests. Delivery isn't confirmed.",
  );
  await expect(editor).toBeHidden();
  await expect(chip(page, "Launch review")).toBeFocused();

  const edit = await editEvent(page, "Launch review");
  await expect(edit).toContainText("Organizer: team@esuno.net");
  await expect(guestRow(edit, sam)).toContainText("Awaiting reply");
  await expect(guestRow(edit, ana)).toContainText("Awaiting reply");
  await expect(edit.getByLabel("Reminder")).toBeDisabled();
  await expect(edit.getByLabel("Calendar")).toBeDisabled();
  // The synthetic guests answer one minute after their invitation.
  await page.clock.setFixedTime(later(2));
  await edit.getByRole("button", { name: "Refresh answers" }).click();
  await expect(guestRow(edit, sam)).toContainText("Accepted");
  await expect(guestRow(edit, ana)).toContainText("Declined");
  await expect(edit.locator(".cal-guests-summary")).toHaveText(
    "Accepted: 1, Declined: 1",
  );
  await axe(page);
});

const folder = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Mail folders" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
const product = (page: Page, name: "Mail" | "Calendar") =>
  page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name, exact: true });
/** Messages handed to the synthetic mailbox, read in the Sent folder. */
async function sent(page: Page) {
  await product(page, "Mail").click();
  await folder(page, "Sent").click();
  await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
  await expect(
    page
      .locator(".thread-subject")
      .first()
      .or(page.getByText("Nothing in Sent.")),
  ).toBeVisible();
  return page.locator(".thread-subject");
}
/** The iCalendar attachment of each Sent message titled `subject`, by recipient. */
async function sentCalendars(page: Page, subject: string) {
  await sent(page);
  const ids = await page
    .locator("button.thread-open")
    .filter({ hasText: subject })
    .evaluateAll((rows) =>
      rows.map((row) =>
        row instanceof HTMLElement ? row.dataset["threadId"] : "",
      ),
    );
  const reader = page.getByRole("region", { name: "Reading pane" });
  const found = new Map<string, string[]>();
  const readAt = async (index: number): Promise<void> => {
    const id = ids[index];
    if (id === undefined) return;
    // Thread IDs stay put while the list refreshes; positions may not.
    const row = page.locator(`button.thread-open[data-thread-id="${id}"]`);
    await row.click();
    await expect(row).toHaveAttribute("aria-current", "true");
    const to = await reader.locator(".message-recipients").first().innerText();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      reader.getByRole("button", { name: /invite\.ics/ }).click(),
    ]);
    const text = await readFile(await download.path(), "utf8");
    found.set(to.replace(/^To /, ""), text.split("\r\n"));
    await readAt(index + 1);
  };
  await readAt(0);
  return found;
}
async function backToCalendar(page: Page) {
  await product(page, "Calendar").click();
  await expect(chip(page, "Design review")).toBeVisible();
}
async function invite(page: Page, title: string, guests: string[]) {
  const editor = await draft(page, title, guests);
  await editor.getByRole("button", { name: "Save" }).click();
  await send(page, "Send invitations?", "Send invitations");
  await expect(notice(page)).toHaveText(
    /^Invitations handed to your mail server/,
  );
}
const setFlag = (page: Page, name: string, value: string | null) =>
  page.evaluate(
    ([key, next]) => {
      if (next === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, next);
    },
    [name, value] as const,
  );

test("invitations are iTIP requests from the chosen address", async ({
  page,
}) => {
  await open(page);
  const editor = await draft(page, "Budget check", [sam]);
  await editor
    .getByLabel("Send invitations from")
    .selectOption("team@esuno.net");
  await editor.getByRole("button", { name: "Save" }).click();
  await send(page, "Send invitations?", "Send invitations");
  await expect(notice(page)).toHaveText(
    "Invitations handed to your mail server for 1 guest. Delivery isn't confirmed.",
  );
  await expect(await sent(page)).toHaveText(["Calendar invitation"]);
  const calendar = (await sentCalendars(page, "Calendar invitation")).get(sam);
  for (const line of [
    "METHOD:REQUEST",
    "SEQUENCE:0",
    "ORGANIZER:mailto:team@esuno.net",
    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${sam}`,
    "SUMMARY:Budget check",
  ])
    expect(calendar).toContain(line);
});

test("updates reach kept guests, removed ones get a cancellation", async ({
  page,
}) => {
  await open(page);
  const editor = await draft(page, "Weekly sync", [sam, ana, lena]);
  await editor.getByLabel("Repeat").selectOption("weekly");
  await editor.getByRole("button", { name: "Save" }).click();
  await send(page, "Send invitations?", "Send invitations");
  await expect(notice(page)).toHaveText(/for 3 guests/);

  await page.clock.setFixedTime(later(2));
  let edit = await editEvent(page, "Weekly sync");
  await expect(guestRow(edit, sam)).toContainText("Accepted");
  // Sam declined a single occurrence of the series.
  await expect(guestRow(edit, sam)).toContainText(
    /Declined on Thu, 5 Nov, 14:00/,
  );
  await expect(guestRow(edit, lena)).toContainText("Tentative");
  await edit.getByLabel("Title").fill("Weekly team sync");
  await edit.getByRole("button", { name: `Remove ${ana}` }).click();
  await expect(edit).toContainText(`Removed, will get a cancellation: ${ana}`);
  await addGuests(edit, "kim@example.test");
  await expect(guestRow(edit, "kim@example.test")).toContainText(
    "Will be invited",
  );
  await edit.getByRole("button", { name: "Save" }).click();
  const review = page.getByRole("dialog", { name: "Send updates?" });
  await expect(review.locator("dt")).toHaveText([
    "Invitation (1)",
    "Updated invitation (2)",
    "Cancellation (1)",
  ]);
  await expect(review.locator("dd li")).toHaveText([
    "kim@example.test",
    sam,
    lena,
    ana,
  ]);
  await expect(review).toContainText("Changes apply to every occurrence.");
  await expect(review).not.toContainText("answer again");
  await send(page, "Send updates?", "Save and send");
  await expect(notice(page)).toHaveText(
    "Updates handed to your mail server for 4 guests. Delivery isn't confirmed.",
  );
  // Every occurrence keeps the series; answers survive a new title.
  await expect(chip(page, "Weekly team sync")).toBeVisible();
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(chip(page, "Weekly team sync")).toBeVisible();
  await page.getByRole("button", { name: "Previous week" }).click();
  edit = await editEvent(page, "Weekly team sync");
  await expect(guestRow(edit, sam)).toContainText("Accepted");
  await expect(guestRow(edit, ana)).toHaveCount(0);

  // A new time asks everyone to answer again.
  await edit.getByLabel("Start time").fill("16:00");
  await edit.getByLabel("End time").fill("17:00");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(review).toContainText(
    "The time or repetition changed, so guests are asked to answer again.",
  );
  await send(page, "Send updates?", "Save and send");
  await expect(notice(page)).toHaveText(/^Updates handed/);
  edit = await editEvent(page, "Weekly team sync");
  await expect(guestRow(edit, sam)).toContainText("Awaiting reply");
  await page.keyboard.press("Escape");

  const cancellations = await sentCalendars(page, "Calendar cancellation");
  expect([...cancellations.keys()]).toEqual([ana]);
  const cancellation = cancellations.get(ana);
  expect(cancellation).toContain("METHOD:CANCEL");
  expect(cancellation).toContain("SEQUENCE:1");
  expect(cancellation).toContain(
    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ana}`,
  );
});

test("moving an event with guests is confirmed and sent as an update", async ({
  page,
}) => {
  await open(page);
  await invite(page, "Studio visit", [sam]);
  const event = chip(page, "Studio visit");
  const box = await event.boundingBox();
  if (!box) throw new Error("The event is not visible");
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 34, { steps: 4 });
  await page.mouse.move(box.x + 20, box.y + 58, { steps: 4 });
  await page.mouse.up();
  const review = page.getByRole("dialog", { name: "Send updates?" });
  await expect(review.locator("dd li")).toHaveText([sam]);
  await expect(review).toContainText("asked to answer again");
  await review.getByRole("button", { name: "Back" }).click();
  // Without confirmation nothing moved and nothing was sent.
  await expect(chip(page, "Studio visit")).toHaveAccessibleName(/14:00/);
  await expect(await sent(page)).toHaveText(["Calendar invitation"]);
});

test("cancelling an event notifies every guest, then removes it", async ({
  page,
}) => {
  await open(page);
  await invite(page, "Offsite", [sam, ana]);
  await chip(page, "Offsite").click();
  await page
    .getByRole("dialog", { name: "Offsite" })
    .getByRole("button", { name: "Delete event" })
    .click();
  const review = page.getByRole("dialog", {
    name: "Cancel event for everyone?",
  });
  await expect(review).toContainText(
    "A cancellation goes to 2 guests. The event is then removed from your calendar. This can't be undone.",
  );
  await expect(review.locator("dd li")).toHaveText([sam, ana]);
  await axe(page);
  await review
    .getByRole("button", { name: "Cancel event and notify guests" })
    .click();
  await expect(notice(page)).toHaveText(
    "Cancellations handed to your mail server for 2 guests. Delivery isn't confirmed.",
  );
  await expect(chip(page, "Offsite")).toHaveCount(0);
  const subjects = await sent(page);
  await expect(
    subjects.filter({ hasText: "Calendar cancellation" }),
  ).toHaveCount(2);
});

/** A send the service refuses with `flag`: it shows `text` and goes back. */
async function refused(page: Page, flag: string, text: string) {
  await setFlag(page, "organizer-fixture-outcome", flag);
  const editor = await draft(page, `Refused ${flag}`, [sam]);
  await editor.getByRole("button", { name: "Save" }).click();
  const review = await send(page, "Send invitations?", "Send invitations");
  await expect(review.getByRole("alert")).toHaveText(text);
  await review.getByRole("button", { name: "Back" }).click();
  await expect(editor.getByLabel("Title")).toHaveValue(`Refused ${flag}`);
  await editor.getByRole("button", { name: "Cancel" }).click();
}

test("refused, failed and uncertain sends stay explicit", async ({ page }) => {
  await open(page);
  // The mail server refuses one recipient: the others are still reported.
  let editor = await draft(page, "Partner call", [
    sam,
    "pat@bounce.example.test",
  ]);
  await editor.getByRole("button", { name: "Save" }).click();
  let review = await send(page, "Send invitations?", "Send invitations");
  const failure = review.getByRole("alert");
  await expect(failure.locator("p")).toHaveText(
    "Invitations handed to your mail server for 1 guest. Delivery isn't confirmed.",
  );
  await expect(failure.locator("li")).toHaveText(
    "Not sent to pat@bounce.example.test: the mail server refused the message.",
  );
  const close = review.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await close.click();
  await expect(chip(page, "Partner call")).toBeVisible();

  // An unknown outcome is retried with the same request: sent once.
  await setFlag(page, "organizer-fixture-outcome", "uncertain");
  editor = await draft(page, "Retry check", [lena]);
  await editor.getByRole("button", { name: "Save" }).click();
  review = await send(page, "Send invitations?", "Send invitations");
  await expect(review.getByRole("status")).toHaveText(
    "Esuno couldn't confirm whether the messages were sent. Trying again is safe: each guest gets this change at most once.",
  );
  await setFlag(page, "organizer-fixture-outcome", null);
  await review.getByRole("button", { name: "Try again" }).click();
  await expect(notice(page)).toHaveText(
    "Invitations handed to your mail server for 1 guest. Delivery isn't confirmed.",
  );

  // A send the service has not finished is checked by its operation.
  await setFlag(page, "organizer-fixture-outcome", "pending");
  editor = await draft(page, "Pending check", [ana]);
  await editor.getByRole("button", { name: "Save" }).click();
  review = await send(page, "Send invitations?", "Send invitations");
  await expect(review.getByRole("status")).toHaveText(
    "The event is saved, but sending isn't finished yet. Check the status again in a moment.",
  );
  await expect(editor).toBeHidden();
  await setFlag(page, "organizer-fixture-outcome", null);
  await review.getByRole("button", { name: "Check status" }).click();
  await expect(notice(page)).toHaveText(/^Invitations handed .* for 1 guest/);

  // Refusals send nothing and return to the editor.
  await refused(
    page,
    "forbidden",
    "You can't send from this address or change this calendar. Nothing was sent.",
  );
  await refused(
    page,
    "conflict",
    "The event changed elsewhere, or an earlier change is still being sent. Nothing was sent. Close this and open the event again.",
  );
  await setFlag(page, "organizer-fixture-outcome", null);

  // An address removed after it was chosen is refused by the service.
  editor = await draft(page, "Revoked sender", [sam]);
  await editor
    .getByLabel("Send invitations from")
    .selectOption("team@esuno.net");
  await setFlag(page, "address-fixture-items", "[]");
  await editor.getByRole("button", { name: "Save" }).click();
  review = await send(page, "Send invitations?", "Send invitations");
  await expect(review.getByRole("alert")).toContainText(
    "You can't send from this address",
  );
  await review.getByRole("button", { name: "Back" }).click();
  await editor.getByRole("button", { name: "Cancel" }).click();

  const subjects = await sent(page);
  await expect(subjects.filter({ hasText: "Calendar invitation" })).toHaveCount(
    3,
  );
});

test("an earlier send is checked again from the event's guest list", async ({
  page,
}) => {
  await open(page);
  await setFlag(page, "organizer-fixture-outcome", "pending");
  const editor = await draft(page, "Supplier sync", [
    sam,
    "pat@bounce.example.test",
  ]);
  await editor.getByRole("button", { name: "Save" }).click();
  const review = await send(page, "Send invitations?", "Send invitations");
  await expect(review.getByRole("status")).toContainText(
    "sending isn't finished yet",
  );
  await setFlag(page, "organizer-fixture-outcome", null);
  await review.getByRole("button", { name: "Close", exact: true }).click();
  const edit = await editEvent(page, "Supplier sync");
  await expect(edit).toContainText(
    "An earlier change is still being sent to the guests.",
  );
  await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
  await edit.getByRole("button", { name: "Check status" }).click();
  const found = edit.getByRole("alert");
  await expect(found.locator("p")).toHaveText(
    "The earlier change was sent, except to these guests:",
  );
  await expect(found.locator("li")).toHaveText(
    "Not sent to pat@bounce.example.test: the mail server refused the message.",
  );
  await expect(edit.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(guestRow(edit, sam)).toContainText("Awaiting reply");
});

test("unreadable guest lists block saving until they load", async ({
  page,
}) => {
  await open(page);
  await invite(page, "Board prep", [sam]);
  await setFlag(page, "organizer-fixture-status", "unavailable");
  const edit = await editEvent(page, "Board prep");
  await expect(edit.getByRole("alert")).toContainText(
    "This event's guests couldn't be loaded, so it can't be saved yet.",
  );
  await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(edit.locator(".cal-editor-block")).toHaveText(
    "Guests couldn't be loaded.",
  );
  // Ctrl + Enter does not save either: the change would lose the guests.
  await edit.getByLabel("Title").fill("Board prep moved");
  await edit.getByLabel("Title").press("Control+Enter");
  await expect(edit).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Send updates?" })).toHaveCount(
    0,
  );
  await setFlag(page, "organizer-fixture-status", null);
  await edit.getByRole("button", { name: "Retry" }).click();
  await expect(guestRow(edit, sam)).toContainText("Awaiting reply");
  await expect(edit.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("answers from unverified senders are listed but not counted", async ({
  page,
}) => {
  await open(page);
  const eve = "eve@unverified.example.test";
  await invite(page, "Vendor demo", [eve]);
  await page.clock.setFixedTime(later(2));
  const edit = await editEvent(page, "Vendor demo");
  await expect(guestRow(edit, eve)).toContainText("Awaiting reply");
  await edit.getByRole("button", { name: "Cancel" }).click();
  // The list of unverified answers is read again every minute.
  const banner = page.locator(".cal-banner-info");
  await expect(banner).toContainText(
    "1 guest answer couldn't be verified and isn't counted.",
    { timeout: 90_000 },
  );
  await banner.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Unverified guest answers" });
  await expect(review.locator(".cal-replies li")).toHaveText(
    `${eve} answered Accepted to “Vendor demo”. Not counted: Esuno couldn't confirm who sent it.`,
  );
  await axe(page);
});

test("plain events stay plain and existing ones cannot gain guests", async ({
  page,
}) => {
  await open(page);
  const edit = await editEvent(page, "Lunch with Sam");
  await expect(edit).toContainText(
    "Guests are invited when an event is created. To invite people, create a new event with them.",
  );
  await expect(edit.getByLabel("Add guests")).toHaveCount(0);
  await edit.getByLabel("Title").fill("Lunch with Sam and Ana");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(notice(page)).toHaveText("Event saved");
  await expect(page.getByRole("dialog", { name: "Send updates?" })).toHaveCount(
    0,
  );
});

test("signing out drops the previous session's guests and addresses", async ({
  page,
}) => {
  await open(page);
  await invite(page, "Private review", [sam]);
  const edit = await editEvent(page, "Private review");
  await expect(guestRow(edit, sam)).toContainText("Awaiting reply");
  await edit.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  // The next session sees other addresses and an unreadable guest list:
  // nothing of the previous one may come from the browser's memory.
  await setFlag(page, "address-fixture-items", "[]");
  await setFlag(page, "organizer-fixture-status", "unavailable");
  await page.getByLabel("Email").fill("you@example.test");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await backToCalendar(page);
  // A failed check is reported, never shown as "no unverified answers".
  const banner = page.locator(".cal-banner", {
    hasText: "Calendar couldn't check for unverified guest answers.",
  });
  await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
  const again = await editEvent(page, "Private review");
  await expect(again.getByRole("alert")).toContainText(
    "This event's guests couldn't be loaded",
  );
  await expect(guestRow(again, sam)).toHaveCount(0);
  await again.getByRole("button", { name: "Cancel" }).click();
  const fresh = await draft(page, "Next session", [ana]);
  await expect(
    fresh.getByLabel("Send invitations from").locator("option"),
  ).toHaveText(["you@example.test"]);
});

test("guests are managed from the keyboard", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const editor = editorOf(page, "New event");
  await expect(editor.getByLabel("Title")).toBeFocused();
  await page.keyboard.type("Keyboard review");
  await editor.getByLabel("Add guests").focus();
  await page.keyboard.type(`${sam}; ${ana}`);
  await page.keyboard.press("Enter");
  // Enter adds guests; it does not submit the form.
  await expect(
    editor.getByRole("list", { name: "Guest list" }).locator("li"),
  ).toHaveCount(2);
  await page.keyboard.type("not-an-address");
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("alert")).toHaveText(
    "“not-an-address” isn't a valid email address.",
  );
  await page.keyboard.press("Control+a");
  await page.keyboard.type("you@example.test");
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("alert")).toHaveText(
    "You're the organizer, not a guest.",
  );
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await editor.getByRole("button", { name: `Remove ${ana}` }).focus();
  await page.keyboard.press("Enter");
  await expect(guestRow(editor, ana)).toHaveCount(0);
  await page.keyboard.press("Control+Enter");
  const review = page.getByRole("dialog", { name: "Send invitations?" });
  await expect(review.locator("dd li")).toHaveText([sam]);
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(guestRow(editor, sam)).toBeVisible();
  await editor.getByLabel("Title").focus();
  await page.keyboard.press("Control+Enter");
  // The confirmation starts on its action, so Enter sends.
  await expect(
    review.getByRole("button", { name: "Send invitations" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText(/^Invitations handed .* for 1 guest/);
});

test.describe("on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("guests and the confirmation fit the screen", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /^Create( C)?$/ }).click();
    const editor = editorOf(page, "New event");
    await editor.getByLabel("Title").fill("Phone review");
    await addGuests(
      editor,
      `${sam}, a-very-long-guest-address@partner.example.test`,
    );
    const remove = editor.getByRole("button", { name: `Remove ${sam}` });
    const box = await remove.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await axe(page);
    await editor.getByRole("button", { name: "Save" }).click();
    const review = page.getByRole("dialog", { name: "Send invitations?" });
    const action = review.getByRole("button", { name: "Send invitations" });
    await expect(action).toBeInViewport();
    await axe(page);
    await action.click();
    await expect(notice(page)).toHaveText(
      /^Invitations handed .* for 2 guests/,
    );
  });
});

test("production bundle excludes the synthetic organizer", async () => {
  const dir = "apps/web/dist/assets";
  const scripts = await Promise.all(
    (await readdir(dir))
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(join(dir, file), "utf8")),
  );
  const bundle = scripts.join("\n");
  expect(bundle).not.toContain("organizer-fixture-outcome");
  expect(bundle).not.toContain("bounce.example.test");
  expect(bundle).toContain("/invitations/organize");
  expect(bundle).toContain("/invitations/organized/status");
});
