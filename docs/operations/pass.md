# Esuno Pass operations

Pass runs the official Vaultwarden web vault and compatible server independently
of the Esuno application accounts. It shares PostgreSQL and Caddy, but does
not require the API, Drive, ingestion or Stalwart. Vault records and metadata
are in the separate `opensuite_pass` database; attachments, signing keys and
other Vaultwarden data are in the `vaultwarden-data` volume. Attachments do not
use S3/B2. Client verification is limited to the cases and versions in the
[compatibility guide](../user/pass-clients.md); the external relay and complete
recovery process have not been verified. This integration is not a security audit.

## Enable and first administrator

1. The operator creates an A record (and AAAA only if IPv6 works) for a
   dedicated hostname such as `pass.example.org` pointing at the server. No DNS
   changes are made by Compose. Allow inbound 80 and 443, and set
   `PASS_PUBLIC_HOST=pass.example.org`
   in `.env`. Caddy obtains and renews a public certificate for the name. The
   default `pass.localhost` uses Caddy's local CA and is for local use; clients
   must trust that CA. The Pass hostname must differ from the main site. Do not
   proxy it under the SPA origin. Compose supplies Caddy's `PASS_SITE_ADDRESS` from `PASS_PUBLIC_HOST` and
   derives Vaultwarden's HTTPS `DOMAIN` from the same host; setting a separate
   `PASS_SITE_ADDRESS` in `.env` does not override this mapping.
   Pass requires `HTTPS_PORT=443`; its startup rejects another value. Set a
   non-overlapping `PASS_NETWORK_SUBNET`, `PASS_NETWORK_IP_RANGE`, and
   `PASS_CADDY_IP` together when the defaults conflict with a host network.
2. Generate a strong random admin password and keep it in a password manager.
   Generate its Argon2id PHC hash using the pinned image's interactive tool:

   ```sh
   docker run --rm -it --entrypoint /vaultwarden vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055 hash
   ```

   Place only the resulting PHC string in a protected host file outside the
   repository and `.env`, readable by container uid 1000, and set
   `PASS_ADMIN_TOKEN_FILE` to its absolute path. Restrict host access (for
   example owned by uid 1000 with mode 0400). Never put the plaintext or hash in Compose or Git. With
   the default `/dev/null` the admin interface is disabled. Recreate Pass after
   changing the file or its path. A plaintext token is refused at startup.

3. Configure SMTP as below before sending invitations. Compose expands Drive's
   required storage variables even when only Pass is started, so configure all
   `DRIVE_S3_*` values and the existing secret-file path first. Caddy also
   requires `apps/web/dist/index.html`; run `pnpm install --frozen-lockfile &&
pnpm build` as in the deployment guide. Set `COMPOSE_PROFILES=pass` in `.env`
   if ordinary upgrade commands should include Pass. Start the services:

   ```sh
   docker compose --profile pass up -d pass caddy
   docker compose --profile pass ps
   ```

   PostgreSQL, secret generation and the one-shot provisioner start as needed.
   The provisioner creates or updates the restricted role and creates the
   dedicated database if absent, including on old PostgreSQL volumes. It fails
   rather than taking over a database owned by another role. Vaultwarden runs
   its own migrations on startup. The generated database password stays in a
   read-only secret subdirectory; the entrypoint constructs `DATABASE_URL` in
   the process environment from that file, not from `.env` or command arguments.

