# ADR 0003: Esuno Vault

- Date: 2026-10-30
- Status: Architecture direction accepted and implemented in the optional profile; independent security review and provider/client proofs remain pending. Not a production-readiness claim.
- Scope: Optional password manager for the single-server target in [ADR 0002](0002-production-target.md). The [threat model and alias contract](../architecture/vault.md) are part of this decision.

## Decision

Run the official Vaultwarden image in the optional Compose `vault` profile. The research baseline is **1.37.4**, released 2026-10-05, with multi-platform index `vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055`. The digest is the Docker Registry manifest-list `Docker-Content-Digest` returned for that tag, not an individual architecture manifest; verify it again at implementation and pin the index. The image's [1.37.4 Dockerfile](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/docker/Dockerfile.debian) selects [bw_web_builds v2026.7.0](https://github.com/dani-garcia/bw_web_builds/releases/tag/v2026.7.0), web-vault image digest `sha256:ba8bab66d4330ab9dbafa8f245bcbe99cf6ee3f2c8ce9b5fbb10e9c49658451c`. The [server release](https://github.com/dani-garcia/vaultwarden/releases/tag/1.37.4) includes security fixes; pins need an ongoing update and regression process. Registry source: [Docker Hub image](https://hub.docker.com/r/vaultwarden/server/tags?name=1.37.4). All external sources in this ADR and the threat model were accessed **2026-10-30**, unless otherwise stated. Source inspection and a registry lookup are not an integration test.

Use PostgreSQL with a separate Vault database, role and generated credential; no SQLite fallback and no live database on B2. Vaultwarden has no startup dependency on API, Stalwart, Drive or ingest. PostgreSQL and Caddy are shared infrastructure, not isolation from their failure; Vault must remain usable through Caddy and PostgreSQL when the other application services fail. The secrets/bootstrap jobs needed to create credentials and the database may run before Vault; they must not introduce a runtime dependency on those application services. SMTP is optional and connects directly to the existing authenticated SES SMTP relay, with verified TLS, not via Stalwart. Without SMTP, invitation and recovery workflows need explicit operator testing and documentation; do not assume email-dependent features work.

Serve the web vault at `https://vault.<domain>` with its own origin, never under the SPA origin or in an iframe. Esuno's `/vault` is a branded shell for status, a local password generator, client setup, a new-tab vault launcher and alias management. The shell and Esuno API must not read, store or transmit vault secrets, master passwords or Vaultwarden tokens; the generator's result is ephemeral and never sent to Esuno services. Use a safe new-tab link (`noopener noreferrer`) and no cross-origin vault messaging. Launcher's status must not require vault credentials. A dedicated origin reduces web isolation risks but a compromised shared Caddy/host can still replace vault code.

Set `SIGNUPS_ALLOWED=false`, leave `SIGNUPS_DOMAINS_WHITELIST` empty, keep invitations available and keep the `ADMIN_TOKEN` Argon2 PHC value outside Git. Block `/admin` and its subpaths on the public site; expose operator access solely through the loopback-only HTTP listener on the server or an SSH tunnel from a trusted machine. Do not publish a bypass port. Caddy must replace any client-supplied IP header, and Vaultwarden must trust that header only from Caddy's actual proxy addresses. Verify spoofing and alternate paths, not just the happy path. Disable Esuno SSO unlock and leave Vaultwarden OIDC/SSO disabled initially. The master password is the intended key-unlock boundary, with supported recovery methods and 2FA handled by the clients. No custom extension or vault CRUD client initially: use official Bitwarden web, browser, desktop, Android, iOS and CLI clients against the self-hosted URL, subject to the compatibility gate below.

## Storage decision — Phase 2 proof

**Decision: retain the local persistent volume plus encrypted restic backups to
private B2.** Keep attachments, Sends, `config.json` and `rsa_key` local, and
back up the separate PostgreSQL database with a consistent PostgreSQL-native
dump or snapshot coordinated with the volume, configuration and keys. Retain
versions needed by backups, protect restic keys separately, alert on failures,
and restore to a clean host. The running vault need not possess backup
credentials. A second backup account or location reduces the consequences of a
single B2-account compromise. Local disk loss and changes since the last good
backup remain risks until recovery is measured.

The selected official 1.37.4 index digest is
`sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055`.
On 2026-10-30 the following command exited 1, reporting `ConfigInvalid` and
`S3 support is not enabled`:

