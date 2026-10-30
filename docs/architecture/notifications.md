# Notification dispatch

Event producers can depend on `NotificationDispatcher` from
`@opensuite/core/services/notifications` and call
`notify(userId, product, { title, body?, url, tag, icon? }, options?)`. Existing three-argument calls remain valid. Options may set `ttl` in seconds (0–2,419,200) and `urgency` (`very-low`, `low`, `normal`, `high`). Products are
`mail`, `calendar` and `drive`. URLs must be same-origin absolute paths; an
optional icon must be under `/icons/`. Payloads are capped at 3,000 UTF-8
bytes. A tag identifies the event for a user and product: the database claims
it atomically for five minutes after at least one delivery succeeds; if none succeeds, the claim is released so a retry can proceed. The browser also uses it to replace an
existing displayed notification. Producers should use stable, non-sensitive
tags and should not put private content in URLs or tags. Mail uses the user's
privacy preference at dispatch time and defaults to a generic title without a
body.

Dispatch looks up only that user's subscriptions for the product. Pushes use
normal urgency and a five-minute TTL by default. HTTP 401, 403, 404 and 410 remove a subscription;
other transport failures increase its failure count and defer eligibility with
exponential backoff. There is no retry queue: another event after the backoff
can attempt delivery, but a failed event is not replayed automatically. A
successful send clears the backoff. A push provider's acceptance is not proof
that a device displayed the notification. The subscription and test API
limits are per API process.

## Calendar reminders

Calendar alarms come from the mailbox's CalDAV events through Stalwart's
JMAP `CalendarEvent/get`, where VALARM is represented by JSCalendar alerts.
About once a minute the API enumerates active calendar subscribers and takes a full,
state-checked snapshot of their events when the previous snapshot is not fresh.
It uses the calendar service's local
recurrence and time-zone expansion to plan a 48-hour rolling window. A failed
or inconsistent snapshot is not used to cancel jobs. A per-user database lease
serializes planners; pending jobs absent from a successful snapshot are removed,
and changed jobs are rescheduled. A unique user, event, occurrence, start and alarm
key retains sent and expired jobs to prevent re-planning them. Finished rows are
purged after 30 days.

Workers claim due jobs using PostgreSQL `FOR UPDATE SKIP LOCKED` and a lease.
After a restart, jobs up to 15 minutes late are eligible; older jobs are marked
skipped. A successful snapshot no more than 15 minutes old is required before
sending; dispatch runs independently of planning. The privacy preference is
checked at send time; generic notifications say “Upcoming event”. Timed events
use their stored time zone; floating and all-day events use the latest calendar
subscriber's browser time zone, falling back to UTC for older subscriptions
until that device opens Calendar or renews its subscription. Only display and
audio alarms are sent; an acknowledgment at or after the trigger suppresses that
occurrence. External edits and deletions are detected by the next
poll, so changes made immediately before dispatch can race the poll.

Expansion supports the recurrence rules handled by the calendar service;
unsupported rule parts are not expanded. The editor can set a single relative
display alarm and preserves custom alarms unless the reminder is changed. Push service acceptance is
not proof of device display. The database and an external push service cannot
commit atomically, so a process failure after provider acceptance and before
recording success may cause a repeated attempt; provider or browser tag
coalescing reduces, but cannot eliminate, that ambiguity.

The shared push dispatcher deduplicates a notification tag for five minutes.
Alarms for the same occurrence use the same tag, so two alarms closer together
than that interval can collapse into one notification.
Tags contain a hash rather than the event UID. Click URLs contain the opaque
JMAP event identifier and occurrence time, even when details are hidden.

## Dispatch results

Producers that need delivery outcomes can depend on `DetailedNotificationDispatcher`;
`createNotificationDispatcher` exposes its `notifyWithResult` with outcomes
`delivered`, `failed`, `no_subscriptions`, `duplicate`, or `invalid`, plus
`delivered` and `failed` counts and an invalid-input reason. `no_subscriptions`
means none are currently eligible, including when all are in backoff. The original
`notify` retains its `Promise<void>` result and throws for invalid inputs.
Custom `NotificationStore` implementations must implement `release` for an
unsuccessful tag claim.
Transport failures do not include endpoints or payloads in logs. Database
bookkeeping failures reject either method. A tag remains claimed after partial
success, so failed devices are not retried by repeating that tag. Device
subscriptions are capped at 20 per user. Signing out removes records for the
current authenticated session across product origins and unsubscribes the local
origin's browser endpoints; already delivered pushes cannot be recalled.

# Mail notifications

