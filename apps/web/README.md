# Web client

The production build serves Mail, Calendar, Drive, Domains, the setup wizard and API status through Caddy. Contacts is a placeholder. Calendar uses the account-scoped contract in `packages/contracts/src/calendar.ts`; it has no invitations, reminders or sharing yet. See the [user guide](../../docs/user/index.md) and [administrator guide](../../docs/admin/index.md) for access and wizard limitations.

The applications share one frame (`src/shell`). On a single origin they live under `/mail`, `/calendar` and `/drive`. When the API reports separate origins at `/api/origins`, each application is served at the root of its own origin, links between them are absolute, and old paths move to the right origin with their query. Sign-in happens on the mail origin; Drive and Calendar receive the session through a single-use token (`src/auth/handoff.tsx`). The browser test `e2e/split-origins.spec.ts` covers this with the production build on `*.localhost` origins and needs Docker for PostgreSQL.

The mail workspace at `/mail` uses the account-scoped oRPC contract in `packages/contracts/src/mail.ts`. The development server (`pnpm --filter @opensuite/web dev`) uses a synthetic in-memory mail router; its changes disappear on reload. The production build excludes that router and calls `/api/mail/*`. The production client uses the authenticated user’s `default` account. Never use the synthetic implementation for real mail.

The development server starts with a synthetic signed-in session. After signing out, use `you@example.test` and `synthetic-password` to sign in. Its synthetic authenticator code is `123456` and its backup code is `backup-code`; these fixtures are excluded from production builds. Production sign-in uses Better Auth at `/api/auth/*`; account creation remains administrator-only.

Email HTML is sanitized and displayed in a sandboxed iframe. Remote images require a per-message opt-in. Inline CID images use authenticated attachment downloads; other attachments can be saved as downloads. Drafts, actions and searches use the same typed contract as the future backend. Keyboard shortcuts are listed in the mail help menu.

Run browser tests with `pnpm build && pnpm test:e2e`. Playwright starts the development server for synthetic mail and a local API on port 3199 for status tests. It checks the built production assets for fixture exclusion. Install Chromium with `pnpm exec playwright install chromium` if needed. The appearance preference and workspace label are stored in this browser.

Drive uploads use presigned object-storage URLs, so the SPA CSP permits HTTP(S) connections in addition to same-origin API requests. Configure the object store’s CORS policy for the application origin.
