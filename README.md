# Esuno

Esuno is a self-hosted mail and file suite, intended as an alternative to hosted mail, calendar and Drive services. It combines a web workspace and application API with the Stalwart mail server, PostgreSQL and S3-compatible storage.

The intended interface addresses are `mail.esuno.net` and `calendar.esuno.net`;
their configuration and DNS cutover remain deployment steps.

> **Status: early development.** The mail API, mailbox provisioning, Drive,
> ingestion and backup tools are implemented. Real SES/B2 behavior and the
> complete production recovery process still require operator verification.
> Calendar lacks invitations, reminders and sharing; Contacts is a placeholder. The setup wizard
> and administrator account controls are available; see the [admin guide](docs/admin/index.md)
> for their current limitations. Vault is not production-ready until security
> and recovery are verified.

## Release status

This first release is an early, single-server baseline. The repository contains:

- **Docker Compose stack** (`compose.yaml`): Caddy (automatic HTTPS), the API,
  the Stalwart mail server (SMTP, IMAP, JMAP, CalDAV, CardDAV on embedded
  RocksDB), PostgreSQL, and an optional `dev` profile with LocalStack S3/SQS
  substitutes. Passwords are generated on first start and never stored in
  `.env` or Git. See [docs/development.md](docs/development.md), including its
  known limitations.
- **Database** (`packages/db`): PostgreSQL schema and versioned migrations, applied by a Compose startup job. See [the database package](packages/db/README.md) for encryption, isolation, and testing details.
- **Web client** (`apps/web`): a mail workspace and live API status page. Mail uses
  synthetic in-browser data in development and the mail and Drive APIs in
  production. Calendar provides event views and editing; Contacts is a placeholder. See [apps/web/README.md](apps/web/README.md).
- **JMAP client** (`packages/jmap`): validated mailbox, email, blob and submission operations, plus a separate server-only Stalwart provisioning client. See [verified behaviour](docs/architecture/jmap-behaviour.md).
- **Mail blob storage:** local by default, with an optional S3-compatible
  backend for new or migrated installations. The
  [object storage guide](docs/operations/object-storage.md) covers restart,
  migration, backup and recovery requirements.
- **Outbound mail:** server-only Stalwart relay configuration and DKIM DNS records; see [outbound operations](docs/operations/outbound.md) for SES, queue limits and deployment steps.
- **Inbound worker** (`apps/ingest`): SES notification processing, durable ledger and archived-envelope replay. See [ingestion](docs/architecture/ingestion.md) for configuration and production limitations.
- **Esuno Vault, built on Vaultwarden** (optional `vault` Compose profile): a dedicated origin, a separate PostgreSQL database, a launcher and hide-my-email aliases. Local automated coverage exists, but security, real-provider recovery and client compatibility remain unverified. See [Vault operations and readiness](docs/operations/vault.md).
- **Drive** (`apps/drive`): independent file metadata and S3-compatible object storage, with direct uploads, sharing and guarded previews. See [development](docs/development.md#drive).
- **API** (`apps/api`): a Fastify server hosting typed procedures (oRPC, Zod
  contracts in `packages/contracts`) with structured JSON logs (pino).
  - `GET /health`: liveness; answers `200` while the process runs.
  - `GET /ready`: readiness over the declared backing services; `200` when all
    are up, `503` with per-dependency status otherwise. The standard API
    checks PostgreSQL and Stalwart.
  - `GET /openapi.json`: OpenAPI 3.1 document generated from the contracts.
  - Behind Caddy, these are served under `/api/`.

## Start here

- [Documentation map](docs/index.md)
- [User guide](docs/user/index.md) and [administrator guide](docs/admin/index.md)
- [Local development](docs/development.md) and the [production deployment runbook](docs/deployment/production.md)
- [Architecture and security](docs/architecture/overview.md)
- [Operations](docs/index.md#operations-and-deployment), [contributing](CONTRIBUTING.md), and [changelog](CHANGELOG.md)

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

## Repository

`apps/api`, `apps/web`, `apps/drive`, `apps/ingest` and `apps/observe` contain the services and client. Shared contracts, domain services, database code, JMAP adapters and configuration live under `packages/`. Compose configuration is in `compose.yaml`; operator assets are in `deploy/`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
