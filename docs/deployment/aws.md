# AWS mail infrastructure

`deploy/aws` is a candidate configuration for one replaceable VPS. SES receives
mail in the selected region (default `eu-north-1`), writes MIME to an encrypted
S3 buffer, and publishes the receipt notification to SNS. SNS delivers it to an
SQS ingestion queue and separately to Firehose for a metadata archive in the
same bucket. The worker imports into Stalwart on the VPS. Sending uses
SES SMTP with STARTTLS on port 2587. Drive and its permanent object storage use
Backblaze B2 and are not provisioned here.

This configuration has only been checked offline: **no real AWS plan or apply,
provider integration, delivery, IAM policy, DNS, recovery, or cost has been
verified**. The worker, relay and backup tooling exist, but end-to-end provider behavior
has not been verified. Treat this as infrastructure to evaluate before cutover. See the [ingestion design](../architecture/ingestion.md).

## Prerequisites and configuration

Use your own AWS account and a region supporting both SES receiving and
Firehose. [AWS lists receiving endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html).
SES identities, inbound resources and SMTP credentials are regional. Use an
operator identity with permission to manage only the necessary resources. Store
state in an encrypted, access-controlled remote backend with locking and backups;
never commit state, variable files containing sensitive data, or credentials.
Coordinate state ownership before importing or provisioning. This module does not
configure a backend. OpenTofu and the provider are pinned in `versions.tf` and
the provider lock file; the offline validation image is pinned separately.

Copy the following example into a private variables file outside the repository,
substituting values belonging to you. The placeholders below are deliberately
not actual domains, bucket names, or resource identifiers:

```hcl
region             = "<aws-region>"
name_prefix        = "<unique-resource-prefix>"
buffer_bucket_name = "<globally-unique-owned-bucket-name>"
domains            = ["<your-domain>"]
recipients         = ["<your-domain>"]
tags               = { environment = "<environment>" }
alarm_actions      = ["<existing-alarm-action-arn>"]
```

`domains` must be explicit lowercase domain names, and `recipients` must be a
nonempty list of lowercase addresses and/or domains. A domain recipient matches
addresses in that domain; individual addresses are narrower. SES acts on matched
recipients, not every verified domain: review aliases, subdomains and Bcc coverage
and the 500-recipient rule limit. A configured recipient must also be a verified
SES receiving identity. Domain and recipient lists are independent: ensure they
match your intended identities. No empty catch-all is allowed. Choose an unused
prefix and a globally unique bucket name. Use `confirmed_expiration_days` to
increase the default 90-day safety window; its minimum is 30 days.

After configuring a backend and private variables, initialize normally in your
own controlled environment. Before creating resources, inventory the account,
reconcile existing resources as described below, and inspect a plan. Only after
review should the account owner apply it. This repository's validation command
never performs these account operations.

After provisioning, publish the identity and signing records in `dns_records`
when safe; hold the receiving MX and any conflicting wildcard changes for the
separate, owner-approved cutover in the production runbook. Merge
SPF with existing policy rather than creating conflicting TXT records. Confirm
SES identity and DKIM verification, MX and MAIL FROM status, region and sandbox
status before routing real mail; request production sending access if necessary.
The MAIL FROM behavior rejects sending when its MX fails rather than silently
falling back. DNS cutover has service-wide effects: coordinate existing mail
routing and verify delivery and rollback before changing MX.

The rule set is **not activated by default**. SES supports one active receipt
rule set per account and region. Activating this one replaces the existing active
set and can interrupt other domains, even though this rule has recipients. First
inspect and deliberately migrate all needed existing rules, ordering and
permissions; this module manages only its own rule. Set `activate_rule_set =
true` only when that replacement is intended, or incorporate this rule into a
separately managed shared rule set instead. Do not have two states manage the
same active set. Review the resulting plan carefully. Inbound sender-to-SES TLS
is optional; SES may accept unencrypted inbound SMTP. The SMTP relay from the
VPS must use STARTTLS, certificate verification, the `smtp_host` output and port 2587. Region-specific SMTP credentials differ from AWS secret keys: derive them
from a separately created access key for the output sending IAM user using the
[AWS procedure](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html).
No keys are created or put in state. Create and rotate the ingestion user's
credentials separately, keep both identities isolated, and protect them on the
VPS. SMTP temporary credentials are not supported.

