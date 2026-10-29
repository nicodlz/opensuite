# Web client

Build the static client before starting the Compose stack: `pnpm install && pnpm build` at the repository root, then `docker compose up -d`. Caddy mounts `apps/web/dist` read-only and serves the SPA, while `/api/*` is proxied to the API and mail protocol routes remain on the mail server. Rebuild the client after changes. The development server (`pnpm --filter @opensuite/web dev`) proxies `/api` to the API at `127.0.0.1:3000`; run the API separately.

The status page checks the API's liveness and readiness every 30 seconds. Other product screens, mail folders, search, accounts and compose are placeholders. The appearance menu offers light, dark and system themes. The workspace label and appearance preference are stored in this browser only. Press `S` outside an input to open workspace settings.

Run browser tests with `pnpm build && pnpm test:e2e`. Playwright starts the Vite preview server and the local API on port 3199. It exercises the live probes and intercepts responses for deterministic status and accessibility scenarios; it does not require the Compose stack. Install Chromium with `pnpm exec playwright install chromium` if needed. The Compose smoke test separately exercises the proxy and live services.
