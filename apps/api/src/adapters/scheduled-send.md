# Scheduled and undo send

Both a configurable undo delay and an explicitly scheduled time use the same
application-held queue. A queued item references the original draft; no delayed
submission is made to Stalwart. The pinned Stalwart version supports a native
hold and cancellation, but it can release a previously accepted submission
after the sending alias is revoked. Keeping the message in the application is
necessary to evaluate current authorization at release time.

The worker leases due items and checks the active account, configured domain,
current sending identity and alias, and billing entitlement and storage quota.
It checks authorization again after reading the draft and immediately before
starting the provider handoff. A denied item remains listed as failed, with a
reason and an audit event, and the original draft is editable. An unavailable
authorization or quota measurement defers the item for a later check. In cloud
mode, measuring the shared mail and Drive quota requires both usage sources;
an unavailable usage source therefore delays release rather than bypassing the
quota check. Self-hosted accounts with no quota do not need a usage measurement.

Final sender authorization and the provider request hold a shared database
lock. Alias, secondary-address, domain, and account revocations take its
exclusive counterpart, so a revocation waits for a request already issued and
no request starts after a committed revocation. The final check, request and
database transaction share a 3-second deadline. When the request expires, its
outcome remains uncertain and the lock is released; the user can
still revoke the sender. A request issued before
revocation may already have been accepted, and is never replayed blindly.
The durable handoff marker is committed before the request so a crash cannot
cause a second submission.

If the lock is busy or a database failure occurs before the request is issued,
the same attempt is safely returned to the queue. An attempt token prevents an
old worker from changing or submitting a newer attempt.
The database enforces the transaction deadline with `transaction_timeout`;
the deployed PostgreSQL image is version 18.

The database lease and state transition give cancellation and submission one
winner. Cancellation succeeds while an item is still held, including when its
deadline has passed but handoff has not begun. Once handoff begins, an unknown
result is shown as uncertain and is reconciled against the provider; it is
never blindly submitted again. A crash after handoff may require a user to
recover a copy if provider evidence is unavailable. A sent state means the mail
server accepted the submission, not that the remote recipient received it.
