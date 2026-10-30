# Production installation on one Ubuntu VPS

This is the ordered procedure for one Ubuntu host, Docker Compose, a public
HTTPS/mail hostname, Backblaze B2 for Stalwart blobs and Drive, and SES in
`eu-north-1` for inbound and outbound. Replace `mail.example.com`,
`example.com`, bucket names and paths with the operator's actual values. The
mailbox domain may differ from the server hostname. The receiving MX and any
wildcard change are a **separate owner-approved cutover**; this procedure does
not authorize them. Real AWS and B2 integration has not been tested here.
Do not cut over until the preservation and verification gates below are met.

## Prerequisites and DNS

1. Prepare an Ubuntu VPS with adequate RAM, encrypted storage and space for
   Docker data and a complete uncompressed backup, synchronized time, Git,
   Docker Engine and the Compose plugin, Node.js 22.18+ and pnpm 12, `openssl`,
   `flock`, and `curl`. Restrict SSH and Docker administration. Install the
   checkout at `/opt/opensuite`, record the commit, and use that directory for
   every command. Enable a host firewall: permit TCP 80/443 for ACME and HTTPS;
   later permit TCP 465/993 only after mail TLS verification. UDP 443 is
   optional. Keep 4190 closed unless explicitly needed. SES sends inbound mail
   to its own MX; do not expose direct SMTP port 25.
2. Publish an A (and only a working AAAA) record for `mail.example.com` to the
   VPS. Permit public ACME HTTP validation and keep Caddy's data volume. Verify
   the regional SES identity for the mailbox domain using the identity's
   supplied TXT/CNAME records and publish its Easy DKIM records. Publish or
   merge an SPF policy and DMARC policy appropriate to _all_ current senders;
   add custom MAIL FROM DNS only if configured and it does not alter existing
   routing. Publish Stalwart's DKIM records after the domain is provisioned as
   described in [outbound operations](../operations/outbound.md). Check each
   record resolves, signatures align and SES verification completes. Do not
   replace the receiving MX or wildcard records at this stage.
3. Create separate private B2 buckets/credentials for mail blobs, Drive and
   restic backups, and a separate archive for inbound notification copies.
   Scope keys to the necessary bucket/prefix and read/write/list/delete rights.
   Obtain each bucket's B2 S3 region and endpoint
   `https://s3.<region>.backblazeb2.com`; never use the native B2 endpoint.
   These stores are independent of the AWS SES S3 buffer.

## Secrets and environment

```sh
cd /opt/opensuite
cp deploy/env.example .env
chmod 600 .env
sudo install -d -m 0755 /etc/opensuite
sudo install -d -m 0755 /etc/opensuite/mail-tls
mkdir -p deploy/backup-status
pnpm install --frozen-lockfile
pnpm build
```

Put the following in `.env`, substituting real values, and leave secret values
out of it. Values are trusted POSIX shell assignments as well as Compose env
values; avoid shell metacharacters. Choose a management subnet that does not
overlap other Docker/host networks and distinct free addresses within it for
all services listed in `deploy/env.example`. If changing the subnet later,
also update the management account's IP restriction.

```dotenv
OPENSUITE_SITE_ADDRESS=mail.example.com
OPENSUITE_PUBLIC_HOST=mail.example.com
MAIL_HOSTNAME=mail.example.com
MAIL_DOMAIN=example.com
# Optional further account domains, comma separated.
#MAIL_DOMAINS=example.net
MAIL_PROTOCOL_BIND=127.0.0.1
MAIL_MANAGEMENT_SUBNET=172.30.248.0/24
MAIL_MANAGEMENT_API_IP=172.30.248.10
MAIL_MANAGEMENT_STALWART_IP=172.30.248.20
MAIL_MANAGEMENT_SETUP_IP=172.30.248.21
MAIL_MANAGEMENT_OPS_IP=172.30.248.22
MAIL_MANAGEMENT_BACKUP_IP=172.30.248.23
MAIL_MANAGEMENT_BOOTSTRAP_IP=172.30.248.24
API_PROXY_CADDY_IP=172.28.254.2
API_PROXY_API_IP=172.28.254.3
MAIL_BLOB_STORE=s3
MAIL_S3_ENDPOINT=https://s3.<b2-region>.backblazeb2.com
MAIL_S3_REGION=<b2-region>
MAIL_S3_BUCKET=<private-mail-bucket>
MAIL_S3_PREFIX=mail/
MAIL_S3_KEY_ID=<mail-key-id>
MAIL_S3_SECRET_FILE=/etc/opensuite/mail-s3-secret
MAIL_S3_ALLOW_SWITCH=1
DRIVE_S3_ENDPOINT=https://s3.<b2-region>.backblazeb2.com
DRIVE_S3_PUBLIC_ENDPOINT=https://s3.<b2-region>.backblazeb2.com
DRIVE_S3_REGION=<b2-region>
DRIVE_S3_BUCKET=<private-drive-bucket>
DRIVE_S3_PREFIX=drive/
DRIVE_S3_ACCESS_KEY=<drive-key-id>
DRIVE_S3_SECRET_FILE=/etc/opensuite/drive-s3-secret
DRIVE_S3_PATH_STYLE=true
MAIL_RELAY_SECRET_FILE=/etc/opensuite/ses-smtp-secret
MAIL_RELAY_CONFIGURED=0
MAIL_TLS_CERT_FILE=/etc/opensuite/mail-tls/fullchain.pem
MAIL_TLS_KEY_FILE=/etc/opensuite/mail-tls/privkey.pem
MAIL_TLS_ENABLED=0
```