4. The public proxy returns 404 for `/admin` and its descendants. On the server
   open `http://127.0.0.1:8081/admin/`, or use a tunnel from a trusted machine:

   ```sh
   ssh -N -L 8081:127.0.0.1:8081 operator@server.example.org
   ```

   Then open the same loopback URL locally. The listener is always bound to
   server loopback; `PASS_ADMIN_PORT` changes its port. The entire Vaultwarden
   listener is available on that loopback port, so limit host and SSH access.
   Sign in with the plaintext admin password, invite the first user and have
   them create their vault from the invitation. Ordinary signups default to
   disabled; invitations default to enabled and invitees can create accounts
   even with ordinary signups closed. `PASS_ORG_CREATION_USERS=none` disables
   organization creation; set it to a comma-separated allowlist of trusted
   email addresses when organizations are needed. Without SMTP, use Vaultwarden's
   invitation workflow as documented upstream and verify delivery/activation
   before relying on it. Vaultwarden admin settings saved in `/data/config.json`
   can override environment settings; treat that file as sensitive and verify
   signup and invitation settings after changes. On startup, Pass refuses a
   saved `signups_allowed: true`, `disable_admin_token: true`, a non-empty
   signup domain whitelist, or a saved admin token unless
   `PASS_ALLOW_SAVED_SIGNUPS=true` is set
   explicitly. The conservative check also refuses JSON Unicode escapes unless
   that override is set; inspect the file before enabling it. A change made in
   the admin interface can take effect immediately, before the next restart.

## SMTP and notifications

Pass can connect directly to the existing SES SMTP endpoint without Stalwart.
Set `PASS_SMTP_HOST`, `PASS_SMTP_PORT` (2587 for SES STARTTLS),
`PASS_SMTP_SECURITY=starttls`, `PASS_SMTP_FROM` to a verified sender and
`PASS_SMTP_USERNAME`. Put the SES SMTP password in a protected host file and set
`PASS_SMTP_SECRET_FILE` to its absolute path. Leave the host empty to disable
SMTP. Recreate Pass after changes and test an invitation with an authorized
recipient. SES sending authorization, identity, quotas and TLS must be configured
by the operator; see [outbound operations](outbound.md).

Websocket notifications pass through Caddy's reverse proxy. For optional mobile
push, obtain an installation ID and key from Bitwarden, set
`PASS_PUSH_ENABLED=true`, `PASS_PUSH_INSTALLATION_ID`, and `PASS_PUSH_KEY_FILE`
to a protected key file. The default `PASS_PUSH_RELAY_URI` and
`PASS_PUSH_IDENTITY_URI` are Bitwarden's endpoints; select the matching region
if needed. This sends notification metadata to the external relay; verify the
current upstream instructions and client behavior before enabling it.

Caddy overwrites `X-Real-IP` from the connection address; Vaultwarden trusts it
only from Caddy's `PASS_CADDY_IP` address on the dedicated Pass network. A
separate upstream proxy needs
an explicitly reviewed client-IP trust configuration. Login and admin limits
are configurable through the `PASS_*_RATELIMIT_*` settings. Caddy applies HSTS,
nosniff, no-referrer and removes `Server`; Vaultwarden provides its own CSP.
Pass uses rotated Docker JSON logs with `LOG_LEVEL=warn` and extended logging
turned off. Request lines and access-token query strings are not logged at this
level. Avoid debug or trace logging: logs can contain usernames, IP addresses
and sensitive diagnostic data. Provisioning emits fixed errors, suppresses its
SQL output and disables PostgreSQL statement logging for its session. The role
password nevertheless appears briefly in the `ALTER ROLE` query visible to
PostgreSQL administrators through activity inspection; restrict database
administration and monitoring access.

The Vaultwarden process runs as uid 1000 with a read-only root filesystem,
no added capabilities and a private writable data volume. PostgreSQL remains a
shared dependency: its superuser can access all databases and its failure can
interrupt Pass. Caddy is shared with the other sites. Pass has outbound network
access for SMTP, notifications and other upstream features; Docker network
isolation does not restrict outbound destinations. Database provisioning revokes
PUBLIC's CONNECT on other connectable databases while preserving existing login
roles' effective access and granting the Esuno application and Drive roles their
own databases. New independent roles need explicit CONNECT grants. Re-run provisioning after
creating another database: PostgreSQL grants PUBLIC access to new databases by
default, including to the Pass login until those grants are reconciled.

### Fail2ban for failed logins

