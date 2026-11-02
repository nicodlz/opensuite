# Mail archive imports

Mail imports accept local EML and MBOX archives, including representative Gmail
Takeout archives. The importer does not access Google or alter the source. A
real Google export has not yet been tested. Reports describe the supported
archive sizes, label mappings, dates, and other limitations.

The worker tracks mailbox changes during its duplicate scan and automatically
retries a conditional write if new mail, reads, moves, or other mailbox
activity changes the Email state. Repeated conflicts are deferred to a later
worker run; no manual resume is needed. Ambiguous writes remain separate from
these definite, safe-to-retry conflicts.

If a destination mailbox is removed, renamed, or moved, the report's
`recovery.action` is `remap`. Call `POST /mail/imports/remap` with `accountId`,
`jobId`, a current `mailboxId`, and the desired Gmail `labels` mapping. The
owner can choose the same mailbox after confirming its new name. The updated
mapping applies to remaining and failed messages; messages already delivered
stay in their existing mailboxes. Imports created before destination tracking
also ask for remapping before they continue.

If the server reports quota exhaustion, the report's `recovery.action` is
`resume`: free space or increase the quota, then call
`POST /mail/imports/resume` with `accountId` and `jobId`. Only the owner can
remap or resume a job. Failed messages are kept until the owner takes action.

## An uncertain import

An interrupted JMAP import can leave the outcome of a message uncertain. The
worker does not automatically repeat that write. Resume the job to reconcile it
against the mailbox; if it remains uncertain, the owner can explicitly abandon
the job.

First call `POST /mail/imports/report` with `accountId` and `jobId`. When
abandonment is available, its `abandonment` object contains `uncertainCount`
and a warning. Display both to the user and obtain their confirmation: some of
those messages may already be in the mailbox. Then call
`POST /mail/imports/abandon` with the same `accountId`, `jobId`,
`uncertainCount`, and `confirm: true`. A stale count, an unconfirmed request,
or a job being processed cannot be abandoned; fetch the report again.

Successful abandonment atomically records an audit event with the user, time,
job ID, and imported, uncertain, failed, duplicate, and pending counts. It
removes the saved archive and job progress and allows a new import. It does not
delete delivered mail or change the source archive. Database backups made
before abandonment may still contain the encrypted archive until those backups
expire under their retention policy.

Re-importing the same archive checks the existing mailbox using Message-ID and
message bytes, so an already-delivered matching message is reported as a
duplicate. Messages without a reliable Message-ID cannot be deduplicated, and
conflicting bytes require attention. A write whose result was uncertain could
also become visible after a new import's duplicate check; check the mailbox
before retrying and review the result.
