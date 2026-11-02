# Export your data

Open Mail and choose **Export data**. Select a mailbox, open a conversation,
and select messages. Download one message as EML or up to 100 as mbox. An
EML contains the original MIME bytes returned by the mail server. The mboxrd
file quotes lines beginning with `From `, adds envelope separators and may add
line endings. Import it as mboxrd; use EML if exact bytes are required. Message
flags, folders and delivery metadata are not included. Each message is limited
to 10 MB and an export to 20 MB. The result lists items that could not be
exported; retry them separately. Browse older conversations with **Next
conversations**. You can start up to five exports per minute; wait before
retrying if the service reports too many requests.

**Download ICS** combines the calendar server's iCalendar objects. UID,
recurrence rules, exceptions and time zones are included when the server
provides them. Supported JSCalendar recurrence rules and excluded occurrences
are converted to RRULE and EXDATE when needed. Other rules, exceptions or
fields missing from the server's iCalendar representation are reported; review
these warnings before relying on the file. Calendar names, colours and event
membership are not retained in the combined file. Other calendar-level
properties may also be omitted. Conflicting time-zone identifiers are renamed
to preserve their definitions, and unreadable objects are reported. Calendar
responses and the resulting file are limited
to 10 MB, 1,000 JMAP events, and 1,000 objects per calendar. If the calendar
is larger, use a CalDAV client to export smaller parts. Reports show up to
1,000 warnings or item failures and indicate when further entries are omitted.
Review the report and retry or use a standard CalDAV client if anything failed.

For contacts, load and select up to 100 contacts at a time and download the
existing vCard export. Browse additional contacts with the page controls. Its
warnings describe fields that could not be exported.
In Drive, select files or folders and use its existing **Download ZIP** action.
These downloads are independent; an export is not a complete account backup.

Downloads contain private, unencrypted data. Store them securely, use an
independently encrypted backup if needed, and verify them by importing copies
into a compatible application. No remote provider backup is created by this
feature. Restoring a file does not remove or modify the original data.
