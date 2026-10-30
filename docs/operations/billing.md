# Billing implementation status

Managed Esuno Cloud billing is incomplete and must not be activated. The API
rejects cloud mode at startup, even when valid Stripe configuration is present.
There is no checkout, webhook processing, account claim, customer portal, mail
quota synchronization, or managed entitlement service in this version. Do not
accept payments or migrate existing accounts using this implementation.
The Stripe dependency is reserved for that work and is intentionally ignored
by the unused-dependency check until the Cloud implementation uses it.

Self-hosted mode is the default and does not create a Stripe client. Billing
operations are disabled; the billing overview reports an unlimited free plan.
Its storage measurement is marked unavailable until both backends can be
measured. Drive has no default quota. An operator can choose a local limit with
`DRIVE_QUOTA_BYTES`.

Drive also has a preliminary internal entitlement client and usage endpoint.
When `DRIVE_ENTITLEMENTS_TOKEN_FILE` is set, new reservations require a valid
response from `DRIVE_ENTITLEMENTS_API` (default `http://api:3000`) and fail
closed if it is unavailable. The API endpoint is not implemented yet, so do
not enable that setting in production. Internal paths are blocked by Caddy.
The Stripe and billing token file settings in the Compose template are
reserved for the unfinished Cloud work; they do not enable billing.

Custom domains remain administrator-managed; any future plan domain count is
an entitlement value, not permission for an account to create domains.

The pinned Stalwart v1.0.1 reports `usedDiskQuota` and accepts
`quotas/maxDiskQuota`. In a local fixture, a 100-byte limit rejected an
oversized mail import, but a zero limit behaved as unlimited. A future quota
synchronizer must handle exhausted accounts without setting this field to zero.

For an operator-run Drive metadata audit, execute `node src/reconcile.ts` from
the Drive service with its normal database and S3 environment. It lists object
metadata, reporting missing keys, size mismatches and orphan keys as JSON
lines; it never downloads object content. `--delete-old-staging` additionally
deletes only unreferenced UUID staging keys older than seven days, with an
ETag condition and a fresh database check. Final objects are never deleted.
Deletion fails closed if the backend does not support the condition; the local
S3 substitute does not implement it.
Stop other Drive writers before using the deletion option, and review the
report first; without coordination a new reservation could race the check.