Create the three secret files outside Git with no trailing newline: the mail
B2 application key secret and SES SMTP password readable by uid 2000, and the
Drive B2 application key secret readable by uid 999. Use mode 0400 and
traversable parent directories. The SES SMTP username is a separate regional
credential, not the AWS API key. Create empty TLS destination files before
starting Compose, or Docker may create directories for missing bind sources:

```sh
sudo touch /etc/opensuite/mail-tls/fullchain.pem /etc/opensuite/mail-tls/privkey.pem
sudo chown 2000:2000 /etc/opensuite/mail-tls/fullchain.pem /etc/opensuite/mail-tls/privkey.pem
sudo chmod 400 /etc/opensuite/mail-tls/fullchain.pem /etc/opensuite/mail-tls/privkey.pem
docker compose config >/dev/null
```

Configure Drive bucket S3 CORS for the exact origin
`https://mail.example.com`, methods `PUT`, `GET`, `HEAD`, allowed headers
`Content-Type` and `Content-Length`, and exposed header `ETag`. Set these
through B2's S3-compatible CORS API; remove native B2 CORS rules first because
B2 S3 CORS works only without native B2 CORS rules. Confirm preflight and a browser upload and
download from the real origin. The public endpoint must be browser-reachable
and match the signed host. See [B2 CORS](https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-s3-compatible-api).

### Separate application origins (optional)

Mail, Drive and Calendar can each be served at the root of their own origin,
for example `https://mail.example.com/`, `https://drive.example.com/` and
`https://calendar.example.com/`. The mail origin stays the sign-in origin.
Add to `.env` (commas, no spaces):

```dotenv
OPENSUITE_SITE_ADDRESS="mail.example.com, drive.example.com, calendar.example.com"
OPENSUITE_PUBLIC_HOST=mail.example.com
AUTH_PRODUCT_ORIGINS=drive=https://drive.example.com,calendar=https://calendar.example.com
DRIVE_TRUSTED_ORIGINS=https://mail.example.com,https://drive.example.com,https://calendar.example.com
```

Create explicit DNS records for each name; do not rely on a wildcard. Add the
Drive origin to the Drive bucket CORS rule. Then check:

- `GET https://<each origin>/api/origins` returns the three origins.
- Opening Drive or Calendar while signed out leads to the mail sign-in page,
  including the second factor, then back to the requested page.
- Signing out on any origin signs out on all three.
- Old URLs such as `https://mail.example.com/drive?…` move to the new origin
  with their query. Public Drive links under `/drive/api/v1/public/…` keep
  working on every origin.
- A `POST` to `/api/…` or `/drive/api/…` with another `Origin` is refused.

Sessions use host-only `__Host-opensuite.*` cookies, never a parent-domain
cookie, so other hosts under the same parent domain cannot read or replace
them. A sibling origin receives the session through a single-use token valid
for one minute, bound to that origin and carried in the URL fragment. After
upgrading from a release with `__Secure-better-auth.*` cookies, every user
signs in once again.

## Moving to a new domain

Schedule a maintenance window and notify users that old hostnames will stop
working. Replace `example.com` with the new domain in the examples below;
keep the existing Vault hostname if it is not moving.

1. Create DNS A records pointing to the server for `mail.example.com`,
   `drive.example.com`, `calendar.example.com`, and, only if moving it,
   `vault.example.com`. Leave MX, wildcard and SPF records unchanged. Confirm
   DNS resolves and ports 80 and 443 are reachable for Caddy's ACME validation.
