# Managed Cloud billing

`ESUNO_DEPLOYMENT_MODE=self-hosted` is the default. Self-hosted installations
never create a Stripe client, have an unlimited Esuno quota and can optionally
set `DRIVE_QUOTA_BYTES` as an operator limit. Billing plan and overview routes
remain available; payment routes return `BILLING_DISABLED`. Storage usage is
measured from Drive and Stalwart when both are reachable. A failed measurement
sets `measured: false`; the values are not estimates.

Cloud mode requires the Stripe secret, webhook signing secret and internal
service token files. Configuration errors stop startup. Only trusted server
configuration chooses the deployment mode. Store all secrets outside Git and
restrict their filesystem permissions. The Compose secrets job generates a
shared service token readable by the API and Drive; `BILLING_INTERNAL_TOKEN_FILE`
can instead point to a host file readable by both service UIDs. Caddy blocks
public access to the internal endpoints. `DRIVE_ENTITLEMENTS_TOKEN_FILE` is an
optional independent override and must contain the same token as the API.

## Stripe account and setup

The account is shared with another business. Esuno creates and recognizes only
objects marked `metadata.esuno=1`; foreign events are recorded as ignored.
Do not reuse another business's customers, products, prices, portal configuration
or webhook endpoint. Each Esuno portal session explicitly names the dedicated
configuration. The account's default portal and unrelated webhooks are not
changed by setup.

Set `STRIPE_SECRET_KEY_FILE` to a protected API key file, `STRIPE_WEBHOOK_URL`
to the HTTPS API endpoint ending `/api/billing/webhook`, and
`AUTH_PUBLIC_ORIGIN` to the application's HTTPS origin. Run:

```sh
node scripts/stripe-setup.mjs --live --dry-run
node scripts/stripe-setup.mjs --live
```

A live key is refused unless `--live` is supplied, including for a dry run.
For a test key, omit `--live`. On first creation the
webhook signing secret is printed **once**: immediately place it in the
protected file named by `STRIPE_WEBHOOK_SECRET_FILE`, and protect the terminal
and its logs. A later setup cannot recover that secret. The script verifies
existing Esuno objects and refuses to modify mismatched objects. It creates
products named Esuno Plus and Esuno Pro with tax code `txcd_10000000` and
statement descriptor `ESUNO.NET`, four inclusive EUR recurring prices, a
portal configuration, and one webhook. Checkout and card statements can also
show the Stripe account's public business name, which is shared with the other
business. Verify the statement appearance before accepting payments.

With automatic tax enabled, setup reads Stripe Tax settings and active
registrations. The account was reported to have an active head office but no
registrations: **no tax registrations: Stripe Tax will compute 0 VAT**. Setup
stops before creating objects unless registrations have been added or the
operator explicitly passes `--allow-no-tax-registration`. The operator must
assess and configure the appropriate Portuguese and/or EU OSS registrations
in the Stripe Dashboard. The override is a deliberate operator decision; it
does not add registrations. API Checkout requests never silently turn off
configured automatic tax.

The webhook subscribes to `checkout.session.completed`, subscription
created/updated/deleted/paused/resumed, and invoice paid/payment_failed/
payment_action_required. Signature verification uses the raw request body.
Stripe is queried for current subscription state; duplicate events do not
repeat the update. Active, trialing and past_due subscriptions grant access;
past_due is a payment warning. Incomplete, incomplete_expired, unpaid,
canceled and paused subscriptions do not grant access. Entitlements use locally stored subscription state, updated by webhooks and a bounded six-hour Stripe reconciliation job. No data is removed on cancellation, expiry,
or downgrade.

Checkout uses Stripe-hosted pages for payment and authentication. Signed-in
customers return to `/settings/billing?billing=updated` on success or
`?billing=canceled` on cancellation; portal flows return to the updated URL.
Public checkout cancellations return to `https://esuno.net` by default; set `BILLING_CANCEL_URL` to override the public site URL.
Successful public checkout returns to `/welcome?session_id=...`. Session IDs
are bearer-like claim secrets: API logs contain only method, status and
duration, and Caddy skips access logs for the welcome and Checkout status
paths. Do not enable downstream logging of those URLs.

A paid public session can be claimed once within 30 days of its creation, on
`BILLING_ACCOUNT_DOMAIN` (default `MAIL_DOMAIN`; Cloud startup requires it to be an account domain and in `SUBSCRIBER_DOMAINS`), after its webhook has been processed. The user signs in normally
and MFA remains unchanged. If provisioning or network interruption leaves a
paid session unclaimed, the operator must verify the payment and purchaser
through a separate channel, then arrange a refund or a controlled manual
reconciliation; never attach an account solely on an unverified email address.
For existing accounts migrating to Cloud, obtain an explicit subscription for
each account before changing the mode. Accounts without entitlement become
read/download/delete-only; administrators remain exempt. Custom-domain counts
are entitlement values only: domains remain administrator-managed.

