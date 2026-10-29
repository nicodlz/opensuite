# Planned SES inbound ingestion

Date: 2026-10-29. **Status: design only.** The SES-to-Stalwart integration has not been exercised. Local substitutes and fixtures must not be presented as provider proof. The target and preservation gate are described in [ADR 0002](../adr/0002-production-target.md); the go/no-go proof and direct-SMTP fallback are in [ADR 0001](../adr/0001-architecture.md).

## Notification contract

The proposed route is an SES receipt rule with an S3 action, its optional SNS notification, and an SQS subscription to that SNS topic. This is an SES **action notification**, not an S3 `ObjectCreated` event. The authoritative format is [AWS: Contents of notifications for Amazon SES email receiving](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html) and [AWS notification examples](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-examples.html), accessed 2026-10-29. AWS describes `receipt.recipients` as “the envelope RCPT TO addresses” matched by the active rule. Use this field, not `To`, `Cc` or `mail.destination`, for routing; it can include Bcc and can differ from header recipients. A rule only reports its matched recipients, so rules and aliases must be designed and tested for complete intended coverage.

The following is an illustrative subset of the AWS-documented JSON format with documented field names and types; resource identifiers are redacted and optional fields and headers are omitted. It is not a captured AWS event. AWS's example encodes `processingTimeMillis` as a number while its field description calls it a string; accept and validate the documented possibilities until real events settle the contract.

```json
{
  "notificationType": "Received",
  "receipt": {
    "timestamp": "2026-10-29T12:00:00.000Z",
    "processingTimeMillis": 200,
    "recipients": ["alice@example.org", "hidden@example.org"],
    "spamVerdict": { "status": "PASS" },
    "virusVerdict": { "status": "PASS" },
    "spfVerdict": { "status": "PASS" },
    "dkimVerdict": { "status": "PASS" },
    "dmarcVerdict": { "status": "PASS" },
    "action": {
      "type": "S3",
      "topicArn": "<redacted>",
      "bucketName": "<redacted>",
      "objectKey": "<redacted>"
    }
  },
  "mail": {
    "timestamp": "2026-10-29T12:00:00.000Z",
    "source": "sender@example.net",
    "messageId": "<redacted>",
    "destination": ["alice@example.org"],
    "headersTruncated": false,
    "headers": [],
    "commonHeaders": {}
  }
}
```

`notificationType` is `Received`; the S3 action includes `type`, `bucketName`, `objectKey` and, for the configured SNS notification, `topicArn`. `mail.messageId` is SES's identifier, not the message's RFC `Message-ID`. The S3 action also permits an object-key prefix; use the actual `receipt.action.objectKey` as the object locator and test prefix behavior rather than reconstructing it. `content` is present for an SNS **action**, not an S3 action; fetch the object for the MIME bytes. AWS calls the S3 payload “raw, unmodified email”; see the [S3 action documentation](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html), accessed 2026-10-29. Any SES-added headers and byte-for-byte preservation across upload and import still need measurement.

Each of `spamVerdict`, `virusVerdict`, `spfVerdict`, `dkimVerdict` and `dmarcVerdict` is an object with a `status` of `PASS`, `FAIL`, `GRAY` or `PROCESSING_FAILED`; the meaning of `GRAY` differs by check. `dmarcPolicy`, when present on DMARC failure, is `none`, `quarantine` or `reject`. Preserve the verdicts and policy alongside the recipient record, including missing or unknown values as explicit uncertainty; do not silently treat them as `PASS`. Select and test a quarantine policy for suspicious or indeterminate cases. SES documents that it supplies verdicts but does not itself act on them in [receiving concepts](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html), accessed 2026-10-29.

For an SNS-to-SQS subscription, [AWS SNS raw delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html), accessed 2026-10-29, documents two body shapes: with raw delivery enabled, the SQS body is the published SES JSON; without it, the body is an SNS notification JSON envelope whose `Message` is a string containing the SES JSON. The SQS receive response itself wraps that body and supplies a receipt handle. Choose one subscription mode and validate the expected shape; reject or quarantine unexpected source/topic/bucket/key combinations. Restrict the queue and topic policies to the intended publishers and subscribers. Do not interpret an SNS `MessageId` as the SES `mail.messageId`.