2. Update the Drive bucket's S3-compatible CORS configuration before moving
   users. Replace these example origins with the exact new origins serving the
   app; preserve any other required rules. For example, save this JSON outside
   Git and use the B2 S3-compatible API to apply it to the Drive bucket:

   ```json
   {
     "CORSRules": [
       {
         "AllowedOrigins": [
           "https://mail.example.com",
           "https://drive.example.com",
           "https://calendar.example.com"
         ],
         "AllowedMethods": ["GET", "HEAD", "PUT"],
         "AllowedHeaders": ["Content-Type", "Content-Length"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }
     ]
   }
   ```

   B2 S3 CORS requires removing native B2 CORS rules first. Confirm browser
   preflight, upload and download after the move; see [B2 CORS](https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-s3-compatible-api).

3. Update `.env` with the new hosts, retaining the existing Vault host if it is
   not moving. Do not include the old hosts in the application or trusted
   origins. Keep existing storage and secret settings. With Vault enabled:

   ```dotenv
   OPENSUITE_SITE_ADDRESS="mail.example.com, drive.example.com, calendar.example.com"
   OPENSUITE_PUBLIC_HOST=mail.example.com
   AUTH_PRODUCT_ORIGINS=drive=https://drive.example.com,calendar=https://calendar.example.com,vault=https://vault.example.com
   DRIVE_TRUSTED_ORIGINS=https://mail.example.com,https://drive.example.com,https://calendar.example.com
   VAULT_PUBLIC_HOST=vault.example.com
   MAIL_HOSTNAME=mail.example.com
   COMPOSE_PROFILES=vault
   ```

   Compose derives `AUTH_PUBLIC_ORIGIN` from `OPENSUITE_PUBLIC_HOST` and
   Caddy's Vault site and Vaultwarden's `DOMAIN` from `VAULT_PUBLIC_HOST`.
   The Vault origin must match `VAULT_PUBLIC_HOST` and is not an application
   authentication origin. Validate with `docker compose config` (the output
   includes operational configuration, so handle it as sensitive).

