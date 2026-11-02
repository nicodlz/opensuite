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

Final sender authorization and alias or secondary-address revocation share a
database lock. The handoff is recorded before the provider request, and the
provider's acceptance is recorded before revocation can succeed. If revocation
wins first, the worker fails the scheduled item with `sender_unavailable`.
While a handoff has an uncertain outcome, revoking that sender returns a
conflict until reconciliation establishes acceptance or definite failure. This
includes a crash immediately after recording the handoff: the application cannot
prove whether the request reached the mail server, so it does not assume that
revocation or cancellation succeeded.

The database lease and state transition give cancellation and submission one
winner. Cancellation succeeds while an item is still held, including when its
deadline has passed but handoff has not begun. Once handoff begins, an unknown
result is shown as uncertain and is reconciled against the provider; it is
never blindly submitted again. A crash after handoff may require a user to
recover a copy if provider evidence is unavailable. A sent state means the mail
server accepted the submission, not that the remote recipient received it.
