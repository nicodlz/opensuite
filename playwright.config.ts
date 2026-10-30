import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error("Invalid browser test port");
  return parsed;
}
const apiPort = port(process.env["E2E_API_PORT"], 3199);
const webPort = port(process.env["E2E_WEB_PORT"], 4173);
export default defineConfig({
  testDir: "./e2e",
  // The static site has its own server: apps/landing/playwright.config.ts.
  testIgnore: "landing.spec.ts",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  outputDir: "./node_modules/.cache/playwright-results",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: "chromium",
    ...devices["Desktop Chrome"],
    locale: "en-US",
  },
  webServer: [
    {
      command: `E2E_API_PORT=${apiPort} node e2e/api-server.ts`,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `API_PROXY_TARGET=http://127.0.0.1:${apiPort} pnpm --filter @opensuite/web dev --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
