# Web client

The production build serves Mail, Drive, Domains and API status through Caddy. Calendar and Contacts are placeholders. This checkout has no sign-in or MFA screens; see the [user guide](../../docs/user/index.md) for session and access limitations and [development](../../docs/development.md) for Compose provisioning status.

From the repository root, `pnpm install && pnpm build` creates `apps/web/dist`. The Vite development server (`pnpm --filter @opensuite/web dev`) uses synthetic in-memory Mail and Drive data; changes disappear on reload. Production builds call the application and Drive APIs. Do not use synthetic data for real mail or files. Email HTML is sanitized and displayed in a sandboxed iframe; remote images require a per-message opt-in.

Run `pnpm exec playwright install chromium` once if needed, then `pnpm test:e2e`. Playwright starts the development server and a local API. Appearance and workspace label preferences are stored in the browser. See [contributing](../../CONTRIBUTING.md) for other checks.
