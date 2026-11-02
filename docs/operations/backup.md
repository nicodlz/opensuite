# Backup and recovery on one VPS

The daily timer starts a **downtime** backup at 01:00 UTC. The controller stops
running Caddy, API, Drive, ingest, observe, Stalwart and Vault, then captures
PostgreSQL custom dumps and globals, the complete stopped Stalwart RocksDB
volume (including WAL), secrets, Caddy, configuration and the stopped Vault
volume. It hashes the current Mail and Drive object prefixes and streams them
through read-only rclone mounts into the **same encrypted restic snapshot** as
the local data. Restic deduplicates unchanged chunks across snapshots. PostgreSQL
dumps are checked for readability and the volume archives are listed. Vault
stays stopped across its dump and volume capture, including attachments and
Sends; SQLite database files are excluded because PostgreSQL is authoritative.

The snapshot is initially tagged `opensuite-pending`. After restarting the
previously running services, the job mounts that exact snapshot, reads back and
compares its local files and object hashes, and promotes it to
`opensuite-verified` only if all checks pass. This verifies the captured bytes
are readable and match the fenced sources; it does not start a replacement
application or prove provider durability. Exercise actual isolated restores
regularly. A failed capture or readback leaves the previous verified snapshot
untouched. Pending snapshots are never selected for recovery.

