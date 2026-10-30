# Outbound mail through SES

Stalwart owns the persistent outbound queue and sends non-local recipients through the configured SMTP relay. Local domains retain local delivery. A successful JMAP submission means the message was queued; SMTP acceptance by SES is also not proof of recipient delivery. Configure SES event publishing and monitor bounces, complaints, delivery failures, queue age and expiry separately. The management integration is server-side only. No real SES connection has been tested by this repository.

## Prepare SES and credentials

1. In **eu-north-1**, verify the sender identity and request production access if needed. The current sending rights cover only the verified identity; do not assume other identities are authorized. In the SES sandbox, recipients must also be verified (or use the mailbox simulator), and default quotas are 200 messages per 24 hours and 1 message per second. Check the actual account quotas in SES; request increases before using higher throughput. SES counts recipients against quotas.
2. Generate SMTP credentials for the same region in SES. These are distinct from ordinary AWS API credentials. Store the SMTP password in a restricted file outside the repository and `.env`. The SMTP username is not the password. SES documents [STARTTLS on port 2587](https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html); the configured endpoint is `email-smtp.eu-north-1.amazonaws.com:2587`, with mandatory STARTTLS and certificate validation. Do not use the adapter's insecure test mode for SES.
3. Set `MAIL_RELAY_SECRET_FILE` in `.env` to the absolute host path and set
   `MAIL_RELAY_CONFIGURED=1` before recreating Stalwart. The file and parent
   directories must be readable/traversable by uid 2000; the file must be
   nonempty and not `/dev/null`. The server and helper mount it read-only.
   Stalwart refuses to start with an empty configured relay secret. Rotation
   requires recreating Stalwart; preserve the file in the encrypted backup.

## Apply

The management helper uses the private management network and generated
management secret; no management port or recovery credential is exposed.
Build the API image first. Replace the SMTP username with the regional SES
username (not the password). Keep all arguments and operator logs private.

```sh
docker compose up -d --no-deps --force-recreate --wait stalwart
docker compose --profile ops run --rm --no-deps management apply SMTP_USERNAME
```

The command reconciles the route, queue, schedule and TLS objects, turns
Stalwart's own DKIM signing off (see below) and reloads settings. Repeat sequentially after a timeout and verify the queue and logs.
Settings are not transactional. Missing routes can fall back to direct MX;
alert on `smtp.id-not-found` and configuration errors. The helper checks the
mounted relay secret, so applying with `/dev/null` fails. Recreate Stalwart
and verify delivery after rotating the file.

The remote queue has one delivery thread, retries after 5 minutes, 30 minutes and then 2 hours, a delay notification after 4 hours and expiry after 24 hours. Stalwart generates delivery failure notifications for failures/expiry; monitor them and the queue. One thread limits concurrency, **not** messages per second or daily volume: enforce SES account rate and rolling quotas upstream, including all senders and other services. Control traffic also follows the relay and the same schedule. Delivery notifications can themselves fail; monitor their queue and logs. See [Stalwart scheduling](https://stalw.art/docs/mta/outbound/scheduling/) and [queue management](https://stalw.art/docs/mta/outbound/queue/).

## DKIM and DNS

Through the relay, SES signs: verify each sending domain as an SES identity
with Easy DKIM and publish its records (the AWS module's `dns_records`
output). The relay configuration turns Stalwart's own signing off for every
domain, new ones and key rotations included. A Stalwart signature does not
survive SES, which rewrites headers it covers, so recipients would see a
failing signature beside the passing SES one, and SES refuses a message
carrying two `DKIM-Signature` headers (`554 Duplicate header`), which then
comes back to the sender as a delivery report. Applying the relay replaces
any per-domain signing exception set by hand. `management reset` restores
Stalwart's default signing for direct delivery.

Stalwart still generates keys for each domain (automatic DKIM management with manual DNS management); they matter only for direct delivery without the relay. Obtain the domain ID from the idempotent management command, then request its typed TXT records:

```sh
docker compose --profile ops run --rm --no-deps management domain example.com
# Use the returned id below.
docker compose --profile ops run --rm --no-deps management dns DOMAIN_ID
```

Publish the returned names and values at your DNS provider, verify propagation and test signatures before sending. No DNS changes are made by this service. Protect Stalwart's data and keys in backups. Review records during key rotation, and retain old records while messages signed with those keys remain in transit. Stalwart signing and SES identity verification/signing are separate; verify alignment for the actual From domain and publish the SES-provided identity records as required. Set SPF and DMARC according to the domain's actual senders and SES configuration. The adapter reports an error if no active supported key exists; it does not verify domain ownership or DNS propagation.

## Rollback and recovery

Pause new submissions, inspect and preserve the queue, and decide how queued mail should be handled before changing routes. To restore Stalwart's default local/MX route, default scheduling, default TLS expressions and its own DKIM signing, run `docker compose --profile ops run --rm --no-deps management reset`. This allows direct MX delivery for non-local recipients and restores Stalwart's default opportunistic TLS behavior; use only when direct delivery is intended and possible. Existing queued recipients may be affected. The named relay objects and secret file are not deleted. Verify the new policy and queue, then remove the secret mount and rotate/revoke credentials when appropriate. For a fail-closed rollback, stop outbound processing instead of selecting direct delivery. Back up the data store and secret separately.
