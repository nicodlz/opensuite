# Administrator guide

The administrator manages users and mail domains; the host operator also controls deployment, credentials, DNS and provider accounts. Start with [local installation](../development.md) or the [production runbook](../deployment/production.md), which is being prepared in parallel and may not yet be present in this checkout.

## Setup wizard and first administrator

A setup wizard is being developed separately and is not present in this checkout. See the production runbook for its deployment and setup procedure when available. Until then, the API has a bootstrap command for the first administrator, but **normal Compose currently supplies the recovery administrator credential while normal Stalwart does not activate it**. Consequently mailbox provisioning and bootstrap cannot be assumed to succeed with the stock stack. See [authentication and provisioning](../development.md#authentication-and-mailbox-provisioning) and the production runbook for the corrected integration; do not expose or leave the recovery override running as a workaround.

Set the public HTTPS host and `MAIL_DOMAIN` before provisioning. New account addresses must use that domain. The bootstrap command in the development guide creates or promotes an account; it does not change an existing password. Restrict access to Docker and the password file.

## Users

There is no user management screen in this checkout. An authenticated administrator can create an account through `POST /api/auth/sign-up/email` with `name`, `email` and `password`, using the administrator's session and the configured Origin. Verify ownership out of band and transmit the initial password securely. Public registration is disabled; passwords require at least 12 characters. Provisioning creates a mailbox and an application-owned credential. A session is issued only after the mailbox link is active. If provisioning fails after user creation, inspect the API logs and reconciliation state before retrying. The API retries pending provisioning at startup and approximately once a minute; run only one API instance because its locks and limits are process-local.

`GET /api/admin/accounts` lists accounts for an authenticated administrator. The current web app has no sign-in or MFA screen; see the [user guide](../user/index.md#signing-in-and-mfa) for the API session flow.

## Domains and DNS

The **Domains** page lets an administrator add a domain, copy the displayed records and select **Recheck DNS**. The domain provider is disabled by default and its API environment and credentials must be supplied separately; the stock Compose API service does not pass the `DOMAINS_*` variables through. Follow [domain operations](../operations/domains.md) for the provider prerequisites, SES rule, DNS records, rechecks and rollback. Publish DNS at your provider; the application does not write it. Merge SPF with any existing policy, and test inbound, outbound and rollback before changing production MX. A verified DNS status is not proof of end-to-end delivery.

## Outbound and SES status

A submitted message enters Stalwart's queue; SES acceptance is not final delivery. Check the queue, bounces, complaints, sending identity verification, sandbox restrictions and actual SES quotas separately. Follow [outbound operations](../operations/outbound.md) for relay settings and the current management-access limitation. No real SES integration is established by the local tests.

## Suspend a mailbox

An administrator can call `POST /api/admin/accounts/{userId}/disable` with an authenticated session and the configured Origin. Obtain the user ID from the account list; this is not an email address. An administrator cannot disable their own account or the last enabled administrator. Disabling removes application sessions and marks the user disabled; Stalwart mailbox suspension is attempted and retried by reconciliation on failure. Suspension disables authentication, receiving and sending permissions; this disable flow does not delete app passwords. Check the API logs and Stalwart state to confirm completion, especially before assuming direct protocol access is blocked. The API does not expose a re-enable operation in this checkout. Plan recovery with the operator and do not delete mailbox data as a substitute for suspension.
