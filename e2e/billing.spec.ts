import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { BillingOverview } from "../packages/contracts/src/billing.ts";

const base: BillingOverview = {
  mode: "cloud",
  source: "subscription",
  plan: "plus",
  exempt: false,
  subscription: {
    status: "active",
    interval: "year",
    amount: 3588,
    currency: "eur",
    currentPeriodEnd: "2027-01-15T00:00:00Z",
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
  },
  uploadsAllowed: true,
  storage: {
    quotaBytes: 50_000_000_000,
    usedBytes: 20_000_000_000,
    driveBytes: 12_000_000_000,
    mailBytes: 8_000_000_000,
    measured: true,
  },
};
const scenarios = {
  active: base,
  past_due: {
    ...base,
    subscription: {
      ...base.subscription,
      status: "past_due",
      interval: "month",
      amount: 349,
      currency: "eur",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
    },
  },
  over_quota: {
    ...base,
    uploadsAllowed: false,
    storage: { ...base.storage, usedBytes: 51_000_000_000 },
  },
  no_plan: {
    ...base,
    plan: "none",
    source: "none",
    uploadsAllowed: false,
    subscription: null,
    storage: { ...base.storage, quotaBytes: null },
  },
  self_hosted: {
    ...base,
    mode: "self-hosted",
    source: "self-hosted",
    plan: "free",
    subscription: null,
    storage: { ...base.storage, quotaBytes: null },
  },
} satisfies Record<string, BillingOverview>;
async function live(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("billing-fixture", "live");
  });
}
async function mockOverview(page: Page, data: BillingOverview) {
  await page.route("**/api/billing", (route) => route.fulfill({ json: data }));
}
async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter(
      (item) => item.impact === "critical" || item.impact === "serious",
    ),
  ).toEqual([]);
}
async function shot(page: Page, name: string) {
  await page.screenshot({
    path: `/tmp/esuno-billing-shots/${name}.png`,
    fullPage: true,
  });
}

