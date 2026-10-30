# Observability on one VPS

The Compose stack runs `observe` every five minutes. It logs one JSON
`observation` containing numeric metrics and alert codes and sends active alerts
and recoveries as JSON to a webhook. Active alerts repeat each cycle; failed
webhook deliveries are retried on the next cycle. Recovery state is in memory
and resets on restart. There is no persistent metrics store or notification
queue. Docker stores at most three 10 MB log files per container. View with
`docker compose logs --tail=100 observe` and `docker compose ps`.

## Configure

1. Copy `deploy/env.example` to `.env` and set the public hostname. Create
   `deploy/observe.env` (mode 0600) with `OBSERVE_WEBHOOK_URL=https://...` for
   an endpoint that accepts a JSON POST. Protect the URL like a password. Use
   a webhook-to-email relay if email is desired. The observer never logs the
   URL or provider error bodies. A missing or failing webhook is logged, but
   cannot notify itself; check that delivery actually arrives. Allow the
   observer outbound access to the webhook and CloudWatch/SQS endpoints.
2. Set `OBSERVE_DISK_PATH` in `.env` to an existing host directory on the
   filesystem holding Docker's data (default `/var/lib/docker`). The observer
   mounts it read-only. If important volumes are on other filesystems, monitor
   those separately. Set `OBSERVE_BACKUP_DIR` to a host directory readable by
   the container's unprivileged `node` user. The default is
   `deploy/backup-status`.
3. Have the backup system atomically update `last-success` in that directory
   **only after** a complete backup and its manifest have succeeded, for
   example write a temporary file and rename it to `last-success`. Its mtime
   is the marker; clocks must be synchronized. No backup automation or restore
   verification is provided here. Missing, future-dated or stale markers alert.
4. If ingestion is configured, create `deploy/ingest.env` (0600) with the
   variables and secrets described in [ingestion](../architecture/ingestion.md),
   then start with `docker compose --profile ingest up -d --build`. The worker
   requires a database URL, queue and storage credentials, and at least one
   Stalwart destination. Its configuration file is not included in the image.
   Give the buffer identity S3 bucket-head/list permission and SQS
   `GetQueueAttributes` in addition to its existing ingest permissions; grant
   the archive identity bucket-head access too. Use dedicated least-privilege
   identities and network restrictions.
5. Add `OBSERVE_INGEST_ENABLED=true`, `OBSERVE_QUEUE_URL`, `OBSERVE_DLQ_URL`,
   `AWS_REGION` and read-only AWS credentials to `deploy/observe.env`. The
   observer needs `sqs:GetQueueAttributes` on both queues and
   `cloudwatch:GetMetricStatistics` for SQS metrics. Optional
   `AWS_ENDPOINT_URL` targets a compatible test endpoint; do not set it to a
   real provider for local tests. Restart `observe` after changes. Set the
   public host to the certificate name; observer connects to `caddy:443` with
   that SNI. Use a different `OBSERVE_CERT_CONNECT_HOST` in observe.env if
   needed.
6. Run `docker compose up -d --build`, inspect `docker compose ps`, and test
   delivery to the webhook with a controlled failure, then confirm recovery.
   Set an independent external uptime/dead-man monitor for the VPS and the
   webhook receiver: this local job cannot alert when the whole VPS, Docker,
   its network, or the job itself is down. Avoid publishing `/ready` or the
   observer's port directly to the Internet.

Optional values in `observe.env`: `OBSERVE_INTERVAL_SECONDS` (300),
`OBSERVE_TIMEOUT_MS` (5000), `OBSERVE_BACKUP_MAX_AGE_SECONDS` (93600),
`OBSERVE_DISK_PERCENT` (85), `OBSERVE_CERT_DAYS` (21),
`OBSERVE_QUEUE_MAX_AGE_SECONDS` (3600), and `OBSERVE_DLQ_MAX_AGE_SECONDS`
(300). The readiness checks have a two-second per-dependency budget. API and
Drive Compose healthchecks use readiness; ingest does too. `/health` is
liveness only. Failed checks may take up to the next interval to reach the
webhook. Health status alone does not restart an unhealthy container.

## Alerts and response

- `api_readiness`, `drive_readiness`, `ingest_readiness` and their
  `_unavailable` variants: the service or a required dependency is down or
  timed out. Check `docker compose ps`, then query `/ready` inside the
  relevant container and inspect sanitized logs. API checks PostgreSQL and
  Stalwart; Drive checks its database and S3 bucket; ingest checks PostgreSQL,
  SQS, both S3 buckets and each configured Stalwart endpoint. Check network,
  credentials and provider status before restarting or changing data.
- `queue_age_seconds`: inbound messages are waiting too long. Check ingest
  readiness and logs, queue depth and provider health. Restore processing before
  the queue retention deadline and follow the ingestion reconciliation guide.
- `dlq_messages` / `dlq_age_seconds`: processing failed repeatedly. Inspect
  queue permissions and failures, retain source objects and investigate the
  ledger and mailbox before redrive; ambiguous imports can duplicate mail.
  `_configuration`, `_unavailable`, or `_age_unavailable` means monitoring is
  incomplete: verify URLs, IAM, region, CloudWatch and network. SQS depth and
  CloudWatch age are approximate and delayed. CloudWatch's DLQ oldest age is
  time since movement to the DLQ, not original enqueue age for standard queues;
  messages can expire sooner than it suggests. CloudWatch can exclude poison
  messages from the main queue age. Check the separate subscription DLQ and
  provider alarms described in [AWS deployment](../deployment/aws.md).
- `backup_age_seconds` or `backup_age_seconds_unavailable`: no recent success
  marker, a future marker, or inaccessible marker. Check the backup job,
  permissions, disk, clock and remote copy, then perform and verify a backup.
  Do not fabricate a marker. Regularly test a full restore and preserve keys.
- `disk_used_percent` or `disk_used_percent_unavailable`: the monitored Docker
  filesystem is near full or inaccessible. Check `df -h`, Docker volume sizes,
  backup state and log rotation. Free space safely; do not delete live volumes.
- `certificate_days` or `certificate_days_unavailable`: the presented HTTPS
  certificate is near expiry, expired, or could not be read. Check DNS, Caddy
  logs, ACME reachability, the public hostname and port 443. Renew and verify
  externally. This check reads expiry and does not validate the certificate
  chain or hostname, so use an external HTTPS check for those properties.

`webhook_not_configured` and `webhook_delivery_failed` appear in observer logs;
repair the endpoint or network and verify delivery. Monitor log access: API,
Drive, worker and observer emit JSON without request URLs, bodies, credentials,
mail addresses or object keys. API and Drive generate request IDs and return
`X-Request-ID`; IDs are local to each service. Third-party Postgres, Caddy and
Stalwart logs have their own formats and may include operational details; keep
them access controlled and review their settings before enabling verbose logs.