```sh
docker run --rm -e I_REALLY_WANT_VOLATILE_STORAGE=true \
  -e DATA_FOLDER=s3://fixture/prefix -e DATABASE_URL=sqlite:///tmp/test.sqlite3 \
  vaultwarden/server@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055
```

With only `ATTACHMENTS_FOLDER=s3://fixture/prefix`, the same image started;
a disposable account and encrypted CLI attachment upload then failed with
`Error: OpenDAL`, and the server logged `S3 support is not enabled`. This is a
runtime check of the exact image, in addition to the [tagged Cargo
features](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/Cargo.toml)
and [Dockerfile](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/docker/Dockerfile.debian)
showing that S3 is an optional compile-time feature.

The proof build used upstream commit `7c188967e7a467b19b2757bc3326f9cf3ccae327`,
its Debian Dockerfile with pinned base images and `DB=postgresql,s3`. On this
linux/amd64 host, `./deploy/vaultwarden-s3-poc/build.sh` completed in 1,619
seconds; `docker image inspect` reported 88,174,562 bytes and image ID
`sha256:d4721ebf02e07961f5fd587d12238d94d09b38f419e6d80cbbc3d920c7472635`.
This is one host's image-size metric and build, not a reproducibility claim.

On 2026-10-30, `node scripts/vault-storage-poc.mjs --report /tmp/vault-storage-proof.json`
ran eight LocalStack cases successfully: setup/account, attachment round trip,
Send round trip, restart, outage, recovery/integrity, attachment deletion, and
bucket/local-data isolation. The proof used PostgreSQL 18.6, LocalStack 4.14.0,
Bitwarden CLI 2026.8.0 and the bundled web vault 2026.7.0. It generated one
8,192-byte attachment and one 6,144-byte Send at runtime. Before deletion the
bucket held exactly two objects under the run's dedicated prefix; afterward it
held only the Send. The RSA key and admin-saved `config.json` were on the local
volume. Disconnecting the S3 network while retaining vault and PostgreSQL
access caused attachment download and upload errors, but the relay was also
unavailable during the upload, so that observation did not isolate the server
failure. After reconnecting, both original files matched, the object listing was
unchanged, and no extra attachment metadata remained. Project containers and volumes were removed.
The revised runner separately proves from inside Vaultwarden that the storage
endpoint is unreachable while the LocalStack relay is available. The upload
then fails; the relay is interrupted only for the separate client download
check. After reconnecting, it checks the existing bytes and metadata and
uploads, downloads, and deletes a second 4,096-byte attachment. It also checks
that local attachment and Send directories are absent or empty and exercises
multipart-upload cleanup. Its JSON report records the tested Git SHA, worktree
state and image IDs. These are small LocalStack tests, not a B2, durability,
crash-consistency or restore proof. **B2: not run: no credentials.**

The custom build is not adopted: maintaining and securing a separate Rust
build and its dependencies, image provenance, security updates and upgrade
regression tests adds supply-chain and operational burden. Revisit the decision
if an official image ships S3 support and an authenticated B2 proof passes;
provider failures, partial operations, versioning, least privilege and a clean,
consistent database/object/key restore must also be verified. PostgreSQL is
never a live filesystem on B2. See [the evaluation runbook](../operations/vault-storage.md)
for configuration, reproduction, cleanup, costs and limitations.

## Configuration and compatibility evidence

