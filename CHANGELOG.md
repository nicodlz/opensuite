# Changelog

## Unreleased

- Added optional Esuno Pass with a digest-pinned Vaultwarden service, separate
  database, launcher and local generator, and hide-my-email aliases. Coordinated
  encrypted backup and restore tooling and local compatibility tests are included.
  Pass is not production-ready until security and recovery are verified; see
  [Pass readiness and evidence](docs/operations/pass.md#production-readiness-gaps).

## First release — unreleased

- Added the Compose baseline with Caddy, PostgreSQL, Stalwart, application API, Drive and observability, plus an optional inbound worker and local AWS substitutes.
- Added account authentication, TOTP and backup codes, mailbox provisioning and suspension, an account-scoped JMAP mail API and Mail workspace. The web client includes sign-in, MFA and session controls.
- Added Drive uploads, quota enforcement, item shares and expiring public links, an administrative domain and DNS workflow, and a setup wizard with user administration. See the [admin guide](docs/admin/index.md) for the current wizard user-creation limitation.
- Added SES integration components, storage, backup and monitoring procedures, and development and integration test projects.
- Calendar lacks invitations, reminders and sharing; Contacts remains a placeholder. Client app-password management is not exposed to users. Real-provider behavior and production recovery require validation.