As an optional additional boundary, configure fail2ban to read the Pass
container's Docker JSON log, including after container recreation and rotation.
The following `/etc/fail2ban/filter.d/opensuite-pass.conf` filter matches the
pinned Vaultwarden release's password and admin login errors:

```ini
[Definition]
failregex = ^\{"log":".*Username or password is incorrect\. Try again\. IP: <HOST>\. Username:
            ^\{"log":".*Invalid admin token\. IP: <HOST>(?:\\n|")
ignoreregex =
```

Configure a jail with the current container's `LogPath` from `docker inspect`,
appropriate `maxretry`, `findtime` and `bantime`, and an action that filters
Docker-published traffic in the host's `DOCKER-USER` chain. Update the log path
when the container is recreated; grant fail2ban access without making the logs
public. Use `fail2ban-regex` with representative sanitized log lines and verify
an actual ban from a controlled source. With another reverse proxy, review the
client-IP trust chain first; otherwise a ban can target the proxy rather than the
client. Built-in Vaultwarden rate limiting remains enabled independently.

## Backups and recovery

The scheduled Esuno restic backup captures the Pass database, stopped data
volume, generated database credential, and configured admin, SMTP and push
files with the rest of the suite. Set `BACKUP_PASS_ENABLED=1` in the protected
backup configuration and test the schedule. The vault container does not receive
backup credentials. Start with the [Pass recovery runbook](pass-recovery.md) for escrow, complete
server loss and the independent restore test. Run that test at least quarterly
and after backup, Vaultwarden, credential or storage changes; test the secondary
copy separately. [Backup operations](backup.md) covers the suite schedule and
retention. Recovery has not been verified against a real B2 account or VPS.

## Upgrade and rollback

Review upstream release notes and database migration compatibility; record the
current version and digest. Take and verify a consistent backup first. Update
the `PASS_IMAGE` version tag and multi-platform digest in `.env` after checking
GitHub releases and the official registry, then run
`docker compose --profile pass up -d pass` and check health, invitations and
client access. Database migrations run automatically and may be irreversible.
For rollback stop Pass, restore the pre-upgrade database **and** matching data
volume and secrets into an isolated environment, then set `PASS_IMAGE` to the previous
image pin. Do not point an older image at a migrated database without upstream
confirmation. Test recovery before reconnecting users.

## Esuno shell status

To enable the Pass launcher in Esuno, include the exact HTTPS vault origin in
`AUTH_PRODUCT_ORIGINS`, for example
`AUTH_PRODUCT_ORIGINS=pass=https://pass.example.org` (comma-separate existing
`drive=` and `calendar=` entries). It must match the dedicated `PASS_PUBLIC_HOST`.
The API checks the origin against `PASS_PUBLIC_HOST` at startup and refuses a mismatch. Recreate the API after changing it. Leave the entry absent when Pass is not
configured. The vault origin is not an Esuno authentication origin and does
not receive sign-in handoffs.

The API reports `GET /api/pass/status`, independently of startup and readiness.
When configured, it calls only `/alive` and `/api/config` on the public HTTPS
origin, without credentials or redirects. The API does not join the dedicated
Pass network and never forwards other vault paths. This avoids changing network
isolation or adding a proxy route; it does require public DNS and TLS to work
from the API container, so an unreachable status may also indicate a DNS, TLS or
network problem. Results (including failures) are cached for 30 seconds and
requests time out after two seconds. A missing origin is a normal disabled
state. Anonymous callers receive only enabled and reachable; the version and check time are available to authenticated sessions. The status does not verify login or client compatibility.

For client setup, version-specific evidence and manual checks, see the
[Pass client compatibility guide](../user/pass-clients.md). Run
`pnpm exec vitest run --project pass` against a local Docker Compose daemon
when changing the Pass stack or pinned CLI. Install the Playwright Chromium
build with `pnpm exec playwright install chromium` first. These tests use
disposable projects, accounts, ports and volumes; they do not establish
production recovery or audit the deployment. The CLI trusts the disposable
Caddy CA via `NODE_EXTRA_CA_CERTS`; registration pins the test certificate in
Chromium after checking its CA chain and hostname. The suite checks the known
raw API denial responses described in the compatibility guide.

