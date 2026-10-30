# Changelog

## Unreleased

- Show a locally generated authenticator setup QR code and manual secret, and allow password-confirmed backup-code regeneration.
- Add an audited operator reset for locked-out TOTP accounts and optional Vault Yubico OTP configuration.

- Pass renamed to Vault. The internal Compose network key stays `pass-network`, so upgrading an existing installation keeps the existing network and does not recreate PostgreSQL; Caddy and the API are recreated for their renamed variables (a short HTTP interruption). An unused `pass-database/` directory created by the previous release in the `secrets` volume can be deleted.

- Added optional Esuno Vault with a digest-pinned Vaultwarden service, separate
  database, launcher and local generator, and hide-my-email aliases. Coordinated
  encrypted backup and restore tooling and local compatibility tests are included.
  Vault is not production-ready until security and recovery are verified; see
  [Vault readiness and evidence](docs/operations/vault.md#production-readiness-gaps).

## First release — unreleased

- Added the Compose baseline with Caddy, PostgreSQL, Stalwart, application API, Drive and observability, plus an optional inbound worker and local AWS substitutes.
- Added account authentication, TOTP and backup codes, mailbox provisioning and suspension, an account-scoped JMAP mail API and Mail workspace. The web client includes sign-in, MFA and session controls.
- Added Drive uploads, quota enforcement, item shares and expiring public links, an administrative domain and DNS workflow, and a setup wizard with user administration. See the [admin guide](docs/admin/index.md) for the current wizard user-creation limitation.
- Added SES integration components, storage, backup and monitoring procedures, and development and integration test projects.
- Calendar lacks invitations, reminders and sharing; Contacts remains a placeholder. Client app-password management is not exposed to users. Real-provider behavior and production recovery require validation.
