import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ready = {
  status: "ready",
  checkedAt: "2026-01-01T00:00:00.000Z",
  dependencies: [],
};
async function mockHealthy(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok", uptimeSeconds: 42 } }),
  );
  await page.route("**/api/ready", (route) => route.fulfill({ json: ready }));
}
/** Visitors without a session see the public pages. */
async function signOut(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("auth-fixture-signed-out", "1"),
  );
}
async function checkAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

for (const theme of ["light", "dark"]) {
  test(`${theme} theme: keyboard controls, focus and accessibility`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
    await signOut(page);
    await page.emulateMedia({
      colorScheme: theme === "light" ? "light" : "dark",
    });
    await mockHealthy(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "All checks operational" }),
    ).toBeVisible();
    await checkAxe(page);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    const outline = await page
      .getByRole("link", { name: "Skip to content" })
      .evaluate((element) => getComputedStyle(element).outlineWidth);
    expect(outline).toBe("3px");
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog", { name: "Workspace settings" });
    await expect(dialog).toBeVisible();
    await checkAxe(page);
    const field = page.getByRole("textbox", { name: "Workspace label" });
    await expect(field).toBeFocused();
    await field.fill("");
    await page.getByRole("button", { name: "Save label" }).click();
    await expect(page.getByText("Enter a workspace label.")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("Test workspace");
    await field.press("Tab");
    await expect(
      page.getByRole("button", { name: "Save label" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("Workspace label saved on this device", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Test workspace")).toBeVisible();
    const menu = page.getByRole("button", {
      name: "Account and appearance menu",
    });
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(
      page.getByRole("menuitemradio", { name: "Use system theme" }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "Light theme" }),
    ).toBeFocused();
    if (theme === "light") {
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitemradio", { name: "Dark theme" }),
      ).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "dark" : "light",
    );
    await checkAxe(page);
    await page.reload();
    await expect(page.getByText("Test workspace")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "dark" : "light",
    );
    await page.getByRole("link", { name: "Calendar" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
}

test("light is the default across products while saved and system choices remain available", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockHealthy(page);
  async function checkDefault(path: string) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  }
  await checkDefault("/status");
  await checkDefault("/mail");
  await checkDefault("/calendar");
  await checkDefault("/drive");
  await checkDefault("/vault");
  await page.goto("/status");
  const menu = page.getByRole("button", { name: "Account menu" });
  await menu.click();
  await page.getByRole("menuitemradio", { name: "Dark theme" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await menu.click();
  await page.getByRole("menuitemradio", { name: "Use system theme" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
});

test("loading, degraded readiness and dependency detail", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { status: "ok", uptimeSeconds: 9 } }),
  );
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/ready", async (route) => {
    await wait;
    await route.fulfill({
      status: 503,
      json: {
        defined: true,
        code: "NOT_READY",
        status: 503,
        message: "One or more dependencies are unavailable",
        data: {
          status: "not_ready",
          checkedAt: "2026-01-01T00:00:00.000Z",
          dependencies: [{ name: "database", status: "down", durationMs: 5 }],
        },
      },
    });
  });
  await page.goto("/status");
  await expect(
    page.getByRole("heading", { name: "Checking services" }),
  ).toBeVisible();
  if (release) release();
  await expect(
    page.getByRole("heading", { name: "Attention needed" }),
  ).toBeVisible();
  await expect(page.getByText("database")).toBeVisible();
  await expect(page.getByText("Degraded").first()).toBeVisible();
  await checkAxe(page);
});