To add a domain, append its exact lowercase name to `domains`, add suitable
recipient conditions, review the plan, publish the new DNS records, verify the
identity, and update MX at the agreed cutover. The sender policy derives an
explicit identity ARN and `*@<that-domain>` From-address condition for each
listed domain. It does not grant rights to unlisted domains; the local-part
wildcard permits any address on each listed domain. A separately verified email
identity may require additional explicit policy handling. Test the actual SES
SMTP authorization, including deny cases, in an authorized environment.

## Existing resources and imports

OpenTofu does not automatically adopt existing resources. Before provisioning,
make a complete inventory in the target account/region and choose whether to
adopt, rename, or integrate with existing resources. Never import one resource
into multiple states. Keep the existing state and configuration backed up; check
that the selected backend, variables and account are correct before running any
commands. Importing associates an object with state; it does **not** make its
configuration match. A subsequent plan can propose replacement or destructive
changes: inspect every change, especially bucket lifecycle, bucket/topic/queue
policies (each is managed as a whole), rule set activation and IAM permissions.
Preserve required existing statements, rules and data or use an isolated set of
resources. Avoid replacing a bucket containing unimported mail.

For an operator performing a deliberate adoption, substitute shell variables
with existing values and use the same private variables file for each import.
For example, with `DOMAIN`, `BUCKET`, `RULE_SET`, `RULE`, and `VARS` supplied by
the operator:

```sh
tofu import -var-file="$VARS" 'aws_ses_domain_identity.domain["'"$DOMAIN"'"]' "$DOMAIN"
tofu import -var-file="$VARS" 'aws_ses_domain_dkim.domain["'"$DOMAIN"'"]' "$DOMAIN"
tofu import -var-file="$VARS" 'aws_ses_domain_mail_from.domain["'"$DOMAIN"'"]' "$DOMAIN"
tofu import -var-file="$VARS" aws_s3_bucket.buffer "$BUCKET"
tofu import -var-file="$VARS" aws_s3_bucket_versioning.buffer "$BUCKET"
tofu import -var-file="$VARS" aws_s3_bucket_public_access_block.buffer "$BUCKET"
tofu import -var-file="$VARS" aws_s3_bucket_server_side_encryption_configuration.buffer "$BUCKET"
tofu import -var-file="$VARS" aws_s3_bucket_lifecycle_configuration.buffer "$BUCKET"
tofu import -var-file="$VARS" aws_s3_bucket_policy.buffer "$BUCKET"
tofu import -var-file="$VARS" aws_ses_receipt_rule_set.inbound "$RULE_SET"
tofu import -var-file="$VARS" aws_ses_receipt_rule.inbound "$RULE_SET:$RULE"
```

