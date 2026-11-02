import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Google Calendar style invitations with Google Meet links, answered through
// the local synthetic invitation service of the development server. They show
// the browser behaviour only; they prove nothing about real Google delivery.
// Wednesday 28 October 2026 in Paris: "Product sync" is on Thursday 5
// November at 10:00 in New York, which is 16:00 in Paris.
const now = new Date("2026-10-28T09:00:00Z");
test.use({ locale: "en-US", timezoneId: "Europe/Paris" });

async function axe(page: Page) {
  // Scanning in place (the message frame is same-origin) avoids the helper
  // page that the default mode opens, which could stall on a busy machine.
  const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}
async function openMail(page: Page) {
  await page.clock.setFixedTime(now);
  await page.addInitScript(() => {
    sessionStorage.setItem("mail-fixture-invitations", "1");
    if (!localStorage.getItem("opensuite-theme"))
      localStorage.setItem("opensuite-theme", "system");
  });
  await page.goto("/mail");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
}
const escape = (text: string) => text.replaceAll(/[()]/g, "\\$&");
/** Opens the conversation whose subject is exactly `subject`. */
async function openThread(page: Page, subject: string) {
  await page
    .locator("button.thread-open")
    .filter({
      has: page.locator(".thread-subject", {
        hasText: new RegExp(`^(Unread, )?${escape(subject)}$`),
      }),
    })
    .click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
}
const invitation = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
const notice = (page: Page) =>
  page.locator(".toast-viewport [aria-live='polite']");
const folder = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Mail folders" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
async function expectResponsesSent(page: Page, subjects: string[]) {
  await folder(page, "Sent").click();
  await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
  // Wait for the list or its empty state, not the folder heading alone.
  await expect(
    page
      .locator(".thread-subject")
      .first()
      .or(page.getByText("Nothing in Sent.")),
  ).toBeVisible();
  await expect(
    page.locator(".thread-subject", { hasText: /Invitation response:/ }),
  ).toHaveText(subjects);
  await folder(page, "Inbox").click();
}
/** The iCalendar REPLY attached to the sent response `subject`, and its recipients. */
async function sentReply(page: Page, subject: string) {
  await folder(page, "Sent").click();
  await openThread(page, subject);
  const reader = page.getByRole("region", { name: "Reading pane" });
  const recipients = await reader
    .locator(".message-recipients")
    .first()
    .innerText();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    reader.getByRole("button", { name: /reply\.ics/ }).click(),
  ]);
  const calendar = await readFile(await download.path(), "utf8");
  await folder(page, "Inbox").click();
  return { recipients, calendar };
}
async function respond(card: Locator, action: string) {
  const choice = card.getByRole("button", { name: action, exact: true });
  await expect(choice).toHaveAttribute("aria-disabled", "false");
  await choice.click();
}

