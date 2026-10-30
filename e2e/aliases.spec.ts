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
async function mockAliases(page: Page) {
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
  await expect(row.getByText("Disabled")).toBeVisible();
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row.getByText("Enabled", { exact: true })).toBeVisible();
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
