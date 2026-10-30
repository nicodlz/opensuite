# Project website

The static Esuno website (`esuno.net`) is built with Vite from `index.html`, `src/landing.css` and `src/main.ts`, using the design tokens and product marks of `apps/web/public`. It has no API, cookies or third-party requests; fonts are bundled. `pnpm build` at the repository root builds it to `apps/landing/dist/`.

Set `VITE_ESUNO_APP_ORIGIN` at build time to the HTTP(S) origin of the Esuno web app, for example `VITE_ESUNO_APP_ORIGIN=https://mail.example.com pnpm build`. It defaults to `https://mail.esuno.net`. Use an origin without a path, credentials, query or fragment. Vite substitutes it into the monthly checkout links in the HTML, so they also work without JavaScript. Rebuild after changing it; the billing toggle changes the interval in the browser.

Caddy serves the site on its own origin when `LANDING_SITE_ADDRESS` is set, under a CSP that allows only same-origin files. A `www.` address in that list redirects to the bare name. Preview locally with `pnpm --filter @opensuite/landing dev`.

Run the landing browser checks after building with `pnpm exec playwright test --config apps/landing/playwright.config.ts`. The preview server uses a process-specific port; set `E2E_LANDING_PORT` to choose one explicitly. The spec captures both pricing states at mobile and desktop widths under `node_modules/.cache/landing-screenshots/` and captures a 1200×630 hero image there. Copy that image to `public/og.png` when the hero changes.
