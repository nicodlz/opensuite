# Stalwart integration evidence

Date: 2026-10-29. Target: `stalwartlabs/stalwart:v1.0.1`. **Evidence methods:** explicitly identified local-container observations and official documentation, RFCs or pinned-source inspection. RFCs describe the protocol contract, not proof of Stalwart runtime conformance. The live Stalwart documentation is not versioned; pinned-tag source is stronger evidence for the specific implementation. All links below were accessed on 2026-10-29. OM-STALWART must validate the remaining flows on the pinned image.

## Observed local container baseline

The following were **verified on a local container, 2026-10-29**, with the pinned v1.0.1 image. The bootstrap `config.json` locates the RocksDB data store; other settings live in that store. Management uses `urn:stalwart:jmap` and `x:<Object>/get` or `x:<Object>/set`, including Domain, Account, NetworkListener, Tracer and Http; `x:Action/set` with `ReloadSettings` applies stored settings. The container uses `STALWART_HOSTNAME`, `STALWART_PUBLIC_URL` and `STALWART_RECOVERY_ADMIN` for initial configuration. This is not a complete management or provisioning test.

Default listeners were observed on ports 25, 465, 993, 995, 4190, 443 and 8080; 587 and 143 were not created by default. No TLS certificate was present by default. Discovery at `/.well-known/jmap` returned 307 to `/jmap/session`; an anonymous session returned 200 with no accounts. `/.well-known/caldav` redirected to `/dav/cal`, and `/.well-known/carddav` to `/dav/card`. `Http.clientIpSource` can trust `X-Forwarded-For`; loopback values were rejected. Restrict the trusted proxy chain and validate the actual Compose proxy and certificate configuration before exposure.

## Management and mail TLS in Compose

