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
   proxy it under the SPA origin. Caddy and Vaultwarden both derive their
   origin from `PASS_PUBLIC_HOST`, with HTTPS for the Vaultwarden `DOMAIN`.
2. Generate a strong random admin password and keep it in a password manager.
   Generate its Argon2id PHC hash using the pinned image's interactive tool:

   ```sh
   docker run --rm -it --entrypoint /vaultwarden vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055 hash
   ```

   Place only the resulting PHC string in a protected host file outside the
   repository and `.env`, readable by the container (currently root), and set
   `PASS_ADMIN_TOKEN_FILE` to its absolute path. Restrict host access (for
   example mode 0600). Never put the plaintext or hash in Compose or Git. With
   the default `/dev/null` the admin interface is disabled. Recreate Pass after
   changing the file or its path. A plaintext token is refused at startup.

3. Configure SMTP as below before sending invitations. Start the services:

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
   disabled; invitations default to enabled. Without SMTP, use Vaultwarden's
   invitation workflow as documented upstream and verify delivery/activation
   before relying on it. Vaultwarden admin settings saved in `/data/config.json`
   can override environment settings; treat that file as sensitive and verify
   signup and invitation settings after changes. On startup, Pass refuses a
   saved `signups_allowed: true` unless `PASS_ALLOW_SAVED_SIGNUPS=true` is set
   explicitly. The conservative check also refuses JSON Unicode escapes unless
   that override is set; inspect the file before enabling it. A change made in
   the admin interface can take effect immediately, before the next restart.

## SMTP and notifications

Pass can connect directly to the existing SES SMTP endpoint without Stalwart.
Set `PASS_SMTP_HOST`, `PASS_SMTP_PORT` (587 or the configured SES STARTTLS port),
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
only from Caddy's `172.28.253.2` address on the dedicated Pass network. A separate upstream proxy needs
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

**The existing scheduled Esuno backup does not capture the Pass database or
volume and does not quiesce Pass.** Set up and test a separate encrypted backup
before storing real vaults. Back up the Pass database, the complete
`vaultwarden-data` volume (including attachments, RSA keys and config), the
Pass database secret, the admin hash and any SMTP/push files together with the
image pin and configuration. Keep recovery keys independently protected and a
second backup location. Restrict access: even encrypted-vault metadata, server
keys, configuration and backup files are sensitive.

For a consistent manual capture, stop Pass to quiesce writes, dump PostgreSQL
with `pg_dump -Fc` and archive the data volume while it is stopped, using
private encrypted scratch and an encrypted backup repository. For example,
with a protected, encrypted `$PASS_BACKUP_DIR` and the default database user:

```sh
docker compose --profile pass stop pass
docker compose exec -T postgres pg_dump -U opensuite -Fc opensuite_pass > "$PASS_BACKUP_DIR/pass.dump"
docker compose --profile pass run --rm --no-deps --entrypoint tar pass -C /data -cf - . > "$PASS_BACKUP_DIR/pass-data.tar"
docker compose --profile pass start pass
```

Ensure Pass is restarted even if a capture command fails. Securely capture the
secret files separately, encrypt and upload the complete set with the chosen
backup tool, check the result, and remove scratch according to its policy. A
restore requires an isolated empty environment: restore the matching secrets,
provision the dedicated database, restore its dump with correct ownership,
restore the volume, then start the same pinned image and verify vault access,
attachments and keys before considering an upgrade. Fence the original writer.
Automated Pass backup, restore and a complete disaster recovery drill remain
open work; the commands above have not established a tested recovery procedure.

## Upgrade and rollback

Review upstream release notes and database migration compatibility; record the
current version and digest. Take and verify a consistent backup first. Update
both the version tag and multi-platform digest in `compose.yaml` after checking
GitHub releases and the official registry, then run
`docker compose --profile pass up -d pass` and check health, invitations and
client access. Database migrations run automatically and may be irreversible.
For rollback stop Pass, restore the pre-upgrade database **and** matching data
volume and secrets into an isolated environment, then restore the previous
image pin. Do not point an older image at a migrated database without upstream
confirmation. Test recovery before reconnecting users.

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
