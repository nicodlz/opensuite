# Esuno Vault: threat model and alias design

Date: 2026-10-30. This threat model describes the design and its residual risks, not evidence of deployment or a security guarantee. **Nothing in this design or its implementation has been independently audited.** External sources below were accessed 2026-10-30. [ADR 0003](../adr/0003-vault.md) records the engine and storage decision; [Vault operations](../operations/vault.md#addendum-requirements-and-evidence) tracks implementation and evidence.

## Assets, actors and flows

Assets include vault item plaintext, master passwords, derived keys and 2FA recovery material on clients; encrypted vault records, attachments and Sends; authentication verifiers and session tokens; the server signing key, admin credential, PostgreSQL and SMTP credentials; alias keys, mappings and mail metadata; and backup snapshots and encryption keys. Actors include vault users, recipients and correspondents, authenticated alias users, operators, compromised or malicious clients, external attackers, hosting and relay providers, and an attacker with control of the B2 account. Users and operators are not interchangeable trust roles.

The browser extension, mobile/desktop app, CLI or web vault talks over TLS to Caddy and Vaultwarden on the dedicated Vault origin. Compatible clients perform vault encryption and decryption locally, then send encrypted item data and authentication material to Vaultwarden; it persists data in the dedicated PostgreSQL database and local volume. The web vault code is itself delivered by the server: a compromised server, Caddy, DNS/TLS path, supply chain or vault origin can serve malicious JavaScript that steals secrets at unlock. Server compromise also exposes authentication verifiers, ciphertext, user/device information and traffic metadata; it is not equivalent to a zero-knowledge guarantee against a malicious server. Attachment/Send content is client-encrypted where the relevant client protocol does so, but filenames, sizes, timing and other metadata may be visible. Never claim all metadata is encrypted. See Bitwarden's [encryption overview](https://bitwarden.com/help/what-encryption-is-used/) and [security white paper](https://bitwarden.com/help/bitwarden-security-white-paper/).

The official web vault is themed with Vaultwarden's `TEMPLATES_FOLDER/scss/user.vaultwarden.scss.hbs` partial, appended to the built-in rules. Caddy serves the small read-only set of replacement images so it can give them revalidation headers and versioned URLs without mounting over files in the hardened Vault container. The shell is generated from the pinned image solely to change its initial title, manifest and icon URLs; Caddy first obtains and preserves Vaultwarden's response security headers. The client JavaScript still changes the tab title and contains Bitwarden/Vaultwarden text, including the landing logo's accessibility label and license and attribution material; those strings are not rewritten. Branding uses system fonts and makes no external font request. Existing bookmarks to an unversioned image can retain an older cached copy until that cache expires.

After every Vaultwarden image update, inspect the new bundle, default SCSS and email templates, update the image digest in `scripts/generate-vault-brand.mjs` and Compose, regenerate with `node scripts/generate-vault-brand.mjs`, review the generated shell and image paths, and rerun the Vault integration tests. Do not reuse the old generated shell with a different client image: its JavaScript and stylesheet names are version-specific. Template overrides are loaded at startup by default, so restart the `vault` container after changing them; saved admin settings take precedence over Compose and must retain `SMTP_EMBED_IMAGES=false`, `SMTP_FROM_NAME=Esuno Vault` and `INVITATION_ORG_NAME=Esuno Vault`.

The mail header uses the publicly served Esuno PNG on the vault origin: the default inline CID images are compiled into Vaultwarden and cannot be replaced through `TEMPLATES_FOLDER`, while a PNG has broad mail-client support and needs no third-party host. The prefix `{{img_src}}../` resolves from Vaultwarden's `/vw_static/` prefix to `/esuno-vault/images/`; clients that block remote images still show the alt text. Upstream inline button styles are recolored by the header's CSS where supported; clients that discard embedded CSS may retain the upstream button color.

### Pinned email template inventory

The image identifies itself as Vaultwarden 1.37.4, revision `7c188967e7a467b19b2757bc3326f9cf3ccae327`; its templates are compiled into the binary. The following inventory was checked against that exact revision's `src/static/templates/email` and `mail.rs`. Each named message has both `.hbs` (text) and `.html.hbs` variants; the three additional partials are `email_header`, `email_footer` and `email_footer_text`. The common header uses `img_src`; the table lists the other variables referenced by either variant, including conditions. Variables such as `url` are supplied with different values for different messages and must not be rewritten.

| Message                                                                             | Referenced variables                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `admin_account_recovery`                                                            | `user_name`, `org_name`, `reset_password`, `reset_2fa`, `fallback_2fa_email` |
| `change_email`                                                                      | `token`                                                                      |
| `change_email_existing`                                                             | `acting_address`, `existing_address`                                         |
| `change_email_invited`                                                              | `acting_address`, `existing_address`, `url`                                  |
| `delete_account`                                                                    | `email`, `token`, `url`, `user_id`                                           |
| `emergency_access_invite_accepted`                                                  | `grantee_email`, `url`                                                       |
| `emergency_access_invite_confirmed`, `emergency_access_recovery_approved`           | `grantor_name`, `url`                                                        |
| `emergency_access_recovery_initiated`                                               | `atype`, `grantee_name`, `url`, `wait_time_days`                             |
| `emergency_access_recovery_rejected`                                                | `grantor_name`                                                               |
| `emergency_access_recovery_reminder`                                                | `atype`, `days_left`, `grantee_name`, `url`                                  |
| `emergency_access_recovery_timed_out`                                               | `atype`, `grantee_name`, `url`                                               |
| `incomplete_2fa_login`                                                              | `datetime`, `device_name`, `device_type`, `ip`, `time_limit`                 |
| `invite_accepted`                                                                   | `email`, `org_name`, `url`                                                   |
| `invite_confirmed`                                                                  | `org_name`, `url`                                                            |
| `new_device_logged_in`                                                              | `datetime`, `device_name`, `device_type`, `ip`, `url`                        |
| `protected_action`, `twofactor_email`                                               | `token`                                                                      |
| `pw_hint_none`, `register_verify_email`, `smtp_test`, `sso_change_email`, `welcome` | `url`                                                                        |
| `pw_hint_some`                                                                      | `hint`, `url`                                                                |
| `recover_twofactor`                                                                 | `datetime`, `ip`                                                             |
| `send_2fa_removed_from_org`, `send_single_org_removed_from_org`                     | `org_name`                                                                   |
| `send_emergency_access_invite`                                                      | `grantor_name`, `url`                                                        |
| `send_org_invite`                                                                   | `org_name`, `url`                                                            |
| `verify_email`, `welcome_must_verify`                                               | `token`, `url`, `user_id`                                                    |

Only the three partials and both variants of `change_email_invited`, `invite_accepted`, `invite_confirmed`, `protected_action`, `smtp_test` and `twofactor_email` are overridden. Their upstream variables and links are retained. The real SMTP invitation test exercises the upstream invitation templates with these partials and follows the received link with signups disabled.

The Esuno SPA and API do not receive vault master passwords, unlocked keys, decrypted items or Vaultwarden session tokens by design. Vaultwarden does receive password-derived authentication material, ciphertext and operational metadata; the password itself is not intentionally transmitted. Do not log secrets, API keys, authentication headers, vault data or unencrypted exports in logs, telemetry, fixtures or error reports. A compromised endpoint or client can still expose plaintext, clipboard contents and autofill; phishing, malicious extensions, weak or reused master passwords and poor recovery handling remain risks. Encourage strong unique master passwords, separately protected recovery information and supported 2FA; loss of the master password or necessary recovery material can make vault data unrecoverable; do not claim rate limiting prevents offline attacks on stolen ciphertext.

The SPA shell uses its own Better Auth session for Esuno functions, including alias management; it never uses that session to unlock the vault. Its generator runs locally and keeps generated values only in memory until dismissed, without analytics or API calls. It must avoid XSS, unsafe HTML, third-party scripts and unsafe storage. Opening the vault in a new tab isolates ordinary DOM and origin storage, not the shared host, browser, same-site cookie exposure or DNS. Use host-only cookies (`__Host-` where applicable), no `Domain` cookies, restrictive CSP and frame ancestors, and carefully review service workers, CORS and redirects. A compromised sibling origin can still conduct same-site attacks: enforce CSRF protection and origin checks on cookie-authenticated operations. Automated shell and navigation checks cover some boundaries; independent review remains necessary.

## Administrative and infrastructure boundaries

Only Caddy serves the public vault; deny `/admin`, `/admin/` and all subpaths before proxying, including encoded and normalized path variations. No public container port or alternative public proxy may bypass the rule. Operator access is through a localhost-only listener or SSH tunnel with host/HTTPS handling validated end to end, and a separate strong admin password verified against the Argon2 PHC `ADMIN_TOKEN`. Keep the PHC and plaintext password outside Git; protect local files and sessions. Caddy overwrites the configured client IP header, and Vaultwarden trusts only the actual Caddy addresses. Test forged headers from outside and untrusted containers, admin routes, rate limits and proxy changes. The admin panel can change effective configuration, including security settings; `config.json` overrides environment values, so inspect effective configuration and restrict who can modify it. An admin or host compromise remains highly privileged.

The vault service only needs its database role, local volume and optional outbound SMTP credentials; do not share application, Drive, mail or backup credentials. Caddy and PostgreSQL are shared failure domains, as are the VPS, network and operator. Neither a healthy SPA nor API health proves vault usability. Local Compose tests cover startup, migrations, isolation, restarts, health and operation while API, Stalwart, Drive and ingest are stopped; see the [evidence matrix](../operations/vault.md#addendum-requirements-and-evidence). SMTP outage affects invitation/recovery emails and any enabled email-based workflows; an established offline client may retain a cached vault, but offline availability is client-specific and must be tested.

Backups contain a consistent PostgreSQL snapshot, attachment/Send volume, configuration and signing keys. Encrypt with restic before B2 upload, separately protect and recover its key, limit B2 credentials, monitor retention and test restoration to an isolated clean host. Coordinate the database and objects, including deletes, so retained snapshots do not point at missing or later versions. A B2-account attacker may read encrypted snapshots and metadata, delete or roll them back, or disrupt recovery; encryption cannot ensure availability or freshness. Use immutability/versioning where supported and a separately administered second backup account or offline location, and test independent key and backup recovery. Host compromise may access plaintext configuration, keys and currently mounted credentials; backup encryption is not protection against that attacker. The local recovery drill covers a substitute; real-provider recovery and a measured recovery time remain open.

## Alias lifecycle and mail boundaries

Aliases are mail features, not vault records. The API accepts an Esuno session
for management or a separate, high-entropy, per-user key for the limited
username-generator endpoint. A stolen key can create aliases until revoked and
may reveal website context; it cannot read vault contents. Website and note
metadata can disclose account associations. See the canonical [alias design and
API contract](aliases.md) for key storage, authorization, lifecycle and CORS.

Provisioning and deletion are reconciled across PostgreSQL and Stalwart; they
are not an atomic transaction with SES or ingestion. The UI identifies aliases
from stored recipient headers on a best-effort basis. It cannot always identify
Bcc from the stored MIME. Disabling an alias removes its managed route. After
SES acceptance, newly unknown recipients are held for replay; re-enabling the
alias and replaying within the hold window can deliver held mail. Operator
rejection or expiry does not bounce the sender. Previously resolved deliveries
or independent static routes may still deliver. Alias identities and outbound
mail are locally tested, but real SES relay behavior is unverified. Replies can expose
primary addresses through headers, quoted text or other metadata. See [alias
inbound behavior and limits](aliases.md#inbound-behavior-and-limits) for details.

The compatibility endpoint accepts the alias key, not a session cookie. CORS
allows any origin only for this key-authenticated endpoint and does not allow
credentials; CORS is not authentication. The [Bitwarden setup](aliases.md#api-and-bitwarden)
uses the Esuno origin, not the vault origin. The client may retain the key and
send a website hostname to the API. Real client compatibility remains unverified.