test("network failures are reported and refresh recovers", async ({ page }) => {
  await page.route("**/api/*", (route) => route.abort("failed"));
  await page.goto("/status");
  await expect(
    page.getByRole("heading", { name: "Some checks are unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("Unable to reach or validate the API"),
  ).toHaveCount(2);
  await page.unrouteAll();
  await mockHealthy(page);
  await page.getByRole("button", { name: "Refresh checks" }).click();
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
});

test("live API probes reach the status page through the preview proxy", async ({
  page,
}) => {
  const healthResponse = page.waitForResponse("**/api/health");
  const readyResponse = page.waitForResponse("**/api/ready");
  await page.goto("/status");
  expect((await healthResponse).status()).toBe(200);
  expect((await readyResponse).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
  await expect(page.getByText(/Uptime: \d+ seconds/)).toBeVisible();
  await expect(page.getByText("No dependencies declared")).toBeVisible();
});

test("a script that fails to load is retried instead of leaving a blank page", async ({
  page,
}) => {
  await mockHealthy(page);
  let aborted = 0;
  // A module of the initial graph fails on two loads in a row, as during a
  // burst of network changes.
  await page.route("**/src/ui/toast.tsx*", async (route) => {
    if (aborted < 2) {
      aborted += 1;
      await route.abort("internetdisconnected");
    } else await route.continue();
  });
  await page.goto("/status");
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
  expect(aborted).toBe(2);
});

test("a script that keeps failing stops after three reloads", async ({
  page,
}) => {
  await mockHealthy(page);
  let attempts = 0;
  await page.route("**/src/ui/toast.tsx*", async (route) => {
    attempts += 1;
    await route.abort("internetdisconnected");
  });
  await page.goto("/status");
  // Reloads wait 0.5 s, 2 s and 4.5 s; allow them all, then confirm no more.
  await expect.poll(() => attempts, { timeout: 20_000 }).toBe(4);
  await page.waitForTimeout(6000);
  expect(attempts).toBe(4);
});

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };
async function useTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => {
    localStorage.setItem("opensuite-theme", value);
  }, theme);
}

test("the root opens Mail with a session and status reflects the real session", async ({
  page,
}) => {
  await mockHealthy(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/mail$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.goto("/status");
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);

  await page.evaluate(() =>
    sessionStorage.setItem("auth-fixture-signed-out", "1"),
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "All checks operational" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle("Sign in · Esuno");
});

const tabTitles: [string, string | RegExp][] = [
  ["/mail", /· Esuno Mail$/],
  ["/calendar", "Esuno Calendar"],
  ["/drive", "Esuno Drive"],
  ["/vault/generator", "Esuno Vault"],
  ["/contacts", "Esuno Contacts"],
  ["/status", "System status · Esuno"],
  ["/domains", "Domains · Esuno"],
  ["/setup", "Setup wizard · Esuno"],
];
for (const [path, title] of tabTitles)
  test(`${path} names its browser tab`, async ({ page }) => {
    await mockHealthy(page);
    await page.goto(path);
    await expect(page).toHaveTitle(title);
  });
test("moving between admin pages updates the tab title", async ({ page }) => {
  await mockHealthy(page);
  await page.goto("/status");
  await expect(page).toHaveTitle("System status · Esuno");
  await page.getByRole("link", { name: "Domains" }).click();
  await expect(page).toHaveTitle("Domains · Esuno");
});

for (const theme of ["light", "dark"] as const)
  for (const [device, viewport] of [
    ["desktop", desktop],
    ["mobile", mobile],
  ] as const) {
    test(`${theme} ${device}: dialog field focus and a pausable notification with Undo`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await mockHealthy(page);
      await page.clock.install();
      await page.goto("/status");
      await expect(
        page.getByRole("heading", { name: "All checks operational" }),
      ).toBeVisible();
      const live = page.locator(".toast-viewport [aria-live='polite']");
      await expect(live).toHaveCount(1);
      await expect(live).toBeEmpty();

      const refresh = page.getByRole("button", { name: "Refresh checks" });
      await refresh.focus();
      await page.keyboard.press("s");
      const dialog = page.getByRole("dialog", { name: "Workspace settings" });
      await expect(
        dialog.getByRole("textbox", { name: "Workspace label" }),
      ).toBeFocused();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Night shift");
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(page.locator(".admin-workspace-name")).toHaveText(
        "Night shift",
      );
      await expect(live).toHaveText("Workspace label saved on this device");
      const notice = page.locator(".toast[data-state='open']");
      await checkAxe(page);

      // Hovering holds the notification well past its ten seconds.
      await notice.hover();
      await page.clock.runFor(30_000);
      await expect(notice).toBeVisible();
      await page.mouse.move(1, 1);
      await page.clock.runFor(10_000);
      await expect(notice).toHaveCount(0);
      await expect(live).toBeEmpty();
      await expect(page.locator(".toast-viewport [aria-live]")).toHaveCount(1);

      // Keyboard: F8 reaches the notification, focus holds it, Undo restores.
      await refresh.focus();
      await page.keyboard.press("s");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Day shift");
      await page.keyboard.press("Enter");
      await expect(live).toHaveText("Workspace label saved on this device");
      const account = page.getByRole("button", { name: "Account menu" });
      await account.focus();
      await page.keyboard.press("F8");
      const undo = page.getByRole("button", { name: "Undo" });
      await expect(undo).toBeFocused();
      await page.clock.runFor(30_000);
      await expect(undo).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(notice).toHaveCount(0);
      await expect(account).toBeFocused();
      await expect(page.locator(".admin-workspace-name")).toHaveText(
        "Night shift",
      );

      // Escape dismisses from the notification too.
      await page.keyboard.press("s");
      await page.keyboard.press("Enter");
      await expect(notice).toBeVisible();
      await page.keyboard.press("F8");
      await page.keyboard.press("Escape");
      await expect(notice).toHaveCount(0);
    });
  }

