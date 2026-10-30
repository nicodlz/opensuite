/* oxlint-disable unicorn/consistent-function-scoping, typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion */
import { createECDH } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

type Fixture = {
  permission?: NotificationPermission;
  installed?: boolean;
  ios?: boolean;
  unsupported?: boolean;
  subscribed?: boolean;
  sessions?: number;
  count?: number;
  nextAt?: number;
};
async function setup(page: Page, fixture: Fixture = {}) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  let subscribed = fixture.subscribed ?? false;
  await page.route("**/api/push/public-key", (route) =>
    route.fulfill({
      json: { publicKey: key.getPublicKey().toString("base64url") },
    }),
  );
  await page.route("**/api/push/status", (route) =>
    route.fulfill({ json: { subscribed } }),
  );
  await page.route("**/api/push/privacy", (route) =>
    route.fulfill({ json: { showDetails: false } }),
  );
  await page.route("**/api/push/subscribe", (route) => {
    subscribed = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript((data) => {
    if (!sessionStorage.getItem("prompt-test-initialized")) {
      sessionStorage.setItem("prompt-test-initialized", "1");
      localStorage.setItem(
        "esuno-notification-mail-sessions",
        String(data.sessions ?? 2),
      );
      localStorage.setItem(
        "esuno-notification-offers",
        JSON.stringify({ count: data.count ?? 0, nextAt: data.nextAt ?? 0 }),
      );
      if (data.subscribed)
        localStorage.setItem(
          "prompt-test-endpoint",
          "https://fcm.googleapis.com/prompt-test",
        );
    }
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === "(display-mode: standalone)"
        ? {
            matches: data.installed ?? false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          }
        : nativeMatchMedia(query);
    if (data.ios) {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      });
      Object.defineProperty(navigator, "standalone", { value: false });
    }
    if (data.unsupported) {
      Reflect.deleteProperty(window, "PushManager");
      return;
    }
    let permission = data.permission ?? "default";
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => permission,
    });
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: () => {
        localStorage.setItem(
          "prompt-test-permission-requests",
          String(
            Number(
              localStorage.getItem("prompt-test-permission-requests") ?? 0,
            ) + 1,
          ),
        );
        permission = "granted";
        return Promise.resolve("granted");
      },
    });
    const make = (endpoint: string): PushSubscription => ({
      endpoint,
      expirationTime: null,
      options: {} as PushSubscriptionOptions,
      getKey: () => null,
      toJSON: () => ({
        endpoint,
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
      }),
      unsubscribe: () => {
        localStorage.removeItem("prompt-test-endpoint");
        return Promise.resolve(true);
      },
    });
    PushManager.prototype.getSubscription = () => {
      const endpoint = localStorage.getItem("prompt-test-endpoint");
      return Promise.resolve(endpoint ? make(endpoint) : null);
    };
    PushManager.prototype.subscribe = () => {
      const endpoint = "https://fcm.googleapis.com/prompt-test";
      localStorage.setItem("prompt-test-endpoint", endpoint);
      return Promise.resolve(make(endpoint));
    };
  }, fixture);
  const status = fixture.subscribed
    ? page.waitForResponse((response) =>
        response.url().endsWith("/api/push/status"),
      )
    : undefined;
  await openMail(page);
  if (status) await status;
}
const banner = (page: Page) =>
  page.getByRole("region", { name: "Notification suggestion" });
async function openMail(page: Page) {
  try {
    await page.goto("/mail");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  } catch (error) {
    // Docker network changes can briefly put Chromium on its own error page.
    const interrupted = await page
      .locator("text=ERR_NETWORK_CHANGED")
      .count()
      .catch(() => 0);
    if (
      !interrupted &&
      !(error instanceof Error && error.message.includes("ERR_NETWORK_CHANGED"))
    )
      throw error;
    await page.goto("/mail");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  }
}
async function nextSession(page: Page) {
  await page.evaluate(() =>
    sessionStorage.removeItem("esuno-notification-mail-session"),
  );
  await openMail(page);
}

test("offers after three browser sessions without prompting on load", async ({
  page,
}) => {
  await setup(page, { sessions: 0 });
  await expect(banner(page)).toHaveCount(0);
  await nextSession(page);
  await expect(banner(page)).toHaveCount(0);
  await nextSession(page);
  await expect(banner(page)).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-label="Notification suggestion"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("prompt-test-permission-requests"),
    ),
  ).toBeNull();
});

test("offers on first installed launch; Enable requests permission and subscribes", async ({
  page,
}) => {
  await setup(page, { installed: true, sessions: 0 });
  await expect(banner(page)).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("prompt-test-permission-requests"),
    ),
  ).toBeNull();
  const request = page.waitForRequest((item) =>
    item.url().endsWith("/api/push/subscribe"),
  );
  await banner(page)
    .getByRole("button", { name: "Enable notifications" })
    .click();
  expect((await request).postDataJSON()).toMatchObject({
    product: "mail",
    endpoint: "https://fcm.googleapis.com/prompt-test",
  });
  await expect(banner(page)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("prompt-test-permission-requests"),
    ),
  ).toBe("1");
});