## Addendum requirements and evidence

This matrix tracks the 2026-10-30 Pass addendum, not a production certification.
“Implemented” means code or a documented decision exists; it does not imply
all parts of a row work in production. The automated column names test coverage,
not a claim that every test was run for this documentation change. A dash means
no evidence or no applicable work in that column. Local tests use disposable
fixtures; recorded versions and results are in the linked guides. Manual means
a recorded human-operated verification, not a procedure awaiting execution.

| Addendum requirement                                                                               | Implemented                                                                                                                      | Verified automatically (test or recorded local result)                                                                                                                                                   | Verified manually                                                                                   | Not verified                                                                                                              | Planned                                                                                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P1/P2: mature engine, separate vault, no new cryptographic backend                                 | Official Vaultwarden, dedicated origin and database; [ADR](../adr/0003-pass.md)                                                  | `test-support/vaultwarden.pass.test.ts`: startup and migrations                                                                                                                                          | Official image S3 feature check recorded in ADR                                                     | Independent security and cryptographic audit                                                                              | Security review before production                                                              |
| P2/P8: optional Compose, configuration, credentials, health, startup and isolation from other apps | `pass` profile, dedicated role/network, health check and bootstrap                                                               | `test-support/compose.pass.test.ts`, `test-support/vaultwarden.pass.test.ts`: profiles, role, restart, health, app services stopped                                                                      | —                                                                                                   | Independence from shared PostgreSQL, Caddy or host is impossible; real deployment upgrades                                | Deployment-specific verification                                                               |
| P2/P8: HTTPS and separate DNS                                                                      | Caddy TLS and operator-created DNS; [setup](#enable-and-first-administrator)                                                     | `test-support/vaultwarden.pass.test.ts`: local proxy and headers                                                                                                                                         | —                                                                                                   | Real DNS, certificate issuance and renewal for an installation                                                            | Operator verifies public TLS                                                                   |
| P2/P8: direct SES SMTP and invitations                                                             | Optional SMTP, invitation-only defaults and loopback admin                                                                       | `test-support/bitwarden.pass.test.ts`: invitation registration in local fixture; `test-support/vaultwarden.pass.test.ts`: closed signup                                                                  | —                                                                                                   | Real SES SMTP, delivery, recovery email and quotas                                                                        | Controlled real SMTP and invitation test                                                       |
| P3: PostgreSQL records, separate credentials, no database on B2                                    | Dedicated PostgreSQL database/role and persistent volume                                                                         | `test-support/vaultwarden.pass.test.ts`: migrations, role and persistence                                                                                                                                | —                                                                                                   | Production upgrade/restore compatibility                                                                                  | Retest migrations on each upgrade                                                              |
| P3: attachments and binary storage, S3 feasibility                                                 | **Decision: local volume plus encrypted restic backups**; official image lacks S3 feature; [storage proof](pass-storage.md)      | `scripts/pass-storage-poc.mjs`: recorded LocalStack attachment/Send cases; `test-support/bitwarden.pass.test.ts`: local attachment round trip                                                            | Official-image feature check recorded in [ADR](../adr/0003-pass.md#storage-decision--phase-2-proof) | Real B2 behavior, provider outages, retention and real restore                                                            | Reconsider direct B2 only after a new decision and provider proof                              |
| P3/P9: consistent encrypted backups, retention, alerts and server-loss recovery                    | Stopped Pass volume and PostgreSQL dump, restic, schedule and alerts; [recovery](pass-recovery.md)                               | `scripts/backup-restore-drill.mjs`: local MinIO restore, keys, item and attachment; `scripts/pass-drill.sh`: failure and retry cases                                                                     | —                                                                                                   | Real B2 and independent restore on a real VPS; measured RTO                                                               | Quarterly independent drills and second-location test                                          |
| P4: client encryption, no server-side vault decryption or shared SSO unlock                        | Upstream client/vault separation; no custom vault crypto; [threat model](../architecture/pass.md)                                | `test-support/bitwarden.pass.test.ts`: plaintext fixture marker absent from sampled dump, volume and logs                                                                                                | —                                                                                                   | Comprehensive secrecy, all logging paths, client integrity and security audit                                             | Independent review and ongoing secret-handling checks                                          |
| P4: sessions, rate limits, headers and admin boundary                                              | Vaultwarden sessions/limits, Caddy headers, loopback admin and proxy trust                                                       | `test-support/vaultwarden.pass.test.ts`: public admin denial, headers and spoofed IP; `test-support/bitwarden.pass.test.ts`: login limiting                                                              | —                                                                                                   | Deployment-specific proxy chain, every attack path and audit                                                              | Validate actual public and tunneled access                                                     |
| P5: branded responsive shell, launcher and generator                                               | Shell, local generator and status; actual vault CRUD remains in bundled web vault                                                | `apps/web/test/pass.test.ts`, `e2e/pass.spec.ts`, `apps/api/test/pass-status.http.test.ts` (UI tests use fixtures)                                                                                       | —                                                                                                   | Independent XSS/security review and all real client flows                                                                 | Custom vault CRUD only after suitable client integration and review                            |
| P5: items, search, categories, vaults, TOTP, favorites, trash and sharing                          | Established web vault/client supplies secret operations; shell does not implement CRUD                                           | `test-support/bitwarden.pass.test.ts`: CLI login items, notes, cards, folders, TOTP field, favorites, trash and file Send                                                                                | —                                                                                                   | Real web-vault search, multiple vaults, strength indicators, TOTP display, secure sharing and responsive secret workflows | Run versioned manual client checks                                                             |
| P6: official browser extensions and desktop                                                        | Self-hosted endpoint and [client setup](../user/pass-clients.md)                                                                 | —                                                                                                                                                                                                        | —                                                                                                   | Chrome, Firefox, Safari and desktop login, sync and autofill                                                              | Manual tests per client and OS                                                                 |
| P6: Android and iOS, autofill, mobile push                                                         | Self-hosted endpoint; optional Bitwarden push relay                                                                              | `test-support/vaultwarden.pass.test.ts`: WebSocket upgrade only                                                                                                                                          | —                                                                                                   | Android/iOS login, sync, autofill, reconnect and mobile push                                                              | Manual tests per platform and relay                                                            |
| P5/P6: passkeys and WebAuthn 2FA                                                                   | Upstream-dependent client features, no support promise                                                                           | —                                                                                                                                                                                                        | —                                                                                                   | Item passkeys, passkey login, WebAuthn 2FA and recovery                                                                   | Test each supported client separately                                                          |
| P6/P10: browser and CLI compatibility, vault persistence and attachment round trip                 | Bundled web vault and Bitwarden-compatible endpoint                                                                              | `test-support/bitwarden.pass.test.ts`: recorded CLI 2026.9.0 login/sync, persistence, attachments and Sends; bundled web 2026.7.0 invitation registration only; [results](../user/pass-clients.md)       | —                                                                                                   | Bundled web login/sync and upgrades or other versions                                                                     | Repeat for each server/client upgrade                                                          |
| P7: alias API, keys, lifecycle and custom domains                                                  | Scoped one-time keys, verified domains, reconciliation, enable/disable and tombstones; [alias guide](../architecture/aliases.md) | `apps/api/test/aliases.http.test.ts`: ownership, keys, domains, lifecycle and reconciliation; `e2e/aliases.spec.ts`: mocked UI                                                                           | —                                                                                                   | Real client generator and real-provider mail flow                                                                         | Record actual client/provider results                                                          |
| P7: alias receipt, identification and replies                                                      | Envelope routing for managed aliases; header-based UI hint and alias sender                                                      | `e2e/aliases.spec.ts`: mocked recipient/reply UI; `apps/api/test/aliases.http.test.ts`: send guard                                                                                                       | —                                                                                                   | Bcc identification when envelope is absent from stored MIME; real SES reply and delivery                                  | Durable envelope-to-message association and provider verification                              |
| P7: disabling aliases and in-flight delivery                                                       | Removal from Stalwart; unknown recipients held for replay, operator rejection or expiry                                          | `apps/api/test/aliases.http.test.ts`: disable/re-enable and tombstone; `packages/core/test/ingestion.test.ts` and `packages/core/test/pipeline.ingest.test.ts`: generic unknown hold, reroute and expiry | —                                                                                                   | Actual disabled-alias SES flow and immediate revocation of previously resolved deliveries and static routes               | Test real-provider flow; fence in-flight and static routes if immediate revocation is required |
| P9: escrow and independent secondary backup                                                        | [Recovery procedure](pass-recovery.md) documents separately held keys and secondary copy                                         | `scripts/backup-restore-drill.mjs`: local substitute only                                                                                                                                                | —                                                                                                   | Retrieval of an actual escrow, real secondary account, immutability and independent restore                               | Operator provisions and tests both locations                                                   |
| P10: cross-user vault isolation                                                                    | Vaultwarden denies another user's item and attachment                                                                            | `test-support/bitwarden.pass.test.ts`: CLI and raw API denial                                                                                                                                            | —                                                                                                   | All upstream authorization paths and audit                                                                                | Report upstream existence oracle and retest                                                    |
| P10: unavailability and restart                                                                    | Service restart and isolated local failure cases                                                                                 | `test-support/vaultwarden.pass.test.ts`, `test-support/bitwarden.pass.test.ts`, `scripts/pass-storage-poc.mjs`                                                                                           | —                                                                                                   | Real-provider failure and production-sized recovery                                                                       | Test deployment-specific failure and recovery                                                  |
| P11: feasibility, phased approach and pinned upstream                                              | ADR, S3 proof and image digest in Compose                                                                                        | `test-support/compose.pass.test.ts`; `scripts/pass-storage-poc.mjs`                                                                                                                                      | Official image feature check in ADR                                                                 | Reproducibility of the custom proof build and future image upgrades                                                       | Review pins and release notes at each upgrade                                                  |

The cross-user test denies access, but Vaultwarden returns distinguishable 400
errors for an inaccessible item and a nonexistent one. This is an **existence
oracle** for a known or guessed item ID, including IDs known to former
organization members; it is a residual upstream risk, not a successful data
read. The [client guide](../user/pass-clients.md#server-selection-and-evidence)
records the observation and reporting status.

## Production-readiness gaps

**Pass is not production-ready until its security and recovery requirements are
verified.** The main outstanding gaps are:

- No independent security audit of the integration, shell or boundaries. A
  compromised vault origin or shared host can serve malicious client code.
- No real B2 test of the storage proof or backup/restore, and no independent
  restore drill on a real VPS. The local substitute does not establish actual
  retention, credentials, recovery time or the secondary copy.
- No recorded manual client test for browser extensions, desktop, Android or
  iOS. Autofill, passkeys, WebAuthn 2FA, mobile push, real SMTP and actual
  Bitwarden alias-generator behavior remain unverified.
- Single-server availability: a server outage or loss interrupts access;
  shared PostgreSQL and Caddy are failure and security boundaries. The shared
  PostgreSQL superuser can access the Pass database despite its separate role.
- Mobile push depends on the external Bitwarden relay and its installation
  credentials; relay availability and metadata disclosure are dependencies.
- Alias identification is a best-effort header match: Bcc may be impossible
  to identify when the envelope address is absent from stored MIME. After SES
  accepts mail to a disabled or deleted alias, an unknown recipient is held;
  re-enabling within the hold window can deliver it. Operator rejection or
  expiry does not notify the sender. Previously resolved deliveries and
  independent static routes can still deliver. See [alias limits](../architecture/aliases.md#inbound-behavior-and-limits).
- The cross-user 400 existence oracle above remains unresolved upstream.
