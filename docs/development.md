# Development and local installation

This page describes what runs today. Planned components are listed at the end.

## Docker Compose stack

```sh
cp deploy/env.example .env
docker compose up -d
docker compose --profile dev up -d   # adds LocalStack (S3/SQS substitutes)
```

| Service          | Image (pinned by digest)                | Role                                                                                           |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `caddy`          | `caddy:2.11.7`                          | HTTPS reverse proxy. `/api/*` goes to the API; JMAP, CalDAV and CardDAV go to the mail server. |
| `api`            | built from `apps/api/Dockerfile`        | Application API (`/health`, `/ready`, `/openapi.json`).                                        |
| `drive`          | built from `apps/drive/Dockerfile`      | Separate Drive API and S3-compatible object storage.                                           |
| `drive-migrate`  | built from `apps/drive/Dockerfile`      | One-shot Drive database migration job.                                                         |
| `stalwart`       | `stalwartlabs/stalwart:v1.0.1`          | Mail server: SMTP, IMAP, JMAP, CalDAV, CardDAV. Data in embedded RocksDB.                      |
| `postgres`       | `postgres:18.6`                         | Application database, plus a separate `opensuite_drive` database.                              |
| `migrate`        | built from `deploy/postgres/Dockerfile` | One-shot job: verifies and applies application migrations before the API starts.               |
| `secrets`        | `alpine:3.24.3`                         | One-shot job: generates local passwords on first start.                                        |
| `stalwart-setup` | `stalwartlabs/stalwart:v1.0.1`          | One-shot job: applies mail server settings (see below).                                        |
| `localstack`     | `localstack/localstack:4.14.0`          | `dev` profile only: local S3 bucket and SQS queues for inbound mail.                           |

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

The `dev` profile starts LocalStack with separate `opensuite-inbound` and
`opensuite-drive` S3 buckets, plus `opensuite-inbound` and
`opensuite-inbound-dlq` SQS queues. No AWS account or
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

## Known limitations

- **TLS for mail protocols:** the mail server has no certificate yet, so TLS
  handshakes on 465 and 993 do not succeed. Certificate provisioning for mail
  is planned with domain onboarding. HTTPS through Caddy works.
- **Mail delivery:** no domain or mailbox is provisioned by default. Local
  JMAP submission and delivery are tested; external delivery is not.
- **Outbound access:** the mail server downloads public network data
  (ASN/geolocation) from GitHub at startup.

## Planned, not implemented

The web client, authentication, SES
ingestion, outbound relays, the setup wizard and
backups.

## Drive

Drive runs separately at `/drive/api/`, with its own `opensuite_drive` database,
migrations, bucket and prefix. Caddy and mail do not depend on Drive startup.
The session adapter forwards only the incoming cookie to the API's
`GET /api/auth/get-session?disableCookieCache=true`; it accepts Better Auth's
`{user, session}` response, verifies matching user IDs and expiry, and fails
closed if the API is unavailable. Authentication is being implemented separately;
until that endpoint is available, authenticated Drive operations are unavailable.
The endpoint URL is selected with `DRIVE_SESSION_API` (default `http://api:3000`).
The internal endpoint must be trusted and reachable at the indicated path.

For local development, `docker compose --profile dev up -d` creates a separate
`opensuite-drive` bucket in LocalStack. The default `test` credentials and
loopback-only endpoint are for local use only. A browser uses the endpoint in
`DRIVE_S3_PUBLIC_ENDPOINT`, which must resolve from the browser and refer to the
same storage as `DRIVE_S3_ENDPOINT` (used by the service); the signed host must
not be rewritten. Configure `DRIVE_S3_BUCKET`, `DRIVE_S3_PREFIX`,
`DRIVE_S3_REGION`, `DRIVE_S3_ACCESS_KEY`, `DRIVE_S3_SECRET_KEY`,
`DRIVE_S3_PATH_STYLE`, and `DRIVE_QUOTA_BYTES` for the deployment. Use a dedicated
bucket and credentials, separate from mail and backups, and TLS for remote
services. Configure S3 CORS for the actual application origins, PUT/GET/HEAD,
required headers, and exposed `ETag`; local development uses permissive CORS.
AWS and other S3-compatible providers have not been exercised here.

The oRPC endpoint `POST /drive/api/v1/command` accepts the discriminated actions
in `packages/contracts/src/drive.ts`. Uploads reserve quota first and return a
five-minute URL. Single uploads require the specified content type and length;
multipart clients request consecutive 5 MiB parts (the last may be smaller),
retain each ETag, and submit them to `finish`. Finalization streams and hashes
the complete object, checks size and content type, and copies it to a key which
is never exposed for upload. Clients must calculate a hexadecimal SHA-256 first.
Reservations, including trashed and pending uploads, count against the per-owner
quota until permanent deletion. Pending uploads can be trashed and deleted.
Configure storage lifecycle rules to clean orphaned `pending/` objects and
incomplete multipart uploads; a still-valid signed URL can recreate a staging
object after finalization. Monitor for orphaned objects and interrupted
finalizations; automatic reconciliation is not implemented.

Files are private unless explicitly shared by user ID; a share applies to the
individual item, not its descendants. Read shares permit download and preview;
write shares also permit rename and move subject to destination authorization.
A write share on a folder permits creating files or folders inside it, charged
to the folder owner; each item created by the recipient receives its own write
share, which can be revoked separately.
Only owners can share, trash, delete, or create public links. Folders must be
empty to trash or delete. Public tokens are returned once, stored hashed, and
checked on each public download at `/drive/api/v1/public/<token>`. Authenticated
preview is `/drive/api/v1/preview/<id>` and is limited to signature-checked
PNG, JPEG, GIF, WebP and PDF with sandbox and nosniff headers. Other content,
including HTML and SVG, is served only as an attachment. Signed download URLs
remain usable until their five-minute expiration, even after a share is revoked;
public links are checked on each request.

`pnpm exec vitest run --project drive` creates a uniquely named disposable
Compose project with random loopback ports, migrates a fresh database, tests
against LocalStack, and removes its containers and volumes on exit. The Compose
smoke test also stops Drive and LocalStack and verifies mail remains available.