test("hides when already granted and subscribed or unsupported", async ({
  page,
}) => {
  await setup(page, { permission: "granted", subscribed: true });
  await expect(banner(page)).toHaveCount(0);
});
test("offers when permission is granted but this product is not subscribed", async ({
  page,
}) => {
  await setup(page, { permission: "granted" });
  await expect(banner(page)).toBeVisible();
  await expect(
    banner(page).getByRole("button", { name: "Enable notifications" }),
  ).toBeVisible();
});
test("does not offer on unsupported browsers", async ({ page }) => {
  await setup(page, { unsupported: true });
  await expect(banner(page)).toHaveCount(0);
});
test("explains denied permission without offering Enable", async ({ page }) => {
  await setup(page, { permission: "denied" });
  await expect(banner(page)).toContainText("browser or device settings");
  await expect(
    banner(page).getByRole("button", { name: "Enable notifications" }),
  ).toHaveCount(0);
});
test("explains Home Screen installation on iOS", async ({ page }) => {
  await setup(page, { ios: true, unsupported: true });
  await expect(banner(page)).toContainText("Add to Home Screen");
  await expect(
    banner(page).getByRole("button", { name: "Enable notifications" }),
  ).toHaveCount(0);
});
test("Later applies the cooldown, then allows another offer", async ({
  page,
}) => {
  await setup(page);
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Later" }).click();
  const delay = await page.evaluate(() => {
    const raw: unknown = JSON.parse(
      localStorage.getItem("esuno-notification-offers") ?? "{}",
    );
    return typeof raw === "object" &&
      raw !== null &&
      "nextAt" in raw &&
      typeof raw.nextAt === "number"
      ? raw.nextAt - Date.now()
      : 0;
  });
  expect(delay).toBeGreaterThan(13.9 * 24 * 60 * 60_000);
  await nextSession(page);
  await expect(banner(page)).toHaveCount(0);
  await page.evaluate(() => {
    const key = "esuno-notification-offers";
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    const count =
      typeof raw === "object" &&
      raw !== null &&
      "count" in raw &&
      typeof raw.count === "number"
        ? raw.count
        : 0;
    localStorage.setItem(
      key,
      JSON.stringify({ count, nextAt: Date.now() - 1 }),
    );
  });
  await nextSession(page);
  await expect(banner(page)).toBeVisible();
});
test("never offers again once the cap is reached", async ({ page }) => {
  await setup(page, { count: 3, nextAt: 0 });
  await expect(banner(page)).toHaveCount(0);
  await nextSession(page);
  await expect(banner(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Notification settings" }).click();
  await expect(
    page.getByRole("button", { name: "Enable notifications" }),
  ).toBeVisible();
});
test("dismissing also sets the cooldown", async ({ page }) => {
  await setup(page);
  await expect(banner(page)).toBeVisible();
  await banner(page)
    .getByRole("button", { name: "Dismiss notification suggestion" })
    .click();
  await nextSession(page);
  await expect(banner(page)).toHaveCount(0);
});

test("calendar stays quiet until a feature offers custom copy", async ({
  page,
}) => {
  await setup(page, { sessions: 0 });
  await page.goto("/calendar");
  await expect(
    page.getByRole("navigation", { name: "Products" }),
  ).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("esuno-notification-offer", {
        detail: {
          product: "calendar",
          reason: "reminder-saved",
          message: "Get this reminder on this device?",
        },
      }),
    ),
  );
  await expect(banner(page)).toContainText("Get this reminder on this device?");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("prompt-test-permission-requests"),
    ),
  ).toBeNull();
});

async function saveCalendarReminder(page: Page) {
  await page.getByRole("button", { name: "Create C", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Title").fill("Reminder prompt test");
  await editor.getByLabel("Reminder").selectOption("10m");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
}

test("saving a calendar reminder offers Enable and subscribes this device", async ({
  page,
}) => {
  await setup(page, { sessions: 0 });
  await page.goto("/calendar");
  await saveCalendarReminder(page);
  await expect(banner(page)).toContainText("Get this reminder on this device?");
  const request = page.waitForRequest((item) =>
    item.url().endsWith("/api/push/subscribe"),
  );
  await banner(page)
    .getByRole("button", { name: "Enable notifications" })
    .click();
  expect((await request).postDataJSON()).toMatchObject({
    product: "calendar",
    endpoint: "https://fcm.googleapis.com/prompt-test",
  });
  await expect(banner(page)).toHaveCount(0);
  await saveCalendarReminder(page);
  await expect(banner(page)).toHaveCount(0);
});

test("Later hides the calendar reminder suggestion", async ({ page }) => {
  await setup(page, { sessions: 0 });
  await page.goto("/calendar");
  await saveCalendarReminder(page);
  await expect(banner(page)).toContainText("Get this reminder on this device?");
  await banner(page).getByRole("button", { name: "Later" }).click();
  await expect(banner(page)).toHaveCount(0);
});

test("editing an event to add a reminder offers calendar notifications", async ({
  page,
}) => {
  await setup(page, { sessions: 0 });
  await page.goto("/calendar");
  await page.getByRole("button", { name: /^Design review,/ }).click();
  await page
    .getByRole("dialog", { name: "Design review" })
    .getByRole("button", { name: "Edit event" })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit event" });
  await editor.getByLabel("Reminder").selectOption("5m");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(banner(page)).toContainText("Get this reminder on this device?");
});

test("a Mail suggestion is not carried into Calendar", async ({ page }) => {
  await setup(page);
  await expect(banner(page)).toContainText("new mail");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Calendar" })
    .click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(banner(page)).toHaveCount(0);
});

test("enabling in Settings closes an existing suggestion", async ({ page }) => {
  await setup(page);
  await expect(banner(page)).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Notification settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await dialog.getByRole("button", { name: "Enable notifications" }).click();
  await expect(dialog.getByText("Status: on")).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(banner(page)).toHaveCount(0);
});
