# Managing mail domains

Domain management is an administrative operation and requires an authenticated administrator. Configure the API authentication and mailbox provisioning described in the [development guide](../development.md), and test inbound delivery before production use. Do not use the development web client's synthetic domains as operational data.

## Ownership and infrastructure changes

The domain service owns per-domain SES identities, verification and the
recipients of its configured receipt rule. The AWS module owns rule sets and
rule actions, but ignores recipient changes after creation; it does not manage
SES identity, DKIM or MAIL FROM resources. Bootstrap recipients must be nonempty,
and a replacement rule uses its configured initial list again, so coordinate
and review any replacement with the domain operator. When adopting existing
resources or transferring identities out of an older state, follow the
[account adoption procedure](../deployment/aws.md#adopting-an-existing-account)
before any apply. Serialize all SES rule and domain changes across processes and
operators, including infrastructure plans and applies, because updates replace
the whole rule and can otherwise overwrite concurrent recipient changes.

The service uses the configured rule name in the **active** SES rule set; it
cannot update a rule in an inactive set. The module's Esuno set is defined but
not activated. Verify the active set, recipients and S3/SNS actions before using
it. Domain onboarding does not update the SMTP IAM policy: coordinate additions
with the operator maintaining `esuno_sending_domains` and verify effective SES
sending permissions. The service does not configure custom MAIL FROM.

## Prepare

Use a controlled test domain first. Record existing DNS and mail routes, TTLs, other senders, and a rollback plan. SES receiving and sending use **eu-north-1**. Configure a pre-existing, enabled rule in the active SES receipt rule set with a nonempty recipient list and the existing S3/SNS actions described in [ingestion](../architecture/ingestion.md). The service changes only that rule's recipients, preserves its other settings, and refuses to modify an unrestricted or disabled rule. It will not remove the final recipient, because an empty list matches all recipients. Serialize SES and Stalwart management across processes and operators; the AWS APIs do not provide a conditional update for receipt rules.

The provider is off by default. Compose passes the optional `DOMAINS_*` settings
from `deploy/env.example` to the API. Set `DOMAINS_SES_ENABLED=true`,
`DOMAINS_SES_RULE`, `DOMAINS_STALWART_ORIGIN`, `DOMAINS_STALWART_USER`, and
`DOMAINS_STALWART_PASSWORD_FILE`. The generated management password is already
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

The provider calls SESv2 `GetEmailIdentity` and, for an absent identity,
`CreateEmailIdentity`; the get response includes Easy DKIM and verification
status. It calls SES `VerifyDomainIdentity` to obtain a TXT token and
`DescribeActiveReceiptRuleSet`, `DescribeReceiptRule`, and, only when the
recipient list needs to change, `UpdateReceiptRule`. It does not call separate
DKIM or MAIL FROM configuration APIs. [AWS's service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html)
lists no resource-level scope for the SES receipt-rule operations or
`VerifyDomainIdentity`; an ARN-scoped policy for these calls will not work. A working wildcard rule-update
permission can modify other rules in the account and region, including their
actions. The production authorization boundary requires an explicit platform
security decision before enabling this feature. Simply starting the API with the
provider disabled creates no SES client and makes no SES requests.

Apply migrations before startup. The migration creates case-insensitive unique indexes on domain names and addresses; if existing names collide by case, migration fails deliberately. Resolve those collisions with the owners before retrying. A domain is associated with the administrator who added it; addresses may belong to other users with active mailbox links. The primary address must match the linked mailbox. An alias is added to that mailbox in Stalwart. Ingestion resolves stored addresses case-insensitively, but each mailbox account ID must also have a matching `INGEST_DESTINATIONS` entry and credential in the worker's current configuration. Plan changes to worker configuration accordingly; dynamic destination credentials are not yet integrated. Coordinate address reassignment with the ingestion ledger and pending archive replay: replay resolves recipients using current routing, so reconcile older unprocessed messages before changing a destination.

## Add and verify

From the Domains admin page add a domain. The service creates or reuses its Stalwart domain and active DKIM records, creates or reuses the SES identity, requests the SES verification token, and adds the domain to the selected receipt rule. It stores a pending record before making remote changes. If a step fails or times out, inspect Stalwart, SES, and the stored domain before rechecking; remote writes and the database are not one transaction. Recheck retries incomplete provisioning. Avoid concurrent changes to the same domain or rule. Creating an existing domain or alias can reuse an existing remote object; investigate ownership before using the operation.

The page displays the records and current check status. Publish them manually at your DNS provider:

- MX for the domain, priority 10, to `inbound-smtp.eu-north-1.amazonaws.com`.
- SPF containing `include:amazonses.com`. Merge it into the existing SPF policy rather than publishing a second SPF record, and account for all senders and lookup limits.
- The active Stalwart DKIM TXT records and the SES Easy DKIM CNAMEs returned for the identity.
- A DMARC TXT record; the suggested `v=DMARC1; p=none` is a monitoring starting point. Choose a policy appropriate to the domain.
- The `_amazonses` TXT verification token from SES.

Use Recheck DNS after publication and propagation. When enabled, a background job also checks provisioned domains hourly; `DOMAINS_CHECK_INTERVAL_SECONDS` can set an interval from 60 to 86400 seconds. Scheduled checks run under the active administrator who added the domain and are marked scheduled in the audit log; if that account is disabled or no longer an administrator, its domains are skipped until an administrator rechecks them. Each record is checked using DNS lookups, and the domain is marked verified only when all records match and SES reports the identity verified for sending. A failed lookup or incomplete SES verification marks it failing; an unchecked domain is pending. This does not prove mail delivery, DKIM alignment, SES receiving actions, or preservation. Verify those separately with controlled messages, including Bcc and replay, before changing production MX records. Only an operator makes DNS changes; this service never writes DNS.

## Adopt the existing Esuno domain

After the platform has resolved the SES authorization boundary, an operator can
adopt `esuno.net` without inserting database rows or recreating the existing SES
identity or receipt rule:

1. Confirm the active regional rule contains `esuno.net`, is enabled and has the
   expected S3/SNS actions. Confirm the existing SES identity and Easy DKIM,
   Stalwart management connectivity, and the intended SES permissions. In the
   private deployment `.env`, set `DOMAINS_SES_ENABLED=true`, the actual
   `DOMAINS_SES_RULE`, the Stalwart origin and user above, and
   `DOMAINS_STALWART_PASSWORD_FILE=/run/opensuite/stalwart-management/password`.
   Set `DOMAINS_SES_CREDENTIALS_FILE` to the host path of the protected JSON
   credentials file. Leave the endpoint empty for AWS.
2. Recreate the API using the deployment's normal Compose command, for example
   `docker compose up -d --no-deps --force-recreate api`. Check its logs for
   startup failures without exposing credentials.
3. As an authenticated administrator, add `esuno.net` in the Domains admin
   page, or POST `{"name":"esuno.net"}` to `/api/admin/domains`. The service
   reuses the existing SES identity, requests its verification token, and leaves
   an already-present recipient and the rule actions unchanged. It also creates
   or reuses the Stalwart domain. If provisioning fails, inspect the pending row
   and remote state and use Recheck rather than inserting or duplicating a row.
4. Publish or reconcile every DNS record displayed by the page, including the
   `_amazonses` token, Stalwart and SES DKIM, MX, SPF and DMARC. An SES-verified
   identity alone does not make the application status verified. Use Recheck
   DNS and confirm the status is `verified`; investigate any missing or
   conflicting records. Then confirm authenticated `GET /api/aliases/domains`
   lists `esuno.net`.
5. Signed in as the owner, choose `esuno.net` under **Default alias domain** on
   the Aliases page. Alternatively, `PUT /api/aliases/default-domain` with the
   verified domain's ID as `{"domainId":"<id>"}`. Confirm the selected default.

## Removal and recovery

Remove addresses and aliases first. The remove operation deletes a managed alias from Stalwart and its routing row; a primary address removal removes its routing row but leaves the mailbox intact. Removing an empty domain removes its receipt-rule recipient and local domain row. It deliberately retains the SES identity and Stalwart domain and keys, which might have existed before onboarding or still be needed for queued messages. Inspect their ownership, backups and mail queues before manually removing those resources. Because the rule cannot be made unrestricted, removal of the last recipient requires an operator to adjust the rule safely first.

Revert DNS manually to the saved records when rolling back, respecting TTLs. Restore the previous receipt rule and sender configuration, preserve inbound S3 objects and archival metadata, and check queues and mail flow. If a remote change succeeded but the database write failed, reconcile the remote state and audit log before retrying; alias and receipt-rule updates are not atomic with database writes. DKIM rotation requires retaining old keys while signed mail is in transit and checking updated records. See [outbound operations](outbound.md) and [ingestion](../architecture/ingestion.md).