## Size and encryption constraints

[AWS SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), accessed 2026-10-29, list a non-adjustable **40 MB** maximum received message including headers for S3 storage, **150 KB** for a message published by an SNS action, and **10 KB** for headers published in SNS notifications. These are distinct limits; the SNS action's content limit is not the S3 action's message limit. The S3 action documentation states oversized mail bounces. MIME encoding and headers consume space, so attachment payloads must be smaller than the message limit. JMAP, proxy, mailbox and temporary-upload limits can be lower; see [Stalwart integration](stalwart.md). Test near all applicable boundaries.

The [SES S3 action documentation](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html), accessed 2026-10-29, distinguishes its optional client-side message encryption from S3 server-side encryption: the former needs a compatible S3 encryption client to decrypt after retrieval. The TypeScript worker's support is unverified. Choose and test an encryption mode, key permissions and restore procedure before enabling it; do not assume an ordinary S3 GET yields plaintext when SES message encryption is enabled.

## Required processing and recovery design

Independently archive the notification and its envelope recipients outside the VPS through the separate managed consumer in [ADR 0002](../adr/0002-production-target.md). Retain the raw MIME independently as well; the S3 object must not be deleted merely because the SQS delivery was acknowledged. That archive and its recovery from notification delivery failures are unverified gates. SQS retention is at most 14 days ([AWS queue parameters](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-queue-parameters.html), accessed 2026-10-29).

The intended state progression is `observed → metadata durable → object verified → recipients resolved → quarantined or import pending → imported → reconciled`. States are per delivery and, where needed, per destination account. Persist the SES message identity, bucket/key, rule-matched envelope recipients, verdicts, destination mapping, byte integrity information, attempts and outcomes before acknowledging the queue message. Store the original S3 object until every destination is confirmed and independent archival and retention/backup policy permit deletion. Restrict object access and encrypt data and backups.

- Validate the event, source and object locator; retain the notification and alert on missing, unknown or inconsistent metadata. Alias expansion and Bcc routing must use the envelope list. Resolve multiple aliases to the same account deliberately so each account receives one logical delivery, while different accounts each receive theirs. Unknown recipients and ambiguous mappings are retained for operator action; a worker cannot retroactively reject an SMTP transaction already accepted by SES.
- A candidate idempotency key combines provider/account/region, SES message identity or actual bucket/key, and resolved destination account; do not use header `Message-ID` as a global unique key. Persist a unique durable delivery record and claim work with a lease. Repeated notifications and retries must converge on that record. Cross-rule duplicates, multiple prefixes and aliases require proof.
- Upload original bytes with the account-scoped JMAP HTTP upload endpoint, then import the returned blob into the intended mailbox. Record individual outcomes. A lost response after `Email/import` may mean the import succeeded: mark it **uncertain**, retain the source and reconcile before retrying. Neither a database transaction nor SQS deduplication can atomically cover a remote JMAP write. A safe, testable reconciliation mechanism or provider-supported idempotency is a go/no-go requirement; searching only by RFC `Message-ID` or content is not a reliable exactly-once proof.
- Retry transient failures with bounded backoff, visibility extension and a DLQ; retain recoverable inputs, alert on age/backlog, missing objects, failed imports and DLQ entries, and provide audited replay. Acknowledge SQS only after the durable state makes recovery possible. Reconcile S3 objects, queue/DLQ and the delivery ledger, including lost notifications and expired retention. An orphan object alone may not contain the envelope recipients or verdicts; do not guess them from headers. Preserve or recover the notification independently and alert if routing evidence is missing.
- Test crashes at every transition, duplicate and reordered notifications, partial multi-account success, invalid recipients, malware/verdict failures, large messages, S3/JMAP outages and timeout-after-commit. Prove restores and retention cover both bytes and routing metadata. No design here guarantees zero loss or exactly-once delivery until these tests and the real-provider proof succeed.
