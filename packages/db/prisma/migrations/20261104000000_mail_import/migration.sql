CREATE TABLE "MailImportJob" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "variant" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "labels" JSONB NOT NULL,
  "archive" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "claimToken" TEXT,
  "claimUntil" TIMESTAMP(3),
  "total" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "MailImportItem" (
  "jobId" TEXT NOT NULL REFERENCES "MailImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "index" INTEGER NOT NULL,
  "marker" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "remoteId" TEXT,
  PRIMARY KEY ("jobId", "index")
);
CREATE INDEX "MailImportJob_userId_createdAt_idx" ON "MailImportJob"("userId", "createdAt");
CREATE INDEX "MailImportJob_status_claimUntil_idx" ON "MailImportJob"("status", "claimUntil");
CREATE UNIQUE INDEX "MailImportJob_one_active_per_user" ON "MailImportJob"("userId") WHERE "status" IN ('queued', 'running', 'attention');
