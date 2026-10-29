# Development and local installation

This page describes what runs today. Planned components are listed at the end.

## Docker Compose stack

```sh
cp deploy/env.example .env
pnpm install && pnpm build   # produces apps/web/dist, mounted by Caddy
docker compose up -d
docker compose --profile dev up -d   # adds LocalStack (S3/SQS substitutes)
```

| Service          | Image (pinned by digest)                | Role                                                                                                      |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `caddy`          | `caddy:2.11.7`                          | Serves the static web client and proxies `/api/*` to the API and mail protocol routes to the mail server. |
| `api`            | built from `apps/api/Dockerfile`        | Application API (`/health`, `/ready`, `/openapi.json`).                                                   |
| `stalwart`       | `stalwartlabs/stalwart:v1.0.1`          | Mail server: SMTP, IMAP, JMAP, CalDAV, CardDAV. Data in embedded RocksDB.                                 |
| `postgres`       | `postgres:18.6`                         | Application database, plus a separate `opensuite_drive` database.                                         |
| `migrate`        | built from `deploy/postgres/Dockerfile` | One-shot job: verifies and applies application migrations before the API starts.                          |
| `secrets`        | `alpine:3.24.3`                         | One-shot job: generates local passwords on first start.                                                   |
| `stalwart-setup` | `stalwartlabs/stalwart:v1.0.1`          | One-shot job: applies mail server settings (see below).                                                   |
| `localstack`     | `localstack/localstack:4.14.0`          | `dev` profile only: local S3 bucket and SQS queues for inbound mail.                                      |

Rebuild the client with `pnpm build` after changes; Caddy mounts `apps/web/dist` read-only. The web client shows live API status; the product pages are placeholders. For the development server and browser tests, see [the web client guide](../apps/web/README.md).

Every long-running service has a Compose health check and a restart policy.
Data lives in named volumes: `postgres-data`, `stalwart-data`, `caddy-data`,
`caddy-config`, `secrets` and `localstack-data`.

### Secrets

On first start, the `secrets` job generates the PostgreSQL password and the
mail server administrator password into the `secrets` volume. Each service
mounts only its own sub-directory, read-only. Neither `.env` nor Git ever
contains these passwords. To read the mail administrator password:

```sh
docker compose exec stalwart cat /run/opensuite/stalwart-admin/password
```

Removing the `secrets` volume while the data volumes remain makes the stored
passwords stale. Back it up together with the data volumes.

### Mail server configuration

`deploy/stalwart/config.json` only locates the data store. Stalwart keeps all
other settings in that store. The `stalwart-setup` job runs after the server is
healthy and applies idempotent settings through the Stalwart management API:

- logs go to standard output (`docker compose logs stalwart`);
- the client address is taken from `X-Forwarded-For`, which Caddy sets
  (exactly one proxy hop). Caddy replaces any value a client sends.

Published mail ports: 25 (SMTP), 465 (submission, implicit TLS), 993 (IMAP,
implicit TLS) and 4190 (ManageSieve). STARTTLS ports 587 and 143 are not
enabled: RFC 8314 recommends implicit TLS for submission and IMAP.

### Migrations

The `migrate` job waits for PostgreSQL and applies versioned Prisma migrations
before the API starts. It checks applied migration checksums before deploying;
never change or remove an applied migration. See [the database package](../packages/db/README.md)
for development, encrypted provider secrets, and test instructions. The API
does not yet use the database or register its readiness probe.

### Local AWS substitutes

The `dev` profile starts LocalStack with an `opensuite-inbound` S3 bucket and
`opensuite-inbound` and `opensuite-inbound-dlq` SQS queues. No AWS account or
credentials are needed. LocalStack only simulates AWS: it proves nothing about
real SES, S3 or SQS behaviour.

LocalStack 4.14.0 is the last release that starts without a LocalStack account.
To use a newer image, set `LOCALSTACK_IMAGE` and `LOCALSTACK_AUTH_TOKEN` in
`.env`.

## Smoke test

```sh
CLEITO_RUN_ID=local-1 node scripts/compose-smoke.mjs --report smoke.xml
```

The smoke test starts a separate Compose project named after `CLEITO_RUN_ID`.
`compose.test.yaml` publishes its ports on random loopback ports. The test then
checks the following through the proxy, over TLS verified with Caddy's local
certificate authority:

- API liveness and readiness;
- JMAP discovery, the anonymous and authenticated sessions, and rejection of a
  wrong password;
- CalDAV and CardDAV discovery;
- the SMTP greeting;
- that a client cannot spoof `X-Forwarded-For`;
- that internal paths such as `/admin` are not exposed.

It writes a JUnit report and always removes the containers and volumes,
including on failure. Pass `--keep` to leave the stack running for inspection.

## JMAP integration tests

`pnpm exec vitest run --project stalwart` starts the pinned Stalwart image in a
separate Compose project, publishes a random loopback port, and removes its
container, network and volume after the suite, including setup and test failures.
Docker and the Compose plugin are required. The direct-listener fixture maps
Stalwart's advertised internal endpoint paths to the published loopback port;
production clients use the advertised URLs and require the same origin as the
discovery endpoint. The fixture tests mail submission and delivery locally,
not external DNS, SMTP relays, TLS or the production proxy.

The regular `@opensuite/jmap` entry point accepts an authorization header from
its caller. `@opensuite/jmap/admin` is a Node-only entry point: instantiate it
only in trusted server code and never expose management credentials to browsers,
logs or application clients. Provisioning is sequential and idempotent for
existing names; serialize provisioning for the same domain, account or alias
and reconcile ambiguous failures before retrying. Reusing an account does not
change or verify its password. See [JMAP behaviour](architecture/jmap-behaviour.md).

## AWS infrastructure validation

Run `node scripts/iac-validate.mjs` to check formatting and validate the pinned
OpenTofu module in Docker without AWS credentials or a backend. Only provider
download uses networking. See [AWS deployment](deployment/aws.md) for operator
setup and the limits of offline validation. The ingestion worker and SES relay
remain unimplemented.

## Known limitations

- **TLS for mail protocols:** the mail server has no certificate yet, so TLS
  handshakes on 465 and 993 do not succeed. Certificate provisioning for mail
  is planned with domain onboarding. HTTPS through Caddy works.
- **Mail delivery:** no domain or mailbox is provisioned by default. Local
  JMAP submission and delivery are tested; external delivery is not.
- **Outbound access:** the mail server downloads public network data
  (ASN/geolocation) from GitHub at startup.

## Planned, not implemented

Mail, calendar, contacts and drive interfaces, authentication, SES ingestion,
outbound relays, the file storage service, the setup wizard and backups.
