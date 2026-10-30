# Administrator guide

The administrator manages users and mail domains; the host operator also controls deployment, credentials, DNS and provider accounts. Start with [local installation](../development.md) or the [production runbook](../deployment/production.md).

## Setup wizard and first administrator

First bootstrap the private Stalwart management account and create the first administrator using the [production runbook](../deployment/production.md#first-administrator) or [development guide](../development.md#authentication-and-mailbox-provisioning). There is no automatic first administrator. The bootstrap command creates or promotes an enabled account in `MAIL_DOMAIN`; it does not change an existing password. Protect Docker access and the password file.

With an administrator session, open **Setup wizard** at `/setup`. The wizard offers five steps:

1. **System check** shows API, database, Stalwart, Drive, Drive object storage, relay configuration and backup marker status. A marker does not verify a restore; check mail blob storage separately.
2. **Mail domain** adds a domain, displays DNS records for manual publication and rechecks them. Register the administrator address for inbound routing when offered.
3. **Outbound relay** shows stored relay and DKIM status and can submit a test message. Configure the relay with the operator procedure and independently confirm delivery.
4. **Create users** provides a form for email, display name and initial password. The address must use `MAIL_DOMAIN`, and that managed domain must already be added.
5. **Finish** summarizes the checks and links to Mail, Drive and operating guides. Unknown and pending checks need investigation; completing the wizard does not prove production readiness.

The wizard requires an existing administrator session. See the [user guide](../user/index.md#signing-in-and-mfa) for sign-in and MFA. Vite development uses synthetic setup data.

## Users

Public registration is disabled. The wizard includes user creation, but **the current production path calls the public sign-up handler with sign-up disabled**; its route tests use a mock identity handler. Do not assume the form successfully creates users until this integration is corrected and tested. An authenticated administrator can use `POST /api/auth/sign-up/email` with `name`, `email` and `password`, their session and the configured Origin. Verify ownership out of band and transmit the initial password securely. The wizard's form accepts 12–128 characters; the authentication service requires at least 12. The direct sign-up API does not perform the wizard's separate inbound-address registration. Inbound routing reaches the account's primary address without registration when the worker has the mailbox key; registering it with `POST /api/admin/domains/{domainId}/addresses` (the account's `userId`, its `localPart` and `isAlias: false`) still reserves it in a managed domain. See [domain operations](../operations/domains.md) and [ingestion](../architecture/ingestion.md) for destination credentials and routing.

Provisioning creates a mailbox and an application-owned credential. A session is issued only after the mailbox link is active. If creation fails, inspect the API logs, existing account and reconciliation state before retrying. The API retries pending provisioning at startup and approximately once a minute; run only one API instance because its locks and limits are process-local. `GET /api/admin/accounts` lists accounts for an authenticated administrator.

## Domains and DNS

The **Domains** page lets an administrator add a domain, copy the displayed records and select **Recheck DNS**. The domain provider is disabled by default and its API environment and credentials must be supplied separately; the stock Compose API service does not pass the `DOMAINS_*` variables through. Follow [domain operations](../operations/domains.md) for the provider prerequisites, SES rule, DNS records, rechecks and rollback. Publish DNS at your provider; the application does not write it. Merge SPF with any existing policy, and test inbound, outbound and rollback before changing production MX. A verified DNS status is not proof of end-to-end delivery.

## Outbound and SES status

A submitted message enters Stalwart's queue; SES acceptance is not final delivery. Check the queue, bounces, complaints, sending identity verification, sandbox restrictions and actual SES quotas separately. Follow [outbound operations](../operations/outbound.md) for relay configuration and rollback. No real SES integration is established by the local tests.

## Suspend a mailbox

An administrator can call `POST /api/admin/accounts/{userId}/disable` with an authenticated session and the configured Origin. Obtain the user ID from the account list; this is not an email address. An administrator cannot disable their own account or the last enabled administrator. Disabling removes application sessions and marks the user disabled; Stalwart mailbox suspension is attempted and retried by reconciliation on failure. Suspension disables authentication, receiving and sending permissions; this disable flow does not delete app passwords. Check the API logs and Stalwart state to confirm completion, especially before assuming direct protocol access is blocked. The API does not expose a re-enable operation in this checkout. Plan recovery with the operator and do not delete mailbox data as a substitute for suspension.
