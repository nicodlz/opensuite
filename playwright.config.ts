import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./node_modules/.cache/playwright-results",
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chromium",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command:
        "API_HOST=127.0.0.1 API_PORT=3199 pnpm --filter @opensuite/api start",
      url: "http://127.0.0.1:3199/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "API_PROXY_TARGET=http://127.0.0.1:3199 pnpm --filter @opensuite/web preview --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
