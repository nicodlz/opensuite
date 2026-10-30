# Mail object storage on a single VPS

The standard Compose installation runs one Stalwart v1.0.1 server. Its
`config.json` keeps the structured data, configuration, mailbox indexes and
blob links in local RocksDB. By default, blobs are there too. An optional
S3-compatible blob store holds message contents, attachments, scripts and
other Stalwart blobs. It does not make the VPS replaceable without restoring
RocksDB and the secrets. It does not add a second mail server or make the
service highly available.

## OVH VPS with Backblaze B2

Create a private B2 bucket and a dedicated application key scoped to that
bucket and the mail prefix, with the read, write, list and delete capabilities
Stalwart needs. Use the S3-compatible endpoint and region supplied for that
bucket by B2, not its native API endpoint. Use HTTPS with a valid certificate.
Use the provider's current documentation for endpoint, bucket and key setup;
this repository has not tested a real B2 account. The bucket must already
exist. Do not reuse Drive, backup, or inbound ingestion credentials.

Place the application key secret in an operator-managed host file, outside the
repository and `.env`. The file must be readable by Stalwart's container uid
2000 and the parent directories traversable; restrict access to the operator
and that uid. The secret must be the only content, without a trailing newline.
Treat the key ID as sensitive operational configuration too. Edit `.env` with
these settings, replacing placeholders with the values supplied by the
operator (do not commit the file):

```dotenv
MAIL_BLOB_STORE=s3
MAIL_S3_ENDPOINT=https://s3.example.invalid
MAIL_S3_REGION=region-placeholder
MAIL_S3_BUCKET=mail-bucket-placeholder
MAIL_S3_PREFIX=mail/
MAIL_S3_KEY_ID=key-id-placeholder
MAIL_S3_SECRET_FILE=/absolute/path/to/mail-secret
MAIL_S3_ALLOW_SWITCH=1
```

The prefix is prepended literally; include the final `/` if desired. Endpoint,
region, bucket, prefix and key ID accept letters, digits, `.`, `_`, `-`, `:`
and `/` only. The secret file is mounted read-only into Stalwart and setup;
the actual secret is not sent over JMAP or stored in RocksDB. The setup job
checks the file is nonempty. Restrict Docker daemon access: container mounts
and environment values are accessible to Docker administrators.

**Changing the setting does not migrate data.** The switch below is safe only
for a new, empty installation or after the migration described below. The
explicit switch flag is a guard, not proof that migration is complete. A
changed endpoint, bucket, region or prefix can also strand data. Do not switch
back to local by simply removing these settings.

1. Keep clients and all mail writers quiesced until the switch, restart and
   verification are complete. Create the bucket, install the secret and
   configure the variables. Start the stack and run the setup job:
   `docker compose up -d` then
   `docker compose up --no-deps --force-recreate --exit-code-from stalwart-setup stalwart-setup`.
   A change reports that a restart is required; it is not active yet.
2. Restart: `docker compose restart stalwart`. Once healthy, run the same
   setup command again. It must report `active blob store upload/download
succeeded`. This is a round-trip against the active backend; it cannot
   prove which backend is active if the required restart was skipped. Confirm
   the probe object appears under the intended mail prefix with your provider's
   tools. Probe uploads are temporary and subject to Stalwart's blob purge.
3. Set `MAIL_S3_ALLOW_SWITCH=0` in `.env` and rerun setup. Later starts are
   idempotent. If configuration differs, setup fails rather than redirecting
   reads automatically. A missing S3 configuration also fails if the saved
   store is S3. Rotate a key by updating the key ID and/or file, recreating
   Stalwart so it receives the new environment and mount, then rerunning the
   probe. Coordinate provider key revocation after verification. For a change
   to the endpoint, region, bucket or prefix, migrate first and repeat the
   guarded procedure.

`ReloadSettings` applies logging and proxy configuration but does not switch
an open blob store; restarting Stalwart is mandatory. If the probe fails, keep
the existing data and investigate credentials, file access, endpoint, bucket,
TLS and server logs. Avoid logging credentials or message contents.

## Isolation and availability