test("a Google invitation is shown, answered and added to Calendar", async ({
  page,
}) => {
  await openMail(page);
  await expectResponsesSent(page, []);
  await openThread(page, "Invitation: Product sync");
  const card = invitation(page, "Invitation: Product sync");
  await expect(card).toContainText("Verified organizer");
  await expect(card.locator("time")).toHaveText(
    /^Thursday, November 5 · 4:00\s?–\s?4:30\sPM$/u,
  );
  await expect(card).toContainText("(GMT+1)");
  await expect(card).toContainText(
    /Event time: Thu 10:00\sAM in America\/New_York/u,
  );
  await expect(card).toContainText("Studio, Room 4B");
  await expect(card).toContainText("Sam Okafor");
  await expect(card).toContainText("You (you)");
  const meeting = card.getByRole("link", { name: /^Join meeting/ });
  await expect(meeting).toHaveAttribute(
    "href",
    "https://meet.google.com/abc-defg-hij",
  );
  await expect(meeting).toHaveAttribute("target", "_blank");
  await expect(meeting).toHaveAttribute("rel", "noopener noreferrer");
  // Showing the invitation sent nothing.
  await expect(card.getByRole("button", { name: "Accept" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await card.getByLabel("Add to calendar").selectOption("work");
  await respond(card, "Accept");
  await expect(card).toContainText(
    "Accepted. Your response was sent to the organizer.",
  );
  await expect(notice(page)).toHaveText("Response sent: Accepted.");
  await expect(card.getByRole("button", { name: "Accept" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectResponsesSent(page, ["Invitation response: accepted"]);
  // The response is an iTIP REPLY for this event, sent to its organizer.
  const reply = await sentReply(page, "Invitation response: accepted");
  expect(reply.recipients).toBe("To lena@studio.example.test");
  for (const line of [
    "METHOD:REPLY",
    "UID:6pq3sync0@google.com",
    "SEQUENCE:0",
    "ORGANIZER:mailto:lena@studio.example.test",
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:you@example.test",
  ])
    expect(reply.calendar.split("\r\n")).toContain(line);
  expect(reply.calendar).not.toContain("NEEDS-ACTION");
  await openThread(page, "Invitation: Product sync");
  // The confirmed response is still shown when the conversation is reopened.
  await expect(card).toContainText("Accepted. Your response was sent");
  await card.getByRole("link", { name: "Open in Calendar" }).click();
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await expect(editor.getByLabel("Title")).toHaveValue("Product sync");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", {
      name: /^Product sync, Thursday, November 5 · 4:00.*, Work$/u,
    }),
  ).toBeVisible();
});

test("verified updates and cancellations change Calendar only when applied", async ({
  page,
}) => {
  await openMail(page);
  await openThread(page, "Invitation: Product sync");
  await respond(invitation(page, "Invitation: Product sync"), "Accept");
  await expect(notice(page)).toHaveText("Response sent: Accepted.");

  await openThread(page, "Updated invitation: Product sync");
  const update = invitation(page, "Updated invitation: Product sync");
  await expect(update.locator("time")).toHaveText(
    /^Friday, November 6 · 5:00/u,
  );
  await expect(update).toContainText("Studio loft, 3rd floor");
  await update.getByRole("button", { name: "Update calendar" }).click();
  await expect(update).toContainText(
    "Your calendar was updated with these changes.",
  );
  await update.getByRole("link", { name: "Open in Calendar" }).click();
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await expect(editor.getByLabel("Title")).toHaveValue("Product sync");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", {
      name: /^Product sync, Friday, November 6 · 5:00/u,
    }),
  ).toBeVisible();
  // Back to Mail inside the app, which keeps the synthetic data of this tab.
  await page.getByRole("link", { name: "Mail" }).first().click();

  await openThread(page, "Canceled event: Product sync");
  const cancelled = invitation(page, "Cancelled event: Product sync");
  await expect(cancelled.locator("time")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await expect(cancelled.getByRole("button", { name: "Accept" })).toHaveCount(
    0,
  );
  await cancelled.getByRole("button", { name: "Remove from calendar" }).click();
  await expect(cancelled).toContainText(
    "The event was removed from your calendar.",
  );
  await expect(notice(page)).toHaveText(
    "The event was removed from your calendar.",
  );
  await cancelled.getByRole("link", { name: "Open in Calendar" }).click();
  // The week has loaded (its other synthetic event is there) without the event.
  await expect(
    page.getByRole("button", { name: /^Roadmap workshop,/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Product sync,/ }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Mail" }).first().click();

  // The original invitation is now out of date.
  await openThread(page, "Invitation: Product sync");
  const original = invitation(page, "Invitation: Product sync");
  await respond(original, "Tentative");
  await expect(original).toContainText("a newer version was already handled");
  await expect(
    original.getByRole("button", { name: "Reload invitation" }),
  ).toBeVisible();
});

test("unverified senders need confirmation and cannot change existing events", async ({
  page,
}) => {
  await openMail(page);
  await openThread(page, "Invitation: Payroll access review");
  const payroll = invitation(page, "Invitation: Payroll access review");
  await expect(payroll).toContainText("Sender not verified");
  await expect(payroll).toContainText("Unverified sender");
  await expect(payroll).not.toContainText("Verified organizer");
  await expect(
    payroll.getByRole("link", {
      name: "Open link meet.google.com.hr-portal.example.test/review",
    }),
  ).toBeVisible();
  await expect(payroll).toContainText("Every week");

  // Keyboard: Accept opens the confirmation with Cancel focused; Escape backs out.
  const accept = payroll.getByRole("button", { name: "Accept" });
  await expect(accept).toHaveAttribute("aria-disabled", "false");
  await accept.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", {
    name: "Respond to an unverified invitation?",
  });
  await expect(confirm).toContainText("Accepted");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(accept).toBeFocused();
  await expect(payroll).not.toContainText("Your response was sent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(
    confirm.getByRole("button", { name: "Respond anyway" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(payroll).toContainText(
    "Accepted. Your response was sent to the organizer.",
  );
  await expect(notice(page)).toHaveText("Response sent: Accepted.");

  await openThread(page, "Invitation: Product sync");
  await respond(invitation(page, "Invitation: Product sync"), "Accept");
  await expect(notice(page)).toHaveText("Response sent: Accepted.");
  await openThread(page, "Updated invitation: Product sync (new link)");
  const spoofed = invitation(page, "Updated invitation: Product sync");
  await expect(spoofed).toContainText("Nothing was changed in your calendar");
  await expect(
    spoofed.getByRole("link", {
      name: /^Open link meet-google\.example\.test/,
    }),
  ).toBeVisible();
  await expect(
    spoofed.getByRole("button", { name: "Update calendar" }),
  ).toHaveCount(0);
  await respond(spoofed, "Accept");
  await expect(confirm).toContainText(
    "Unverified changes can't update an event that's already in your calendar.",
  );
  await confirm.getByRole("button", { name: "Respond anyway" }).click();
  await expect(spoofed).toContainText(
    "Changes from an unverified sender can't be applied to an event that's already in your calendar.",
  );

  await openThread(page, "Canceled event with note: Product sync");
  const cancel = invitation(page, "Cancelled event: Product sync");
  await expect(cancel).toContainText("Nothing was removed from your calendar.");
  await expect(cancel.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(
    cancel.getByRole("button", { name: "Remove from calendar" }),
  ).toHaveCount(0);
  await cancel.getByRole("link", { name: "Open in Calendar" }).click();
  await expect(
    page.getByRole("button", { name: /^Product sync, Thursday, November 5/u }),
  ).toBeVisible();
});

test("unreadable invitations, uncertain results and conflicts stay explicit", async ({
  page,
}) => {
  await openMail(page);
  await page.evaluate(() =>
    sessionStorage.setItem("invitation-fixture-fail-read", "1"),
  );
  await openThread(page, "Invitation: Product sync");
  await expect(
    page.getByText("The invitation details couldn't be loaded."),
  ).toBeVisible();
  await page.evaluate(() =>
    sessionStorage.removeItem("invitation-fixture-fail-read"),
  );
  await page.getByRole("button", { name: "Retry" }).click();
  const card = invitation(page, "Invitation: Product sync");
  await expect(card).toContainText("Verified organizer");

  await page.evaluate(() =>
    sessionStorage.setItem("invitation-fixture-outcome", "uncertain"),
  );
  await respond(card, "Accept");
  await expect(card).toContainText(
    "We couldn't confirm whether this worked. Check the status before trying again.",
  );
  await expect(notice(page)).toHaveText("Result unknown. Check the status.");
  await expect(card.getByRole("button", { name: "Accept" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.evaluate(() =>
    sessionStorage.removeItem("invitation-fixture-outcome"),
  );
  await card.getByRole("button", { name: "Check status" }).click();
  await expect(card).toContainText(
    "Accepted. Your response was sent to the organizer.",
  );
  await expect(card.locator(".invite-status")).toBeFocused();
  await expectResponsesSent(page, ["Invitation response: accepted"]);

  await openThread(page, "Invitation: Product sync");
  await page.evaluate(() =>
    sessionStorage.setItem("invitation-fixture-outcome", "conflict"),
  );
  await respond(card, "Decline");
  await expect(card).toContainText(
    "This invitation changed, or a newer version was already handled.",
  );
  await expect(notice(page)).toHaveText(/^This invitation changed/);
  await expect(
    card.getByRole("button", { name: "Check status" }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Reload invitation" }),
  ).toBeVisible();
});

const phone = { width: 390, height: 844 };
for (const theme of ["light", "dark"] as const)
  test(`${theme} invitation on a phone is readable and answerable`, async ({
    page,
  }) => {
    await page.setViewportSize(phone);
    await page.emulateMedia({ colorScheme: theme });
    await openMail(page);
    await openThread(page, "Invitation: Payroll access review");
    const card = invitation(page, "Invitation: Payroll access review");
    await expect(card).toContainText("Sender not verified");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const accept = card.getByRole("button", { name: "Accept" });
    const box = await accept.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(40);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(phone.width);
    await axe(page);
    await respond(card, "Tentative");
    await page
      .getByRole("dialog", { name: "Respond to an unverified invitation?" })
      .getByRole("button", { name: "Respond anyway" })
      .click();
    await expect(card).toContainText(
      "Tentative. Your response was sent to the organizer.",
    );
    await axe(page);
  });

test("production bundle excludes the synthetic invitations", async () => {
  const dir = "apps/web/dist/assets";
  const scripts = await Promise.all(
    (await readdir(dir))
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(join(dir, file), "utf8")),
  );
  expect(scripts.length).toBeGreaterThan(0);
  const bundle = scripts.join("\n");
  expect(bundle).not.toContain("6pq3sync0@google.com");
  expect(bundle).not.toContain("mail-fixture-invitations");
  expect(bundle).toContain("/invitations/act");
});
