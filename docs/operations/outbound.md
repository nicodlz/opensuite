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
Settings are not transactional: after a failed `apply` or `reset`, run the same command again until it succeeds before any reload or Stalwart restart, or mail may leave unsigned by direct MX delivery. Missing routes can fall back to direct MX;
alert on `smtp.id-not-found` and configuration errors. The helper checks the
mounted relay secret, so applying with `/dev/null` fails. Recreate Stalwart
and verify delivery after rotating the file.

The remote queue has one delivery thread, retries after 5 minutes, 30 minutes and then 2 hours, a delay notification after 4 hours and expiry after 24 hours. Stalwart generates delivery failure notifications for failures/expiry; monitor them and the queue. One thread limits concurrency, **not** messages per second or daily volume: enforce SES account rate and rolling quotas upstream, including all senders and other services. Control traffic also follows the relay and the same schedule. Delivery notifications can themselves fail; monitor their queue and logs. See [Stalwart scheduling](https://stalw.art/docs/mta/outbound/scheduling/) and [queue management](https://stalw.art/docs/mta/outbound/queue/).

## DKIM and DNS

Through the relay, SES signs: verify each sending domain as an SES identity
with Easy DKIM and publish its records (the AWS module's `dns_records`
output). The relay configuration turns Stalwart's own signing off for every
domain, new ones and key rotations included: SES refused messages already
carrying Stalwart's signatures (`554 Duplicate header 'DKIM-Signature'`,
returned to the sender as a delivery report), and a single Stalwart
signature failed at the recipient after relaying. DMARC alignment therefore
rests on SES alone, so every domain that sends must keep a verified SES
identity with signing enabled. Check it before a new domain sends, and
before applying the relay:

```sh
aws sesv2 get-email-identity --region eu-north-1 --email-identity DOMAIN \
  --query '{s:VerifiedForSendingStatus,d:DkimAttributes,m:MailFromAttributes}'
```

It must show `VerifiedForSendingStatus` true, `DkimAttributes` with
`SigningEnabled` true, `Status` `SUCCESS` and, for Easy DKIM,
`SigningAttributesOrigin` `AWS_SES`, and, when a custom MAIL FROM is
configured, `MailFromDomainStatus` `SUCCESS`. Applying the relay replaces any per-domain signing exception set
by hand. Installations that applied the relay before this rule must apply it
again once (the setup status shows the relay as needing attention until
then); messages already queued keep the signatures they were given and may
come back as delivery reports. Afterwards, `x:MtaStageData` shows
`dkimSignDomain` as always false. `management reset` restores Stalwart's
default signing for direct delivery. Reports Stalwart generates are configured apart and are not changed: a delivery report (DSN) is sent from `MAILER-DAEMON@` its report domain (`x:DsnReportSettings` `fromAddress`) and signed by its own `dkimSignDomain`. Before relying on reports to external addresses through the relay, prove with a real report that its From is a verified SES identity the SMTP user's IAM policy allows (`ses:FromAddress` conditions name exact domains, not their subdomains) and that it carries no Stalwart signature; otherwise SES refuses it.

Stalwart still generates keys for each domain (automatic DKIM management with manual DNS management); they matter only for direct delivery without the relay. Obtain the domain ID from the idempotent management command, then request its typed TXT records:

```sh
docker compose --profile ops run --rm --no-deps management domain example.com
# Use the returned id below.
docker compose --profile ops run --rm --no-deps management dns DOMAIN_ID
```

Publish the returned names and values at your DNS provider, verify propagation and test signatures before sending. No DNS changes are made by this service. Protect Stalwart's data and keys in backups. Review records during key rotation, and retain old records while messages signed with those keys remain in transit. Stalwart signing and SES identity verification/signing are separate; verify alignment for the actual From domain and publish the SES-provided identity records as required. Set SPF and DMARC according to the domain's actual senders and SES configuration. The adapter reports an error if no active supported key exists; it does not verify domain ownership or DNS propagation.

## Rollback and recovery

Before `management reset`, make sure Stalwart's DKIM records are published for every sending domain: direct delivery is signed with them. Pause new submissions, inspect and preserve the queue, and decide how queued mail should be handled before changing routes. To restore Stalwart's default local/MX route, default scheduling, default TLS expressions and its own DKIM signing, run `docker compose --profile ops run --rm --no-deps management reset`. This allows direct MX delivery for non-local recipients and restores Stalwart's default opportunistic TLS behavior; use only when direct delivery is intended and possible. Existing queued recipients may be affected. The named relay objects and secret file are not deleted. Verify the new policy and queue, then remove the secret mount and rotate/revoke credentials when appropriate. For a fail-closed rollback, stop outbound processing instead of selecting direct delivery. Back up the data store and secret separately. Before returning to a release that does not manage signing, run `management reset` (or restore `dkimSignDomain` by hand) if direct delivery will be used, as that release leaves Stalwart's signing off.
