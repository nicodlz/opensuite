import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Every journey runs the real interface in Chromium against the synthetic
// mail and calendar data of the development server. Touch screens are
// emulated; the on-screen keyboard test also replaces the browser's visual
// viewport with a synthetic one, since Chromium cannot open a keyboard.

const phone = { width: 390, height: 844 };
const smallPhone = { width: 360, height: 740 };
const landscape = { width: 844, height: 390 };
const tablet = { width: 768, height: 1024 };
const desktop = { width: 1440, height: 900 };
const touch = { hasTouch: true, isMobile: true } as const;

// Wednesday 28 October 2026, 10:00 in Paris: the synthetic calendar places
// its events around the current week.
const now = new Date("2026-10-28T09:00:00Z");
test.use({ locale: "en-GB", timezoneId: "Europe/Paris" });
test.beforeEach(async ({ page }) => {
  // The synthetic messages link to remote images that must never load.
  await page.route("https://images.example.test/**", (route) => route.abort());
});

/**
 * Serious accessibility problems of the layout. A message's own content is
 * checked by mail.spec.ts; analysing its frame takes far longer.
 */
async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude(".message-frame")
    .analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

/** Neither the page nor any of its scrolling areas scrolls sideways. */
async function expectNoSidewaysScroll(page: Page) {
  const wide = await page.evaluate(() => {
    const found: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth)
      found.push("page");
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const style = getComputedStyle(element);
      if (
        ["auto", "scroll"].includes(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1 &&
        element.checkVisibility()
      )
        found.push(element.className || element.tagName);
    }
    return found;
  });
  expect(wide).toEqual([]);
}

/** Visible controls in `scope` smaller than 44 × 44 pixels. */
async function smallTargets(scope: Locator) {
  return scope
    .locator(
      "button:not(:disabled), a[href], select, input:not([type=checkbox]):not([type=file])",
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) =>
          element.checkVisibility({ visibilityProperty: true }),
        )
        .map((element) => {
          const { width, height } = element.getBoundingClientRect();
          const name =
            element.getAttribute("aria-label") ?? element.textContent;
          return { name: name.trim(), width, height };
        })
        .filter(({ width, height }) => width < 44 || height < 44),
    );
}

/** The box of `locator` lies inside the window. */
async function expectInWindow(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const size = page.viewportSize();
  expect(box).not.toBeNull();
  expect(size).not.toBeNull();
  if (!box || !size) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
}

/** Whether the current history entry is a panel entry. */
const hasLayer = (page: Page) =>
  page.evaluate(() => {
    const state: unknown = history.state;
    return typeof state === "object" && state !== null && "layer" in state;
  });

/**
 * Replaces the browser's visual viewport with a synthetic one, since
 * Chromium cannot open an on-screen keyboard. The returned function shows a
 * keyboard of the given height, or hides it with zero.
 */
async function syntheticKeyboard(page: Page) {
  await page.addInitScript(() => {
    const fake = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      offsetTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", { value: fake });
    window.addEventListener("synthetic-keyboard", (event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "number")
        return;
      fake.height = window.innerHeight - event.detail;
      fake.dispatchEvent(new Event("resize"));
    });
  });
  return (height: number) =>
    page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent("synthetic-keyboard", { detail }));
    }, height);
}

/** Bottom edge of `locator`, or infinity while it is not shown. */
async function bottomOf(locator: Locator) {
  const box = await locator.boundingBox();
  return box ? box.y + box.height : Number.POSITIVE_INFINITY;
}

const conversation = (page: Page, name: string) =>
  page
    .getByRole("region", { name: "Conversations" })
    .getByRole("button", { name: new RegExp(name) });
const subject = (page: Page) =>
  page.getByRole("heading", { name: "A little update for Friday" });
const composer = (page: Page) =>
  page.getByRole("region", { name: "Compose message" });
const notice = (page: Page) =>
  page.locator(".toast-viewport [aria-live='polite']");
