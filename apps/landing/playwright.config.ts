import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

process.env["E2E_LANDING_PORT"] ??= String(38000 + (process.pid % 20000));
const port = Number(process.env["E2E_LANDING_PORT"]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Invalid landing browser test port");
}

export default defineConfig({
  testDir: "../../e2e",
  testMatch: "landing.spec.ts",
  timeout: 60_000,
  outputDir: "../../node_modules/.cache/landing-playwright-results",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chromium",
    locale: "en-US",
    baseURL: `http://127.0.0.1:${port}`,
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command: `pnpm --filter @opensuite/landing preview --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
