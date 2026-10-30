# Development and local installation

## Locked-out account recovery

An operator with database access can reset Esuno TOTP and backup codes after
verifying the account owner's identity through a separate channel. Stop every
API instance first so no sign-in or MFA operation can race the reset. Back up
the database, then run from the repository root with `DATABASE_URL` set to a
connection for a role allowed to update authentication records and append
audit events:

```sh
node scripts/reset-mfa.mjs user@example.org
```

The transaction deletes the account's MFA record and security keys, pending challenges and
trusted-device records, revokes its sessions, and appends
`mfa.operator_reset.success` to the audit log. Restart the API and have the
user sign in and enrol a new factor. The user's password is unchanged. Protect
the database credential and audit operator access independently: the event
identifies the target, not the human operator. This procedure does not reset
the separate Vault account.

This page describes what runs today. Planned components are listed at the end.

## Docker Compose stack

```sh
cp deploy/env.example .env
# Use these values only with the disposable local profile:
printf %s test > /tmp/opensuite-drive-local-secret
chmod 644 /tmp/opensuite-drive-local-secret
# Set the Drive variables shown below in .env.
docker compose --profile dev up -d localstack
pnpm install && pnpm build   # produces apps/web/dist, mounted by Caddy
# First bootstrap the mail management account as described below.
docker compose up -d
docker compose --profile dev up -d   # adds LocalStack (S3/SQS substitutes)
```

For local-only Drive, set the following in `.env`. The file above contains a
public test credential, so its permissive mode is not suitable for production.

```dotenv
DRIVE_S3_ENDPOINT=http://localstack:4566
DRIVE_S3_PUBLIC_ENDPOINT=http://localhost:4566
DRIVE_S3_BUCKET=opensuite-drive
DRIVE_S3_PREFIX=drive/
DRIVE_S3_REGION=us-east-1
DRIVE_S3_ACCESS_KEY=test
DRIVE_S3_SECRET_FILE=/tmp/opensuite-drive-local-secret
```

| Service          | Image (pinned by digest)                | Role                                                                                                      |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `caddy`          | `caddy:2.11.7`                          | Serves the static web client and proxies `/api/*` to the API and mail protocol routes to the mail server. |
| `api`            | built from `apps/api/Dockerfile`        | Application API (`/health`, `/ready`, `/openapi.json`).                                                   |
| `drive`          | built from `apps/drive/Dockerfile`      | Separate Drive API and S3-compatible object storage.                                                      |
| `drive-migrate`  | built from `apps/drive/Dockerfile`      | One-shot Drive database migration job.                                                                    |
| `stalwart`       | `stalwartlabs/stalwart:v1.0.1`          | Mail server: SMTP, IMAP, JMAP, CalDAV, CardDAV. Data in embedded RocksDB.                                 |
| `postgres`       | `postgres:18.6`                         | Application database, plus a separate `opensuite_drive` database.                                         |
| `migrate`        | built from `deploy/postgres/Dockerfile` | One-shot job: verifies and applies application migrations before the API starts.                          |
| `secrets`        | `alpine:3.24.3`                         | One-shot job: generates local passwords on first start.                                                   |
| `stalwart-setup` | `stalwartlabs/stalwart:v1.0.1`          | One-shot job: applies mail server settings (see below).                                                   |
| `localstack`     | `localstack/localstack:4.14.0`          | `dev` profile only: local S3 bucket and SQS queues for inbound mail.                                      |

Rebuild the client with `pnpm build` after changes; Caddy mounts `apps/web/dist` read-only. The web client shows live API status and a mail interface. The production mail API is wired to Stalwart; synthetic data is available only in the development server. Other product pages are placeholders. For the development server and browser tests, see [the web client guide](../apps/web/README.md).

Every long-running service has a Compose health check and a restart policy.
Data lives in named volumes: `postgres-data`, `stalwart-data`, `caddy-data`,
`caddy-config`, `secrets` and `localstack-data`.

### Secrets

On first start, the `secrets` job generates separate PostgreSQL, Stalwart
recovery and management passwords in the `secrets` volume. Normal Stalwart
startup does not mount or activate the recovery password. Back up the secrets
with the data volumes; losing the management password requires deliberate
recovery. Docker administrators and processes with access to the internal
mail listener and management credential are trusted.

### Mail bootstrap and upgrades

`deploy/stalwart/config.json` locates RocksDB; settings live in the store.
For a fresh install **or an upgrade from the old recovery-only setup**, stop
public access before starting the temporary recovery administrator. Choose a
non-overlapping `MAIL_MANAGEMENT_SUBNET` first; do not change it later without
updating the account's allowed IPs. Run from the repository root:

