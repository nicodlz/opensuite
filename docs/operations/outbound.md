# Outbound mail through SES

Stalwart owns the persistent outbound queue and sends non-local recipients through the configured SMTP relay. Local domains retain local delivery. A successful JMAP submission means the message was queued; SMTP acceptance by SES is also not proof of recipient delivery. Configure SES event publishing and monitor bounces, complaints, delivery failures, queue age and expiry separately. The management integration is server-side only. No real SES connection has been tested by this repository.

## Prepare SES and credentials

1. In **eu-north-1**, verify the sender identity and request production access if needed. The current sending rights cover only the verified identity; do not assume other identities are authorized. In the SES sandbox, recipients must also be verified (or use the mailbox simulator), and default quotas are 200 messages per 24 hours and 1 message per second. Check the actual account quotas in SES; request increases before using higher throughput. SES counts recipients against quotas.
2. Generate SMTP credentials for the same region in SES. These are distinct from ordinary AWS API credentials. Store the SMTP password in a restricted file outside the repository and `.env`. The SMTP username is not the password. SES documents [STARTTLS on port 2587](https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html); the configured endpoint is `email-smtp.eu-north-1.amazonaws.com:2587`, with mandatory STARTTLS and certificate validation. Do not use the adapter's insecure test mode for SES.
3. Put the file path in the shell environment as `MAIL_RELAY_SECRET_FILE` when starting Compose; it is mounted read-only as `/run/opensuite/smtp-secret` in Stalwart. The file and parent directories must be readable/traversable by Stalwart's UID 2000. The server reads the file as a secret reference; the password is not sent in the management API. Back up and rotate it securely. Recreate Stalwart after replacing the bind-mounted file or changing its path; reload and verify delivery after rotation. Do not put the value in logs, environment files or Git.

## Apply

The setup command uses Node 22.18+ and the workspace dependencies. Run from a trusted host with a local management listener; this optional overlay exposes port 18080 only on loopback. Use a private administrator password file and remove it after use. Set the SMTP username separately; the placeholder below is not a credential.

```sh
export MAIL_RELAY_SECRET_FILE=/secure/path/smtp-password
docker compose -f compose.yaml -f deploy/stalwart/compose.outbound.yaml up -d stalwart
umask 077
docker compose exec -T stalwart cat /run/opensuite/stalwart-admin/password > /secure/path/admin-password
node --experimental-strip-types scripts/outbound.mjs apply http://127.0.0.1:18080 /secure/path/admin-password SMTP_USERNAME
rm /secure/path/admin-password
```

Remove the overlay and recreate Stalwart when management access is no longer needed. The command reconciles named route, virtual queue, schedule and TLS objects, verifies their stored values, changes the singleton strategy, and calls `ReloadSettings`. Repeated sequential runs are safe. Serialize management changes; a timeout can mean the server applied a write, so reconcile by running again and checking logs. Settings are not transactional: pause submissions and inspect errors if configuration fails partway through. Ensure the named objects are never deleted while the strategy references them: [Stalwart falls back to MX](https://stalw.art/docs/mta/outbound/strategy/) for missing routes. Alert on `smtp.id-not-found` and configuration errors. Check actual server logs and send a controlled message after applying; API success alone does not prove active delivery.

The remote queue has one delivery thread, retries after 5 minutes, 30 minutes and then 2 hours, a delay notification after 4 hours and expiry after 24 hours. Stalwart generates delivery failure notifications for failures/expiry; monitor them and the queue. One thread limits concurrency, **not** messages per second or daily volume: enforce SES account rate and rolling quotas upstream, including all senders and other services. Control traffic also follows the relay and the same schedule. Delivery notifications can themselves fail; monitor their queue and logs. See [Stalwart scheduling](https://stalw.art/docs/mta/outbound/scheduling/) and [queue management](https://stalw.art/docs/mta/outbound/queue/).

## DKIM and DNS

Create a domain through the server-side `StalwartAdmin.createDomain` provisioning function. Stalwart's default automatic DKIM management generates domain keys with manual DNS management. `StalwartAdmin.dkimRecords(domainId)` returns typed TXT records for active keys; alternatively, with the same temporary management access:

```sh
node --experimental-strip-types scripts/outbound.mjs dns http://127.0.0.1:18080 /secure/path/admin-password DOMAIN_ID
```

Publish the returned names and values at your DNS provider, verify propagation and test signatures before sending. No DNS changes are made by this service. Protect Stalwart's data and keys in backups. Review records during key rotation, and retain old records while messages signed with those keys remain in transit. Stalwart signing and SES identity verification/signing are separate; verify alignment for the actual From domain and publish the SES-provided identity records as required. Set SPF and DMARC according to the domain's actual senders and SES configuration. The adapter reports an error if no active supported key exists; it does not verify domain ownership or DNS propagation.

## Rollback and recovery

Pause new submissions, inspect and preserve the queue, and decide how queued mail should be handled before changing routes. To restore Stalwart's default local/MX route, default scheduling and default TLS expressions, run `node --experimental-strip-types scripts/outbound.mjs reset http://127.0.0.1:18080 /secure/path/admin-password`. This allows direct MX delivery for non-local recipients and restores Stalwart's default opportunistic TLS behavior; use only when direct delivery is intended and possible. Existing queued recipients may be affected. The named relay objects and secret file are not deleted. Verify the new policy and queue, then remove the secret mount and rotate/revoke credentials when appropriate. For a fail-closed rollback, stop outbound processing instead of selecting direct delivery. Back up the data store and secret separately.
