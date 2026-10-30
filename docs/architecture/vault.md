# Esuno Vault: threat model and alias design

Date: 2026-10-30. This threat model describes the design and its residual risks, not evidence of deployment or a security guarantee. **Nothing in this design or its implementation has been independently audited.** External sources below were accessed 2026-10-30. [ADR 0003](../adr/0003-vault.md) records the engine and storage decision; [Vault operations](../operations/vault.md#addendum-requirements-and-evidence) tracks implementation and evidence.

## Assets, actors and flows

Assets include vault item plaintext, master passwords, derived keys and 2FA recovery material on clients; encrypted vault records, attachments and Sends; authentication verifiers and session tokens; the server signing key, admin credential, PostgreSQL and SMTP credentials; alias keys, mappings and mail metadata; and backup snapshots and encryption keys. Actors include vault users, recipients and correspondents, authenticated alias users, operators, compromised or malicious clients, external attackers, hosting and relay providers, and an attacker with control of the B2 account. Users and operators are not interchangeable trust roles.

The browser extension, mobile/desktop app, CLI or web vault talks over TLS to Caddy and Vaultwarden on the dedicated Vault origin. Compatible clients perform vault encryption and decryption locally, then send encrypted item data and authentication material to Vaultwarden; it persists data in the dedicated PostgreSQL database and local volume. The web vault code is itself delivered by the server: a compromised server, Caddy, DNS/TLS path, supply chain or vault origin can serve malicious JavaScript that steals secrets at unlock. Server compromise also exposes authentication verifiers, ciphertext, user/device information and traffic metadata; it is not equivalent to a zero-knowledge guarantee against a malicious server. Attachment/Send content is client-encrypted where the relevant client protocol does so, but filenames, sizes, timing and other metadata may be visible. Never claim all metadata is encrypted. See Bitwarden's [encryption overview](https://bitwarden.com/help/what-encryption-is-used/) and [security white paper](https://bitwarden.com/help/bitwarden-security-white-paper/).

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
