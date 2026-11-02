import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const template: {
  id: string;
  address: string;
  localPart: string;
  domainId: string;
  website: string | null;
  note: string | null;
  enabled: boolean;
  ready: boolean;
  detachedByDomain: boolean;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
} = {
  id: "a1",
  address: "friday@example.test",
  localPart: "friday",
  domainId: "d1",
  website: "example.com",
  note: "Shopping",
  enabled: true,
  ready: true,
  detachedByDomain: false,
  suspended: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
/** Paths answered with a 503 while listed, to exercise load failures. */
type Failing = { paths: string[] };
async function mockAliases(page: Page, failing: Failing = { paths: [] }) {
  let aliases = [
    { ...template },
    {
      ...template,
      id: "a2",
      address: "pending@example.test",
      ready: false,
      enabled: false,
    },
    {
      ...template,
      id: "a3",
      address: "suspended@example.test",
      suspended: true,
    },
    {
      ...template,
      id: "a4",
      address: "waiting@example.test",
      ready: false,
    },
  ];
  let keys: {
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }[] = [];
  let defaultDomain: string | null = null;
  await page.route("**/api/aliases**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (failing.paths.includes(path))
      return route.fulfill({
        status: 503,
        json: {
          defined: false,
          code: "SERVICE_UNAVAILABLE",
          status: 503,
          message: "Unavailable",
        },
      });
    let result: unknown;
    if (path === "/api/aliases/domains")
      result = [
        { id: "d1", name: "example.test" },
        { id: "d2", name: "second.test" },
      ];
    else if (path === "/api/aliases/default-domain") {
      if (method === "PUT")
        defaultDomain = z
          .object({ domainId: z.string() })
          .parse(request.postDataJSON()).domainId;
      result = { domainId: defaultDomain };
    } else if (path === "/api/aliases/keys" && method === "GET") result = keys;
    else if (path === "/api/aliases/keys" && method === "POST") {
      const key = {
        id: "k1",
        name: z.object({ name: z.string() }).parse(request.postDataJSON()).name,
        prefix: "es_key_",
        createdAt: template.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      };
      keys = [...keys, key];
      result = { ...key, secret: "es_key_test_secret_once" };
    } else if (path.startsWith("/api/aliases/keys/") && method === "DELETE") {
      keys.forEach((key) => {
        key.revokedAt = template.createdAt;
      });
      result = { revoked: true };
    } else if (path === "/api/aliases/match") {
      const addresses = z
        .object({ addresses: z.array(z.string()) })
        .parse(request.postDataJSON()).addresses;
      result = aliases.filter((alias) => addresses.includes(alias.address));
    } else if (path === "/api/aliases" && method === "GET") result = aliases;
    else if (path === "/api/aliases" && method === "POST") {
      const input = z
        .object({
          prefix: z.string().optional(),
          website: z.string().optional(),
          note: z.string().optional(),
          domainId: z.string(),
          requestId: z.string(),
        })
        .parse(request.postDataJSON());
      expect(input.requestId).toBeTruthy();
      const alias = {
        ...template,
        id: "new",
        address: `${input.prefix ?? "random"}-xyz@example.test`,
        localPart: `${input.prefix ?? "random"}-xyz`,
        domainId: input.domainId,
        website: input.website ?? null,
        note: input.note ?? null,
      };
      aliases = [...aliases, alias];
      result = alias;
    } else if (path.endsWith("/disable") || path.endsWith("/enable")) {
      const id = path.split("/").at(-2);
      aliases = aliases.map((alias) =>
        alias.id === id
          ? { ...alias, enabled: path.endsWith("/enable") }
          : alias,
      );
      result = aliases.find((alias) => alias.id === id);
    } else if (method === "DELETE") {
      aliases = aliases.filter((alias) => alias.id !== path.split("/").at(-1));
      result = { deleted: true };
    } else return route.fulfill({ status: 404, json: {} });
    await route.fulfill({ json: result });
  });
}
test("manage aliases, default domain and one-time keys", async ({
  page,
  context,
}) => {
  await mockAliases(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/vault/aliases");
  await expect(page.getByText("friday@example.test")).toBeVisible();
  await page.getByLabel("Filter").selectOption("suspended");
  await expect(page.getByText("suspended@example.test")).toBeVisible();
  await expect(page.getByText("friday@example.test")).toHaveCount(0);
  await page.getByLabel("Filter").selectOption("all");
  await page.getByLabel("Search aliases").fill("shopping");
  await expect(page.getByText("friday@example.test")).toBeVisible();
  await page.getByLabel("Search aliases").fill("");
  await page.getByLabel("Default domain").selectOption("d2");
  await expect(page.getByText("Default domain updated.")).toBeVisible();
  await page.getByRole("button", { name: "Create alias", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create alias" });
  await dialog.getByLabel("With prefix").check();
  await dialog.getByLabel("Prefix", { exact: true }).fill("shop");
  await dialog
    .getByRole("combobox", { name: "Domain", exact: true })
    .selectOption("d1");
  await dialog.getByLabel("Website (optional)").fill("shop.example.com");
  await dialog.getByLabel("Note (optional)").fill("My shop");
  await dialog.getByRole("button", { name: "Create alias" }).click();
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "shop-xyz@example.test" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Copy/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "shop-xyz@example.test",
  );
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete alias?" });
  await expect(confirmation.getByText(/never be reused/)).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Delete" }).click();
  await confirmation.getByRole("button", { name: "Delete alias" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Key name").fill("Browser");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const keyDialog = page.getByRole("dialog", { name: "Copy your API key" });
  await expect(keyDialog.getByText(/shown only once/)).toBeVisible();
  await keyDialog.getByRole("button", { name: "Copy API key" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "es_key_test_secret_once",
  );
  await keyDialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("es_key_test_secret_once")).toHaveCount(0);
  const keyRow = page.getByRole("listitem").filter({ hasText: "Browser" });
  await expect(keyRow).toContainText("Never");
  await keyRow.getByRole("button", { name: "Revoke" }).click();
  await expect(keyRow).toContainText("Revoked");
});
test("each alias shows one explicit, visually distinct status", async ({
  page,
}) => {
  await mockAliases(page);
  await page.goto("/vault/aliases");
  const expected = [
    ["friday@example.test", "Active", "Receiving mail."],
    ["waiting@example.test", "Pending", "Being set up."],
    ["pending@example.test", "Disabled", "Setup is still pending."],
    ["suspended@example.test", "Suspended", "Suspended by your administrator."],
  ] as const;
  const colours = await Promise.all(
    expected.map(async ([address, label, detail]) => {
      const row = page.getByRole("listitem").filter({ hasText: address });
      const badge = row.getByText(label, { exact: true });
      await expect(badge).toBeVisible();
      await expect(row).toContainText(detail);
      return badge.evaluate((node) => {
        const style = getComputedStyle(node);
        return `${style.backgroundColor}/${style.color}`;
      });
    }),
  );
  expect(new Set(colours).size).toBe(expected.length);
  // Row actions share one style; only Delete is marked as destructive.
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "friday@example.test" });
  const background = (name: string) =>
    row
      .getByRole("button", { name })
      .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await background("Copy friday")).toBe(
    await background("Disable friday"),
  );
  const colour = (name: string) =>
    row
      .getByRole("button", { name })
      .evaluate((node) => getComputedStyle(node).color);
  expect(await colour("Delete friday")).not.toBe(
    await colour("Disable friday"),
  );
});

test("keyboard focus follows alias create, disable, undo and delete", async ({
  page,
}) => {
  await mockAliases(page);
  await page.goto("/vault/aliases");
  const rowOf = (address: string) =>
    page.getByRole("listitem").filter({ hasText: address });
  await expect(rowOf("friday@example.test")).toBeVisible();

  // Create: focus lands on the new alias's Copy button.
  await page.getByRole("button", { name: "Create alias", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create alias" });
  await expect(dialog.getByLabel("Random")).toBeFocused();
  await dialog.getByLabel("Website (optional)").fill("kbd.example.com");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Alias created: random-xyz@example.test"),
  ).toBeVisible();
  await expect(
    rowOf("random-xyz@example.test").getByRole("button", { name: /^Copy/ }),
  ).toBeFocused();

  // Disable: the same row keeps focus, and the notification offers Undo.
  const toggle = rowOf("friday@example.test").getByRole("button", {
    name: "Disable friday@example.test",
  });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const enable = rowOf("friday@example.test").getByRole("button", {
    name: "Enable friday@example.test",
  });
  await expect(enable).toBeFocused();
  await expect(page.getByText("friday@example.test disabled.")).toBeVisible();
  await page.keyboard.press("F8");
  await expect(page.getByRole("button", { name: "Undo" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    rowOf("friday@example.test").getByText("Active", { exact: true }),
  ).toBeVisible();
  await expect(
    rowOf("friday@example.test").getByRole("button", {
      name: "Disable friday@example.test",
    }),
  ).toBeFocused();

  // Disabling under the Enabled filter: the row leaves; focus takes its place.
  await page.getByLabel("Filter").selectOption("enabled");
  await rowOf("friday@example.test")
    .getByRole("button", { name: /^Disable/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(rowOf("friday@example.test")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Disable waiting@example.test" }),
  ).toBeFocused();

  // Delete: Cancel takes focus first; after deleting, the next row's Delete.
  await page
    .getByRole("button", { name: "Delete waiting@example.test" })
    .focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("dialog", { name: "Delete alias?" });
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    confirmation.getByRole("button", { name: "Delete alias" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rowOf("waiting@example.test")).toHaveCount(0);
  await expect(page.getByText("waiting@example.test deleted.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete random-xyz@example.test" }),
  ).toBeFocused();

  // Deleting the last listed alias moves focus to the list heading.
  await page.keyboard.press("Enter");
  await confirmation
    .getByRole("button", { name: "Delete alias" })
    .press("Enter");
  await expect(
    page.getByText("No aliases match this search and filter."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your aliases", exact: true }),
  ).toBeFocused();
});

test("Undo works even when the refresh after disabling is slow", async ({
  page,
}) => {
  await mockAliases(page);
  let slow = false;
  await page.route("**/api/aliases", async (route) => {
    if (slow && route.request().method() === "GET")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fallback();
  });
  let enables = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/aliases/a1/enable")) enables++;
  });
  await page.goto("/vault/aliases");
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "friday@example.test" });
  slow = true;
  await row.getByRole("button", { name: /^Disable/ }).click();
  await expect(row).toContainText("New mail is held instead of delivered");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  expect(enables).toBe(1);
  await expect(
    page.getByText("friday@example.test enabled again."),
  ).toBeVisible();
});

test("a load failure replaces dependent panels and explains disabled actions", async ({
  page,
}) => {
  const failing = {
    paths: [
      "/api/aliases",
      "/api/aliases/domains",
      "/api/aliases/default-domain",
      "/api/aliases/keys",
    ],
  };
  await mockAliases(page, failing);
  await page.goto("/vault/aliases");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "Could not load your aliases, alias domains, and API keys",
  );
  await expect(alert).toContainText("Alias service unavailable.");
  // No empty state or settings panel is shown next to the error.
  await expect(page.getByText(/no aliases yet|No aliases match/)).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Your aliases", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Default alias domain" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Alias API keys" }),
  ).toHaveCount(0);
  const create = page.getByRole("button", {
    name: "Create alias",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription(
    "Available once your aliases and domains load.",
  );
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter(
      (item) => item.impact === "serious" || item.impact === "critical",
    ),
  ).toEqual([]);

  // Retry by keyboard once the service is back.
  failing.paths = [];
  await alert.getByRole("button", { name: "Retry" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("friday@example.test")).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Aliases", level: 1 }),
  ).toBeFocused();

  // Only the failed part is hidden when one request fails.
  failing.paths = ["/api/aliases/keys"];
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load API keys",
  );
  await expect(page.getByText("friday@example.test")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Default alias domain" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Alias API keys" }),
  ).toHaveCount(0);
});

