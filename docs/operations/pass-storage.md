# Pass storage evaluation

This is a disposable evaluation, not production configuration. The decision is
in [ADR 0003](../adr/0003-pass.md). Production keeps Vaultwarden's data volume
and encrypted restic backups to a separate private B2 location, plus coordinated
PostgreSQL-native backups and recovery testing.

## Reproduce

Prerequisites: Docker with Compose and Buildx, Git, OpenSSL, Node.js and pnpm,
and the Playwright Chromium installed for the repository's pinned version
(`pnpm exec playwright install chromium`). Run from the repository root:

```sh
pnpm install --frozen-lockfile
./deploy/vaultwarden-s3-poc/build.sh
node scripts/pass-storage-poc.mjs --report /tmp/pass-storage.json
```

The build script checks out upstream tag 1.37.4 at commit
`7c188967e7a467b19b2757bc3326f9cf3ccae327` into a temporary directory. It
uses upstream's Debian Dockerfile and `DB=postgresql,s3` build argument, with
the two otherwise mutable Rust and Debian base tags replaced by pinned digests;
upstream's web vault and cross-build helper are already pinned. Source files
are not changed. OS packages are still fetched from mutable Debian repositories;
this is not a reproducible or attested supply-chain build. The image is named
`opensuite-vaultwarden-s3-poc:1.37.4` and must not be deployed.

The runner creates a unique Compose project and prefix, random loopback ports,
a loopback HTTPS proxy with a temporary self-signed certificate, a temporary
account and random files. Because Vaultwarden returns presigned S3 download
URLs, a second temporary HTTP relay binds only to the Docker host bridge on a
random port; it lets both Vaultwarden and the host CLI reach the same LocalStack
endpoint. Do not expose this relay beyond the local Docker host. The bundled web vault creates the account; pinned
Bitwarden CLI 2026.8.0 encrypts and handles items, attachments and Sends. The
instance permits signup and disables the admin token **only for the proof**.
PostgreSQL and LocalStack are disposable; PostgreSQL fsync is disabled. The
runner disconnects Vaultwarden from its S3 network while leaving its database
network connected through a test-only Caddy gateway, then reconnects it. In LocalStack mode it also makes the
client-facing relay unavailable. In B2 mode the client may still be able to
read an already presigned URL directly even when the server cannot reach B2;
the test reports this distinction. It writes a JSON report and removes its
containers, volumes, networks and temporary client state on normal completion,
failure, SIGINT or SIGTERM. An uncatchable termination or Docker failure may
require manual cleanup; the report identifies the unique project/prefix. It
never prunes resources belonging to another project. LocalStack is a simulator,
not evidence of B2 compatibility or durability.

## Optional B2 run

The same command runs the local cases first and then the B2 cases only if all
four required variables are set. Otherwise the report says `not run: no
credentials`. Use an empty, private test bucket or a key constrained to a
nonempty test prefix. Obtain the test key securely, keep it out of shell
history, and export it in the operator's environment before running:

```sh
export PASS_B2_TEST_ENDPOINT='https://s3.<region>.backblazeb2.com'
export PASS_B2_TEST_BUCKET='<test-bucket>'
export PASS_B2_TEST_PREFIX='pass-storage-tests/'
# Read the prefix-restricted test credentials without putting them in history.
read -r -s -p 'Test key ID: ' PASS_B2_TEST_KEY_ID; printf '\n'
read -r -s -p 'Test application key: ' PASS_B2_TEST_APP_KEY; printf '\n'
export PASS_B2_TEST_KEY_ID PASS_B2_TEST_APP_KEY
node scripts/pass-storage-poc.mjs --report /tmp/pass-storage-b2.json
```

`PASS_B2_TEST_REGION` is optional for a standard B2 hostname and required if
the region cannot be inferred. Prefix must end in `/`; the runner appends a
random project ID and removes only that unique subprefix. The key must allow
list, read, write, and deletion of objects and their versions/delete markers
within that prefix; verify B2's actual prefix restrictions before using it. The
runner lists and deletes every version and marker it created, verifies the
prefix is empty, and reports cleanup failures. Retention, legal holds, missing
permissions, interruption or network failure can prevent deletion; inspect the
reported prefix and clean it manually. Requests incur provider charges. Docker
administrators can inspect container environment variables. Credentials are
never embedded in S3 URIs or the JSON report; use a short-lived, dedicated key
and revoke it after the test.

## S3 options and operational assessment

In an S3-enabled 1.37.4 build, `DATA_FOLDER` can be an S3 URI, but the proof
keeps it local and sets `ATTACHMENTS_FOLDER` and `SENDS_FOLDER` separately to
`s3://bucket/prefix/attachments?...` and `s3://bucket/prefix/sends?...`.
The query parameters set `endpoint`, `region`,
`enable_virtual_host_style=false` and `default_storage_class=STANDARD`.
Vaultwarden otherwise defaults to virtual-host style and `INTELLIGENT_TIERING`;
path style and `STANDARD` avoid assuming that a compatible endpoint supports
AWS-specific addressing and storage classes. URI option values must be URL
encoded. The proof uses `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` through
the upstream AWS credential chain; it does not establish support for `_FILE`
variants. Keep the data directory, temporary files, configuration and RSA keys
on local persistent storage, never on a live PostgreSQL filesystem in B2.
Saved `config.json` can override environment settings. Production would require
separate credentials and restricted access, encryption, lifecycle and a tested
consistent database/object/key backup and restore process.

The S3 implementation is an optional compile-time feature, not part of the
selected official image. Each upgrade would require rebuilding and maintaining
the Rust dependency chain, pinning and reviewing build inputs, producing and
verifying image provenance, scanning, tracking security releases and retesting
client and provider behavior. Pinning base images alone does not remove these
burdens. A bucket is not a backup; versioning and backups need separate failure
domains and retention. Budget for local volume capacity, restic storage and
retained versions, B2 API operations, egress and restore transfer, and the
additional build/maintenance effort. Prices and free allowances change; consult
the provider's current rates for the chosen region and workload.

The [1.37.4 storage implementation](https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/storage.rs)
constructs an OpenDAL S3 operator with a custom HTTP transport. An earlier
[S3 transport issue](https://github.com/dani-garcia/vaultwarden/issues/7630)
and [custom-endpoint discussion](https://github.com/dani-garcia/vaultwarden/discussions/7327)
illustrate the feature's recent changes; neither source demonstrates B2
reliability. Explicit URI endpoint and region options are used here instead of
assuming precedence of AWS endpoint environment variables. The proof does not
establish behavior for multipart uploads, versioning, concurrent writers,
crashes during writes, throttling, key rotation, B2 retention, or restoration.

## Observed result (2026-10-30)

The release POC build took 1,619 seconds on this linux/amd64 host. Docker
reported 88,174,562 bytes for the loaded image. The final LocalStack report
contained eight passing cases plus successful cleanup; B2 was not run because
the required credentials were absent. The 8,192-byte attachment and
6,144-byte Send downloaded byte-for-byte before and after a Vaultwarden
restart. The fixture bucket contained one object for each under the run prefix;
the attachment object disappeared on deletion, and the RSA key and saved
configuration were local. During the simulated outage the vault and PostgreSQL
remained reachable, while attachment download and upload returned errors. After
reconnection the original files, object listing and attachment metadata were
unchanged. These checks cover one small failure scenario; they do not establish
behavior under all partial writes, concurrent operations or real B2 failures.
