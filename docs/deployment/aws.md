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
The application's SES domain adapter currently uses `eu-north-1`; the module's
region must agree with the application and existing resources. Choose an unused
resource prefix and an owned, globally unique bucket. Configure an
access-controlled remote backend with locking and backups; this module does not
configure one. OpenTofu and the provider are pinned in `versions.tf` and the
provider lock file.

State and saved plans use enforced OpenTofu AES-GCM encryption with a PBKDF2
passphrase. Supply a unique, high-entropy `state_key` securely (for example,
`TF_VAR_state_key`) **before init**, import, plan and other operations. Never
commit or log it; back up the key separately and test recovery. Losing it makes
the encrypted state and plans unreadable. Protect the backend and local backups
as well; encryption is not an access-control system. The enforced configuration
cannot read plaintext state or plans. For an existing encrypted state, first
verify that its key, provider name, method and parameters are compatible; plan a
key rollover if they are not. For plaintext state, back it up and follow
[OpenTofu's migration procedure](https://opentofu.org/docs/v1.9/language/state/encryption/)
in a controlled, separately approved transition, including its temporary
unencrypted fallback, before returning to enforced encryption. Protect and
retire plaintext state, saved plans and backups under the operator's retention
policy. Do not assume that merely adding this configuration migrates them.

Copy this example into a private variables file outside the repository,
substituting your values. Supply the encryption key separately:

```hcl
region                   = "<aws-region>"
name_prefix              = "<unique-resource-prefix>"
buffer_bucket_name       = "<globally-unique-owned-bucket-name>"
initial_recipients       = ["<original-rule-domain>"]
esuno_initial_recipients = ["<esuno-rule-domain>"]
esuno_sending_domains    = ["<esuno-sending-domain>"]
sending_iam_user_name    = "<existing-smtp-user>"
# Optional if the existing names differ from the derived defaults:
# ingestion_queue_name = "<existing-queue-name>"
# ingestion_dlq_name   = "<existing-dlq-name>"
tags          = { environment = "<environment>" }
alarm_actions = ["<existing-alarm-action-arn>"]
```

The two initial recipient lists must be nonempty, lowercase addresses and/or
domains. SES treats an empty list as a catch-all. Choose values that match the
intended verified receiving identities, including aliases, subdomains and Bcc,
and consider SES's 500-recipient rule limit. Despite their historical names,
these variables manage recipients continuously. Update them through the single
operator-owned IaC workflow; drift appears in plans. Review the exact recipient
list before any apply or replacement.

`esuno_message_prefix` defaults to `messages/esuno/`; set it to the existing
dedicated prefix if different. It scopes the Esuno rule's S3 action, the added
bucket permission, the noncurrent-version lifecycle and worker deletion. The
original rule still writes under `messages/`; deletion outside the dedicated
prefix is no longer granted by this module. Ensure the worker's
`INBOUND_BUFFER_PREFIX` and replay configuration match the actual paths and
that other rules' messages have a safe, separately authorized cleanup process.
The existing SMTP user and its credentials are managed outside this module. The
inline policy permits `ses:SendRawEmail` only for the SES identity ARNs and
`*@domain` From addresses in `esuno_sending_domains`. Domain adoption
does not extend that policy: the operator must review and update it for each
additional sending domain. Other attached policies can also grant access; review
the user's effective permissions, including restrictions and deny cases. Derive
regional SMTP credentials from a separately created access key using the
[AWS procedure](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html).
No keys are created or stored in state; SMTP temporary credentials are not
supported. Provision and rotate ingestion credentials separately.

## SES ownership and activation

The operator owns the whole receipt rule, including recipients, in one OpenTofu
state and separately manages SES identities and verification. OpenTofu manages
both rule sets, the rules' S3/SNS actions, bucket, topic, queues, DLQs, IAM and
policies. It does not manage domain identities, DKIM or custom MAIL FROM.
The API can opt into read-only adoption of explicitly approved, already verified
domains with existing recipients; it does not create or verify an SES identity
or update a rule. See [domain operations](../operations/domains.md).

Set `domain_adoption_domains` to approved domains to create the optional
separate IAM user and its read-only policy; an empty set creates neither.
`ses:GetEmailIdentity` is scoped to those identity ARNs. SES v1 requires
`Resource: "*"` for `GetIdentityVerificationAttributes`,
`DescribeActiveReceiptRuleSet`, and `DescribeReceiptRule`; they are constrained
by `aws:RequestedRegion`, which limits the region but not individual identities
or rules. They can reveal other metadata in that region. No SES write,
`iam:PassRole`, S3, SNS or SQS permission is granted. Provision credentials
outside state and store them in the API's protected secret file. Verify the real
policy and its effective permissions before any approved apply.

Both rule sets default to unmanaged activation. Set `activate_rule_set = true`
only to manage the original set, or `activate_esuno_rule_set = true` only to
manage the Esuno set. Never enable both. SES permits one active set per account
and region. Both active-set resources and the Esuno rule set and rule use
`prevent_destroy`: switching, replacing, or stopping their management requires
deliberate operator reconciliation, not a routine apply. Import an already active set into exactly one state before planning;
otherwise it is not tracked. A missing resource in state does not establish
whether a set is active. Inspect the real active set and complete plan; never
apply a plan that deactivates production receipt.

On 2026-10-30 the operator confirmed the active production set is
`opensuite-esuno-inbound`, containing enabled rule `opensuite-esuno-store`,
recipient `esuno.net`, and its S3 action in `eu-north-1`. For this account the
private variables must include `name_prefix = "opensuite"`,
`activate_esuno_rule_set = true`, `activate_rule_set = false`, and
`esuno_initial_recipients = ["esuno.net"]`. These are production values, not
module defaults. Import the active-set resource as described below and confirm
the full rule, its order and permissions. Verify current AWS state again before
any future plan: these values are an observation, not a guarantee. The API's
`DOMAINS_SES_RULE_SET` and `DOMAINS_SES_RULE` must name the actual active set
and its rule; the API verifies that the configured set is active before reading
the rule. SES inbound TLS is optional; the VPS SMTP relay must use STARTTLS and
certificate verification.

## Adopting an existing account

Only the infrastructure operator should perform this procedure, in the intended
account and region. These are account and state operations, not offline checks:

1. Inventory resources, ownership, rule-set activation, recipients, bucket
   contents, all IAM grants, lifecycle rules and the **complete** bucket, topic
   and queue policies. Back up the existing state and encryption keys. Coordinate
   with every other state owner and pause domain management and concurrent IaC
   operations. Never import a resource into multiple states.
2. Configure the backend and key as above, and adapt the private variables and,
   where necessary, configuration to match the existing objects. Both bucket
   and topic policies and the S3 lifecycle configuration are singletons: this
   module replaces each as a whole. Compare every existing statement and rule
   with AWS, preserve all still required entries, and do not assume the two
   baseline statements plus Esuno additions cover account-specific permissions.
   The proposed lifecycle contains only 30-day noncurrent-version expiration
   under the dedicated prefix; it removes the old multipart and confirmed-object
   expiration rules. Review retention consequences before any change.
3. Import every matching IaC-owned resource into the intended state using the
   [provider's import formats](https://registry.terraform.io/providers/hashicorp/aws/5.100.0/docs).
   For example, supply `VARS`, `BUCKET`, `RULE_SET`, `RULE`, `ESUNO_RULE_SET`
   and `ESUNO_RULE` privately and use:

   ```sh
   tofu import -var-file="$VARS" aws_s3_bucket.buffer "$BUCKET"
   tofu import -var-file="$VARS" aws_s3_bucket_lifecycle_configuration.buffer "$BUCKET"
   tofu import -var-file="$VARS" aws_s3_bucket_policy.buffer "$BUCKET"
   tofu import -var-file="$VARS" aws_ses_receipt_rule_set.inbound "$RULE_SET"
   tofu import -var-file="$VARS" aws_ses_receipt_rule.inbound "$RULE_SET:$RULE"
   tofu import -var-file="$VARS" aws_ses_receipt_rule_set.esuno "$ESUNO_RULE_SET"
   tofu import -var-file="$VARS" aws_ses_receipt_rule.esuno "$ESUNO_RULE_SET:$ESUNO_RULE"
   # Only when the Esuno set is already active and activate_esuno_rule_set is true:
   tofu import -var-file="$VARS" 'aws_ses_active_receipt_rule_set.esuno[0]' "$ESUNO_RULE_SET"
   ```

   Also import versioning, public access block and encryption configuration,
   SNS topic and policy, all queues, queue policies and redrive settings,
   subscriptions, Firehose, IAM users/roles and inline policies, and alarms as
   applicable. Import the original active-rule-set resource only if that set is
   already active and `activate_rule_set` is true. An active set is a singleton:
   never import it into two resources or states. If a previous state tracks a
   different active-set address, back up state and coordinate a state-only
   handoff before import; do not destroy or deactivate the live set. Do not import SES identities,
   DKIM or MAIL FROM into this module. The old adopted state addresses
   `aws_s3_bucket_lifecycle_configuration.esuno_buffer` and
   `aws_iam_user_policy.esuno_smtp` move to
   `aws_s3_bucket_lifecycle_configuration.buffer` and
   `aws_iam_user_policy.sending` respectively via `moved` blocks. Do not import
   objects already in that state; if both the old and new addresses are present,
   stop and reconcile ownership rather than creating duplicates. A pending move
   appears in the plan even when it proposes no remote changes. To obtain a
   strictly empty adoption plan without applying, an operator may perform the
   corresponding `tofu state mv` as a separately approved state-only transition
   after backing up state and verifying both addresses. For an object not yet in
   state, import to the new address. For example, supply the existing
   `SENDING_USER` and `SENDING_POLICY` and use:

   ```sh
   tofu import -var-file="$VARS" aws_iam_user_policy.sending "$SENDING_USER:$SENDING_POLICY"
   ```

   Reconcile the policy name, user, and any other inline or attached policies;
   do not leave a second broad policy attached unnoticed. If older state tracks
   `aws_ses_domain_identity.domain`, `aws_ses_domain_dkim.domain`,
   `aws_ses_domain_mail_from.domain` or `aws_iam_user.sending`, the module's
   `removed` blocks protect those objects from destruction. OpenTofu 1.9.1
   forgets them without destroying them; its `removed` syntax does not support
   the nested lifecycle block introduced in 1.10. The plan will show pending
   state removals, so it will not yet be empty. To meet the empty-plan adoption
   requirement, back up and verify the state, coordinate the handoff, and have
   the operator perform a separately approved state-only removal of those
   addresses (for example, `tofu state rm` for each tracked resource) before
   re-planning. Never delete the remote objects. The `removed` blocks also
   protect against destruction if tracked instances remain in another state.

4. Run a real `tofu plan` with the intended variables and encrypted state. It
   **must be empty** after adoption: resolve every proposed creation, deletion,
   replacement, policy, lifecycle, queue name, recipient, IAM or activation
   change with the operator and repeat the plan. Inspect the move annotations
   and confirm no replacements, deletions, or unintended policy changes; a
   state move is not itself proof that the remote attributes match. Inspect
   the full recipient lists in the plan and directly in AWS. Queue
   `max_message_size` drift is also intentionally ignored; inspect it separately.
   The queue defaults now derive as `<prefix>-inbound` and
   `<prefix>-inbound-dlq`; use the optional name variables to preserve existing
   names. Check the active set and the full resulting policies directly, and
   verify no untracked resources or other IAM policies grant broader access.
5. Only after an empty plan and explicit operator approval may the operator
   apply. For any later intended change, make a new plan and obtain approval for
   that specific change; never treat an earlier empty plan as approval for it.
   This repository's offline validation performs none of these operations.

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
alarms alone cannot prove preservation. Recover from the Firehose archive and the buffer's versions as in
[Recovering mail from the archives](production.md#recovering-mail-from-the-archives),
which validates each payload.

The buffer bucket has versioning enabled. Only noncurrent versions under the
dedicated Esuno prefix expire, 30 days after becoming noncurrent. Deletion
creates a delete marker; recovery requires restoring the prior version before
expiry. Current versions, other prefixes, metadata and incomplete multipart
uploads have no expiration from this configuration. A bucket has just one
lifecycle configuration, so adoption must preserve any other needed rules. The
worker may delete only objects under the dedicated prefix and must do so only
after all recipients and recovery requirements are confirmed, not merely after
queue acknowledgement. Reconcile orphan objects and retain their independent
metadata; S3 objects and notifications are not transactional. Versioning is not
an immutable backup; monitor storage and delete markers and arrange retention
for other prefixes separately. Account administrators can change policies or
delete data. S3 is a temporary buffer, not the permanent mail or Drive store.

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
