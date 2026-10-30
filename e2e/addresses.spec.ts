import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

async function mockAddresses(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("addresses-fixture", "live"),
  );
  let rows = [
    {
      id: "primary",
      address: "you@esuno.net",
      primary: true,
      ready: true,
      removing: false,
      pending: false,
    },
  ];
  await page.route("**/api/addresses**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith("/domains"))
      return route.fulfill({
        json: [
          { id: "d1", name: "esuno.net" },
          { id: "d2", name: "esn.pm" },
        ],
      });
    if (method === "POST") {
      const input = z
        .object({ localPart: z.string(), domainId: z.string() })
        .parse(route.request().postDataJSON());
      rows.push({
        id: "extra",
        address: `${input.localPart}@${input.domainId === "d2" ? "esn.pm" : "esuno.net"}`,
        primary: false,
        ready: true,
        removing: false,
        pending: false,
      });
      return route.fulfill({ json: rows.at(-1) });
    }
    if (method === "DELETE") {
      rows = rows.filter((row) => row.id !== "extra");
      return route.fulfill({ json: { removed: true } });
    }
    return route.fulfill({
      json: { addresses: rows, limit: 5, remaining: 5 - rows.length },
    });
  });
}
test("add and remove an address", async ({ page }) => {
  await mockAddresses(page);
  await page.goto("/settings/addresses");
  await expect(page.getByText("1 of 5 used")).toBeVisible();
  await expect(page.getByText("Primary", { exact: true })).toBeVisible();
  await page.getByLabel("Address name").fill("hello");
  await page.getByLabel("Domain").selectOption("d2");
  await page.getByRole("button", { name: "Add address" }).click();
  await expect(page.getByText("hello@esn.pm")).toBeVisible();
  await expect(page.getByText("2 of 5 used")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "/tmp/esuno-addresses-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("stop arriving");
  await page.getByRole("button", { name: "Remove address" }).click();
  await expect(page.getByText("hello@esn.pm")).toHaveCount(0);
});
test("mobile settings and sign in with an extra address", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAddresses(page);
  await page.goto("/settings/addresses");
  await expect(
    page.getByRole("heading", { name: "Addresses", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/esuno-addresses-mobile.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    sessionStorage.setItem("auth-fixture-signed-out", "1");
    sessionStorage.setItem(
      "address-fixture-items",
      JSON.stringify([{ id: "extra", address: "hello@esn.pm" }]),
    );
  });
  await page.goto("/login");
  await page
    .getByLabel("Email address (any of your Esuno addresses)")
    .fill("hello@esn.pm");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mail/);
});

test("refreshes pending addresses after a provisioning delay", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("addresses-fixture", "live"),
  );
  let created = false;
  let polls = 0;
  await page.route("**/api/addresses**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/domains"))
      return route.fulfill({ json: [{ id: "d1", name: "esuno.net" }] });
    if (route.request().method() === "POST") {
      created = true;
      return route.fulfill({
        json: {
          id: "extra",
          address: "slow@esuno.net",
          primary: false,
          ready: false,
          pending: true,
          removing: false,
        },
      });
    }
    if (created) polls++;
    return route.fulfill({
      json: {
        addresses: [
          {
            id: "primary",
            address: "you@esuno.net",
            primary: true,
            ready: true,
            pending: false,
            removing: false,
          },
          ...(created
            ? [
                {
                  id: "extra",
                  address: "slow@esuno.net",
                  primary: false,
                  ready: polls > 1,
                  pending: polls <= 1,
                  removing: false,
                },
              ]
            : []),
        ],
        limit: 5,
        remaining: created ? 3 : 4,
      },
    });
  });
  await page.goto("/settings/addresses");
  await page.getByLabel("Address name").fill("slow");
  await page.getByRole("button", { name: "Add address" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "slow@esuno.net" });
  await expect(row).toContainText("Pending");
  await expect(row).toContainText("Ready", { timeout: 15_000 });
});
