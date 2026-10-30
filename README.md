# OpenSuite

A self-hostable suite for mail, calendar, contacts and file storage.

> **Status: early development.** The mail API, mailbox provisioning, Drive,
> ingestion and backup tools are implemented. Real SES/B2 behavior and the
> complete production recovery process still require operator verification.
> Calendar and contacts interfaces and the setup wizard remain planned.

## What works today

- **Docker Compose stack** (`compose.yaml`): Caddy (automatic HTTPS), the API,
  the Stalwart mail server (SMTP, IMAP, JMAP, CalDAV, CardDAV on embedded
  RocksDB), PostgreSQL, and an optional `dev` profile with LocalStack S3/SQS
  substitutes. Passwords are generated on first start and never stored in
  `.env` or Git. See [docs/development.md](docs/development.md), including its
  known limitations.
- **Database** (`packages/db`): PostgreSQL schema and versioned migrations, applied by a Compose startup job. See [the database package](packages/db/README.md) for encryption, isolation, and testing details.
- **Web client** (`apps/web`): a mail workspace and live API status page. Mail uses
  synthetic in-browser data in development and the mail and Drive APIs in
  production. Calendar and contacts are placeholders. See [apps/web/README.md](apps/web/README.md).
- **JMAP client** (`packages/jmap`): validated mailbox, email, blob and submission operations, plus a separate server-only Stalwart provisioning client. See [verified behaviour](docs/architecture/jmap-behaviour.md).
- **Mail blob storage:** local by default, with an optional S3-compatible
  backend for new or migrated installations. The
  [object storage guide](docs/operations/object-storage.md) covers restart,
  migration, backup and recovery requirements.
- **Outbound mail:** server-only Stalwart relay configuration and DKIM DNS records; see [outbound operations](docs/operations/outbound.md) for SES, queue limits and deployment steps.
- **Inbound worker** (`apps/ingest`): SES notification processing, durable ledger and archived-envelope replay. See [ingestion](docs/architecture/ingestion.md) for configuration and production limitations.
- **Drive** (`apps/drive`): independent file metadata and S3-compatible object storage, with direct uploads, sharing and guarded previews. See [development](docs/development.md#drive).
- **API** (`apps/api`): a Fastify server hosting typed procedures (oRPC, Zod
  contracts in `packages/contracts`) with structured JSON logs (pino).
  - `GET /health`: liveness; answers `200` while the process runs.
  - `GET /ready`: readiness over the declared backing services; `200` when all
    are up, `503` with per-dependency status otherwise. The standard API
    checks PostgreSQL and Stalwart.
  - `GET /openapi.json`: OpenAPI 3.1 document generated from the contracts.
  - Behind Caddy, these are served under `/api/`.

## Installation

For a single Ubuntu VPS, follow the complete ordered
[production runbook](docs/deployment/production.md). It covers prerequisites,
DNS, secrets, B2, SES, first admin, TLS renewal, backups, monitoring,
verification and rollback. Use the operator's hostname and mail domain in
place of its examples. The receiving MX and wildcard switch require a separate
owner-approved cutover; the runbook does not perform one. Local tests have not
established real SES/B2 behavior.

1. Install Docker Compose, Git, Node.js 22.18+ and pnpm 12; clone at
   `/opt/opensuite`. Publish the hostname A/working AAAA record, allow 80/443,
   and configure the B2 buckets, S3 CORS, SES identity, regional resources and
   protected files as described in the runbook. Copy `deploy/env.example` to
   `.env`, fill every required `DRIVE_S3_*` value and the file paths, and create
   the TLS bind files. The template is not production-ready by itself.
2. Build the web client and images and bootstrap the private mail management
   account with public access stopped:

   ```sh
   cd /opt/opensuite
   pnpm install --frozen-lockfile && pnpm build
   docker compose config >/dev/null
   docker compose build
   docker compose run --rm secrets
   docker compose stop caddy
   docker compose -f compose.yaml -f deploy/stalwart/compose.bootstrap.yaml up -d --wait stalwart
   docker compose -f compose.yaml -f deploy/stalwart/compose.bootstrap.yaml --profile bootstrap run --rm stalwart-bootstrap
   docker compose up -d --no-deps --force-recreate --wait stalwart
   docker compose run --rm --no-deps stalwart-setup
   docker compose restart stalwart
   docker compose up -d --wait stalwart
   docker compose run --rm --no-deps stalwart-setup
   ```

   On a new B2 mail store, verify the second setup's round-trip probe, set
   `MAIL_S3_ALLOW_SWITCH=0`, and rerun setup. Follow the separate migration
   procedure before switching an existing store. Then run `docker compose up -d`.

3. Provision the first administrator, install the mail certificate and daily
   renewal timer, verify 465/993 before opening them, configure SES inbound and
   the port 2587 outbound relay, and install and test encrypted backups and
   observer alerts using the linked runbook. Exercise delivery, replay, B2,
   restore and independent archive recovery before the approved DNS cutover.

## Development

Requirements: Node.js 22.18 or later, pnpm 12.

```sh
pnpm install
cp deploy/env.example .env   # optional; defaults match the template
# Set DATABASE_URL to a PostgreSQL application-role connection for local API development.
pnpm --filter @opensuite/api dev
# In another terminal: pnpm --filter @opensuite/web dev
curl http://127.0.0.1:3000/health
```

Checks:

```sh
pnpm typecheck
pnpm lint          # oxlint, type-aware
pnpm format:check  # Prettier
pnpm knip          # unused files, exports and dependencies
node scripts/iac-validate.mjs # offline AWS module checks (Docker required)
pnpm test          # Vitest unit project
pnpm build         # static web client
pnpm test:e2e      # Vite preview and a local API; install Chromium first
pnpm exec vitest run --project stalwart  # real server; Docker required
pnpm exec vitest run --project drive     # disposable PostgreSQL and LocalStack
OPENSUITE_RUN_ID=local-1 node scripts/compose-smoke.mjs --report smoke.xml
```

Vitest projects are selected by file suffix: `*.test.ts` runs in `unit`;
`*.db.test.ts`, `*.http.test.ts`, `*.stalwart.test.ts`, `*.ingest.test.ts`
and `*.drive.test.ts` run in the projects of the same name, which need the
corresponding infrastructure.

## Repository layout

| Path                         | Contents                                               |
| ---------------------------- | ------------------------------------------------------ |
| `apps/api`                   | HTTP API server                                        |
| `apps/web`                   | Mail workspace and API status page                     |
| `apps/ingest`                | Inbound mail ingestion worker                          |
| `apps/drive`                 | Independent file storage service                       |
| `packages/contracts`         | Shared API schemas and procedure contracts             |
| `packages/core`              | Domain, services and provider adapters                 |
| `packages/jmap`              | JMAP and server-side provisioning clients              |
| `packages/db`                | PostgreSQL schema, migration job, and provider storage |
| `packages/design-tokens`     | Shared light and dark theme tokens                     |
| `packages/typescript-config` | Shared strict TypeScript configuration                 |
| `packages/oxlint-config`     | Shared oxlint configuration                            |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
