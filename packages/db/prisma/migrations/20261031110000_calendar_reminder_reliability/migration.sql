ALTER TABLE "User" ADD COLUMN "calendarTimeZone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "CalendarReminder" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
DROP INDEX "CalendarReminder_userId_uid_recurrenceKey_alarmId_key";
CREATE UNIQUE INDEX "calendar_reminder_identity_key" ON "CalendarReminder"("userId", "uid", "recurrenceKey", "alarmId", "occurrenceStart");
CREATE INDEX "CalendarReminder_state_updatedAt_idx" ON "CalendarReminder"("state", "updatedAt");