The configured names must match the existing objects. If adopting the already
active set and `activate_rule_set` is true, import
`'aws_ses_active_receipt_rule_set.inbound[0]'` using the existing rule set name.
Similarly inventory and import existing SNS topic and policy, SQS queues and
policies, subscriptions, Firehose stream, IAM users/roles and inline policies,
and alarms, using the IDs and resource-specific import formats in the
[provider documentation](https://registry.terraform.io/providers/hashicorp/aws/5.100.0/docs).
For example the topic and SQS queue use their existing ARN and URL respectively.
If an existing resource has a different name or another state owns it, do not
blindly import or create a duplicate: adapt ownership/configuration and review
its plan first. Provider-managed default resources and singleton configurations
may need separate imports even when their parent has been imported.

## Recovery, retention and monitoring

SNS raw delivery is enabled for both subscriptions: the queue body and each
archive record contain the SES JSON directly, avoiding a second SNS wrapper.
The S3-action notification includes the object location, matched envelope
recipients (including Bcc), and verdicts. It is not an S3 event, and the MIME
object is not a reliable substitute for the envelope. Check and preserve the
actual `receipt.action.objectKey`, `receipt.recipients`, verdicts and message
identity; do not infer recipients from message headers. Unmatched recipients are
not captured by that rule. [AWS documents the notification](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html).

Firehose independently batches the same notification into gzip-compressed,
newline-delimited records under `metadata/` with no lifecycle expiration; S3
server-side AES256 encryption also covers this prefix. It is independent of the
VPS and ingestion queue after delivery, but shares the AWS account, region and
bucket with the MIME buffer. It is not a cross-account backup, an immutable
archive, or a guarantee of zero loss. Firehose's buffer introduces latency;
DirectPut retries S3 delivery for up to 24 hours, after which records can be
lost. SNS-to-subscription failures go to a separate 14-day SQS DLQ; Firehose
acceptance is not proof of S3 archival. See [Firehose retry limits](https://docs.aws.amazon.com/firehose/latest/dev/retry.html).
Back up and restrict metadata separately, test restoring and parsing records,
reconcile archive records against objects and imports, and alert and act promptly
on missing records, delivery failures and age. SNS may duplicate records. The Firehose subscription role trusts the SNS service
and can write only to this stream; restrict who can pass that role and manage
subscriptions. The trust policy restricts assumption to the account and inbound topic ARN; verify SNS supplies those context keys in the target environment before relying on delivery. The SNS topic itself is not KMS-encrypted; do not claim end-to-end encryption of
metadata. S3 uses server-side encryption, not SES's incompatible client-side
message encryption option.

The main queue and both DLQs retain messages for at most 14 days. With a
standard SQS queue, a message moved to a DLQ retains its original enqueue time,
so it can have less than 14 days left there. The ingestion DLQ handles repeated
worker failures; the subscription DLQ handles SNS delivery failures for either
subscription. Configure `alarm_actions` to an independently managed, tested
notification endpoint: without it, alarms change state but notify nobody. Five
alarms cover queue age, both DLQ depths, SNS failed deliveries and Firehose S3
freshness. Missing metrics are treated as non-breaching, so also monitor service
health, missing metrics, SNS redrive failures, and archive completeness; these
alarms alone cannot prove preservation. Establish a documented replay process
that identifies the failed subscription and validates each payload.

The buffer bucket has versioning enabled. Noncurrent `messages/` versions
expire 30 days after becoming noncurrent, including versions of unconfirmed
objects that were overwritten or deleted; incomplete multipart uploads across the bucket
are aborted after 7 days. A delete creates a delete marker, and
recovery requires restoring the prior version before expiry. Versioning is not
an immutable backup, and it also applies to `metadata/` objects, whose
noncurrent versions have no automatic expiry. Budget for retained versions and
remove delete markers through a controlled reconciliation process.

The current-version S3 lifecycle rule only applies to `messages/` objects tagged
`opensuite-import=confirmed`, and only after 90 days from object creation by
default (minimum 30). **Untagged objects never expire via this rule**, including
unconfirmed and ambiguous imports, even after queue retention ends. The worker
has no tagging rights: a separate, controlled reconciliation process may tag
only after every intended recipient import is confirmed and backup/retention
policy permits deletion. Tagging an already-old object can make it immediately
eligible for expiration. The worker's `DeleteObject` permission likewise must be
used only after all recipients and recovery requirements are confirmed. Do not
tag or delete on queue acknowledgement alone. Reconcile orphan objects and
retain their independent metadata; S3 objects and notifications are not
transactional. Account administrators can still change policies or delete data.
S3 is a temporary buffer, not the permanent mail or Drive store.

## Indicative costs

For planning only, with 10,000 messages received and 10,000 recipient deliveries
sent per month, no attachment charges, and no free-tier credits, SES à-la-carte
message charges are about $1 received + $1 sent, plus $0.09 per 1,000 incoming
256 KB chunks. Five standard CloudWatch alarms would be about $0.50/month at
AWS's published US East example rate; verify Stockholm pricing and free-tier
eligibility. This is a partial estimate, not a price guarantee.

Also budget for S3 storage (including unconfirmed objects and indefinitely
retained metadata), requests and retrieval/transfer to the VPS; SNS publishes
and deliveries; SQS requests including polling, retries and DLQs; Firehose
DirectPut ingestion rounded to 5 KB per record, S3 writes, and any optional
logging/notifications. Costs depend on traffic, message sizes, retention and
region. The VPS, DNS, backups, Backblaze B2, taxes and any dedicated SES
features are additional. Use current [SES](https://aws.amazon.com/ses/pricing/),
[Firehose](https://aws.amazon.com/firehose/pricing/),
[S3](https://aws.amazon.com/s3/pricing/), [SNS](https://aws.amazon.com/sns/pricing/),
[SQS](https://aws.amazon.com/sqs/pricing/) and
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) pricing for a full
regional estimate.

## Offline validation

From the repository root run `node scripts/iac-validate.mjs`. Docker runs the
pinned official OpenTofu image with the module mounted read-only, no credentials
or backend, and a temporary data directory. Formatting and validation run with
network disabled; initialization enables network only to download the locked
provider. The container filesystem is read-only apart from temporary storage.
This checks syntax and provider schema only; it cannot prove cloud permissions,
regional availability, DNS, mail behavior, preservation or runtime recovery.