Use separate private buckets for mail blobs, Drive objects and backup copies,
with different credentials and independently enforced policies. If provider
constraints require a shared bucket, use non-overlapping prefixes _and_ keys
restricted to those prefixes; verify the provider actually enforces those
restrictions. Backups must use a separate credential and failure domain where
possible, with versioning or immutable retention to protect against deletion.
Drive is a separate service and mail must not depend on its availability or
credentials. Drive is implemented as a separate service; see [Drive configuration](../development.md#drive).

The optional SES inbound S3 buffer is a separate temporary transit store with
its own AWS account policy, bucket, prefix, lifecycle and credentials. It is
not the permanent B2 mail store, Drive store, or backup. See [ingestion](../architecture/ingestion.md) for the worker and its current production limits; no real provider behaviour is claimed.

If B2 or the network is unavailable, mailbox metadata may remain available but
reading message bodies and attachments fails; writes and incoming delivery can
also fail or be deferred. Do not interpret metadata availability as proof of
mail availability. Local disk, CPU, RAM, networking and the single VPS remain
failure points. Monitor disk space, server health, object-store errors, failed
delivery, backup age and restore tests. Budget for VPS disk and snapshots,
object storage capacity, API requests, retention/versioned copies, download
and network transfer, and backup storage. Prices, free allowances and egress
rules change; consult current OVH and B2 pricing for the selected regions and
measure the workload. Do not treat a bucket as a backup by itself.

## Consistent backup and restore

Quiesce inbound and outbound traffic and all other writers, then stop Stalwart
and confirm it has exited. The stop is the consistency boundary: keep the
server stopped until **both** the complete RocksDB volume and all objects under
the configured mail prefix have been copied. Prevent other principals from
writing or deleting those objects during the copy. Capture the complete
`stalwart-data` volume including permissions, the whole mail object prefix,
the `secrets` volume, the external S3 secret, `.env`, config file, image
digest, bucket/prefix and version metadata together as one encrypted,
access-controlled backup set. Do not back up only the RocksDB files while the
server is running. Resume service only after both copies complete. Store the
backup separately from the live bucket and validate its completeness and
integrity. A local-blob installation needs the stopped RocksDB volume and
secrets; its blobs are included in RocksDB.

Restore to a fresh, empty volume and an isolated bucket/prefix or the same
bucket restored to the captured point. Restore the object copy before starting
Stalwart, preserving every key and its bytes; restore the matching RocksDB
volume and secrets, and use the matching pinned version, configuration and
credentials. Ensure the old instance and all other writers are stopped. Start
the restored instance in isolation and verify a known message and attachment,
mailbox metadata, and application health before any cutover. Never overwrite a
live bucket with an older backup while writers are active. Keep independent
copies and test recovery regularly, including encryption keys and permissions.
The encrypted backup and new-host restore procedure, including its current
Compose preflight limitation, is documented in [Backup and recovery](backup.md). Its local S3 substitute test is not a B2
compatibility test.

## Migrating local blobs to S3

Do not merely switch `BlobStore`: old links would point to absent objects.
Plan downtime, stop all writers and take and verify a complete rollback
backup. Stalwart's [database migration procedure](https://stalw.art/docs/management/maintenance/migration/)
describes an offline full export with `--config ... --export ...`, then import
into empty target stores with `--config ... --import ...`; include all families,
especially blob links and bodies. `CONFIG_PATH` must be unset for those CLI
arguments. Protect the export as it contains all configuration and secrets.
Arrange the target's S3 BlobStore configuration before import, without starting
writers; after import confirm the imported registry still points to the target
store, restart, reindex and validate messages and attachments before cutover.
The exact staging of the target registry and S3 setting for this pinned image
has not been verified by this project: rehearse the full process on copies and
consult the version-specific documentation/source before using it on production.
Retain the old volume and backup until the restored data is verified. Search
indexes and unlinked training data may require rebuilding. Do not claim a
migration succeeded from a settings update alone.

## Implementation references

The v1.0.1 [schema](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/registry/src/schema/structs.rs)
defines the `BlobStore` singleton, S3 `Custom` region, `keyPrefix`, and
`EnvironmentVariable`/`File` references. Its
[S3 backend](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/store/src/backend/s3/mod.rs)
uses path-style requests and prepends the prefix verbatim. The
[blob-store documentation](https://stalw.art/docs/storage/blob/) explains the
restart and migration requirement. See the
[S3 backend documentation](https://stalw.art/docs/storage/backends/s3/) for
write verification and failure behaviour. These sources describe Stalwart;
LocalStack tests do not establish B2 compatibility or durability.