test("without an eligible domain, Create alias says why", async ({ page }) => {
  await mockAliases(page);
  await page.route("**/api/aliases/domains", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/vault/aliases");
  await expect(page.getByText("friday@example.test")).toBeVisible();
  const create = page.getByRole("button", {
    name: "Create alias",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription(
    /No alias domain is available yet/,
  );
  await expect(page.getByText(/Bitwarden uses this domain/)).toHaveCount(0);
});

test("recipient badge and reply sender use a matching alias", async ({
  page,
}) => {
  await mockAliases(page);
  await page.goto("/mail");
  await page.getByRole("button", { name: /Maya Chen/ }).click();
  await expect(
    page.getByText("Matched recipient alias: friday@example.test (Ready)"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const composer = page.getByRole("region", { name: "Compose message" });
  await expect(composer.getByLabel("From")).toHaveValue("friday@example.test");
  await composer.getByLabel("From").selectOption("you@example.test");
  await composer.getByLabel("From").selectOption("friday@example.test");
  await composer.getByLabel("Message body").fill("Thanks!");
  await composer.getByRole("button", { name: "Save and close draft" }).click();
  await page.getByRole("button", { name: /Drafts/ }).click();
  await page
    .getByRole("button", { name: /A little update for Friday/ })
    .click();
  await expect(composer.getByLabel("From")).toHaveValue("friday@example.test");
});
test("alias service errors do not interrupt Mail or replies", async ({
  page,
}) => {
  await page.route("**/api/aliases**", (route) =>
    route.fulfill({
      status: 401,
      json: {
        defined: false,
        code: "UNAUTHORIZED",
        status: 401,
        message: "Unauthorized",
      },
    }),
  );
  await page.goto("/mail");
  await page.getByRole("button", { name: /Maya Chen/ }).click();
  await expect(
    page.getByRole("heading", { name: "A little update for Friday" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const composer = page.getByRole("region", { name: "Compose message" });
  await expect(composer.getByLabel("From")).toHaveValue("you@example.test");
  await expect(page).toHaveURL(/\/mail$/);
});

for (const theme of ["light", "dark"] as const)
  test(`${theme} aliases are accessible on mobile`, async ({ page }) => {
    await mockAliases(page);
    await page.addInitScript(() => {
      if (!localStorage.getItem("opensuite-theme"))
        localStorage.setItem("opensuite-theme", "system");
    });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/vault/aliases");
    await expect(page.getByText("friday@example.test")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page
      .getByRole("button", { name: "Create alias", exact: true })
      .click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

test("subscriber alias domain selectors show only offered domains", async ({
  page,
}) => {
  await mockAliases(page);
  await page.route("**/api/aliases/domains", (route) =>
    route.fulfill({
      json: [
        { id: "d1", name: "esuno.net" },
        { id: "d2", name: "esn.pm" },
      ],
    }),
  );
  await page.goto("/vault/aliases");
  await expect(
    page.getByLabel("Default domain").locator("option"),
  ).toContainText(["esuno.net", "esn.pm"]);
  await expect(page.getByLabel("Default domain").locator("option")).toHaveCount(
    3,
  );
  await page.getByRole("button", { name: "Create alias", exact: true }).click();
  const choices = page
    .getByRole("dialog", { name: "Create alias" })
    .getByRole("combobox", { name: "Domain" })
    .locator("option");
  await expect(choices).toHaveText(["esuno.net", "esn.pm"]);
});
