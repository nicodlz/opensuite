# Contributing

Use Node.js 22.18 or later and pnpm 12 (the pinned package manager is in `package.json`). Install dependencies from the repository root with `pnpm install`. See [development](docs/development.md) for Compose, secrets and local service setup. Never commit credentials, generated secrets or real mail; use synthetic data and disposable services in tests.

## Checks

Run the checks relevant to a change from the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm knip
pnpm test
pnpm build
```

`pnpm test` runs the Vitest `unit` project. The other projects are selected by file suffix and run separately:

```sh
pnpm exec vitest run --project db
pnpm exec vitest run --project http
pnpm exec vitest run --project stalwart
pnpm exec vitest run --project ingest
pnpm exec vitest run --project drive
pnpm exec playwright install chromium
pnpm test:e2e
node scripts/iac-validate.mjs
```

The `db`, `http`, `stalwart`, `ingest` and `drive` projects need Docker and Compose for their disposable infrastructure; the browser tests use a local API and Vite development server. The infrastructure validation uses Docker and downloads the locked provider but does not contact an AWS account. See [development](docs/development.md) and the individual test configurations for prerequisites and limits. A local substitute is not proof of provider behavior.

## Conventions

Use the shared TypeScript configuration and contracts in `packages/`, preserve service and credential boundaries, and keep migrations immutable once applied. Add or update focused tests for behavior and failure paths. Format with `pnpm format`; do not commit its unrelated changes. Document new configuration, commands and recovery implications alongside the implementation. Never put production credentials, tokens or message contents into fixtures or logs.
