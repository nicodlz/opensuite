# Direct mail migration

Direct migration is available through the authenticated Mail API. The current
web interface does not provide a direct migration wizard. The source is opened
with TLS and read-only IMAP commands. No Esuno-hosted Gmail account is needed.
The Gmail preset uses `imap.gmail.com:993`; generic IMAP requires a hostname and
port. Use an app password, not the source account's main password.

## Destination policy

The default policy permits no IMAP destinations. Set
`MAIL_MIGRATION_IMAP_ALLOW` in `.env` to a comma-separated list of exact
hostname and port pairs, for example:

```dotenv
MAIL_MIGRATION_IMAP_ALLOW=imap.gmail.com:993,mail.example.net:993
MAIL_MIGRATION_GOOGLE_OAUTH=false
```

Recreate the API container after changing the policy. Hostnames must be fully
qualified. Malformed policy entries and OAuth settings stop API startup; use
`true` or `false` for the OAuth setting. At connection time every DNS answer must be public unicast; the API
pins an IPv4 answer to the TLS connection and verifies the certificate against
the original hostname. An IPv4 address is required. Private, loopback,
link-local, multicast, reserved and literal-IP destinations are refused even
when listed. Restrict API-container egress independently. An allowlist entry
allows any authenticated user to submit credentials to that server; only list
servers the operator trusts. No source server is contacted during setup.

## Google OAuth

`MAIL_MIGRATION_GOOGLE_OAUTH` defaults to `false`. Setting it to `true` permits
an authenticated user to provide a previously obtained Google OAuth access
token for the Gmail preset. This API does not register a Google application,
run an authorization flow, or obtain or refresh tokens. The operator and user
must arrange an authorized token with the IMAP scope separately. Enabling the
option does not itself contact Google. On completion or cancellation the API
attempts to revoke the token at Google's fixed revocation endpoint. Revocation
can invalidate other tokens associated with the same Google grant. If it fails,
the job reports that revocation is unconfirmed; retry or revoke the grant in
the Google account. The API retains the encrypted token for at most 24 hours;
after that deadline the user must revoke the grant separately. Real Google
connections and revocation have not been tested here.

## Jobs and recovery

The API routes are `POST /api/mail/direct-imports/create`, `list`, `report`,
`cancel`, `resume`, `revoke`, and `abandon`. All require the signed-in owner's session and the
configured request origin. For create, provide `accountId`, `mailboxId`, an
optional `labels` mapping from source folder or Gmail label names to existing
mailbox IDs, and `source`. The Gmail source has `kind: "gmail"`, `username`,
and either `password` or `oauthAccessToken`; generic IMAP has `kind: "imap"`,
`host`, `port`, `username`, and `password`. Use the OpenAPI schema for exact
fields. Progress and per-message status are returned by report; list identifies
the source type. Resume accepts a replacement credential in `password` when
needed. For OAuth, first use `revoke` on an attention job, then obtain a new
token and resume: revoking the old token can also revoke tokens under the same
Google grant. Credentials are encrypted with the mailbox key and scoped to the owner
and job; they expire after 24 hours and are cleared after completion or
cancellation. Protect and back up the mailbox key as for other mailbox secrets.
Do not put source credentials in logs, shell history, or support requests.

Each job inventories at most 100 folders, 1,000 messages, and 3,000 inspected
message occurrences, and reads messages
up to 4 MiB each. Only explicitly mapped labels or folders are preserved;
unmapped labels and unsupported flags are reported as limitations. IMAP
settings may hide messages or labels. A source mailbox's UIDVALIDITY or a
message changing during migration requires attention. Missing dates fall back
to the message header. MIME bytes are transferred without modification. Gmail
message identifiers group occurrences across folders when the server provides
them; servers without that extension can expose the same message more than
once. The duplicate check compares Message-ID and raw bytes, but cannot prove
global uniqueness; missing IDs and conflicting messages need review. Existing
duplicates retain their destination flags and dates.

An interrupted external import is reconciled by its durable marker before new
messages are imported. An unknown result that cannot be established remains in
attention; do not manually retry the same message without checking the target.
Cancellation leaves already imported mail in place and preserves unresolved
results for reconciliation. If an uncertain result cannot be reconciled, the
owner can explicitly abandon it after cancellation using the reported count.
Abandonment removes the job and retained source data, never delivered mail;
check the destination first. An OAuth token must be revoked or expire before
abandonment. If a destination mailbox is renamed or removed,
the job stops rather than silently changing its destination. The current API
does not remap a stopped direct job; cancel it and start a new one after
checking the destination and any unresolved results. Remove a source app
password at the provider after use. No source message is deleted or modified.