for (const theme of ["light", "dark"] as const)
  test(`${theme} mobile: the navigation drawer holds focus and gives it back`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile);
    await useTheme(page, theme);
    await page.goto("/vault/generator");
    const opener = page.getByRole("button", { name: "Open navigation" });
    await expect(opener).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Esuno Vault navigation" });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Close navigation" }),
    ).toBeFocused();
    await expect(page.locator(".shell-body")).toHaveAttribute("inert", "");
    await expect(
      drawer.locator(".shell-nav-item[aria-current='page']"),
    ).toHaveText(["Generator"]);
    await checkAxe(page);
    // Record every element that takes focus outside the drawer while tabbing.
    await page.evaluate(() => {
      const outside: string[] = [];
      Reflect.set(window, "focusOutsideDrawer", outside);
      document.addEventListener("focusin", (event) => {
        if (
          event.target instanceof Element &&
          !event.target.closest(".shell-sidebar")
        )
          outside.push(event.target.outerHTML.slice(0, 80));
      });
    });
    await Array.from({ length: 16 }).reduce<Promise<void>>(
      (previous) => previous.then(() => page.keyboard.press("Tab")),
      Promise.resolve(),
    );
    expect(
      await page.evaluate(() => {
        const outside: unknown = Reflect.get(window, "focusOutsideDrawer");
        return Array.isArray(outside) ? outside.map(String) : null;
      }),
    ).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".shell-body")).not.toHaveAttribute("inert");

    // Choosing a destination closes the drawer as well.
    await page.keyboard.press("Enter");
    await drawer.getByRole("link", { name: "Calendar" }).click();
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(drawer).toHaveCount(0);
  });

test("only the exact sidebar and product links are marked current", async ({
  page,
}) => {
  await page.goto("/vault/generator");
  const sidebar = page.locator(".shell-sidebar-scroll");
  await expect(sidebar.locator("[aria-current='page']")).toHaveText([
    "Generator",
  ]);
  await expect(sidebar.getByRole("link", { name: "Overview" })).not.toHaveClass(
    /\bactive\b/,
  );
  await expect(page.locator(".shell-rail [aria-current='page']")).toHaveText([
    "Vault",
  ]);
  await page.goto("/domains");
  await expect(sidebar.locator("[aria-current='page']")).toHaveText([
    "Domains",
  ]);
  // Calendar shows its messages in the shared region, not in one of its own.
  await page.goto("/calendar");
  await expect(page.locator(".toast-viewport")).toHaveCount(1);
});

const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number);
const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (color: string) => {
  const [r = 0, g = 0, b = 0] = channels(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
/** WCAG contrast ratio of two opaque CSS colours. */
function contrast(foreground: string, background: string) {
  const [light = 0, dark = 0] = [
    luminance(foreground),
    luminance(background),
  ].toSorted((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
/** Text colour of each visible key cap and the first opaque background behind it. */
async function kbdColors(page: Page) {
  return page.locator("kbd:visible").evaluateAll((keys) =>
    keys.map((key) => {
      let node: Element | null = key;
      let background = "rgb(255, 255, 255)";
      while (node) {
        const value = getComputedStyle(node).backgroundColor;
        if (value !== "transparent" && !value.endsWith(", 0)")) {
          background = value;
          break;
        }
        node = node.parentElement;
      }
      return {
        key: key.textContent,
        color: getComputedStyle(key).color,
        background,
      };
    }),
  );
}
for (const theme of ["light", "dark"] as const)
  test(`${theme}: keyboard shortcut keys are readable`, async ({ page }) => {
    await page.setViewportSize(desktop);
    await useTheme(page, theme);
    await page.goto("/mail");
    await expect(page.getByText("for keyboard shortcuts")).toBeVisible();
    await page.keyboard.press("?");
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    const keys = await kbdColors(page);
    expect(keys.length).toBeGreaterThan(3);
    for (const { key, color, background } of keys)
      expect(
        contrast(color, background),
        `contrast of ${key} (${color} on ${background})`,
      ).toBeGreaterThanOrEqual(4.5);
  });
