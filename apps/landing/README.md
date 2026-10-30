# Project website

The static Esuno website (`esuno.net`): one page built with Vite from `index.html`, `src/landing.css` and `src/main.ts`, using the design tokens and the product marks of `apps/web/public`. It has no API, cookies or third-party requests; fonts are bundled. `pnpm build` at the repository root builds it to `dist/`.

Caddy serves it on its own origin when `LANDING_SITE_ADDRESS` is set, under a CSP that allows only same-origin files. A `www.` address in that list redirects to the bare name. Preview locally with `pnpm --filter @opensuite/landing dev`.

`public/og.png` is a screenshot of the hero at 1200×630; refresh it when the hero changes.
