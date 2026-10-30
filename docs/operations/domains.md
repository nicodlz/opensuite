# Managing mail domains

Domain management is an administrative operation and requires an authenticated administrator. Configure the API authentication and mailbox provisioning described in the [development guide](../development.md), and test inbound delivery before production use. Do not use the development web client's synthetic domains as operational data.

## Ownership and infrastructure changes

For now, one infrastructure operator owns the entire SES receipt rule, including
recipients, through OpenTofu. Both rule resources declare recipients without
ignoring changes, so a plan shows drift. Review plans and serialize changes;
never let multiple states or out-of-band tools manage the same rule. The
operator separately manages SES identities and their verification. The API's
opt-in adoption mode is read-only with respect to SES and Stalwart domains: it
accepts only approved, already verified and configured domains. It does not
create an identity, request verification, or alter a receipt rule. New SES
domains and recipients remain an operator task.

The service checks the configured rule name in the **active** SES rule set. The
module's Esuno set is not activated by this configuration. Verify the active
set, recipients and S3/SNS actions before using adoption. Coordinate sending
policy changes with `esuno_sending_domains`. See the
[account adoption procedure](../deployment/aws.md#adopting-an-existing-account)
before any apply.

A future dynamic workflow requires a separate trusted intermediary, isolated
from the exposed API and independently validating domain authorization, fixed
rule, nonempty recipients and unchanged actions, TLS and status. It needs a
single writer, shared lock, before/after verification, audit and alerting. SES
has no conditional rule update, so a lock cannot guard against administrators or
other tools writing outside the protocol; prohibit concurrent writers and detect
drift. Its own update permission would still require `Resource: "*"`; its
security depends on isolation and its code. Require security review and targeted
real-environment tests before activation. A component in the API process or
container is not this boundary.

## Prepare

Record existing DNS and routes, TTLs and rollback steps. SES receiving and the
adapter use `eu-north-1`. Configure an enabled rule in the active set with a
nonempty recipient list and S3/SNS actions. The operator must approve the exact
domains before adoption, ensure the SES identity is verified and has Easy DKIM
and a legacy verification token, and ensure Stalwart already has that domain
and active DKIM records. Missing prerequisites fail adoption; the API does not
repair them remotely.

The provider is off by default. Compose passes the optional `DOMAINS_*` settings
from `deploy/env.example` to the API. Set `DOMAINS_SES_ENABLED=true`,
`DOMAINS_SES_MODE=adopt`, `DOMAINS_ADOPT_DOMAINS` (comma-separated exact approved
domains), `DOMAINS_SES_RULE_SET`, `DOMAINS_SES_RULE`, `DOMAINS_STALWART_ORIGIN`,
`DOMAINS_STALWART_USER`, and `DOMAINS_STALWART_PASSWORD_FILE`. The generated management password is already
mounted at `/run/opensuite/stalwart-management/password`; the standard
management origin is `http://stalwart-management:8080` and the bootstrapped
username is `management@opensuite.internal`. The password file must be readable
by the API and must not be committed or logged. Set
`DOMAINS_SES_CREDENTIALS_FILE` to an absolute host path to a protected JSON file
readable by container uid 1000. It must contain `accessKeyId` and
`secretAccessKey`, with optional `sessionToken`; do not place their values in
`.env`, Git, or command output. Compose mounts the file read-only. The normal
AWS SDK credential chain is used if the file path is unset. The credentials must
be separate from the sending and ingestion credentials. Set
`DOMAINS_SES_ENDPOINT` only for isolated local substitutes, not AWS.

The opt-in IAM principal in the AWS module grants `ses:GetEmailIdentity` only
for the approved identity ARNs. `ses:GetIdentityVerificationAttributes`,
`ses:DescribeActiveReceiptRuleSet`, and `ses:DescribeReceiptRule` require
`Resource: "*"`; the policy limits them to the configured AWS region, not a
particular domain or rule. These reads can reveal metadata for other identities
or receipt rules in that region. It grants no SES writes, `iam:PassRole`, or
S3, SNS or SQS permissions. The app calls no identity creation, verification or
receipt-rule update API. [AWS's service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html)
lists no resource-level scope for the SES v1 rule or verification operations;
an ARN-scoped grant would not work. Simply starting the API with the provider
disabled creates no SES client and makes no SES requests.

Apply migrations before startup. The migration creates case-insensitive unique indexes on domain names and addresses; if existing names collide by case, migration fails deliberately. Resolve those collisions with the owners before retrying. A domain is associated with the administrator who added it; addresses may belong to other users with active mailbox links. The primary address must match the linked mailbox. An alias is added to that mailbox in Stalwart. Ingestion resolves stored addresses and each mailbox's primary address case-insensitively and delivers with the mailbox's stored credential (see [ingestion](../architecture/ingestion.md)); a worker without the mailbox key needs a matching `INGEST_DESTINATIONS` entry and credential for each mailbox account ID instead. Coordinate address reassignment with the ingestion ledger and pending archive replay: replay resolves recipients using current routing, so reconcile older unprocessed messages before changing a destination.

## Add and verify

The operator first prepares and verifies the SES identity, receiving recipient,
Stalwart domain and DNS. The API then reads those prerequisites and checks all
of the following before creating its own domain row: SES verification and Easy
DKIM tokens; an existing legacy `_amazonses` TXT verification token; the enabled
rule's exact nonempty recipient; Stalwart's existing domain and active DKIM;
and matching MX, SPF, DMARC, SES and Stalwart DKIM and verification TXT records.
A missing token is an error: the API does not call `VerifyDomainIdentity` as a
fallback. An identity verified through DKIM can lack a legacy token; in that
case coordinate a separate operator-owned verification workflow before adoption.
DNS checks require a matching token but do not themselves create any record.

On success the service stores a verified domain. Recheck and the hourly job also
recheck SES, the rule and DNS; a failing check marks it failing and removes it
from the eligible alias domains. The job runs under the active administrator who
added it. These checks do not prove end-to-end mail delivery or recovery; test
those separately. If a database write fails after preflight, inspect the row and
use Recheck where applicable before retrying. Only an operator changes DNS.

## Adopt the existing Esuno domain

After the read-only IAM principal and all prerequisites are in place, an operator can
adopt `esuno.net` without inserting database rows or recreating the existing SES
identity or receipt rule:

1. Confirm the active regional rule contains `esuno.net`, is enabled and has the
   expected S3/SNS actions. Confirm the existing SES identity and Easy DKIM,
   Stalwart management connectivity, and the intended SES permissions. In the
   private deployment `.env`, set `DOMAINS_SES_ENABLED=true`, the actual
   `DOMAINS_SES_RULE`, `DOMAINS_SES_RULE_SET`, `DOMAINS_SES_MODE=adopt`,
   `DOMAINS_ADOPT_DOMAINS=esuno.net`, the Stalwart origin and user above, and
   `DOMAINS_STALWART_PASSWORD_FILE=/run/opensuite/stalwart-management/password`.
   Set `DOMAINS_SES_CREDENTIALS_FILE` to the host path of the protected JSON
   credentials file. Leave the endpoint empty for AWS.
2. Recreate the API using the deployment's normal Compose command, for example
   `docker compose up -d --no-deps --force-recreate api`. Check its logs for
   startup failures without exposing credentials.
3. Before adding, publish and verify all required records as described above.
   Confirm that SES returns a legacy verification token and that the exact
   `_amazonses` TXT matches it. If it has no token or a DNS or receipt
   prerequisite is missing, stop: adoption fails without creating the domain
   row or changing SES or Stalwart.
4. As an authenticated administrator, add `esuno.net` in the Domains admin
   page, or POST `{"name":"esuno.net"}` to `/api/admin/domains`. The service
   reads the existing SES identity and receipt rule and the existing Stalwart
   domain; it creates the local domain row only after checks pass. Confirm the
   status is `verified` and authenticated `GET /api/aliases/domains` lists it.
   If a database save fails after creation, inspect the pending row and use
   Recheck before retrying. No manual database insertion is needed.
5. Signed in as the owner, choose `esuno.net` under **Default alias domain** on
   the Aliases page. Alternatively, `PUT /api/aliases/default-domain` with the
   verified domain's ID as `{"domainId":"<id>"}`. Confirm the selected default.

## Removal and recovery

Remove addresses and aliases first. Removing a managed alias deletes it from Stalwart and its routing row; removing a primary address removes its address row but leaves the mailbox intact, and mail to it keeps arriving through the mailbox's own primary address. To stop inbound mail, disable the account. In adoption mode removing a domain through this service fails closed because it cannot change the receipt rule. Coordinate removal with the operator and a separate migration workflow. SES identities, the Stalwart domain and keys might have existed before onboarding or still be needed for queued messages. Inspect their ownership, backups and mail queues before manually removing those resources. An empty receipt-rule recipient list matches all verified domains, so never use it as a removal shortcut.

Revert DNS manually to the saved records when rolling back, respecting TTLs. Restore the previous receipt rule and sender configuration, preserve inbound S3 objects and archival metadata, and check queues and mail flow. If a remote change succeeded but the database write failed, reconcile the remote state and audit log before retrying; alias and receipt-rule updates are not atomic with database writes. DKIM rotation requires retaining old keys while signed mail is in transit and checking updated records. See [outbound operations](outbound.md) and [ingestion](../architecture/ingestion.md).