The API tracks JMAP Email state only for enabled users with an active mailbox and at least one mail push subscription using the configured VAPID key. The notifier stays stopped when push is disabled because VAPID configuration is unavailable, or when its own configuration is invalid; these errors do not prevent the API from starting. Each API process selects up to `MAIL_PUSH_CONNECTIONS` users for authenticated JMAP EventSource connections. StateChange events wake the worker; users poll `Email/changes` while their stream is unavailable or exceeds the cap. A connection and each reconnection also trigger a scan to recover missed events. A stream with no traffic for 90 seconds reconnects; its retries use jittered backoff. The cap is per API process, not global. Sessions are cached briefly per user; workers that lose a shared cursor lease wait before retrying. The API reads the encrypted mailbox link server-side and verifies the primary account before using its credential. Session endpoints are rewritten to the configured internal Stalwart origin; credentials are never sent to another origin. Work runs independently of API startup and requests, with at most eight concurrent change scans per process. Failed scans and streams back off independently; logs contain neither mailbox credentials nor message content.

The database stores one cursor per subscribed user and a short, fenced lease to prevent competing API instances from advancing it at once. The last subscription's removal, including removal after a permanent push failure, deletes the cursor. A new subscription, a replaced mailbox, missing cursor or `cannotCalculateChanges` establishes a silent baseline. Stalwart reports malformed state tokens as `invalidArguments`; a fresh-state probe must succeed before those are reset silently. A restart resumes the stored cursor; after an abrupt stop a lease can delay recovery for up to five minutes. The first baseline happens on the first scan, so mail arriving between subscription and that scan is included silently. Only IDs in `created` are considered: current mailbox membership must include the Inbox role and exclude Junk, `$seen` must be absent, and `receivedAt` must be no older than the freshness window and no more than one minute in the future to tolerate clock skew. Updated IDs do not produce notifications. A creation also reported as updated during the collection window is suppressed, because JMAP does not cheaply reveal whether it moved out of Junk. JMAP exposes current metadata, not a creation-time mailbox history: if a message is created in Junk and moved to Inbox before the first change scan, the server may report it as a creation with its current Inbox membership. The worker cannot distinguish that case from a new Inbox message.

A short collection window groups concurrent arrivals. Above the configured threshold a single count notification opens the Inbox; otherwise each eligible message gets a `mail:<emailId>` tag and opens its conversation. Details contain a truncated sender and subject, never the body. The shared dispatcher applies the user's privacy setting and sends a generic notification when details are disabled. It handles device failures and deduplication. The same-origin click link opens and focuses the message in its conversation; an unavailable or deleted conversation may show an error.

JMAP, PostgreSQL and Web Push cannot participate in one transaction. The cursor is saved after dispatch, so a crash after delivery but before the save can retry a notification; shared dispatcher tag deduplication limits this window but does not provide an unlimited exactly-once guarantee. A burst tag is derived from the message IDs, so a different burst grouping after a crash can also be retried. Push delivery itself is best effort; expired subscriptions and provider failures can prevent a notification. Cursor loss or an expired JMAP change history intentionally causes silent resynchronization. The freshness window suppresses old catch-up messages. Keep clocks synchronized.

Configuration (defaults shown):

- `MAIL_PUSH_CONNECTIONS=50`: per-process EventSource connection cap; `0` selects polling only (0–1000).
- `MAIL_PUSH_POLL_SECONDS=30`: fallback poll interval (5–300).
- `MAIL_PUSH_REFRESH_SECONDS=10`: subscription and mailbox refresh interval (5–300).
- `MAIL_PUSH_FRESHNESS_SECONDS=900`: maximum received age (60–86400).
- `MAIL_PUSH_BURST_SECONDS=3`: collection window (0–30).
- `MAIL_PUSH_BURST_THRESHOLD=3`: a larger group becomes one notification (1–100).

On shutdown the supervisor stops, streams are aborted, and in-flight work drains before the database disconnects. Unsubscribed users stop tracking on the next refresh; their cursor is removed immediately when the last device is removed. See the [ingestion architecture](ingestion.md) for the separate inbound mail pipeline.

## Contextual offers

A feature inside a product's `AppShell` can import `useNotificationPrompt`
from `apps/web/src/push/hook.ts` and call
`offer({ reason: "reminder-saved", message: "Get this reminder on this device?" })`
from a user action. The hook displays an in-app suggestion only; permission
is requested solely after Enable is clicked. Calendar can call the hook after
saving an event with a reminder. The browser stores offer counts and the
14-day dismissal cooldown locally per origin, with a maximum of three offers.