```sh
docker compose run --rm secrets
docker compose stop caddy
docker compose -f compose.yaml -f deploy/stalwart/compose.bootstrap.yaml up -d --wait stalwart
docker compose -f compose.yaml -f deploy/stalwart/compose.bootstrap.yaml --profile bootstrap run --rm stalwart-bootstrap
docker compose up -d --force-recreate --wait stalwart
docker compose up -d
```

The job creates `management@opensuite.internal` with a separately generated
password and an allowed-IP restriction to the management network; it verifies
the credential before exiting. It refuses to take over an existing domain if
that credential does not work. Resolve that collision or an interrupted
bootstrap manually using the temporary recovery override. The account is an
administrator: protecting its secret and every container with access to the
mail listener is essential. The recovery override must be removed and Stalwart
recreated before Caddy is restarted. Verify the recovery credential no longer
authenticates. To recover later, stop Caddy and deliberately use the temporary
override again; remove it and recreate Stalwart afterwards.

`stalwart-setup` connects to `http://stalwart:8080` on the management network
using that account. API provisioning uses the same account over the
management network with `StalwartAdmin`; its API is unchanged.
Never use the public HTTPS origin for management. `Http.clientIpSource` trusts
one X-Forwarded-For hop, and Caddy replaces client-supplied values and refuses
connections originating from the management subnet. Do not put another
untrusted proxy in front of Caddy or attach Caddy to the management network.
Containers that can directly contact Stalwart can forge that header, so the
allowed-IP rule is a boundary against public clients, not against compromised
containers or Docker administrators. The stock Caddy image cannot inspect JSON
request bodies; it does not filter `urn:stalwart:jmap` itself.

Setup enables stdout logging and proxy trust before checking blob storage;
S3-compatible blobs require the separate [object storage procedure](operations/object-storage.md).

- logs go to standard output (`docker compose logs stalwart`);
- the client address is taken from `X-Forwarded-For`, which Caddy sets
  (exactly one proxy hop). Caddy replaces any value a client sends.
- outbound relay configuration is applied separately through the server-only management adapter; see [outbound operations](operations/outbound.md).
- blobs remain local by default. For S3-compatible storage, follow
  [object storage operations](operations/object-storage.md), including the
  explicit switch guard, restart, probe and migration precautions.

### Mail TLS and ports