- PostgreSQL is supported by the [tagged configuration](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/.env.template) and [database source](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/db/mod.rs). No authoritative supported-version matrix was found. The stack currently pins PostgreSQL 18.6; local startup and migrations are covered by `test-support/vaultwarden.vault.test.ts`; production upgrades and real-host restore on that version remain **unverified**. A [maintainer's older response](https://github.com/dani-garcia/vaultwarden/discussions/5073) about PostgreSQL 17 is not a guarantee for 18.
- Vaultwarden's [environment reader](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/util.rs) supports `_FILE` for settings read through it, including a complete `DATABASE_URL_FILE` and `ADMIN_TOKEN_FILE`; defining both forms fails and file content is trimmed. This is not a blanket promise for third-party library environment variables. Saved `config.json` overrides editable environment settings, so protect, inspect and back it up; enforce closed signups and other policy against effective configuration. See [config source](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/config.rs).
- The [template](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/.env.template) defaults `IP_HEADER` to `X-Real-IP` and `IP_HEADER_TRUSTED_PROXIES` to `local`; explicitly scope trusted proxies. `LOGIN_RATELIMIT_SECONDS`/`LOGIN_RATELIMIT_MAX_BURST` default to 60/10, admin equivalents 300/3, unauthenticated equivalents 60/50. These are averages and burst limits, not a substitute for perimeter controls. In 1.37.4 `X-Forwarded-For` uses the rightmost untrusted address; configure every trusted proxy correctly. Enable `ENABLE_WEBSOCKET=true` and proxy WebSocket upgrades on the main HTTP service; test notifications and reconnects. See [release notes](https://github.com/dani-garcia/vaultwarden/releases/tag/1.37.4) and [proxy guidance](https://github.com/dani-garcia/vaultwarden/wiki/Proxy-examples).
- Mobile push is optional. `PUSH_ENABLED`, `PUSH_INSTALLATION_ID` and `PUSH_INSTALLATION_KEY` use the Bitwarden push relay; obtain the installation ID and key from [bitwarden.com/host](https://bitwarden.com/host), and protect the key. This is an external service and privacy/availability dependency, not self-contained push. WebSockets and mobile push are distinct. Source: [mobile push wiki](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-Mobile-Client-push-notification) and the tagged template.
- Vaultwarden implements OIDC SSO (`SSO_ENABLED=false` by default); it is not an initial Esuno integration. Authentication and decryption are separate, and identity-provider availability, account linking and recovery would need a separate proof. See [SSO wiki](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-SSO-support-using-OpenId-Connect).
- [Passkeys stored in login items for third-party sites](https://bitwarden.com/help/storing-passkeys/) are a client capability, distinct from Vaultwarden's [WebAuthn two-factor implementation](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/api/core/two_factor/webauthn.rs). A maintainer stated [login to Vaultwarden with a passkey is unsupported](https://github.com/dani-garcia/vaultwarden/discussions/1944); current 1.37.4 behavior is **unverified** and must not be promised. WebAuthn registration has [reported client issues](https://github.com/dani-garcia/vaultwarden/issues/7387). Test item passkeys, WebAuthn 2FA, recovery and each client/platform independently.
- [1.37.0 release notes](https://github.com/dani-garcia/vaultwarden/releases/tag/1.37.0) require that release for Bitwarden clients 2026.7.0 and newer; this is not a blanket compatibility guarantee for all later versions. The [1.37.4 notes](https://github.com/dani-garcia/vaultwarden/releases/tag/1.37.4) say CLI 2026.4.2 and older cannot receive Sends and remove legacy endpoints. The [2026.8 client login regression](https://github.com/bitwarden/clients/issues/22575) illustrates protocol drift. See [client compatibility](../user/vault-clients.md) for recorded CLI and web-vault results; extensions, desktop, Android, iOS, autofill, passkeys, WebAuthn 2FA and upgrade/rollback still require verification.

## Alternatives and consequences

- **Engine:** Vaultwarden is a small, independently deployed Bitwarden-compatible server with established clients; it is an unofficial implementation and may lag client/server protocol changes. Official Bitwarden self-hosting is an alternative with a different operational footprint and licensing/feature model; other password managers would require another client ecosystem or bespoke integrations. Reimplementing a vault or cryptography is rejected.
- **Storage:** direct S3 may reduce local binary storage but adds an unproven provider and custom-build risk. Local volume plus encrypted restic is the current choice subject to the proof above; neither replaces consistent tested recovery.
- **Origin:** a path on the SPA origin or iframe would share browser origin or embedding trust with the application. A dedicated vault origin limits that exposure, at the cost of separate DNS/TLS and explicit cross-origin alias configuration.
- **SSO:** OIDC could centralize authentication but adds identity-provider and lifecycle coupling and does not remove the client encryption-key boundary. Keep it disabled until reviewed independently.
- **Custom React vault:** defer CRUD. The [internal SDK](https://github.com/bitwarden/sdk-internal/blob/c1c9b9a540510f9f8b3f4eb37c0738f510f89b98/README.md) explicitly says its password-manager interface is unsupported and unstable; the public Secrets Manager SDK is a different product. No suitable independently audited, stable integration was established. The [SDK license](https://github.com/bitwarden/sdk-internal/blob/c1c9b9a540510f9f8b3f4eb37c0738f510f89b98/LICENSE) offers GPLv3 or the SDK license by default, with `bitwarden_license` solely SDK-licensed; [clients licensing](https://github.com/bitwarden/clients/blob/desktop-v2026.10.2/LICENSE.txt) defaults to GPLv3, with the Bitwarden License in `bitwarden_license`. Review exact files, dependencies, distribution obligations and trademarks before reuse; license availability does not establish security. A future client requires a stable supported interface, threat model, compatibility tests and independent cryptographic/security review.
