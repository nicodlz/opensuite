# Web client

Build the static client before starting the Compose stack: `pnpm install && pnpm build` at the repository root, then `docker compose up -d`. Caddy serves the SPA and proxies `/api/*` to the API. The status page checks liveness and readiness every 30 seconds.

The mail workspace at `/mail` uses the account-scoped oRPC contract in `packages/contracts/src/mail.ts`. The development server (`pnpm --filter @opensuite/web dev`) uses a synthetic in-memory mail router; its changes disappear on reload. The production build excludes that router and calls `/api/mail/*`. The production mail backend and account selection are not implemented yet, so production mail requests currently fail. The current client uses the `default` account ID until authentication is integrated. Never use the synthetic implementation for real mail.

Email HTML is sanitized and displayed in a sandboxed iframe. Remote images require a per-message opt-in. Attachments are fetched and saved as downloads. Drafts, actions and searches use the same typed contract as the future backend. Keyboard shortcuts are listed in the mail help menu.

Run browser tests with `pnpm build && pnpm test:e2e`. Playwright starts the development server for synthetic mail and a local API on port 3199 for status tests. It checks the built production assets for fixture exclusion. Install Chromium with `pnpm exec playwright install chromium` if needed. The appearance preference and workspace label are stored in this browser.
