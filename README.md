# OpenSuite

OpenSuite is a self-hosted mail and file suite, intended as an alternative to hosted mail, calendar and Drive services. It combines a web workspace and application API with the Stalwart mail server, PostgreSQL and S3-compatible storage.

## Release status

This first release is an early, single-server baseline. The repository contains:

- A mail workspace and authenticated mail API for conversations, drafts, attachments, folders and search, backed by Stalwart JMAP.
- A separate Drive service and workspace for uploads, files, item sharing and expiring public links.
- Authentication, TOTP and backup-code support, account provisioning and suspension, and an administrator domain/DNS workflow.
- A Compose stack, optional inbound worker, SES relay and domain adapters, backups and monitoring tools. Provider integrations and production recovery need the validation described in the operator guides.

The **calendar and contacts web pages are placeholders**; authenticated DAV interoperability is not established. The current web client has no sign-in, MFA, user administration, setup-wizard or client app-password screens. Authentication APIs exist, but the standard Compose provisioning configuration and outbound management procedure need the fixes described in [development](docs/development.md#authentication-and-mailbox-provisioning) and [outbound operations](docs/operations/outbound.md#apply). Follow the [user guide](docs/user/index.md) for the resulting limits. The Vite development server uses synthetic mail and Drive data, not a real account. No zero-access or end-to-end encryption is claimed.

## Start here

- [Documentation map](docs/index.md)
- [User guide](docs/user/index.md) and [administrator guide](docs/admin/index.md)
- [Local development and installation](docs/development.md); [production deployment runbook](docs/deployment/production.md) (being prepared separately)
- [Architecture and security](docs/architecture/overview.md)
- [Operations](docs/index.md#operations-and-deployment), [contributing](CONTRIBUTING.md), and [changelog](CHANGELOG.md)

The production runbook is being developed in parallel and may not exist in this checkout yet. For development, Node.js 22.18 or later, pnpm 12, Docker and Compose are required. Follow the local guide rather than assuming a bare `docker compose up` completes mail bootstrap.

## Repository

`apps/api`, `apps/web`, `apps/drive`, `apps/ingest` and `apps/observe` contain the services and client. Shared contracts, domain services, database code, JMAP adapters and configuration live under `packages/`. Compose configuration is in `compose.yaml`; operator assets are in `deploy/`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
