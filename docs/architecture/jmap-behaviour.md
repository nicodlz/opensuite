# Stalwart JMAP behaviour

Verified against the pinned `stalwartlabs/stalwart:v1.0.1` image with the
`stalwart` Vitest project and a fresh RocksDB store. These observations apply
to that configuration, not every deployment or version.

## Email import

- **Verified by test:** `Blob/upload` with base64 data creates a blob usable by
  `Email/import`. The original multipart MIME message downloaded from the
  resulting Email's `blobId` matches the uploaded bytes, and an attachment
  blob downloads to its decoded original bytes. Attempting to import another
  account's temporary blob returns the per-item error `blobNotFound`.
- **Verified by test:** supplied `$seen` and `$flagged` keywords and the
  supplied `receivedAt` are retained. Stalwart also reports `$hasattachment`
  for the multipart message. For a message without an attachment and without
  supplied keywords or `receivedAt`, it reports `$hasnoattachment` and a
  timestamp within the import interval. A subsequent `Email/set` changes
  mailbox membership and keywords while the attachment keyword remains.
- **Verified by test:** importing the same blob and MIME twice creates two
  distinct Email IDs. Do not blindly retry an import after an ambiguous
  response: content and `Message-ID` are not a proven idempotency key.
- **Verified by test:** the session advertises `maxSizeUpload` of 50,000,000
  bytes. A 50,000,000-byte MIME message uploaded through the raw HTTP endpoint
  imports successfully. Uploading 50,000,001 bytes is rejected before import
  with HTTP 400 and problem type `urn:ietf:params:jmap:error:limit`. This is an
  upload boundary in this configuration, not proof of a separate maximum for
  `Email/import` on pre-existing blobs. JSON `Blob/upload` is also constrained
  by the smaller request size and encoding overhead; quotas and proxy limits
  can be lower.
- **Verified by test:** an imported draft can be submitted using an account
  identity, delivered to another local account and answered with a reply. A
  successful submission alone does not establish external delivery.

## Management API

- **Verified by test:** calls to `/jmap/` use the core and
  `urn:stalwart:jmap` capabilities and the `x:Domain`, `x:Account` methods.
  Domain creation uses a name; user creation uses a domain ID and password
  credential. Account aliases are entries in the account's `aliases` map,
  updated through `x:Account/set`, rather than a separate `x:Alias` object.
- **Verified by test:** repeated sequential creation of the same domain, user
  and alias returns the existing object without another alias. The existing
  user's password is not changed or checked. Per-item errors are returned to
  the caller; they are not interpreted as successful creation.
- **Verified by test:** authenticated user session discovery exposes a primary
  mail account and the URLs used for mail operations. The direct-listener test
  fixture substitutes its loopback host and port for the image's advertised
  internal host; this does not verify production reverse-proxy configuration.

Management credentials belong exclusively in trusted server code. The
`@opensuite/jmap/admin` entry point is Node-only and is not re-exported by the
regular client. The client does not provide distributed locking or automatic
reconciliation of a lost write response. Serialize operations for a given
object, handle concurrent provisioning explicitly, and reconcile ambiguous
results before retrying. Least-privilege roles, password rotation, lifecycle
operations, external SMTP and production TLS are not verified by this suite.