const chip = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${title},`) });

test.describe("Mail on a phone", () => {
  test.use({ viewport: phone, ...touch });

  test("list, reader and full-screen draft follow Back, and controls fit a finger", async ({
    page,
  }) => {
    await page.goto("/mail");
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await expectNoSidewaysScroll(page);
    expect(await smallTargets(page.locator(".shell-topbar"))).toEqual([]);
    expect(await smallTargets(page.locator(".list-heading"))).toEqual([]);
    // No keyboard to use the shortcuts with.
    await expect(
      page.getByRole("button", { name: "Keyboard shortcuts" }),
    ).toBeHidden();
    const fab = page.getByRole("button", { name: "New message" });
    await expect(fab).toBeVisible();

    await conversation(page, "Maya Chen").tap();
    await expect(subject(page)).toBeVisible();
    expect(page.url()).toMatch(/\/mail$/);
    // New message would cover Reply; Reply stays at hand at the bottom.
    await expect(fab).toBeHidden();
    const reply = page.getByRole("button", { name: "Reply", exact: true });
    await expect(reply).toBeInViewport({ ratio: 1 });
    expect(await smallTargets(page.locator(".reading-toolbar"))).toEqual([]);
    expect(await smallTargets(page.locator(".reply-actions"))).toEqual([]);
    await expectNoSidewaysScroll(page);
    // Actions that do not fit are in More.
    await expect(
      page.getByRole("button", { name: "Mark unread" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "More actions" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Mark unread" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Newer conversation" }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await axe(page);

    await reply.tap();
    const draft = composer(page);
    await expect(draft.getByLabel("Message body")).toBeFocused();
    const box = await draft.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, ...phone });
    // What the draft covers is out of reach, and it is already full screen.
    await expect(page.locator(".shell-topbar")).toBeHidden();
    await expect(subject(page)).toBeHidden();
    await expect(
      draft.getByRole("button", { name: "Maximize draft" }),
    ).toBeHidden();
    expect(await smallTargets(draft)).toEqual([]);
    await axe(page);

    // Back minimizes the draft, then closes the conversation, in Mail.
    await page.goBack();
    await expect(
      composer(page).getByRole("button", { name: "Restore draft" }),
    ).toBeVisible();
    await expect(subject(page)).toBeVisible();
    await page.goBack();
    await expect(subject(page)).toBeHidden();
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    expect(page.url()).toMatch(/\/mail$/);

    // The draft comes back full screen; closing it saves it.
    await composer(page).getByRole("button", { name: "Restore draft" }).tap();
    await expect(composer(page).getByLabel("Message body")).toBeVisible();
    await composer(page)
      .getByRole("button", { name: "Save and close draft" })
      .tap();
    await expect(composer(page)).toHaveCount(0);
    await expect(fab).toBeVisible();
  });

  test("the in-page Back button and an archive leave no stale history entry", async ({
    page,
  }) => {
    await page.goto("/mail");
    const start = await page.evaluate(() => history.length);
    await conversation(page, "Maya Chen").tap();
    await expect(subject(page)).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).tap();
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await conversation(page, "Alex Rivera").tap();
    await page.getByRole("button", { name: "Archive", exact: true }).tap();
    await expect(notice(page)).toContainText("Conversation archived.");
    await expect(conversation(page, "Alex Rivera")).toHaveCount(0);
    // Back now leaves Mail: no closed panel is waiting in the history.
    await expect.poll(() => hasLayer(page)).toBe(false);
    expect(await page.evaluate(() => history.length)).toBe(start + 1);
  });

  test("leaving Mail for another product, and Forward, leave no extra stops", async ({
    page,
  }) => {
    await page.goto("/mail");
    await conversation(page, "Maya Chen").tap();
    await expect(subject(page)).toBeVisible();
    // A closed conversation does not come back with Forward.
    await page.goBack();
    await expect(subject(page)).toBeHidden();
    await page.goForward();
    await expect.poll(() => hasLayer(page)).toBe(false);
    await expect(subject(page)).toBeHidden();

    // Over to Calendar with a conversation open, then back to Mail.
    await conversation(page, "Maya Chen").tap();
    await expect(subject(page)).toBeVisible();
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page
      .getByRole("navigation", { name: "Switch product" })
      .getByRole("link", { name: "Calendar" })
      .tap();
    await expect(page).toHaveURL(/\/calendar$/);
    await page.goBack();
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await expect.poll(() => hasLayer(page)).toBe(false);
    // The next Back leaves Mail: no stop shows the same list again.
    await page.goBack();
    await expect(page).toHaveURL("about:blank");
  });

  test("a long draft scrolls between its header and Send on a short screen", async ({
    page,
  }) => {
    await page.setViewportSize(landscape);
    await page.goto("/mail");
    await page.getByRole("button", { name: "New message" }).tap();
    const draft = composer(page);
    await draft.getByRole("button", { name: "Cc Bcc" }).tap();
    const fields = draft.locator(".compose-fields");
    expect(
      await fields.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    const body = draft.getByLabel("Message body");
    await body.tap();
    await body.fill("Hello from a short screen");
    await expect(body).toBeInViewport();
    const send = draft.getByRole("button", { name: "Send" });
    await expectInWindow(page, send);
    expect(await bottomOf(fields)).toBeLessThanOrEqual(
      (await draft.locator(".compose-footer").boundingBox())?.y ?? 0,
    );
    // An error below the fields is reachable too.
    await send.tap();
    const error = draft.getByRole("alert");
    await expect(error).toHaveText("Add at least one recipient.");
    await error.scrollIntoViewIfNeeded();
    await expect(error).toBeInViewport();
  });

  test("tapping the avatar selects a conversation", async ({ page }) => {
    await page.goto("/mail");
    const row = page.locator(".thread-row", { hasText: "Maya Chen" });
    // The whole avatar column selects, not only the small checkbox.
    await row.locator(".thread-select").tap({ position: { x: 29, y: 70 } });
    await expect(
      row.getByRole("checkbox", { name: "Select conversation" }),
    ).toBeChecked();
    await expect(page.getByText("1 selected")).toBeVisible();
    expect(await smallTargets(page.locator(".bulk-actions"))).toEqual([]);
    await expect(subject(page)).toBeHidden();
  });

  test("the draft stays above a synthetic on-screen keyboard", async ({
    page,
  }) => {
    const keyboard = await syntheticKeyboard(page);
    await page.goto("/mail");
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    const fab = page.getByRole("button", { name: "New message" });
    await keyboard(340);
    // The floating button would sit on the keyboard.
    await expect(fab).toBeHidden();
    await keyboard(0);
    await fab.tap();
    await composer(page).getByLabel("To").tap();
    await keyboard(340);
    await expect
      .poll(async () => (await composer(page).boundingBox())?.height)
      .toBe(phone.height - 340);
    const send = composer(page).getByRole("button", { name: "Send" });
    const box = await send.boundingBox();
    expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(
      phone.height - 340,
    );
    await keyboard(0);
    await expect
      .poll(async () => (await composer(page).boundingBox())?.height)
      .toBe(phone.height);
  });
});

for (const [name, viewport] of [
  ["a small phone", smallPhone],
  ["a phone held sideways", landscape],
] as const)
  test.describe(`Mail on ${name}`, () => {
    test.use({ viewport, ...touch });

    test("has no sideways scrolling and a full-screen draft", async ({
      page,
    }) => {
      await page.goto("/mail");
      await conversation(page, "Maya Chen").tap();
      await expect(subject(page)).toBeVisible();
      await expectNoSidewaysScroll(page);
      expect(await smallTargets(page.locator(".reading-toolbar"))).toEqual([]);
      await page.getByRole("button", { name: "Reply", exact: true }).tap();
      // Full screen in both orientations, with Send in view.
      expect(await composer(page).boundingBox()).toMatchObject({
        x: 0,
        y: 0,
        ...viewport,
      });
      await expectInWindow(
        page,
        composer(page).getByRole("button", { name: "Send" }),
      );
      await expectNoSidewaysScroll(page);
    });
  });

test.describe("Mail on a tablet", () => {
  test.use({ viewport: tablet, ...touch });

  test("the reader covers the list and Back returns to it; a draft stays a window", async ({
    page,
  }) => {
    await page.goto("/mail");
    await conversation(page, "Maya Chen").tap();
    await expect(subject(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mark unread" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Older conversation" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reply", exact: true }).tap();
    const box = await composer(page).boundingBox();
    expect(box?.width).toBeLessThan(tablet.width);
    await expect(page.locator(".shell-topbar")).toBeVisible();
    await page.goBack();
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe("Mail on a desktop", () => {
  test.use({ viewport: desktop });

  test("keeps both panes and its keyboard, with no extra history", async ({
    page,
  }) => {
    await page.goto("/mail");
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    const start = await page.evaluate(() => history.length);
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect(subject(page)).toBeVisible();
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await expect(conversation(page, "Maya Chen")).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(start);
    await expect(
      page.getByRole("button", { name: "More actions" }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Mark unread" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Back", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await page.keyboard.press("c");
    const draft = composer(page);
    await expect(draft.getByLabel("To")).toBeFocused();
    expect((await draft.boundingBox())?.width).toBeLessThan(800);
    await expect(page.locator(".shell-topbar")).toBeVisible();
  });

  test("resizing keeps the open conversation and closes the drawer", async ({
    page,
  }) => {
    await page.setViewportSize(phone);
    await page.goto("/mail");
    await conversation(page, "Maya Chen").click();
    await expect(subject(page)).toBeVisible();
    await expect(conversation(page, "Maya Chen")).toBeHidden();
    await page.setViewportSize(desktop);
    await expect(subject(page)).toBeVisible();
    await expect(conversation(page, "Maya Chen")).toBeVisible();
    await page.setViewportSize(phone);
    await expect(subject(page)).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Mail navigation" });
    await expect(drawer).toBeVisible();
    await page.setViewportSize(desktop);
    await expect(
      page.getByRole("dialog", { name: "Mail navigation" }),
    ).toHaveCount(0);
    await expect(page.locator(".shell-body")).not.toHaveAttribute("inert");
    await expectNoSidewaysScroll(page);
  });
});

test("reduced motion turns off the drawer animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(phone);
  await page.goto("/mail");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const duration = await page
    .locator(".shell-sidebar")
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(
    duration.split(",").every((value) => Number.parseFloat(value) <= 0.01),
  ).toBe(true);
});

test.describe("Calendar on a phone", () => {
  test.use({ viewport: phone, ...touch });

  test("the agenda lists the month, and events are created and edited by touch", async ({
    page,
  }) => {
    await page.clock.setFixedTime(now);
    await page.goto("/calendar");
    await expect(
      page.getByRole("button", { name: "Day", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await smallTargets(page.locator(".cal-toolbar"))).toEqual([]);
    await expect(
      page.getByRole("button", { name: "Keyboard shortcuts" }),
    ).toBeHidden();
    await expectNoSidewaysScroll(page);

    await page.getByRole("button", { name: "Agenda", exact: true }).tap();
    await expect(
      page.getByRole("heading", { name: "October 2026" }),
    ).toBeVisible();
    const today = page.getByRole("list", { name: /28 October/ });
    await expect(
      today.getByRole("button", { name: /^Team stand-up,/ }),
    ).toBeInViewport();
    expect(await smallTargets(page.locator(".cal-agenda"))).toEqual([]);
    await expectNoSidewaysScroll(page);
    await axe(page);

    // Create from the floating button: the form keeps Save in view.
    await page.getByRole("button", { name: "Create", exact: true }).tap();
    const editor = page.getByRole("dialog", { name: "New event" });
    await editor.getByLabel("Title").fill("Phone planning");
    const save = editor.getByRole("button", { name: "Save" });
    await expectInWindow(page, save);
    expect(await smallTargets(editor)).toEqual([]);
    await save.tap();
    await expect(notice(page)).toHaveText("Event created");
    const created = chip(page, "Phone planning");
    await expect(created).toBeVisible();

    // Edit it from its details, shown as a sheet at the bottom.
    await created.tap();
    const details = page.getByRole("dialog", { name: "Phone planning" });
    await expectInWindow(page, details);
    await details.getByRole("button", { name: "Edit event" }).tap();
    const edit = page.getByRole("dialog", { name: "Edit event" });
    await edit.getByLabel("Title").fill("Phone planning review");
    await edit.getByRole("button", { name: "Save" }).tap();
    await expect(notice(page)).toHaveText("Event saved");
    await expect(chip(page, "Phone planning review")).toBeVisible();

    // The day header opens the day; the agenda is remembered.
    await page
      .getByRole("button", { name: /28 October\. Open day view$/ })
      .tap();
    await expect(
      page.getByRole("heading", { name: /Wednesday,? 28 October 2026/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Agenda", exact: true }).tap();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Agenda", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("quick create stays above a synthetic on-screen keyboard", async ({
    page,
  }) => {
    const keyboard = await syntheticKeyboard(page);
    await page.clock.setFixedTime(now);
    await page.goto("/calendar");
    // Wednesday 28 October at 16:00 in the day view.
    await page.locator(".cal-scroll").evaluate((element) => {
      element.scrollTop = 12 * 48;
    });
    const grid = await page.locator(".cal-columns").boundingBox();
    if (!grid) throw new Error("Time grid is not visible");
    await page.touchscreen.tap(grid.x + grid.width / 2, grid.y + 16 * 48 + 10);
    const quick = page.getByRole("dialog", { name: "New event" });
    await expect(quick.getByLabel("Title")).toBeFocused();
    await keyboard(340);
    await expect
      .poll(() => bottomOf(quick))
      .toBeLessThanOrEqual(phone.height - 340);
    expect(
      await bottomOf(quick.getByRole("button", { name: "Save" })),
    ).toBeLessThanOrEqual(phone.height - 340);
    await page.keyboard.type("Quick sync");
    await page.keyboard.press("Enter");
    await expect(notice(page)).toHaveText("Event created");
    await keyboard(0);
    await expect(chip(page, "Quick sync")).toBeVisible();
  });

  test("an event's details fit a phone held sideways", async ({ page }) => {
    await page.setViewportSize(landscape);
    await page.clock.setFixedTime(now);
    await page.goto("/calendar");
    await chip(page, "Team stand-up").tap();
    await expectInWindow(
      page,
      page.getByRole("dialog", { name: "Team stand-up" }),
    );
    await expectNoSidewaysScroll(page);
  });
});

test.describe("Calendar on a desktop", () => {
  test.use({ viewport: desktop });

  test("A opens the agenda from the keyboard and the help lists it", async ({
    page,
  }) => {
    await page.clock.setFixedTime(now);
    await page.goto("/calendar");
    await expect(
      page.getByRole("button", { name: "Week", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("a");
    await expect(
      page.getByRole("button", { name: "Agenda", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: "October 2026" }),
    ).toBeVisible();
    await page.keyboard.press("j");
    await expect(
      page.getByRole("heading", { name: "November 2026" }),
    ).toBeVisible();
    await expect(chip(page, "Roadmap workshop").first()).toBeVisible();
    await page.keyboard.press("?");
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toContainText("Day, week, month or agenda view");
    await page.keyboard.press("Escape");
    await page.keyboard.press("w");
    await expect(
      page.getByRole("button", { name: "Week", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

for (const theme of ["light", "dark"] as const)
  for (const [name, viewport] of [
    ["phone", phone],
    ["tablet", tablet],
  ] as const)
    test.describe(`${theme} ${name}`, () => {
      test.use({ viewport, ...touch, colorScheme: theme });

      test("Mail, its drawer and the agenda are accessible", async ({
        page,
      }) => {
        await page.addInitScript(() =>
          localStorage.setItem("opensuite-theme", "system"),
        );
        await page.clock.setFixedTime(now);
        await page.goto("/mail");
        await conversation(page, "Maya Chen").tap();
        await expect(subject(page)).toBeVisible();
        await axe(page);
        await page.getByRole("button", { name: "Open navigation" }).tap();
        await expect(
          page.getByRole("dialog", { name: "Mail navigation" }),
        ).toBeVisible();
        await axe(page);
        await page.goto("/calendar");
        await page.getByRole("button", { name: "Agenda", exact: true }).tap();
        await expect(chip(page, "Lunch with Sam")).toBeVisible();
        await axe(page);
      });
    });