for (const size of ["desktop", "mobile"] as const) {
  for (const [state, data] of Object.entries(scenarios)) {
    test(`${size} settings: ${state}`, async ({ page }) => {
      if (size === "mobile")
        await page.setViewportSize({ width: 390, height: 844 });
      await live(page);
      await mockOverview(page, data);
      await page.goto("/settings/billing");
      await expect(
        page.getByRole("heading", { name: "Plan & storage" }),
      ).toBeVisible();
      if (state === "active")
        await expect(
          page.getByText("€2.99/month, billed €35.88 per year"),
        ).toBeVisible();
      if (state === "past_due")
        await expect(
          page.getByText(/Payment issue.*update your payment method/),
        ).toBeVisible();
      if (state === "over_quota")
        await expect(
          page.getByText(/new uploads and incoming mail are paused/),
        ).toBeVisible();
      if (state === "no_plan")
        await expect(
          page.getByRole("button", { name: "Continue to checkout" }),
        ).toBeVisible();
      if (state === "self_hosted") {
        await expect(
          page.getByText(/Self-hosted — no subscription/),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: /checkout|change plan|Manage billing/i,
          }),
        ).toHaveCount(0);
      }
      await axe(page);
      await shot(page, `settings-${state}-${size}`);
    });
  }
}
test("settings handle unknown usage, warning, read-only and cancellation", async ({
  page,
}) => {
  await live(page);
  let data: BillingOverview = {
    ...base,
    storage: { ...base.storage, measured: false, usedBytes: 50_000_000_000 },
    subscription: {
      ...scenarios.past_due.subscription,
      status: "unpaid",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2027-01-15T00:00:00Z",
    },
  };
  await page.route("**/api/billing", (route) => route.fulfill({ json: data }));
  await page.goto("/settings/billing?billing=updated");
  await expect(page.getByText("Usage temporarily unavailable.")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByText(/read-only/)).toBeVisible();
  await expect(page.getByText(/Cancellation scheduled/)).toBeVisible();
  await expect(
    page.getByText(/Your plan updates as soon as Stripe confirms/),
  ).toBeVisible();
  data = { ...base, storage: { ...base.storage, usedBytes: 40_000_000_000 } };
  await expect(page.getByText(/at least 80%/)).toBeVisible({ timeout: 8000 });
  data = { ...base, storage: { ...base.storage, usedBytes: 47_500_000_000 } };
  await expect(page.getByText(/at least 95%/)).toBeVisible({ timeout: 8000 });
});
test("operator account has no purchase UI", async ({ page }) => {
  await live(page);
  await mockOverview(page, {
    ...base,
    exempt: true,
    source: "operator",
    storage: { ...base.storage, quotaBytes: null },
  });
  await page.goto("/settings/billing");
  await expect(
    page.getByText("Operator account — no plan limits."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /checkout|change plan|Manage billing/i }),
  ).toHaveCount(0);
});
for (const action of ["change", "portal", "checkout"] as const) {
  test(`${action} sends the expected body and follows the redirect`, async ({
    page,
  }) => {
    await live(page);
    await mockOverview(page, action === "checkout" ? scenarios.no_plan : base);
    let body: unknown;
    await page.route(`**/api/billing/${action}`, async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({
        json: { url: `${new URL(page.url()).origin}/stripe-result` },
      });
    });
    await page.route("**/stripe-result", (route) =>
      route.fulfill({ contentType: "text/html", body: "Stripe confirmation" }),
    );
    await page.goto("/settings/billing");
    if (action !== "portal") {
      await page
        .getByRole("combobox", { name: "Plan", exact: true })
        .selectOption("pro");
      await page
        .getByRole("combobox", { name: "Billing interval" })
        .selectOption("month");
    }
    await page
      .getByRole("button", {
        name:
          action === "portal"
            ? "Manage billing"
            : action === "change"
              ? "Continue to change plan"
              : "Continue to checkout",
      })
      .click();
    await expect(page).toHaveURL(/stripe-result/);
    expect(body).toEqual(
      action === "portal" ? {} : { plan: "pro", interval: "month" },
    );
  });
}
test("downgrade asks for confirmation when current usage exceeds target", async ({
  page,
}) => {
  await live(page);
  await mockOverview(page, {
    ...base,
    plan: "pro",
    storage: {
      ...base.storage,
      quotaBytes: 500_000_000_000,
      usedBytes: 60_000_000_000,
    },
  });
  await page.goto("/settings/billing");
  await page.getByRole("button", { name: "Continue to change plan" }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing is deleted");
  await expect(
    page.getByRole("button", { name: "Continue with downgrade" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Billing interval" })
    .selectOption("year");
  await expect(
    page.getByRole("button", { name: "Continue with downgrade" }),
  ).toHaveCount(0);
});
test("subscribe chooser, checkout and billing error", async ({ page }) => {
  await live(page);
  await page.route("**/api/billing/plans", (route) =>
    route.fulfill({
      json: { mode: "cloud", checkout: true, pricesIncludeTax: true },
    }),
  );
  await page.goto("/subscribe?plan=invalid&interval=month");
  await expect(
    page.getByRole("heading", { name: "Choose Esuno Cloud" }),
  ).toBeVisible();
  await axe(page);
  await shot(page, "subscribe-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "subscribe-mobile");
  await page.route("**/api/billing/checkout", (route) =>
    route.fulfill({
      status: 404,
      json: {
        defined: true,
        code: "BILLING_DISABLED",
        status: 404,
        message: "Billing is not enabled",
      },
    }),
  );
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await expect(
    page.getByRole("link", { name: "Self-hosting documentation" }),
  ).toBeVisible();
});
test("subscribe follows a checkout URL", async ({ page }) => {
  await live(page);
  await page.addInitScript(() =>
    sessionStorage.setItem("auth-fixture-signed-out", "1"),
  );
  let body: unknown;
  await page.route("**/api/billing/plans", (route) =>
    route.fulfill({
      json: { mode: "cloud", checkout: true, pricesIncludeTax: true },
    }),
  );
  await page.route("**/api/billing/checkout", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      json: { url: `${new URL(route.request().url()).origin}/stripe-result` },
    });
  });
  await page.route("**/stripe-result", (route) =>
    route.fulfill({ contentType: "text/html", body: "Stripe" }),
  );
  await page.goto("/subscribe?plan=pro&interval=year");
  await expect(page).toHaveURL(/stripe-result/);
  expect(body).toEqual({ plan: "pro", interval: "year" });
});
test("welcome confirms, claims and offers sign-in", async ({ page }) => {
  await live(page);
  let calls = 0;
  let body: unknown;
  await page.route("**/api/billing/checkout/cs_test_abc", (route) => {
    calls++;
    return route.fulfill({
      json: {
        state: calls === 1 ? "pending" : "claimable",
        plan: "plus",
        interval: "month",
        domain: "example.test",
      },
    });
  });
  await page.route("**/api/billing/claim", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { email: "sam@example.test" } });
  });
  await page.goto("/welcome?session_id=cs_test_abc");
  await expect(page.getByText("Confirming your payment…")).toBeVisible();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toBeVisible();
  await axe(page);
  await shot(page, "welcome-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "welcome-mobile");
  await page.getByLabel("Name", { exact: true }).fill("Sam");
  await page.getByLabel("Address", { exact: true }).fill("sam");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a long secure password");
  await page.getByLabel("Confirm password").fill("a long secure password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(body).toEqual({
    sessionId: "cs_test_abc",
    name: "Sam",
    localPart: "sam",
    password: "a long secure password",
  });
});
test("Drive shows over quota and maps upload quota errors", async ({
  page,
}) => {
  await live(page);
  await page.addInitScript(() =>
    sessionStorage.setItem("drive-fixture-live", "1"),
  );
  await mockOverview(page, scenarios.over_quota);
  await page.route("**/drive/api/v1/command", (route) => {
    const input: unknown = route.request().postDataJSON();
    return typeof input === "object" &&
      input !== null &&
      "action" in input &&
      input.action === "upload"
      ? route.fulfill({
          status: 403,
          json: {
            defined: true,
            code: "QUOTA_EXCEEDED",
            status: 403,
            message: "Quota exceeded",
          },
        })
      : route.fulfill({ json: { entries: [] } });
  });
  await page.goto("/drive");
  await expect(
    page.getByText(/new uploads and incoming mail are paused/),
  ).toBeVisible();
  await axe(page);
  await page.getByLabel("Choose files to upload").setInputFiles({
    name: "file.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByRole("alert")).toContainText("Storage quota exceeded");
  await expect(
    page.getByRole("link", { name: "Review plan & storage" }),
  ).toHaveAttribute("href", "/settings/billing");
});

for (const code of ["CONFLICT", "SERVICE_UNAVAILABLE"] as const) {
  test(`settings explain ${code}`, async ({ page }) => {
    await live(page);
    await mockOverview(page, base);
    await page.route("**/api/billing/portal", (route) =>
      route.fulfill({
        status: code === "CONFLICT" ? 409 : 503,
        json: {
          defined: true,
          code,
          status: code === "CONFLICT" ? 409 : 503,
          message: "Unavailable",
        },
      }),
    );
    await page.goto("/settings/billing");
    await page.getByRole("button", { name: "Manage billing" }).click();
    await expect(page.getByRole("alert")).toContainText(
      code === "CONFLICT" ? "conflicts" : "temporarily unavailable",
    );
  });
}
for (const state of ["claimed", "expired"] as const) {
  test(`welcome ${state}`, async ({ page }) => {
    await live(page);
    await page.route("**/api/billing/checkout/cs_test_abc", (route) =>
      route.fulfill({
        json: { state, plan: "plus", interval: "year", domain: "example.test" },
      }),
    );
    await page.goto("/welcome?session_id=cs_test_abc");
    await expect(
      page.getByText(
        state === "claimed" ? /already set up/ : /checkout has expired/,
      ),
    ).toBeVisible();
    if (state === "claimed")
      await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await axe(page);
  });
}
test("settings are accessible from the account menu in dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await live(page);
  await mockOverview(page, base);
  await page.goto("/mail");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Plan & storage" }).click();
  await expect(
    page.getByRole("heading", { name: "Plan & storage" }),
  ).toBeVisible();
  await axe(page);
  await shot(page, "settings-active-dark");
});

test("an ended subscription starts checkout and complimentary plans cannot be purchased", async ({
  page,
}) => {
  await live(page);
  let overview: BillingOverview = {
    ...base,
    plan: "none",
    source: "none",
    uploadsAllowed: false,
    subscription: { ...scenarios.past_due.subscription, status: "canceled" },
  };
  await page.route("**/api/billing", (route) =>
    route.fulfill({ json: overview }),
  );
  let checkout = 0;
  await page.route("**/api/billing/checkout", (route) => {
    checkout++;
    return route.fulfill({
      status: 503,
      json: {
        defined: true,
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        message: "Unavailable",
      },
    });
  });
  await page.goto("/settings/billing");
  await expect(
    page.getByRole("heading", { name: "Choose your plan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await expect.poll(() => checkout).toBe(1);
  overview = { ...base, source: "grant", subscription: null };
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Complimentary plan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /checkout|change plan|Manage billing/i }),
  ).toHaveCount(0);
});

test("self-hosted subscribe does not request checkout", async ({ page }) => {
  await live(page);
  let calls = 0;
  await page.route("**/api/billing/plans", (route) =>
    route.fulfill({
      json: { mode: "self-hosted", checkout: false, pricesIncludeTax: true },
    }),
  );
  await page.route("**/api/billing/checkout", (route) => {
    calls++;
    return route.abort();
  });
  await page.goto("/subscribe?plan=plus&interval=year");
  await expect(page.getByText(/Esuno is self-hosted here/)).toBeVisible();
  expect(calls).toBe(0);
});

test("welcome explains an unavailable address", async ({ page }) => {
  await live(page);
  await page.route("**/api/billing/checkout/cs_test_abc", (route) =>
    route.fulfill({
      json: {
        state: "claimable",
        plan: "plus",
        interval: "month",
        domain: "example.test",
      },
    }),
  );
  await page.route("**/api/billing/claim", (route) =>
    route.fulfill({
      status: 409,
      json: {
        defined: true,
        code: "CONFLICT",
        status: 409,
        message: "Unavailable",
      },
    }),
  );
  await page.goto("/welcome?session_id=cs_test_abc");
  await page.getByLabel("Name", { exact: true }).fill("Sam");
  await page.getByLabel("Address", { exact: true }).fill("sam");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a long secure password");
  await page.getByLabel("Confirm password").fill("a long secure password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This address is unavailable, choose another",
  );
});

test("Drive explains when there is no plan", async ({ page }) => {
  await live(page);
  await mockOverview(page, scenarios.no_plan);
  await page.goto("/drive");
  await expect(
    page.getByText("Choose a plan to enable uploads and incoming mail."),
  ).toBeVisible();
});
