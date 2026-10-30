# Changelog

## First release — unreleased

- Added the Compose baseline with Caddy, PostgreSQL, Stalwart, application API, Drive and observability, plus an optional inbound worker and local AWS substitutes.
- Added account authentication, TOTP and backup codes, mailbox provisioning and suspension, an account-scoped JMAP mail API and Mail workspace. The sign-in, MFA and session interface is on `om-web-fix` and has not yet been merged into this checkout.
- Added Drive uploads, quota enforcement, item shares and expiring public links, an administrative domain and DNS workflow, and a setup wizard with user administration. See the [admin guide](docs/admin/index.md) for the current wizard user-creation limitation.
- Added SES integration components, storage, backup and monitoring procedures, and development and integration test projects.
- Calendar and Contacts web pages remain placeholders; client app-password management is not exposed to users. Real-provider behavior and production recovery require validation.
