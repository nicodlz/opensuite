CREATE TABLE "CalendarImportJob" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "confirmed" BOOLEAN NOT NULL DEFAULT false,
  "abandoned" BOOLEAN NOT NULL DEFAULT false,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CalendarImportJob_userId_createdAt_idx" ON "CalendarImportJob"("userId", "createdAt");
CREATE TABLE "CalendarImportItem" (
  "id" TEXT PRIMARY KEY,
  "jobId" TEXT NOT NULL REFERENCES "CalendarImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "index" INTEGER NOT NULL,
  "file" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "uid" TEXT,
  "title" TEXT NOT NULL,
  "event" TEXT,
  "issues" TEXT NOT NULL,
  "previewState" TEXT NOT NULL,
  "previewReason" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "state" TEXT NOT NULL,
  "error" TEXT,
  "eventId" TEXT,
  CONSTRAINT "CalendarImportItem_state_check" CHECK ("state" IN ('pending', 'processing', 'imported', 'duplicate', 'failed', 'abandoned')),
  CONSTRAINT "CalendarImportItem_previewState_check" CHECK ("previewState" IN ('new', 'update', 'duplicate', 'conflict', 'invalid'))
);
CREATE UNIQUE INDEX "CalendarImportItem_jobId_index_key" ON "CalendarImportItem"("jobId", "index");

CREATE TABLE "CalendarImportIdentity" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "uid" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "eventId" TEXT
);
CREATE UNIQUE INDEX "CalendarImportIdentity_userId_accountId_calendarId_uid_key" ON "CalendarImportIdentity"("userId", "accountId", "calendarId", "uid");