## Complimentary grants

An operator with an appropriately protected database-owner connection can
grant access without Stripe. Set `DATABASE_URL` securely in the CLI environment
(do not put it in shell history or Git), then run, for example:

```sh
node apps/api/src/billing-grant.ts user@example.com --plan unlimited --reason "complimentary access"
node apps/api/src/billing-grant.ts user@example.com --plan plus --expires 2027-12-31 --reason "one-year grant"
node apps/api/src/billing-grant.ts user@example.com --revoke --reason "grant ended"
node apps/api/src/billing-grant.ts --list
```

The application database role can read grants but cannot create, change or
delete them; there is no HTTP grant procedure. Each create, revoke and list
operation is audited. Active grants take precedence over subscriptions: Plus
and Pro use their plan limits; unlimited grants have no storage or plan limits
and appear as exempt Pro in the overview. A null expiry is lifetime. Expired
and revoked grants no longer apply, and no files or mail are deleted. Optional
`BILLING_INTERNAL_API` and `BILLING_INTERNAL_TOKEN_FILE` let the CLI request
an immediate mail quota refresh; otherwise the periodic job refreshes it.
Plus and Pro provide 5 and 15 mailbox addresses respectively, primary address
included; self-hosted, operator and unlimited-grant entitlements have no plan
address limit. Address creation is enforced by the separate address feature.
Database audit rows identify the affected account, not the human operator;
record operator access separately.

## Storage and reconciliation

Cloud storage combines Drive files, trash and unexpired reservations with
Stalwart mail usage. Drive checks the owner's quota and fresh mail usage inside
the owner reservation lock, including uploads by shared-folder collaborators.
Stalwart's per-account limit is `max(1, quotaBytes - driveBytes)` for Cloud
accounts and one byte without entitlement. Zero is never written: Stalwart
v1.0.1 treats zero as unlimited. Existing mail remains readable above the limit.
Self-hosted and exempt accounts have the limit removed.

The API refreshes the mail limit on subscription changes, Drive requests a
best-effort refresh after successful file completion or deletion, and a bounded
job retries every five minutes. Mail and Drive are separate systems: concurrent
mail delivery or an unavailable refresh can cause a temporary overshoot until
refresh succeeds; the five-minute schedule is not a guarantee during outages.
No automatic deletion occurs when a user is over quota.

For a Drive metadata audit, run `node src/reconcile.ts` from the Drive service
with its normal database and S3 environment. It lists object metadata, reporting
missing keys, size mismatches and orphan keys as JSON lines without downloading
content. Review the report and stop Drive writers before `--delete-orphans`:
that flag only attempts conditional deletion of unreferenced UUID staging keys
older than seven days. Final objects are never deleted. The local S3 substitute
does not implement the condition and the command fails closed. **Verify on B2
before using `--delete-orphans`.**

### Acknowledging a permanently failed webhook

After independently verifying the event and resolving its subscription state, an operator may stop the stuck-event alert by marking that specific event ignored and processed in PostgreSQL:

```sql
UPDATE "StripeEvent" SET "ignoredAt" = now(), "processedAt" = now()
WHERE id = 'evt_REPLACE_WITH_VERIFIED_ID' AND "processedAt" IS NULL;
```

Record the event ID and reason in the incident log; reconciliation remains responsible for repairing subscription state.

### Subscriber domains

Cloud requires `SUBSCRIBER_DOMAINS`, a comma-separated list of account
domains. Entries are normalized to lowercase. Each must be `MAIL_DOMAIN`, in `MAIL_DOMAINS`, or an
existing managed domain. The API refuses to start if the list is empty, a
listed domain is not an account domain, or the billing account domain is
missing from the list. For example, when the primary technical mailbox uses
`MAIL_DOMAIN=technical.example`, configure:

```dotenv
MAIL_DOMAIN=technical.example
MAIL_DOMAINS=esuno.net,esn.pm
SUBSCRIBER_DOMAINS=esuno.net,esn.pm
BILLING_ACCOUNT_DOMAIN=esuno.net
```

Newly provisioned configured subscriber domains start as `pending`. The scheduled domain job
excludes configured domains, so an administrator must run a manual DNS recheck
in the Domains settings after configuring the required records. Both
`esuno.net` and `esn.pm` must be `verified` before they can be used for aliases.

Non-admins, including technical mailboxes without the admin role, can choose
only listed domains for new addresses, aliases, and alias defaults; existing
mailboxes and aliases continue to work. When no usable default is set, the
API-key generator chooses the first available subscriber domain, with the
billing account domain first in Cloud mode and the rest in list order.
Administrators retain their existing domain choices. Self-hosted deployments
may leave the list empty to keep the existing unrestricted behavior.
