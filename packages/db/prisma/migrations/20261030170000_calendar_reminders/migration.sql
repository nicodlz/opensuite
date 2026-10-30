CREATE TABLE "CalendarReminderSync" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "owner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  CONSTRAINT "CalendarReminderSync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "CalendarReminder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "uid" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "recurrenceKey" TEXT NOT NULL,
  "alarmId" TEXT NOT NULL,
  "occurrenceStart" TIMESTAMP(3) NOT NULL,
  "triggerAt" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "timeZone" TEXT NOT NULL,
  "allDay" BOOLEAN NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "claimOwner" TEXT,
  "claimUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  CONSTRAINT "CalendarReminder_state_check" CHECK ("state" IN ('pending', 'sent', 'skipped')),
  CONSTRAINT "CalendarReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CalendarReminder_userId_uid_recurrenceKey_alarmId_key" ON "CalendarReminder"("userId", "uid", "recurrenceKey", "alarmId");
CREATE INDEX "CalendarReminder_state_triggerAt_idx" ON "CalendarReminder"("state", "triggerAt");
CREATE INDEX "CalendarReminder_userId_state_idx" ON "CalendarReminder"("userId", "state");
