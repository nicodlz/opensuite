# Pass recovery after server loss

Pass uses the shared Esuno restic repository. Each successful capture stops
Pass, takes a custom PostgreSQL dump and copies its local volume while it is
still stopped. This preserves `rsa_key*`, `config.json` when present,
attachments, Sends and the optional icon cache; no live PostgreSQL or SQLite
files are copied. The generated Pass database credential is in the Compose
secrets archive; the configured admin hash and optional SMTP/push files are
captured separately. Configured files must be readable and nonempty. The
snapshot also includes sensitive configuration, database metadata, keys and
ciphertext, so restrict access to the repository and encrypted scratch.

## Prepare before a disaster

Set `BACKUP_PASS_ENABLED=1` in `/etc/opensuite/backup.conf`, enable the timer
and verify a successful snapshot and alerts as described in [backup
operations](backup.md). Keep the restic password and B2 application key
**off-server**, along with the repository URL, region, backup configuration,
recorded Git revision, image pins, provider account recovery information and
this procedure. Escrow separate copies in an access-controlled offline medium
and a separate password manager or organizational recovery vault; arrange
access for more than one authorized operator and test retrieval. Never store the
restic password or B2 key only in this Pass instance. Escrow the plaintext admin
token separately as well as its backed-up hash. Protect the
master passwords and user recovery factors separately: the server backup cannot
recover a forgotten master password.
Record each successful snapshot ID and capture time in an independently
administered log; the restic JSON backup output includes the snapshot ID.

Protect against compromise or deletion of the primary B2 account with a
separately administered backup host. That host pulls snapshots from the primary
repository using a read-only key and runs `restic copy` to a secondary
repository using its own append-only or write-only credential. For example,
use `rest-server --append-only`, or a B2 key without `deleteFiles` with Object
Lock configured and tested for the chosen retention policy. Grant any read and
list operations restic requires while denying deletion. The production host
must never hold secondary credentials. Only the separate administration host
may prune the secondary; keep any secondary prune/delete key offline until it
is needed. Verify and restore from the second location independently, and test
provider-specific retention and lock behavior before relying on it.

## Restore to a new VPS

1. Fence the lost/old server and external writers. Obtain the escrowed restic
   password, B2 key, repository URL and configuration. Prepare a new VPS with
   Docker Compose, Git, `flock`, the saved Esuno revision, pinned images,
   encrypted private scratch and empty Compose volumes. Prepare empty isolated
   mail and Drive object prefixes matching the saved configuration. See
   [backup operations](backup.md#rebuild-a-new-vps) for full prerequisites,
   service dependencies and build steps. No real B2 recovery has yet been
   verified by this project.
2. List repository snapshots with `restic snapshots` on a trusted recovery host
   configured with the escrowed credentials. Compare the selected snapshot ID
   and timestamp against the independently recorded last success before
   trusting it, to detect rollback. Select the verified ID explicitly below.
   Install the escrowed recovery `backup.conf` and restic password under
   `/etc/opensuite` with restricted permissions. In the clean checkout, with no
   `.env`, select the intended isolated project for this shell and run:

   ```sh
   export COMPOSE_PROJECT_NAME=recovery
   deploy/backup/restore.sh                  # latest snapshot
   # Or select a known snapshot:
   deploy/backup/restore.sh SNAPSHOT_ID
   ```

   The controller restores configuration and secrets, the volume and the
   dedicated `opensuite_pass` role/database, then leaves Pass stopped. For an
   isolated partial target, stop all project services and use the following
   command to replace local state:

   ```sh
   export COMPOSE_PROJECT_NAME=recovery
   deploy/backup/restore.sh --force --confirm-project recovery SNAPSHOT_ID
   ```

   Both object prefixes are checked and dry-run listed before local state is cleared.
   Existing objects must match the snapshot; missing objects are copied and the
   complete prefixes are verified. Keep `COMPOSE_PROJECT_NAME` exported for all
   subsequent Compose commands, even if the recovered `.env` records another
   project name. A failed restore can leave partial state; discard the target or
   carefully retry with `--force`. Never use this against a live system.

   If the confirmed project matches `opensuite`, the repository Compose name,
   or the name recorded in the current or saved `.env`, the command requires
   `--i-understand-this-is-production` immediately after the project name. Use
   it only after explicitly fencing the production project and accepting its
   replacement. The same acknowledgement is required if the repository's
   Compose name cannot be determined.

3. Check the saved image version, `.env`, file permissions and effective
   `config.json`, and ensure the intended hostname/TLS and SMTP settings are
   correct. Start Pass with `docker compose --profile pass up -d pass caddy`.
   In an isolated network, sign in with the same master password and verify a
   known item, an attachment and the server RSA key against independently
   recorded evidence. Exercise MFA and invitation/recovery workflows if used.
   Only reconnect clients and enable external traffic after verification.

The RSA signing key is restored, so recovery does not deliberately invalidate
all existing sessions or tokens. Individual tokens may nevertheless expire or
be revoked, and state changes after the selected snapshot are lost. If the
old host or credentials may be compromised, revoke sessions and rotate the
relevant credentials using a separately reviewed incident procedure.

## Independent recovery tests and expected loss

At least quarterly, and after changes to the backup, Vaultwarden version,
credentials or storage, retrieve the escrowed material independently and
restore a recent snapshot to a separate disposable VPS or isolated Compose
project and object store. Fence the original writers and prevent test mail,
push, public DNS or external access. Verify login with a test account, decrypt
a known item, download and compare an attachment, compare the RSA key, check
the admin credential and record snapshot time, results and elapsed recovery
time. Test the secondary location separately. Destroy the isolated target and
its decrypted scratch after verification. Never write an unencrypted vault
export to disk.

The automated check `node scripts/backup-restore-drill.mjs --report
/tmp/pass-drill.xml` tests a local substitute, not real B2 or a production-sized
restore. The daily schedule has a nominal loss window of up to 24 hours plus
capture time. All Pass changes since the last successful coordinated snapshot
may be lost; failed or missed runs extend that window. There is no continuous
backup or PostgreSQL point-in-time recovery. Measure actual recovery time with
a representative independent restore.
