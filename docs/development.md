# Development and local installation

This page describes the current checkout. The [production runbook](deployment/production.md) is being prepared in parallel and may not yet be present here.

## Docker Compose stack

```sh
cp deploy/env.example .env
pnpm install && pnpm build   # produces apps/web/dist, mounted by Caddy
# First bootstrap the mail management account as described below.
docker compose --profile dev up -d   # starts the stack with local S3/SQS substitutes
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
| `observe`        | built from `apps/observe/Dockerfile`    | Health and operational checks; webhook configuration is optional.                                         |
| `ingest`         | built from `apps/ingest/Dockerfile`     | Optional `ingest` profile; requires separately configured resources and credentials.                      |
| `localstack`     | `localstack/localstack:4.14.0`          | `dev` profile only: local S3 bucket and SQS queues for inbound mail.                                      |

Rebuild the client with `pnpm build` after changes; Caddy mounts `apps/web/dist` read-only. The web client shows API status, Mail, Drive and Domains. The Vite development server uses synthetic Mail, Drive and domain data; production builds use the APIs. Calendar and Contacts are placeholders, and there are no sign-in or MFA screens in this checkout. See the [user guide](user/index.md) for current access limitations. For the development server and browser tests, see [the web client guide](../apps/web/README.md).

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
using that account. The current API provisioning runtime instead uses the `admin` recovery identity and the recovery password. Normal Stalwart startup does not activate that identity, so stock Compose provisioning and bootstrap cannot be assumed to work. See [authentication and provisioning](#authentication-and-mailbox-provisioning) and the [production runbook](deployment/production.md) for the parallel fix.
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

Ports 465, 993 and 4190 bind to `127.0.0.1` by default. Caddy's HTTPS
certificate does not automatically configure Stalwart. To share it with mail,
set `MAIL_HOSTNAME` and `OPENSUITE_SITE_ADDRESS` to the same real hostname,
obtain Caddy's certificate, and export its full chain and private key to
operator-managed host files outside the repository. For Caddy's usual ACME
storage, the files are under `/data/caddy/certificates/` in the Caddy container;
choose the actual issuer and hostname directory. Copy both files securely,
restrict access, and make them readable to uid 2000. Do not expose the key in
`.env`, logs or shell arguments. Configure their absolute paths in
`MAIL_TLS_CERT_FILE` and `MAIL_TLS_KEY_FILE`, set `MAIL_TLS_ENABLED=1`, and
recreate Stalwart and rerun setup:

```sh
docker compose up -d --force-recreate --wait stalwart
docker compose run --rm stalwart-setup
docker compose restart stalwart
```

Setup validates the hostname, expiry and matching key and registers file
references. Before setting `MAIL_PROTOCOL_BIND=0.0.0.0`, use an independent
TLS client on each loopback port to verify the served chain and hostname,
including a STARTTLS handshake for ManageSieve. Then recreate Stalwart and
verify externally. Caddy renewals are **not automatically copied**: arrange a
secure renewal hook or operator procedure to refresh both exported files,
recreate Stalwart (file bind mounts can retain old inodes), rerun setup and
verify the new certificate before expiry. Monitor certificate expiry. The
loopback default is the safe state until this is done.

No host port 25 is published in the normal stack: inbound mail must pass through
SES. For a deliberate emergency direct-SMTP fallback, use
`docker compose -f compose.yaml -f deploy/stalwart/compose.direct-smtp.yaml up -d stalwart`;
it defaults to loopback and `DIRECT_SMTP_BIND=0.0.0.0` explicitly exposes it.
Direct mail bypasses SES filtering and archival. Remove the override and
recreate Stalwart after the fallback. STARTTLS ports 587 and 143 remain disabled.

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

## Smoke test

```sh
node scripts/compose-smoke.mjs --report smoke.xml
```

The smoke test requires `--report PATH` as shown. It starts a separate Compose project with a generated run ID.
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
and `MAIL_DOMAIN` to the single domain allowed for new accounts. Registration is
restricted to authenticated administrators; it does not verify email ownership.
The administrator must verify the address out of band and send the initial
password securely. Passwords need at least 12 characters. MFA supports TOTP
and backup codes. Caddy must be the only proxy trusted by the API: Compose uses
a dedicated network and fixed Caddy address and replaces X-Forwarded-For.
Do not publish the API directly or add untrusted containers to that network.

There is no automatic first administrator. The following bootstrap command exists, but the normal Compose credential mismatch described below must be fixed before it can provision an account. Once the management integration is corrected, prepare a password file outside Git and `.env`, then run:

```sh
docker compose exec -T api node apps/api/src/bootstrap.ts admin@example.com /dev/stdin < /secure/path/initial-password
```

The email must belong to `MAIL_DOMAIN`. For an existing account the command
promotes that account without changing its password; a disabled account cannot be
promoted. An administrator can then create accounts with
`POST /api/auth/sign-up/email` using their session and the configured Origin.
The command is an operator action: restrict Docker access. Administrators cannot
disable themselves or the last enabled administrator.

Signup provisions a Stalwart account and address, with a random inaccessible
primary password and an application credential encrypted in the database.
The API mounts the generated Better Auth secret, mailbox encryption key, and
Stalwart recovery administrator secret read-only. Its runtime authenticates as
`admin`, but normal Stalwart startup does not activate that recovery identity.
The separate management account is created by bootstrap and used by setup, not
by this API runtime. Thus stock Compose account provisioning is blocked until
the integration is corrected. Do not leave the recovery override active to
work around it; see the [production runbook](deployment/production.md) being
prepared in parallel. Back up the secrets volume
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

- **Mail certificate renewal:** exporting Caddy certificates and verifying mail
  TLS is an operator responsibility; there is no automated renewal hook.
- **Mail delivery:** no domain or mailbox is provisioned by default. Local
  JMAP submission and delivery are tested; a fake SMTP relay is tested; real SES delivery is not.
- **Outbound access:** the mail server downloads public network data
  (ASN/geolocation) from GitHub at startup.

## Remaining work

Calendar and contacts web interfaces are placeholders. Sign-in, MFA, user administration, setup wizard and client app-password screens are not present in this checkout. Production SES and storage-provider behavior and recovery need independent validation. See the [user guide](user/index.md) and [administrator guide](admin/index.md).

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
multipart clients request consecutive 5 MiB parts (the last may be smaller),
retain each ETag, and submit them to `finish`. Finalization streams and hashes
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
incomplete multipart uploads; a still-valid signed URL can recreate a staging
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

The standard API startup composes authentication and the mail service using
`STALWART_INTERNAL_ORIGIN` and the mailbox key loaded from `MAILBOX_KEY_FILE`.
The authenticated actor and active mailbox link scope requests; the browser
receives the application session cookie, not the mail credential. The Vite
development server uses synthetic mail, while production builds use the API.
The current Compose provisioning mismatch above must be resolved before relying
on a newly provisioned mailbox.

Attachment links are scoped to the signed-in user and expire after one minute.
They are held in process memory, so deployments with multiple API instances
need sticky routing or a shared token store. Replacing a draft creates a new
JMAP email ID; callers must use the ID returned by each update. A successful
submission means Stalwart accepted the message for delivery, not that a remote
recipient received it. If submission times out or its follow-up mailbox update
fails, delivery may already be underway; inspect the mailbox and delivery queue
before retrying.