4. Recreate Caddy with `docker compose up -d --no-deps caddy`. Wait for a
   valid public certificate on the new mail hostname. Then run
   `sudo /opt/opensuite/deploy/tls/renew.sh` to install its Caddy certificate
   for SMTP/IMAP and recreate Stalwart. The renewal timer already selects the
   Caddy certificate named by `MAIL_HOSTNAME`. Run `docker compose up -d` to
   recreate services with their new configuration. Wait for the
   `stalwart-setup` job to exit successfully and inspect its logs, then perform
   the checks in [Mail TLS](#mail-tls), including certificate hostname on ports
   465 and 993.
   Verify the three web origins, sign-in and handoff, Vault, and Drive uploads,
   downloads and public links. If Vault moves, update its clients' server URL.
5. Users must sign in again because application cookies are host-only. Update
   the Bitwarden SimpleLogin alias generator's Server URL to
   `https://mail.example.com` (without `/api`). Update IMAP and SMTP server
   hostnames in mail clients to `mail.example.com`; a certificate for the new
   name does not validate for the old name, and mail protocols do not redirect.

## Bootstrap and mail storage

Keep Caddy stopped and public mail ports closed while the recovery override is
active. Run this sequence even on a fresh server; ordinary `up` cannot create
the management account. If bootstrap reports an existing conflicting identity,
stop and resolve it rather than replacing it.

```sh
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

The first setup changes a new, empty mail store to B2; the restart activates
it, and the second setup must report a successful active blob upload/download.
Check the probe under the intended B2 prefix. Set `MAIL_S3_ALLOW_SWITCH=0`
then rerun setup. Never use the switch as a migration for existing local blobs;
follow [object storage](../operations/object-storage.md). Verify the recovery
override is absent from the running Stalwart container before exposing Caddy.
Start the stack with `docker compose up -d` and inspect `docker compose ps` and
`docker compose logs stalwart-setup`. Setup failures are recorded and alerted,
but do not stop the API or HTTPS; repair and rerun the job.

## Upgrade to fixed network addresses

Schedule a short maintenance window. This release leaves the existing network
subnets and IPAM unchanged: do not remove or recreate the networks. On the
existing installation, the API proxy address defaults to `172.28.254.3`,
replacing the operator's manual endpoint reservation; Caddy remains at
`172.28.254.2`. The management API keeps its existing `.10` default. Configure
the other distinct management addresses from the environment template within
the existing `MAIL_MANAGEMENT_SUBNET`, retaining any existing API IP and subnet.

Before upgrading, list the current assignments (substitute the actual project
name for `opensuite`):

```sh
docker network inspect -f '{{.Name}}{{range .Containers}}{{"\n  "}}{{.Name}} {{.IPv4Address}}{{end}}' \
  opensuite_api-proxy opensuite_mail-management
```

Look for `.2` and `.3` on the API proxy network and for `.10` and `.20`–`.24` on
the management network. Only the API, Caddy and Stalwart may hold them; if
any other running container (for example a leftover `management`,
`stalwart-setup` or `backup-management` one-off) occupies one of these
addresses, stop it during the window so Compose can claim it. Wait for all setup,
bootstrap, management and backup jobs to finish; do not run two instances of
the same one-off service concurrently. Scheduled and manual `backup.sh` jobs
using the same scratch directory are serialized by its flock; direct Compose
invocations or different scratch directories do not share that protection.

Run `docker compose up -d` with the installation's usual profiles. Compose
recreates the API and Stalwart containers for their changed network settings
and recreates/runs the `stalwart-setup` job. Any existing `management` service
container is recreated when its ops profile is enabled; the backup and
bootstrap one-offs receive their addresses on their next run. Caddy's address
and configuration are unchanged by the defaults, so it need not be recreated.
Other configuration or image changes can cause additional recreations. No
particular startup order between the API and Caddy is required. Verify
`docker compose ps`, setup logs, and application and mail health afterwards.

Because one-off services now have fixed addresses, two instances of the same
one-off cannot run at once. Wait for the `stalwart-setup` container created by
`docker compose up -d` to exit before running `docker compose run --rm
--no-deps stalwart-setup` manually, and remove any orphaned
`backup-management` container left by an interrupted backup before the next
run.

To roll back, check out the previous release and run `docker compose up -d`;
the networks are unchanged. The API then returns to a dynamic address on the
API proxy network, which reintroduces the original start-order risk: re-apply
the manual endpoint reservation, or always start Caddy before the API.

## Optional Vault

Vault is optional and is not production-ready until security and recovery have
been verified. It can run without the mail and application services, but shares
Caddy, PostgreSQL and the server. Use the ordered [Vault setup and operations
procedure](../operations/vault.md#enable-and-first-administrator) for the
following steps:

1. Create the `vault.example.com` A record yourself, and an AAAA record only if
   IPv6 works. Esuno and Compose never create it. Allow 80/443 for Caddy to
   obtain and renew a publicly trusted TLS certificate. Use a dedicated origin.
2. Set `VAULT_PUBLIC_HOST=vault.example.com` in `.env`; Compose derives Caddy's
   `VAULT_SITE_ADDRESS` and Vaultwarden's HTTPS `DOMAIN` from it. Set
   `COMPOSE_PROFILES=vault` so ordinary Compose upgrades include the profile.
   Keep `VAULT_IMAGE` pinned to the official version and digest, and choose
   non-overlapping `VAULT_NETWORK_SUBNET`, `VAULT_NETWORK_IP_RANGE` and
   `VAULT_CADDY_IP` together. See the [environment template](../../deploy/env.example)
   for defaults and the setup guide for required Drive configuration and builds.
3. Configure the protected admin token file and SES SMTP on port 2587 with
   STARTTLS. Open the loopback admin port locally or through SSH, invite the
   first vault user, and choose `VAULT_ORG_CREATION_USERS` as described in the
   [setup guide](../operations/vault.md#enable-and-first-administrator). Mobile
   push is optional and requires the external relay and protected installation
   key; see [SMTP and notifications](../operations/vault.md#smtp-and-notifications).
4. Add `vault=https://vault.example.com` to `AUTH_PRODUCT_ORIGINS` and recreate
   the API to enable the Esuno launcher. See [shell status](../operations/vault.md#esuno-shell-status).
   For alias API keys and Bitwarden's username generator, follow the
   [alias setup](../architecture/aliases.md#api-and-bitwarden).
5. Set `BACKUP_VAULT_ENABLED=1`, configure the scheduled encrypted backup and
   complete the [independent recovery test](../operations/vault-recovery.md#independent-recovery-tests-and-expected-loss).
   The scheduled backup includes the Vault database and data volume when enabled.
   Use the [upgrade and rollback procedure](../operations/vault.md#upgrade-and-rollback)
   before changing the pinned image.

## First administrator

Create a strong initial password in a protected file outside the checkout and
`.env`, with no trailing newline. Use an address within `MAIL_DOMAIN`, a
domain in `MAIL_DOMAINS` or a managed domain:

```sh
docker compose exec -T api node apps/api/src/bootstrap.ts admin@example.com /dev/stdin < /secure/path/initial-password
```

Securely deliver the initial credential and remove the temporary file. The
command provisions the mailbox and promotes the account. Sign in at the HTTPS
site, enable MFA, and create any additional accounts through the authenticated
admin signup API. Check provisioning and reconciliation logs; signup does not
verify mailbox ownership. See [authentication](../development.md#authentication-and-mailbox-provisioning).

## Additional account domain

Accounts can use other domains than `MAIL_DOMAIN`, for example to give
`user@example.net` a mailbox on the same installation. Each address must
belong to only one account.

1. Add the domain, in lowercase, to `MAIL_DOMAINS` in `.env` (comma separated)
   and recreate the API so it reads the new value: `docker compose up -d api`.
   A plain restart keeps the old environment, and the bootstrap command,
   which runs in the API container, refuses the domain until then. Domains
   managed in the console are accepted without this step.
2. Create the account. With an administrator session, call
   `POST /api/auth/sign-up/email` with `name`, `email` and `password` and the
   configured Origin, as described in the
   [admin guide](../admin/index.md#users); the bootstrap command also works
   but promotes the account to administrator. Provisioning creates the domain
   in Stalwart; mail between local accounts of both domains is then delivered
   locally.
3. Receive mail: add the domain to both the `domains` and `recipients`
   variables of the [AWS module](aws.md) (they are independent; import an
   SES identity that already exists with `tofu import` first), apply, and
   after owner approval publish its MX, as in
   [SES inbound and outbound](#ses-inbound-and-outbound). Check that the
   worker routes the address: a release that routes primary addresses and
   delivers to linked mailboxes needs nothing else; otherwise issue a static
   route and destination for the account with the `management ingest` helper
   and recreate the worker with `docker compose --profile ingest up -d ingest`.
4. Send mail: SES accepts only verified identities, so publish every record
   of the AWS module's `dns_records` output for the domain (identity, SES
   DKIM, MAIL FROM MX and SPF), Stalwart's DKIM record from
   `management dns`, and SPF and DMARC, as in
   [outbound DKIM and DNS](../operations/outbound.md#dkim-and-dns).
   Until then SES rejects its messages and the sender receives a bounce.

To retire a domain listed in `MAIL_DOMAINS`, remove it from that list and
recreate the API as well as removing its managed domain: once the domain
record is gone, the list alone accepts new accounts in it again.

Before deploying a release with this support, list the domain records
(`SELECT name, status, "removalPending" FROM "Domain";`): every managed
domain whose removal has not started becomes available for accounts. Before
rolling back, make sure every account in another domain has its mailbox:
older releases refuse to provision such an account on every reconciliation,
including when it is disabled before it was provisioned.

## Mail TLS

After Caddy has obtained a publicly trusted certificate for the same hostname,
run the installer once as root. It reads the live Caddy data volume, validates
the hostname, remaining life and matching private key, installs uid-2000 files,
and recreates Stalwart to refresh its file mounts.

```sh
sudo /opt/opensuite/deploy/tls/renew.sh
# Set MAIL_TLS_ENABLED=1 in .env, then:
docker compose run --rm --no-deps stalwart-setup
docker compose restart stalwart
sudo cp deploy/tls/opensuite-mail-tls.service deploy/tls/opensuite-mail-tls.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opensuite-mail-tls.timer
sudo systemctl start opensuite-mail-tls.service
sudo systemctl status opensuite-mail-tls.timer
```

On certificate change the daily persistent timer copies the new pair and
recreates Stalwart; a pending marker causes a failed restart to be retried.
Check its journal and test the certificate chain, hostname and expiry on both
465 and 993, initially against loopback with the correct SNI. For example,
`openssl s_client -connect 127.0.0.1:465 -servername mail.example.com -verify_return_error </dev/null`
and repeat for 993. Only after both pass, set `MAIL_PROTOCOL_BIND=0.0.0.0`,
recreate Stalwart, open the chosen firewall ports and repeat externally. The
observer checks expiry on each port; an external check must validate the chain
and name. The timer requires root, Docker access, openssl and the checkout at
`/opt/opensuite`. Adapt the unit paths for another checkout.

## SES inbound and outbound

Use [AWS deployment](aws.md) to inventory and prepare the reviewed regional
SES identity, encrypted S3 buffer, SNS raw delivery, SQS ingestion and DLQs,
Firehose notification archive, IAM, alarms and a receipt rule. Do not replace
an existing active rule set without coordinating its owner. Establish and test
an independent, durable copy of both original MIME and complete receipt
notifications, including Bcc and verdicts; the worker deletes the buffer after
successful imports, and its own archive does not protect events never received.
The regional [SES endpoint list](https://docs.aws.amazon.com/general/latest/gr/ses.html)
includes `eu-north-1` receiving. Do not change the MX yet.

Linked mailboxes need no destination (see below). To deliver a mailbox
instead with a separate inbound app password, obtain its account ID without
exposing its application credential. The query below assumes the default PostgreSQL user
and database names; substitute the values in `.env` if changed:

```sh
docker compose exec -T postgres psql -U opensuite -d opensuite -c "SELECT address, \"accountId\" FROM \"MailboxLink\" WHERE status = 'active';"
umask 077
docker compose --profile ops run --rm --no-deps -T management ingest user@example.com ACCOUNT_ID > /secure/path/inbound-destination.json
```

The helper issues a distinct inbound app password, verifies that it resolves to
the intended account, finds its junk mailbox, and writes a destination JSON
object and credential ID to the protected file. This is a secret, not a log.
If issuance or verification fails, a credential may have been created: inspect
and revoke it before retrying. Revoke inbound credentials independently when
removing a route or rotating a key; they are distinct from the API's own
credentials. Verify mailbox and alias sign-in and quarantine behavior.

Create `deploy/ingest.env` (0600) with `DATABASE_URL` for the application DB
role, `AWS_REGION=eu-north-1`, AWS buffer/queue credentials,
`INBOUND_BUCKET`, `INBOUND_BUFFER_PREFIX`, `INBOUND_QUEUE_URL`,
`INBOUND_TOPIC_ARN`, `ARCHIVE_BUCKET`, `ARCHIVE_PREFIX`, and the separate
archive endpoint, region and credentials. The application DB role is
`opensuite_app` and its generated password is readable at
`/run/opensuite/app-database/password` inside the API container; securely form
the PostgreSQL URL with percent-encoding, host `postgres`, and `POSTGRES_DB`.
Do not print that password. A representative env file, with placeholders
replaced and the destination copied from the protected JSON output, is:

```dotenv
DATABASE_URL=postgresql://opensuite_app:<url-encoded-password>@postgres:5432/opensuite
AWS_REGION=eu-north-1
AWS_ACCESS_KEY_ID=<ingestion-access-key-id>
AWS_SECRET_ACCESS_KEY=<ingestion-secret-key>
INBOUND_BUCKET=<aws-buffer-bucket>
INBOUND_BUFFER_PREFIX=messages/
INBOUND_QUEUE_URL=https://sqs.eu-north-1.amazonaws.com/<account>/<queue>
INBOUND_TOPIC_ARN=arn:aws:sns:eu-north-1:<account>:<topic>
ARCHIVE_ENDPOINT_URL=https://s3.<b2-region>.backblazeb2.com
ARCHIVE_REGION=<b2-region>
ARCHIVE_BUCKET=<private-archive-bucket>
ARCHIVE_PREFIX=notifications/
ARCHIVE_ACCESS_KEY_ID=<archive-key-id>
ARCHIVE_SECRET_ACCESS_KEY=<archive-secret-key>
INGEST_ROUTES='[{"address":"user@example.com","destination":"ACCOUNT_ID"}]'
INGEST_DESTINATIONS='[{"id":"ACCOUNT_ID","origin":"http://stalwart:8080","authorization":"Basic <encoded-credential>","quarantineMailbox":"JUNK_ID","rewriteSessionUrls":true}]'
```

Mailboxes created in the admin console, with their addresses, aliases and
domain addresses, need no entry: Compose gives the worker the mailbox key
(`MAILBOX_KEY_FILE`) and the internal Stalwart origin
(`INGEST_MAILBOX_ORIGIN`), and it delivers with each mailbox's stored
credential, read at every connection. Each mailbox's primary address is
routed, as well as its addresses and aliases. Held mail for a new mailbox is
delivered by the next replay, and the first deployment with linked delivery
may at once deliver older mail that waited with `Destination is not
configured` or was held for a primary address within `INGEST_HOLD_DAYS`. That credential is the one the API
uses, not a separate inbound app password: the key opens every mailbox with
full access, so the worker must stay on the private network, without a
published port, and its logs and environment remain restricted. Compose's
`environment` overrides `deploy/ingest.env`; to turn linked delivery off, set
`INGEST_MAILBOX_KEY_FILE=` and `INGEST_MAILBOX_ORIGIN=` (both empty) in
`.env` and recreate the worker. Alert on repeated
`Destination lookup failed` or JMAP 401 errors, and if Stalwart rate-limits
or bans failed authentication, exempt the worker's network: every delivery
comes from its address, so one stale credential must not block the others.
`INGEST_ROUTES` and `INGEST_DESTINATIONS` are optional, for mailboxes
delivered with a separate inbound app password; a static destination takes
precedence over a linked mailbox with the same account ID and keeps
receiving if that mailbox is disabled, until it is removed. For them, add a
static route for each independently configured mailbox address and one
destination per mailbox. Managed aliases resolve from the database; do not add
them to `INGEST_ROUTES`, because static routes can bypass alias disablement
(see [alias inbound behavior](../architecture/aliases.md#inbound-behavior-and-limits)).
Every static route's `destination` must match a destination's `id`, which is
the Stalwart account ID. Changing them requires recreating the worker with
`docker compose --profile ingest up -d ingest` (a plain restart keeps the old
environment). Before upgrading to linked delivery, compare each static entry
with `SELECT address, "accountId" FROM "MailboxLink";`: a static route must
name the same account as the database for that address, or the message fails
with `Conflicting recipient routes`, and a static destination's `id` must be
the account its credential opens, or delivery fails with `Destination
credential is for another account`. Neither loses mail; both block it until
corrected. Protect and back up these files; safely delete the intermediate
destination file after use. The exact schema, permission requirements,
ambiguity handling and replay procedure are in
[ingestion](../architecture/ingestion.md). Start and check `docker compose --profile ingest up -d --build ingest`. Install the replay timer after configuring backups below. Alert on replay
failures. Verify destination credentials
and quarantine mailboxes before allowing production traffic.

For outbound, create regional SES SMTP credentials and a verified sender,
request production sending access and set appropriate quotas. Install the SMTP
secret file described above, set `MAIL_RELAY_CONFIGURED=1`, then run:

```sh
docker compose up -d --no-deps --force-recreate --wait stalwart
docker compose --profile ops run --rm --no-deps management apply SES_SMTP_USERNAME
```

The route requires STARTTLS and certificate validation to
`email-smtp.eu-north-1.amazonaws.com:2587`. Verify queue behavior, delivery,
bounces, complaints and SES quotas with controlled mail. See
[outbound operations](../operations/outbound.md) for DKIM, limits and rollback.

## Backups and observability

Configure `/etc/opensuite/backup.conf`, restic password, the independent B2
repository and encrypted scratch as in [backup and recovery](../operations/backup.md).
Keep an independently protected offline copy of the recovery key and config.
Quiesce external writers and presigned uploads during the backup window; the
job stops the Compose ingest worker, observer and application services. Run:

```sh
sudo deploy/backup/init.sh
sudo deploy/backup/backup.sh
sudo cp deploy/backup/opensuite-backup.service deploy/backup/opensuite-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opensuite-backup.timer
sudo cp deploy/ingest/opensuite-replay.service deploy/ingest/opensuite-replay.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opensuite-replay.timer
```

Confirm the success event and `deploy/backup-status/last-success`, inspect
`systemctl list-timers`, and perform a complete isolated restore drill. The
persistent backup timer runs daily at 01:00 UTC; the replay timer runs hourly.
Replay and TLS renewal share the backup lock and report an error if it is held;
alert on those systemd failures and investigate. A replay still running at
01:00 makes that night's backup exit with `overlap` (the next attempt is the
following day): replay reads every archived notification and reprocesses held
mail, so alert on replay duration as archive and held volume grow. Protect TLS, SMTP, Drive, ingestion,
observer and backup secrets included in the encrypted snapshot. Object histories,
provider policies and external infrastructure need separate protection.

Configure `deploy/observe.env` (0600) with `OBSERVE_WEBHOOK_URL`,
`OBSERVE_INGEST_ENABLED=true`, the two queue URLs, `AWS_REGION=eu-north-1`
and read-only SQS/CloudWatch credentials. Follow
[observability](../operations/observability.md), including bucket permissions,
webhook testing, queue/DLQ alarms and a separate external uptime/dead-man check.
Restart observe after changes. Check setup status, backup age, disk, readiness,
HTTPS and both mail certificate alerts; inspect timers and journals as well.

## Verification and owner-approved cutover

Before requesting cutover, verify HTTPS chain and health, API and Drive
readiness, sign-in and MFA, a newly provisioned mailbox, an attachment, Drive
browser PUT/GET/HEAD and CORS, both mail TLS endpoints, the backup restore,
webhook delivery and recovery, replay, queue/DLQ and independent archive
recovery. Send controlled SES test mail from/to authorized test identities and
verify full envelope routing, aliases/Bcc, quarantine, exact MIME, SMTP TLS,
DKIM/SPF/DMARC and bounce monitoring. No live provider behavior is established
by offline tests. If a test domain is used, configure its own identity and MX
with its owner's permission. Resolve failures before proceeding.

Record existing MX, wildcard and related DNS values and TTLs, current SES rule
set, queues and rollback owner. Separately obtain the domain owner's approval
for the receiving MX (`10 inbound-smtp.eu-north-1.amazonaws.com` for the
chosen mailbox domain), any wildcard change and rule-set activation. At the
agreed window, apply only the approved changes, confirm propagation and monitor
both old and new routes through the TTL and queue drain. Unknown recipients are
held _after_ SES acceptance (see the hold window in
[ingestion](../architecture/ingestion.md)), so the routes should be complete. Before enabling reception,
confirm on the real buckets that the SES buffer has an agreed lifecycle for
noncurrent versions (do not assume the Terraform module's 30 days; a bucket
without a lifecycle configuration keeps deleted messages indefinitely) and that
archive retention exceeds `INGEST_HOLD_DAYS`.

## Rollback

To return to a worker release that has held recipients but not linked
delivery, no ledger conversion is needed: roll back the image together with
`compose.yaml` and keep a static route and destination for every mailbox
that must keep receiving. Recipients of other mailboxes then wait with
`Destination is not configured`, and mail for primary addresses without an
address record is held again, until linked delivery returns.

Before running a worker release that predates held recipients, convert the
ledger to states that release knows (procedure checked against the previous
release's ledger on PostgreSQL). Older code fails on any message that has a
`held` or `rerouted` recipient, including a duplicate or redriven SQS
notification for a message that was already delivered, and sends it to the
dead-letter queue after its retries:

1. Quiesce every ledger writer, letting work finish rather than interrupting
   an import:

   ```sh
   systemctl stop opensuite-replay.timer        # no new scheduled replay
   # A running oneshot replay is "activating", not "active".
   while [ "$(systemctl is-active opensuite-replay.service)" = activating ]; do sleep 30; done
   docker compose --profile ingest stop ingest  # SIGTERM; the worker drains
   docker ps --filter label=com.docker.compose.service=ingest   # must list none
   ```

   The last command also shows one-off `docker compose run` replays or
   operator commands; wait for them too. Leave the queues in place.

2. With the current release, finish every held recipient: list them with
   `operator list held`, then provision the address and run
   `deploy/ingest/replay.sh` once by hand, or reject them, until the list is
   empty. Wait for that replay to exit and repeat the checks of step 1.
3. Take a backup (`deploy/backup/backup.sh`, or at least a `pg_dump` of the
   ledger tables). Then relabel routed rows in one transaction that records
   each change in the append-only `InboundResolutionAudit` table, while holding
   the lock that backup and replay share, so neither can start meanwhile
   (`flock -n` fails instead of waiting if one is running):

   ```sh
   . /etc/opensuite/backup.conf
   { [ -z "$(docker ps -q --filter label=com.docker.compose.service=ingest)" ] &&
     flock -n "${BACKUP_SCRATCH:?}/opensuite-backup.lock" \
       docker compose exec -T postgres \
       sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < rollback-relabel.sql; } ||
     echo 'ingest running, lock held or SQL failed: relabel NOT applied' >&2
   ```

   with `rollback-relabel.sql` containing:

   ```sql
   BEGIN;
   INSERT INTO "InboundResolutionAudit"
     ("id", "recipientKey", "operator", "reason", "action", "previousState")
   SELECT gen_random_uuid()::text, "idempotencyKey", '<operator>',
          'Relabelled before rollback to a release without rerouted',
          'rollback-relabel', 'rerouted'
   FROM "InboundRecipient" WHERE state = 'rerouted';
   UPDATE "InboundRecipient"
   SET state = 'rejected', error = 'Rerouted; relabelled before rollback'
   WHERE state = 'rerouted';
   COMMIT;
   ```

   `rerouted` only means the address was moved, under the message lock and
   before any import attempt, to a mailbox recipient of the same message. It
   says nothing about delivery: that destination recipient keeps its own
   state (`received`, `failed`, `importing`, `uncertain`, `imported` or
   `quarantined`), which this statement leaves unchanged and which the older
   release processes as usual if it has a static destination for it (step
   4). Check those destination recipients before and
   after, for example with `operator list` and the rows of the same messages.

4. The older release delivers only to static destinations and requires at
   least one. Before starting it, make sure `deploy/ingest.env` has a
   non-empty `INGEST_DESTINATIONS` with a route and destination for every
   mailbox that must keep receiving (see the `management ingest` helper
   above); recipients for other mailboxes, including rerouted ones, stay
   failed with their buffer kept until a release with linked delivery
   returns. Roll back `compose.yaml` with the image.
5. Start the older worker and re-enable the replay timer. The worker then
   processes the queue backlog, any redrive and unfinished destination
   recipients; mail for unknown recipients is again rejected and its object
   deleted once the other recipients finish.

Pause new submissions and preserve the Stalwart outbound queue, SES buffer,
notifications, DLQs and ingestion ledger. Restore the recorded DNS MX and any
wildcard values and prior SES active rule set as approved; keep both paths
monitored through DNS TTL and drain, avoiding simultaneous delivery writers.
Reconcile messages accepted during the transition and replay only according to
[ingestion recovery](../architecture/ingestion.md). For a relay rollback, prefer
stopping outbound processing until the queue is understood; the documented
relay reset enables direct MX and may deliver queued mail. For host recovery,
fence the old VPS and use the isolated [restore procedure](../operations/backup.md);
never restore over live object prefixes. Keep backups and provider state until
recovery and mail flow are verified.
