import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// The development server serves synthetic migrations from
// apps/web/src/dev-data/migration.ts; nothing here reaches Google or a real
// IMAP server. The synthetic state lives in the page, so the tests move
// between pages inside the application.

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}
const scenario = (page: Page, value: string) =>
  page.addInitScript((name) => {
    sessionStorage.setItem("migration-fixture", name);
  }, value);
/** An MBOX archive; each entry is the synthetic outcome of one message. */
const mbox = (outcomes: string[]) =>
  outcomes
    .map(
      (outcome, index) =>
        `From sender@example.test Mon Jan  1 00:00:00 2024\nMessage-ID: <m${String(index)}@example.test>\nSubject: Message ${String(index)}\n${outcome ? `X-Fixture-Outcome: ${outcome}\n` : ""}\nBody ${String(index)}\n`,
    )
    .join("");
const ics = (events: [uid: string | null, title: string][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap(([uid, title]) => [
      "BEGIN:VEVENT",
      ...(uid ? [`UID:${uid}`] : []),
      `SUMMARY:${title}`,
      "DTSTART:20261110T090000Z",
      "DTEND:20261110T100000Z",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
const file = (name: string, text: string) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(text),
});
const counts = (page: Page) => page.getByRole("list", { name: "Counts" });
const status = (page: Page) => page.locator("output.migration-status-head");
const notice = (page: Page) =>
  page.locator(".toast-viewport [aria-live='polite']");

async function chooseSource(page: Page, source: RegExp) {
  await page.goto("/settings/migration/new");
  await page.getByRole("radio", { name: source }).check();
  await page.getByRole("button", { name: "Continue" }).click();
}
async function startArchive(page: Page, outcomes: string[]) {
  await chooseSource(page, /^Mail archive/);
  await page
    .getByLabel("Mail archive", { exact: true })
    .setInputFiles(
      file("All mail Including Spam and Trash.mbox", mbox(outcomes)),
    );
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into mailbox").selectOption("Archive");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(
    page.getByRole("heading", { name: "Mail archive import" }),
  ).toBeVisible();
}

test("offers the optional assistant once on first use", async ({ page }) => {
  await scenario(page, "empty");
  await page.goto("/mail");
  const offer = page.getByRole("dialog", {
    name: "Moving from another service?",
  });
  await expect(offer).toBeVisible();
  await axe(page);
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await offer.getByRole("link", { name: "Start a migration" }).click();
  await expect(page).toHaveURL(/\/settings\/migration\/new$/);
  await expect(
    page.getByRole("heading", { name: "Start a migration" }),
  ).toBeVisible();
});

test("an account with migrations is not offered the assistant", async ({
  page,
}) => {
  await page.goto("/mail");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.goto("/settings/migration");
  await expect(page.getByRole("link", { name: /Mail archive/ })).toBeVisible();
  await page.getByRole("link", { name: "Mail", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the assistant is reachable from the account menu and every settings page", async ({
  page,
}) => {
  await page.goto("/mail");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Migration" }).click();
  await expect(
    page.getByRole("heading", { name: "Migration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Migration", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const fromSettings = async (path: string) => {
    await page.goto(path);
    await page.getByRole("link", { name: "Migration", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/migration$/);
    await expect(
      page.getByRole("link", { name: "Start a migration" }),
    ).toBeVisible();
  };
  await fromSettings("/settings/addresses");
  await fromSettings("/settings/billing");
});

test("imports a mail archive after destinations and limits, across navigation", async ({
  page,
}) => {
  await scenario(page, "empty");
  await page.goto("/settings/migration");
  await expect(
    page.getByRole("heading", { name: "No migrations yet" }),
  ).toBeVisible();
  await axe(page);
  await page.getByRole("link", { name: "Start a migration" }).click();
  await page.getByRole("radio", { name: /^Mail archive/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Choose an .mbox or .eml file.",
  );
  const picker = page.getByLabel("Mail archive", { exact: true });
  await picker.setInputFiles(file("takeout-001.zip", "PK"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("Extract the .mbox file");
  await picker.setInputFiles(
    file("Takeout.mbox", mbox(["", "", "duplicate", ""])),
  );
  await expect(
    page.getByRole("radio", { name: /Standard \(mboxo\)/ }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Import into mailbox").selectOption("Archive");
  await page.getByRole("button", { name: "Map a label" }).click();
  await page.getByLabel("Label 1", { exact: true }).fill("Work");
  await page.getByLabel("Mailbox for label 1").selectOption("Work");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Review and confirm" }),
  ).toBeFocused();
  const review = page.locator(".migration-summary");
  await expect(review).toContainText("Takeout.mbox");
  await expect(review).toContainText("Archive");
  await expect(review).toContainText("Work → Work");
  await expect(page.getByText(/Archive size: .* of 8\.0 MB/)).toBeVisible();
  await expect(page.getByText(/jobs to 1,000 messages/)).toBeVisible();
  await axe(page);
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(
    page.getByRole("heading", { name: "Mail archive import" }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Progress" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Mail", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.goBack();
  await expect(status(page)).toHaveText("Completed");
  await expect(counts(page)).toContainText("3 Imported");
  await expect(counts(page)).toContainText("1 Skipped as already present");
  await expect(
    page.getByText(
      "All 4 messages processed: 3 imported, 1 skipped as already present.",
    ),
  ).toBeVisible();
  await axe(page);
  await page.getByRole("link", { name: "All migrations" }).click();
  await expect(page.getByRole("link", { name: /Mail archive/ })).toContainText(
    "Completed",
  );
});

test("reports failures, resumes, and abandons uncertain messages", async ({
  page,
}) => {
  await scenario(page, "empty");
  await startArchive(page, ["", "failed", "uncertain", ""]);
  await expect(status(page)).toHaveText("Needs attention");
  await expect(
    page.getByText(
      "Not finished: 2 of 4 messages imported. 1 failed and 1 uncertain need your attention.",
    ),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Mail archive import report" });
  await expect(page.getByLabel(/Show only the 2 items/)).toBeChecked();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).toContainText("Simulated failed message.");
  await expect(table).toContainText("Uncertain");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const report = await readFile(await (await download).path(), "utf8");
  expect(report).toContain('"Status","Needs attention"');
  expect(report).toContain('"Message 2","Failed","Simulated failed message."');

  await page.getByRole("button", { name: "Resume import" }).click();
  await expect(counts(page)).toContainText("3 Imported");
  await expect(counts(page)).toContainText("0 Failed");
  await expect(status(page)).toHaveText("Needs attention");

  await page.getByRole("button", { name: "Abandon import" }).click();
  const dialog = page.getByRole("dialog", { name: "Abandon this import?" });
  await expect(dialog).toContainText("never deletes delivered mail");
  const confirm = dialog.getByRole("button", { name: "Abandon import" });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByLabel("I checked my mailbox for the 1 uncertain message.")
    .check();
  await confirm.click();
  await expect(page).toHaveURL(/\/settings\/migration$/);
  await expect(notice(page)).toHaveText(
    "Import abandoned. Mail already delivered was not deleted.",
  );
  await expect(
    page.getByRole("heading", { name: "No migrations yet" }),
  ).toBeVisible();
});

test("refuses a second archive import while one is active", async ({
  page,
}) => {
  await scenario(page, "empty");
  await startArchive(page, ["", "", "", "", "", ""]);
  await page.getByRole("link", { name: "All migrations" }).click();
  await page.getByRole("link", { name: "Start a migration" }).click();
  await page.getByRole("radio", { name: /^Mail archive/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByLabel("Mail archive", { exact: true })
    .setInputFiles(file("second.eml", "Subject: Hi\n\nBody\n"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into mailbox").selectOption("Inbox");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Another import is already in progress. Wait for it to finish or cancel it first.",
  );
  await expect(
    page.getByRole("link", { name: "Check your migrations" }),
  ).toBeVisible();
});

test("connects to an IMAP server without exposing the password, then cancels", async ({
  page,
}) => {
  const secret = "app-secret-4821";
  await scenario(page, "empty");
  await chooseSource(page, /^Other mail server/);
  await page.getByLabel("Server").fill("imap.unlisted.test");
  await page.getByLabel("Username").fill("me@example.test");
  await page.getByLabel("App password").fill(secret);
  await expect(page.getByLabel("App password")).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into mailbox").selectOption("Inbox");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".migration-summary")).toContainText(
    "me@example.test on imap.unlisted.test:993",
  );
  await expect(page.locator("body")).not.toContainText(secret);
  await page.getByRole("button", { name: "Start import" }).click();
  // Like the real API, the server that is not allowed fails when the
  // migration connects, not when it is created.
  await expect(
    page.getByRole("heading", { name: "IMAP import" }),
  ).toBeVisible();
  const credential = page.getByRole("region", { name: "Source password" });
  await expect(credential).toContainText(
    "Stored encrypted for this migration only",
  );
  await expect(status(page)).toHaveText("Needs attention");
  await expect(page.getByRole("alert")).toHaveText(
    "Source or destination unavailable; check credentials and resume.",
  );
  await expect(
    page.getByText("ask your administrator whether this server is allowed"),
  ).toBeVisible();
  await expect(credential).toContainText("resume with a new app password");
  await axe(page);
  await page.getByRole("button", { name: "Cancel import" }).click();
  await page
    .getByRole("dialog", { name: "Cancel this import?" })
    .getByRole("button", { name: "Cancel import" })
    .click();
  await expect(status(page)).toHaveText("Cancelled");
  await expect(credential).toContainText(
    "Deleted. The stored password was removed",
  );
  await expect(
    page.getByText(
      /^Cancelled: \d of \d messages imported before cancellation/,
    ),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    [sessionStorage, localStorage]
      .flatMap((storage) =>
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? "";
          return `${key}=${storage.getItem(key) ?? ""}`;
        }),
      )
      .join("\n"),
  );
  expect(stored).not.toContain(secret);
  await expect(page.locator("body")).not.toContainText(secret);
});

test("resumes a Gmail migration with a new app password", async ({ page }) => {
  await scenario(page, "empty");
  await chooseSource(page, /^Gmail account/);
  await expect(
    page.getByText("signing in with Google is not available here"),
  ).toBeVisible();
  await page.getByLabel("Gmail address").fill("you@gmail.com");
  await page.getByLabel("App password").fill("wrong-password");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into mailbox").selectOption("Inbox");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(
    page.getByRole("heading", { name: "Gmail import" }),
  ).toBeVisible();
  await expect(status(page)).toHaveText("Needs attention");
  await expect(page.getByRole("alert")).toHaveText(
    "Source or destination unavailable; check credentials and resume.",
  );
  await page.getByLabel(/New app password/).fill("fresh-app-password");
  await page.getByRole("button", { name: "Resume import" }).click();
  await expect(status(page)).toHaveText("Completed");
  await expect(counts(page)).toContainText("4 Imported");
  await expect(page.getByLabel(/New app password/)).toHaveCount(0);
});

test("previews calendar files, pauses when leaving and continues", async ({
  page,
}) => {
  await scenario(page, "empty");
  await chooseSource(page, /^Calendar files/);
  await page.getByLabel("Calendar files", { exact: true }).setInputFiles([
    file(
      "work.ics",
      ics([
        ["e1", "Planning"],
        ["e2", "Review"],
        ["e3", "Retro"],
        ["e4", "Demo"],
        ["e5", "[duplicate] Stand-up"],
      ]),
    ),
    file("broken.ics", ics([[null, "No identifier"]])),
  ]);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into calendar").selectOption("Work");
  await page.getByRole("button", { name: "Preview import" }).click();

  const preview = page.getByRole("list", { name: "Preview" });
  await expect(preview).toContainText("4 New");
  await expect(preview).toContainText("1 Already present");
  await expect(preview).toContainText("1 Invalid");
  await expect(
    page.getByText("Conflicting and invalid events will not be imported"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(
    page.getByRole("heading", { name: "Calendar import" }),
  ).toBeVisible();
  await expect(status(page)).toHaveText("Importing");
  await expect(counts(page)).toContainText("1 Imported");
  await page
    .getByRole("link", { name: "Calendar", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/calendar/);
  await page.goBack();
  await expect(status(page)).toHaveText("Paused");
  await expect(
    page.getByText("Calendar imports run while this page is open"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue import" }).click();
  await expect(status(page)).toHaveText("Needs attention");
  await expect(
    page.getByText(
      "Not finished: 4 of 6 events imported, 1 skipped as already present. 1 failed and 0 uncertain need your attention.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Calendar import report" }),
  ).toContainText("The event has no UID.");

  await page.getByRole("button", { name: "Remove from list" }).click();
  await page
    .getByRole("dialog", { name: "Remove this report?" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(
    page.getByRole("heading", { name: "No migrations yet" }),
  ).toBeVisible();
});

test("refuses a calendar selection too large for one request", async ({
  page,
}) => {
  await scenario(page, "empty");
  await chooseSource(page, /^Calendar files/);
  const padding = `X-FILLER:${"x".repeat(470_000)}`;
  await page
    .getByLabel("Calendar files", { exact: true })
    .setInputFiles([
      file("one.ics", ics([["a1", "First"]]) + padding),
      file("two.ics", ics([["b1", "Second"]]) + padding),
    ]);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Import them in smaller batches.",
  );
  await expect(
    page.getByRole("heading", { name: "Source details" }),
  ).toBeVisible();
});

test("cancels a calendar import without claiming it finished", async ({
  page,
}) => {
  await scenario(page, "empty");
  await chooseSource(page, /^Calendar files/);
  await page.getByLabel("Calendar files", { exact: true }).setInputFiles(
    file(
      "trip.ics",
      ics([
        ["t1", "Flight"],
        ["t2", "Hotel"],
        ["t3", "Museum"],
        ["t4", "Dinner"],
      ]),
    ),
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into calendar").selectOption("Personal");
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(counts(page)).toContainText("1 Imported");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(status(page)).toHaveText("Paused");
  const report = page.getByRole("table", { name: "Calendar import report" });
  await expect(report.getByText("Importing", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel import" }).click();
  await page
    .getByRole("dialog", { name: "Cancel this import?" })
    .getByRole("button", { name: "Cancel import" })
    .click();
  await expect(status(page)).toHaveText("Cancelled");
  await expect(
    page.getByText(/^Cancelled: [12] of 4 events imported before cancellation/),
  ).toBeVisible();
  await expect(report).toContainText("Not imported");
});

test("explains denied, unavailable, missing and offline states", async ({
  page,
  context,
}) => {
  const choose = (name: string) =>
    page.evaluate((value) => {
      sessionStorage.setItem("migration-fixture", value);
    }, name);
  await page.goto("/settings/migration");
  await choose("denied");
  await page.reload();
  await expect(page.getByRole("alert").first()).toHaveText(
    "You don’t have access to migrations for this account.",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

  await page.evaluate(() =>
    sessionStorage.setItem("migration-fixture", "unavailable"),
  );
  await page.reload();
  await expect(page.getByRole("alert").first()).toContainText(
    "The migration service is unavailable.",
  );
  await expect(
    page.getByRole("button", { name: "Try again" }).first(),
  ).toBeVisible();

  await page.evaluate(() =>
    sessionStorage.setItem("migration-fixture", "empty"),
  );
  await page.goto("/settings/migration/mail/missing-job");
  await expect(page.getByRole("alert")).toHaveText(
    "This migration doesn’t exist or isn’t available to your account.",
  );
  await page.goto("/settings/migration/elsewhere/missing-job");
  await expect(
    page.getByRole("heading", { name: "Migration not found" }),
  ).toBeVisible();

  await chooseSource(page, /^Gmail account/);
  await page.getByLabel("Gmail address").fill("you@gmail.com");
  await page.getByLabel("App password").fill("app-password");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Import into mailbox").selectOption("Inbox");
  await page.getByRole("button", { name: "Continue" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "You’re offline, so the start of this migration could not be confirmed.",
  );
  await context.setOffline(false);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("the assistant works with the keyboard and fits the screen", async ({
    page,
  }) => {
    await scenario(page, "empty");
    await page.goto("/settings/migration/new");
    const first = page.getByRole("radio", { name: /^Gmail account/ });
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("radio", { name: /^Other mail server/ }),
    ).toBeChecked();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Source details" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const server = page.getByLabel("Server");
    await expect(server).toBeFocused();
    // Each key re-renders the assistant; focus must stay in the field.
    await page.keyboard.type("imap.example.test");
    await expect(server).toHaveValue("imap.example.test");
    await expect(server).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.type("me@example.test");
    await expect(page.getByLabel("Username")).toHaveValue("me@example.test");
    await axe(page);
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
  });
});