The recovery administrator is present only during the explicit bootstrap or
recovery override. Normal setup uses a separate Admin account
whose credential allows the private Compose management subnet. The API provisioning runtime also uses the private management account; see
[authentication and provisioning](../development.md#authentication-and-mailbox-provisioning). Caddy removes
untrusted forwarded-address values and blocks clients from that subnet, while
the mail server trusts one forwarded hop. Direct access to the internal mail
listener is trusted; a compromised container on any network attached to
Stalwart can spoof the forwarded header. Caddy cannot inspect JMAP JSON with its
stock modules, so it does not block the management capability by body content.
See [bootstrap and operations](../development.md#mail-bootstrap-and-upgrades).

Caddy TLS and Stalwart TLS are separate. Mail ports bind to loopback until the
operator exports Caddy's chain and key, configures Stalwart's file-backed
certificate, verifies handshakes and explicitly changes the bind address.
Renewal export and verification are operator responsibilities. Port 25 is not
published in the standard stack; the documented fallback bypasses SES.

## JMAP

- **Session:** [Stalwart's JMAP overview](https://stalw.art/docs/http/jmap/) documents discovery via `/.well-known/jmap`, the session resource and its `apiUrl`, `uploadUrl`, `downloadUrl`, account and capability information. Use advertised URLs and capabilities, not hard-coded account IDs. [Capabilities](https://stalw.art/docs/http/jmap/capabilities/) are permission-dependent. Method: official documentation.
- **HTTP upload and `Blob/upload` are different operations:** [RFC 8620 §6.1](https://www.rfc-editor.org/rfc/rfc8620.html#section-6.1) defines a raw HTTP POST to the session `uploadUrl` returning a `blobId`; [Stalwart's HTTP overview](https://stalw.art/docs/http/) documents the upload endpoint. [RFC 9404 §4.1](https://www.rfc-editor.org/rfc/rfc9404.html#section-4.1) defines the JSON JMAP `Blob/upload` method using `urn:ietf:params:jmap:blob`, `accountId`, and a `create` map of data sources. Stalwart [advertises that capability](https://stalw.art/docs/http/jmap/capabilities/), and its [v1.0.1 upload implementation](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/jmap/src/blob/upload.rs) assembles data sources, checks limits and temporary quota, and returns per-item `created` or `notCreated` results. Use an actual returned blob ID for a subsequent import. Method: official documentation, RFCs and pinned source inspection; same-request creation-reference resolution is not verified.
- **Limits:** [Stalwart limits](https://stalw.art/docs/http/jmap/protocol/) describe a default 10 MB JMAP request body and 50 MB single upload, temporary upload quotas and expiry, and separate message limits. JSON `Blob/upload` is subject to the request-body limit as well as upload limits; encoding increases its size. Prefer the raw HTTP upload endpoint for large messages and check the session and deployment limits, including proxy limits. The [v1.0.1 method source](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/jmap/src/blob/upload.rs) uses a strict `<` comparison for assembled method data against its configured upload limit; test the boundary. Method: official documentation and pinned source inspection.
- **`Email/import`:** [RFC 8621 §4.8](https://www.rfc-editor.org/rfc/rfc8621.html#section-4.8) describes importing an existing RFC 5322 message using an uploaded `blobId`, `mailboxIds`, optional `keywords` and `receivedAt`, with per-item results. The [v1.0.1 implementation](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/jmap/src/email/import.rs) checks that a destination mailbox exists and is authorized, fetches the blob, parses it, rejects invalid messages and returns success or per-item errors. Import separately for each resolved destination account; receipt routing and retries are application responsibilities. Do not assume a timeout means failure or that message IDs deduplicate imports. Method: RFC and pinned source inspection; byte preservation and exact error behavior are unverified at runtime.
- **`Email/set`:** [RFC 8621 §4.6](https://www.rfc-editor.org/rfc/rfc8621.html#section-4.6) defines creating, updating and destroying Email objects; it is useful for composing drafts or changing mailbox membership and keywords. Stalwart has a [v1.0.1 implementation](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/jmap/src/email/set.rs). It is not a substitute for importing the original RFC 5322 bytes. Method: RFC and pinned source inspection.
- **`EmailSubmission/set`:** [RFC 8621 §7.5](https://www.rfc-editor.org/rfc/rfc8621.html#section-7.5) defines submission of an existing Email with an identity and optional envelope, including per-item errors. Stalwart has a [v1.0.1 implementation](https://github.com/stalwartlabs/stalwart/blob/v1.0.1/crates/jmap/src/submission/set.rs). A successful submission is not final delivery. Method: RFC and pinned source inspection.

## Management

The [official management overview](https://stalw.art/docs/management/cli/) describes a JMAP management API using `urn:stalwart:jmap` and `x:` object types. [Domain](https://stalw.art/docs/ref/object/domain/), [Account](https://stalw.art/docs/ref/object/account/) and [DkimSignature](https://stalw.art/docs/ref/object/dkim-signature/) references document `x:Domain/set`, `x:Account/set` and `x:DkimSignature/set` create/update/destroy operations and required permissions. Domain DKIM settings include automatic or manual management; signature objects include a selector, domain and key material. Use server-side least-privilege management credentials; verify actual v1.0.1 request schemas, key generation, DNS records, permissions, account credential provisioning and revocation before implementation. The provider's SES signing is a separate integration. Method: official documentation for object schemas; the existence of Domain and Account management methods was also verified on a local container, 2026-10-29. DKIM operations and exact schemas remain unverified at runtime.

## Calendar and contacts

[Stalwart's DAV overview](https://stalw.art/docs/http/webdav/) documents CalDAV at `/dav/cal/<account>/`, CardDAV at `/dav/card/<account>/`, and discovery redirects from `/.well-known/caldav` and `/.well-known/carddav`. It describes account identifiers and access restrictions. Client interoperability, recurrence, authorization and backup/restore remain to be tested. Method: official documentation and local-container discovery redirects, 2026-10-29; authenticated DAV behavior remains unverified.

## Clustering

[Stalwart's cluster overview](https://stalw.art/docs/cluster/) describes shared data, blob, search and Redis-based in-memory stores, a coordinator and unique node identifiers. Its documented shared data-store options include PostgreSQL; RocksDB and SQLite cannot serve as a shared cluster data store. Official binaries support Redis and NATS coordination. The proposed HA profile uses shared PostgreSQL, S3-compatible blob storage and Redis/Valkey, with a coordinator, across failure domains. Store failover, node failover, edition-specific restrictions and recovery must be tested; two processes alone do not create HA. Method: current official documentation only.

## S3-compatible mail blobs

[Stalwart's blob store overview](https://stalw.art/docs/storage/blob/) distinguishes structured data such as accounts, mailboxes, flags, calendars and contacts from message-content blobs. Its [S3-compatible backend documentation](https://www.stalw.art/docs/storage/backends/s3/) describes a custom endpoint and names Backblaze B2 as a compatible service. Method: current official documentation, accessed 2026-10-29. This is not proof that B2 works with the pinned image, credentials, chosen endpoint or recovery scheme. OM-B2-MAIL must verify operations, private access, failures and backup consistency with actual B2 before the [production target](../adr/0002-production-target.md) relies on it.