[Stalwart's backup procedure](https://stalw.art/docs/management/maintenance/backup/)
permits stopping the server and copying the complete RocksDB directory before
its blob store, without an intervening blob purge. A file-by-file RocksDB copy
while Stalwart is running is unsafe. Hashing and uploading large object
prefixes while services are stopped can cause long downtime, even though
unchanged chunks are deduplicated. The complete readback and pruning occur after
services restart. Measure the window with representative data.

**Capacity and isolation.** Mail and Drive object contents are not copied in
full to local scratch. The helper uses read-only FUSE mounts and bounded rclone
buffers; listings, manifests and restic's working memory still grow with the
number of objects. Scratch must be a private encrypted filesystem large enough
for uncompressed PostgreSQL dumps, stopped volumes, configuration, manifests,
restic's executable and working space. `BACKUP_SCRATCH_RESERVE_BYTES` defaults
to 4 GiB and checks minimum free space before quiescing; size it for the actual
installation. A full filesystem during capture fails the job. Scratch is
removed on normal exit or handled termination; the next lock holder removes
stale stages after a crash.

Docker must support `/dev/fuse`. The pinned streaming helper has `SYS_ADMIN`
and an unconfined AppArmor profile to mount FUSE; it can read the backup and
object credentials and the private stage. Treat Docker administrators and this
helper as trusted, restrict host access and network access, and use a dedicated
backup host or stronger isolation if this permission is unacceptable. The job
and restore fail when FUSE is unavailable. Source object names must be
representable by rclone's filesystem mount; test unusual names and large files
with the actual provider. No 10 TB file or real B2 limit has been proven.

`BACKUP_BUDGET_BYTES` is the operator's restic repository budget. Before stopping
services the job compares it to restic's raw-data statistics. It emits
`storage_near_limit` at 80% or when current usage plus the full source size and
scratch reserve could exceed the budget. A successful run with that warning
writes `capacity` to `last-failure`, causing the existing observer's generic
`backup_failure` alert while still updating `last-success`; the next successful
run without a warning clears it. An already exhausted budget emits
`storage_budget_exceeded`, fails before stopping services and reports failure.
When no independently restored recovery point is pinned, successful backups
write `verification` to `last-failure` and emit `retention_waiting_restore`;
the observer also reports its generic `backup_failure` alert. Alert on those
events, observer failures, missing or stale success, and provider
quota and billing independently. Restic statistics exclude some provider-side
versions, incomplete uploads, unreferenced packs and other prefixes; this is
not a provider free-space check. Quota, network, repository, scratch or key
failures can still stop backups. Add capacity before exhaustion and investigate
failed jobs rather than silently accepting an aging recovery point.
If the budget is already reached, increase it and any provider quota as needed,
or run the guarded retention maintenance described below. Maintenance cannot
reclaim data still required by the policy or its pins, and a prune may itself
need temporary provider space. A failed daily run remains failed until a later
backup succeeds; maintenance does not publish a new success marker.

**Scope and fencing.** The snapshot captures current object bytes, not old
versions, bucket policies, incomplete multipart uploads or arbitrary S3
metadata. Drive's database holds content types; pending uploads must be retried.
Use separate Mail and Drive buckets or non-overlapping prefixes. Before every
capture fence independent ingestion workers, cron jobs, external database
writers, presigned upload clients, other S3 writers/deleters, lifecycle jobs,
migrations, setup jobs and concurrent Compose changes. The controller cannot
stop external writers or backup jobs on another host. The optional Compose
ingestion worker is stopped and restarted if running. The inbound buffer and
notification archives are separate recovery requirements; see
[inbound retention](../architecture/ingestion.md#retention-and-backup-coverage).

## Provision and schedule

1. Install the checkout on an encrypted host, configure the services, and create
   a private B2 S3-compatible repository and application key separate from Mail
   and Drive. The backup key needs list, read, write and delete for restic locks,
   snapshot retention and pruning. Restrict the repository prefix and TLS, and
   protect against compromised credentials with a separately administered copy.
   No real B2 behavior has been verified by this project.
2. Copy `deploy/backup/backup.conf.example` to `/etc/opensuite/backup.conf`,
   mode 0600. Set the repository, key, encrypted scratch, budget and retention
   values. Store a strong random restic password in the named mode-0600 file.
   Keep independent offline copies of the password, backup key, repository URL,
   Git revision, image pins and this procedure. Never keep the only copy inside
   this Vault. The snapshot contains `.env`, object and relay credentials, TLS,
   ingest and observe files when configured, generated secrets, and configured
   Vault admin, SMTP and push secrets. Restrict access. Configuration files are
   trusted POSIX shell assignments.
3. Run `deploy/backup/init.sh` once for a new empty repository. It never
   auto-initializes after an access error. Run `deploy/backup/backup.sh`, check
   the `success` event and verify a restore. Failures, overlap, restart failure,
   a missing success marker and age must alert. A failed job can leave a pending
   snapshot or an already verified snapshot; do not treat either as a successful
   run solely by its timestamp. The `snapshot_verified` event includes the
   promoted snapshot ID and capture time. Record both and the overall successful
   job outcome independently.

   Vault is detected from its existing Compose container, database or profile.
   Set `BACKUP_VAULT_ENABLED=1` for every installation using Vault so a missing
   database cannot look like an unused profile. Missing Vault keys or unreadable
   data fail the whole backup. `BACKUP_VAULT_EXCLUDE=1` is an emergency opt-out;
   it emits `vault_explicitly_excluded` and the snapshot cannot recover Vault.
   Vault capture failures write `vault` to `last-failure` and observe reports
   `backup_vault_failure`; other failures and capacity or verification warnings
   report `backup_failure`. An overlapping run does not change markers. Monitor
   systemd/journal independently if markers cannot be written.

   After successful verification, retention and cleanup, the job publishes
   `last-ingest-capture` and atomically replaces `last-success`. The capture
   time is also in `config/ingest-capture-start`. It is an operational hint,
   not proof that any message and all envelope recipients are covered; follow
   the [inbound retention procedure](../architecture/ingestion.md#retention-and-backup-coverage).

4. Install `deploy/backup/opensuite-backup.service` and
   `deploy/backup/opensuite-backup.timer` in `/etc/systemd/system/`, adjust paths,
   run `systemctl daemon-reload`, then enable the persistent timer with
   `systemctl enable --now opensuite-backup.timer`. Check the journal and timer.

## Retention and independent copies

Byte readback alone does not prove an application can open the recovered data.
After an independent isolated restore has successfully checked PostgreSQL,
RocksDB, Mail, Drive and Vault as applicable, the operator must attest that
specific verified snapshot using its full ID:

```sh
deploy/backup/mark-restorable.sh SNAPSHOT_ID --confirm-restored SNAPSHOT_ID
```

The operator must have actually completed the isolated restore and checked the
bytes and application behavior; the command records that assertion and cannot
verify the human procedure. Tagging changes the restic snapshot ID: record the
new ID in the `snapshot_restorable` event and update the independent recovery
record. The command refuses pending or unverified snapshots. Keep an independent
record of the evidence and repeat the drill regularly. Before retiring an older
pin, follow the inbound retention procedure and confirm that a newer independent
restore has succeeded and its pin is recorded. Then supply both full pinned IDs:

```sh
deploy/backup/retire-restorable.sh OLD_PIN_ID --confirm-replacement NEW_PIN_ID
```

The command refuses a missing, unverified, unpinned, older, identical or
future-dated replacement and leaves the replacement pin in place. Removing the
old pin changes that snapshot's ID; record the `snapshot_unpinned` event. This
does not immediately delete the snapshot: the next retention pass applies the
declared policy. Keep the only pin until another independent restore is proven.

Until a recovery point is pinned, backup still runs but **does not forget or
prune any snapshots**, and raises `retention_waiting_restore` and the observer
warning described above. After a pin exists and each newer capture passes byte
readback, the job applies `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY` and
`BACKUP_KEEP_MONTHLY` (defaults 7, 5 and 12), grouping by captured path. It
always preserves every pinned snapshot, all snapshots newer than the newest pin
(with a time margin), and at least the two newest verified snapshots. This means
long gaps between full restore drills require more storage; monitor the budget
and advance the pin after a newer independent restore. Once a pin exists the
job retains one pending snapshot for investigation and does not forget legacy
untagged snapshots. Forget and prune run separately. If prune is interrupted,
the retained verified snapshots remain referenced and the next successful
verified backup retries it. The job invokes restic's stale-only `unlock` after
a prune failure and before a new backup. If the entire helper or host is killed,
a recent lock from its former container may remain until restic considers it
stale; an early retry fails and alerts rather than forcing the lock. Investigate
persistent locks and outages. Never use a forced unlock while another host could
be writing.

If a daily backup has stopped at the repository budget, an operator may run
`deploy/backup/retention.sh` from the configured checkout. It takes the same
host lock and applies the same policy without creating a new snapshot, and
refuses to prune without an independent restore pin. Fence other hosts first.
If no snapshots are eligible, or the provider has too little working space for
prune, add capacity; never remove the last restorable copy to make room.
Restic retention is a rolling selection, not a promise of 7+5+12 distinct
snapshots. Before retiring any recovery point, follow the inbound retention
procedure for originals and every envelope recipient covered by that snapshot.
Do not apply an independent age-only lifecycle to restic packs. Provider
versioning may retain hidden versions and add costs.

For a secondary copy, use a separately administered host with read-only access
to the primary repository and append-only or write-only access to a separate
repository. Pull with `restic copy`; the production host must not hold secondary
credentials. Restrict secondary deletion independently, verify its retention
semantics with the provider, and rehearse recovery from it. Compare the chosen
snapshot ID and capture time with the independent record to detect rollback.
See [Vault recovery](vault-recovery.md).

## Rebuild a new VPS

1. Fence the old host and external writers. Install Docker/Compose with FUSE,
   Git, `flock`, the recorded Esuno revision and pinned images. Build the app
   images and run `pnpm install --frozen-lockfile && pnpm build` for that
   revision. Provision encrypted scratch and private, empty Mail and Drive
   buckets/prefixes. They must match the saved `.env` and Stalwart registry;
   for a drill use isolated accounts, DNS and networking. Preserve any original
   data independently and never point the recovery host at live destinations.
2. Restore the escrowed backup configuration and restic password under
   `/etc/opensuite`. In a clean checkout with no `.env` and empty Compose volumes,
   set `COMPOSE_PROJECT_NAME=recovery` and run `deploy/backup/restore.sh`, or
   pass an explicit verified snapshot ID. Default `latest` selects the newest
   verified streaming snapshot; if none exists it falls back to the latest
   legacy snapshot, provided that snapshot is not pending. Older untagged
   snapshots can also be selected by ID and require scratch for their full
   object copies. If more than one snapshot path group matches, `latest` is
   refused and an explicit ID is required. Pending snapshots are rejected.
   The controller restores local data to scratch and streams objects directly
   from the mounted restic snapshot to the destination.
   Both object prefixes are checked and dry-run listed before local state is
   cleared. It restores config, secrets, RocksDB, both app databases and the
   Vault database and volume, but starts only PostgreSQL.

   `restore.sh --force --confirm-project recovery [snapshot-id]` replaces local
   volumes and files only when every target service is stopped. Existing objects
   must be an exact byte-matching subset of the selected snapshot; missing
   objects are copied without overwriting and the complete prefixes are checked.
   Fence all writers for a retry. A failure can leave partial state: discard the
   target or carefully retry with `--force`. If the project matches `opensuite`,
   the repository Compose name or the project name in the current or saved
   `.env`, add `--i-understand-this-is-production` after the project name only
   after explicitly fencing and accepting replacement of that production
   project. An unresolved repository name also requires that acknowledgement.

3. Inspect `.env`, permissions, secrets, image pins and `config/git-revision`.
   Start services only in the intended isolation. Verify known mail and
   attachments, mailbox, calendar, Drive file, app databases and Vault item,
   attachment and RSA key. Test SMTP and queue behavior in isolation; restored
   queue entries can be delivered again. Reconcile the inbound archive and
   ledger before replay or cutover. Only then enable external traffic, scheduled
   workers, backups and DNS. Record timings and results. See
   [Vault recovery](vault-recovery.md) for Vault-specific checks.

## Objectives, tests and pending proof

The daily schedule has a nominal loss window of up to 24 hours plus capture
time. Failed or missed runs, unavailable providers or lost keys extend it;
all changes since the last verified capture can be lost. Provider versioning
alone does not coordinate RocksDB, PostgreSQL, secrets and object mappings. More
frequent coordinated snapshots could reduce the nominal window but increase
downtime and load; there is no implemented WAL/PITR or continuous backup. RTO is
not established: measure a representative replacement-host restore, validation
and cutover before making a commitment.

Run `./scripts/backup-integration.sh` for isolated disposable Compose projects
and SeaweedFS, or `node scripts/backup-restore-drill.mjs --report
/tmp/vault-drill.xml` for the Vault-inclusive drill. They do not call AWS or B2.
They exercise recovery, byte checks, capacity failures, deduplication and
interrupted pruning; fixture results do not prove provider behavior or VPS RTO.

After explicit authorization, an independent operator should restore a
recorded snapshot on a replacement VPS using escrowed credentials, a private B2
repository and isolated empty Mail/Drive destinations. Prevent live writes,
outbound mail, push and public traffic. Record the selected snapshot, versions,
capacity, duration and results independently. Success requires PostgreSQL and
RocksDB to open, known mailbox messages, attachments and Drive files to match
independently recorded bytes, and Vault sign-in, item, attachment and RSA key
verification. Reconcile the restored ledger and every envelope recipient with
retained originals and notifications before cleanup. Test failure recovery
without endangering production, then remove decrypted scratch and the isolated
target. This real-provider and replacement-VPS proof remains pending.
