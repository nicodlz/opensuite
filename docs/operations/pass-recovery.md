# Pass recovery after server loss

Pass uses the shared OpenSuite restic repository. Each successful capture stops
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
access for more than one authorized operator and test retrieval. Protect the
master passwords and user recovery factors separately: the server backup cannot
recover a forgotten master password.

Protect against compromise or deletion of the primary B2 account with an
independently administered second location or provider and separate credentials.
For example, use `restic copy` to a second repository, with append-only access
or object lock where compatible with that repository's retention and pruning;
keep the second repository's password and credentials in independent escrow.
Verify copies and practice recovery from that location. Restic encryption alone
does not prevent deletion or rollback by a compromised backup account.

## Restore to a new VPS

1. Fence the lost/old server and external writers. Obtain the escrowed restic
   password, B2 key, repository URL and configuration. Prepare a new VPS with
   Docker Compose, Git, `flock`, the saved OpenSuite revision, pinned images,
   encrypted private scratch and empty Compose volumes. Prepare empty isolated
   mail and Drive object prefixes matching the saved configuration. See
   [backup operations](backup.md#rebuild-a-new-vps) for full prerequisites,
   service dependencies and build steps. No real B2 recovery has yet been
   verified by this project.
2. Install the escrowed recovery `backup.conf` and restic password under
   `/etc/opensuite` with restricted permissions. In the clean checkout, with no
   `.env`, run:

   ```sh
   deploy/backup/restore.sh                  # latest snapshot
   # Or select a known snapshot:
   deploy/backup/restore.sh SNAPSHOT_ID
   ```

   The controller restores configuration and secrets, the volume and the
   dedicated `opensuite_pass` role/database, then leaves Pass stopped. For an
   isolated partial target, stop all project services and use
   `deploy/backup/restore.sh --force SNAPSHOT_ID` to replace local state. It
   refuses populated object prefixes unless they exactly match the selected
   snapshot. A failed restore can leave partial state; discard the target or
   carefully retry with `--force`. Never use this against a live system.

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