Ports 465, 993 and 4190 bind to loopback until TLS has been installed and
verified. The Caddy certificate is copied and renewed by the systemd timer in
[the production runbook](deployment/production.md#mail-tls). Observer checks
both 465 and 993 independently.

### Migrations

The `migrate` job waits for PostgreSQL and applies versioned Prisma migrations
before the API starts. It checks applied migration checksums before deploying;
never change or remove an applied migration. See [the database package](../packages/db/README.md)
for development, encrypted provider secrets, and test instructions. The API
uses a separate application database login and registers a database readiness
probe. The migration job configures that login after applying migrations;
it can append and read audit rows but cannot change or truncate them.

### Local AWS substitutes

The `dev` profile starts LocalStack with `opensuite-inbound`, `opensuite-archive` and
`opensuite-drive` S3 buckets, plus `opensuite-inbound` and `opensuite-inbound-dlq` SQS queues. No AWS account or
credentials are needed. LocalStack only simulates AWS: it proves nothing about
real SES, S3 or SQS behaviour.

LocalStack 4.14.0 is the last release that starts without a LocalStack account.
To use a newer image, set `LOCALSTACK_IMAGE` and `LOCALSTACK_AUTH_TOKEN` in
`.env`.

## Optional Vault profile

`docker compose --profile vault up -d vault caddy` starts Vaultwarden, its
database provisioner and shared PostgreSQL without requiring mail or Drive.
The local vault origin is `https://vault.localhost`; Caddy's local CA must be
trusted. Set an Argon2 admin-token file to enable the loopback-only admin
listener. See [Vault operations](operations/vault.md) for setup, invitations,
backup limitations and the required separate origin. The standard backup does
not include Vault.

`pnpm exec vitest run --project vault` runs a disposable Vaultwarden, PostgreSQL
and Caddy integration project. Docker Compose is required; the suite removes
its project containers and volumes even on failure.

## Smoke test

```sh
node scripts/compose-smoke.mjs --report smoke.xml
```

The smoke test starts a separate Compose project with a generated run ID.
`compose.test.yaml` publishes its ports on random loopback ports. The test then
checks the following through the proxy, over TLS verified with Caddy's local
certificate authority:

- API liveness and readiness;
- JMAP discovery, the anonymous session, rejection of the internal management
  account through Caddy, and rejection of a wrong password;
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
discovery endpoint. The fixtures test local submission and delivery and an authenticated fake SMTP relay. They do not verify external DNS, real relay TLS or the production proxy.

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
setup and the limits of offline validation. The SES relay has not been tested against AWS.

For the pinned Stalwart and disposable MinIO S3 integration test:

```sh
pnpm exec vitest run --project stalwart
```

This uses a separate Compose project, a pinned MinIO server, LocalStack's local
CLI, and a random loopback port. It exercises a
message with an attachment, a storage outage and a stopped-store restore,
then removes its containers and volumes. The local substitute does not verify
real object-storage providers. Docker is required.

## Authentication and mailbox provisioning

The API serves Better Auth at `/api/auth/*` through Caddy, with secure,
HTTP-only, SameSite=Lax cookies. Set `OPENSUITE_PUBLIC_HOST` to the HTTPS host
and `MAIL_DOMAIN` to the primary domain for new accounts. Accounts may also
use any domain in the comma-separated `MAIL_DOMAINS` and any domain an
administrator manages in the console, until its removal starts; every other
domain is refused at signup, bootstrap and provisioning. Registration is
restricted to authenticated administrators; it does not verify email ownership.
The administrator must verify the address out of band and send the initial
password securely. Passwords need at least 12 characters. MFA supports TOTP
and backup codes. Caddy must be the only proxy trusted by the API: Compose uses
a dedicated network and fixed Caddy address and replaces X-Forwarded-For.
Do not publish the API directly or add untrusted containers to that network.

There is no automatic first administrator. To create or promote an enabled,
provisioned account, prepare a password file outside Git and `.env`, then run:

```sh
docker compose exec -T api node apps/api/src/bootstrap.ts admin@example.com /dev/stdin < /secure/path/initial-password
```

The email must belong to an allowed domain (see above). For an existing account the command
promotes that account without changing its password; a disabled account cannot be
promoted. An administrator can then create accounts with
`POST /api/auth/sign-up/email` using their session and the configured Origin.
The command is an operator action: restrict Docker access. Administrators cannot
disable themselves or the last enabled administrator.

Signup provisions a Stalwart account and address, with a random inaccessible
primary password and an application credential encrypted in the database.
The API mounts the generated Better Auth secret, mailbox encryption key, and
Stalwart management secret read-only; back up the secrets volume
alongside the database and mail data. Loss of the mailbox key prevents
recovering stored credentials. Do not place secrets in `.env` or Git.

Provisioning can fail after the account transaction commits. A startup and
one-minute reconciliation retries unlinked accounts and interrupted suspensions.
It suspends the mailbox, revokes application-owned credentials (including a
credential whose response was lost), then issues a replacement. Disabled users
lose sessions immediately; a failed Stalwart suspension is retried. Monitor API
logs for reconciliation failures. Run one API instance: provisioning locks and
rate limits are in-process and are not shared across replicas. Auth limits are
per IP and per account plus IP, and reset on restart. Audit events are append-only
for the application database role. The API's live-session middleware checks the
database and active mailbox before protected procedures or Drive sessions.

## Known limitations

- **Mail delivery:** no domain or mailbox is provisioned by default. Local
  JMAP submission and delivery are tested; a fake SMTP relay is tested; real SES delivery is not.
- **Outbound access:** the mail server downloads public network data
  (ASN/geolocation) from GitHub at startup.

## Planned, not implemented

Calendar and contacts web interfaces and production SES provider proof. The setup wizard is available; see the [administrator guide](admin/index.md) for its current user-creation limitation.

## Ingestion

See [ingestion](architecture/ingestion.md) for configuration, archive and replay operation, and production limitations. `pnpm exec vitest run --project ingest` runs an isolated Compose project with random loopback ports for PostgreSQL, LocalStack and Stalwart. It removes its own containers and volumes, including on setup failure. The disposable PostgreSQL instance runs with fsync disabled; this suite does not test database crash durability. No real AWS or B2 access is needed.

## Drive

Drive runs separately at `/drive/api/`, with its own `opensuite_drive` database,
migrations, bucket and prefix. Caddy and mail do not depend on Drive startup.
The session adapter forwards only the incoming cookie to the API's
`GET /auth/get-session?disableCookieCache=true`; it accepts Better Auth's
`{user, session}` response, verifies matching user IDs and expiry, and fails
closed if the API is unavailable. The API must be running for authenticated Drive operations.
The endpoint URL is selected with `DRIVE_SESSION_API` (default `http://api:3000`).
The internal endpoint must be trusted and reachable at the indicated path.

The `drive-migrate` job uses the PostgreSQL administrator secret only to create
and maintain the `opensuite_drive` login and transfer the Drive database and
existing Drive tables to it. It applies migrations as that role. The long-running
service receives only the separately generated `drive-database` secret, through
`DRIVE_DATABASE_PASSWORD_FILE`. The role cannot connect to the main database:
the migration job revokes its default PUBLIC CONNECT grant and grants CONNECT to
`opensuite_app`. Other main-database roles need explicit CONNECT grants. Back up
the database and secrets before upgrading an existing installation; orphaned
Drive entries must be repaired before the parent foreign key can be installed.

For local development, `docker compose --profile dev up -d` creates a separate
`opensuite-drive` bucket in LocalStack. Set explicit test credentials and loopback-only endpoints for local use. A browser uses the endpoint in
`DRIVE_S3_PUBLIC_ENDPOINT`, which must resolve from the browser and refer to the
same storage as `DRIVE_S3_ENDPOINT` (used by the service); the signed host must
not be rewritten. Configure `DRIVE_S3_BUCKET`, `DRIVE_S3_PREFIX`,
`DRIVE_S3_REGION`, `DRIVE_S3_ACCESS_KEY`, `DRIVE_S3_SECRET_FILE`,
`DRIVE_S3_PATH_STYLE`, and `DRIVE_QUOTA_BYTES` for the deployment. Use a dedicated
bucket and credentials, separate from mail and backups, and TLS for remote
services. Configure S3 CORS for the actual application origins, PUT/GET/HEAD,
required headers, and exposed `ETag`; local development uses permissive CORS.
AWS and other S3-compatible providers have not been exercised here.

The web Drive workspace uses synthetic in-memory data in the Vite development
server and the real Drive API in production builds. Set `DRIVE_PROXY_TARGET` to
proxy `/drive/api` to a local Drive service when testing a production preview.
The current contract does not expose quota totals or lists of existing shares
and links; the workspace reports quota as unavailable and accepts user and
link IDs to change or revoke access. A public link and its ID must be saved
when created because the token is returned only once. The browser attempts to
remove pending reservations when an upload fails or is cancelled; if it lacks
owner access, the service has no separate abort command and cleanup requires
the owner.

The oRPC endpoint `POST /drive/api/v1/command` accepts the discriminated actions
in `packages/contracts/src/drive.ts`. Uploads reserve quota first and return a
five-minute URL. Single uploads require the specified content type and length;
multipart clients request consecutive parts of at least 5 MiB, sized to fit at
most 10,000 parts (the last may be smaller), retain each ETag, and submit them
to `finish`. Multipart reservations expire after 24 hours; each signed part URL
still expires within five minutes. Finalization streams and hashes
the complete object, checks size and content type, and copies it to a key which
is never exposed for upload. Clients must calculate a hexadecimal SHA-256 first.
Ready files and unexpired reservations, including trashed entries, count against
the per-owner quota. Expired pending and failed uploads no longer reserve quota.
The Drive process sweeps up to 100 expired uploads every minute, aborting their
multipart uploads and deleting their storage and rows; failed cleanup is retried.
Parts and finalization are rejected after expiry. A checksum or metadata mismatch
marks an upload failed, and finish attempts are limited to 10 per user per minute
per Drive process (the in-memory limit resets on restart and is not shared across
replicas). Pending and failed uploads can also be trashed and deleted.
Configure storage lifecycle rules to clean orphaned `pending/` objects and
incomplete multipart uploads under both `pending/` and `objects/`; a still-valid signed URL can recreate a staging
object after finalization. Monitor for orphaned objects and interrupted
finalizations; automatic reconciliation is not implemented.

Files are private unless explicitly shared by user ID; a share applies to the
individual item, not its descendants. Read shares permit download and preview;
write shares also permit rename and move subject to destination authorization.
Only an owner can move an item to their root.
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

## Mail API composition

The mail routes use the authenticated actor supplied by the API identity adapter.
Configure `JMAP_ORIGIN` with the Stalwart JMAP origin and
`PROVIDER_ENCRYPTION_KEY` with the same 64-character hexadecimal key used to
protect mailbox credentials. Both belong on the API server; the browser only
receives the application session cookie. The JMAP session's advertised URLs
must use that same origin. The auth startup composition must pass its identity
adapter to `buildServer` so requests can resolve the current session; it may
also supply the mail service through the `mail` dependency. The web app uses
its synthetic mailbox in the Vite dev server and the API in production builds.

Attachment links are scoped to the signed-in user and expire after one minute.
They are held in process memory, so deployments with multiple API instances
need sticky routing or a shared token store. Replacing a draft creates a new
JMAP email ID; callers must use the ID returned by each update. A successful
submission means Stalwart accepted the message for delivery, not that a remote
recipient received it. If submission times out or its follow-up mailbox update
fails, delivery may already be underway; inspect the mailbox and delivery queue
before retrying.
