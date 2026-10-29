# OpenSuite

A self-hostable suite for mail, calendar, contacts and file storage.

> **Status: early development.** Only the pieces listed below exist. Mail
> application-level mail provisioning, calendar and contacts features, drive, the web client and the
> setup wizard are planned and not implemented yet.

## What works today

- **Docker Compose stack** (`compose.yaml`): Caddy (automatic HTTPS), the API,
  the Stalwart mail server (SMTP, IMAP, JMAP, CalDAV, CardDAV on embedded
  RocksDB), PostgreSQL, and an optional `dev` profile with LocalStack S3/SQS
  substitutes. Passwords are generated on first start and never stored in
  `.env` or Git. See [docs/development.md](docs/development.md), including its
  known limitations (no mail TLS certificate yet).
- **Database** (`packages/db`): PostgreSQL schema and versioned migrations, applied by a Compose startup job. See [the database package](packages/db/README.md) for encryption, isolation, and testing details.
- **JMAP client** (`packages/jmap`): validated mailbox, email, blob and submission operations, plus a separate server-only Stalwart provisioning client. See [verified behaviour](docs/architecture/jmap-behaviour.md).
- **API** (`apps/api`): a Fastify server hosting typed procedures (oRPC, Zod
  contracts in `packages/contracts`) with structured JSON logs (pino).
  - `GET /health`: liveness; answers `200` while the process runs.
  - `GET /ready`: readiness over the declared backing services; `200` when all
    are up, `503` with per-dependency status otherwise. The standard API
    checks its application database.
  - `GET /openapi.json`: OpenAPI 3.1 document generated from the contracts.
  - Behind Caddy, these are served under `/api/`.

Authentication components are under development and are not wired into the
standard startup. They must not be used as a production login yet; mailbox
provisioning and lifecycle reconciliation, audit coverage, account-based
rate limits and authorization procedures remain to be integrated.

## Installation

```sh
git clone <repository> opensuite && cd opensuite
cp deploy/env.example .env
docker compose up -d
curl -k https://localhost/api/health   # `localhost` uses a certificate from Caddy's local CA
```

## Development

Requirements: Node.js 22.18 or later, pnpm 12.

```sh
pnpm install
cp deploy/env.example .env   # optional; defaults match the template
# Set DATABASE_URL to a PostgreSQL application-role connection for local API development.
pnpm --filter @opensuite/api dev
curl http://127.0.0.1:3000/health
```

Checks:

```sh
pnpm typecheck
pnpm lint          # oxlint, type-aware
pnpm format:check  # Prettier
pnpm knip          # unused files, exports and dependencies
pnpm test          # Vitest unit project
pnpm exec vitest run --project stalwart  # real server; Docker required
CLEITO_RUN_ID=local-1 node scripts/compose-smoke.mjs --report smoke.xml
```

Vitest projects are selected by file suffix: `*.test.ts` runs in `unit`;
`*.db.test.ts`, `*.http.test.ts`, `*.stalwart.test.ts`, `*.ingest.test.ts`
and `*.drive.test.ts` run in the projects of the same name, which need the
corresponding infrastructure.

## Repository layout

| Path                         | Contents                                               |
| ---------------------------- | ------------------------------------------------------ |
| `apps/api`                   | HTTP API server                                        |
| `apps/web`                   | Web client (placeholder)                               |
| `apps/ingest`                | Inbound mail ingestion worker (placeholder)            |
| `apps/drive`                 | File storage service (placeholder)                     |
| `packages/contracts`         | Shared API schemas and procedure contracts             |
| `packages/core`              | Services (currently readiness evaluation)              |
| `packages/jmap`              | JMAP and server-side provisioning clients              |
| `packages/db`                | PostgreSQL schema, migration job, and provider storage |
| `packages/design-tokens`     | Design tokens (placeholder)                            |
| `packages/typescript-config` | Shared strict TypeScript configuration                 |
| `packages/oxlint-config`     | Shared oxlint configuration                            |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
