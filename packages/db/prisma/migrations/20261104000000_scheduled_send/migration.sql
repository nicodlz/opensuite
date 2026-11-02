CREATE TABLE "ScheduledSend" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "identityId" TEXT NOT NULL,
  "releaseAt" TIMESTAMP(3) NOT NULL,
  "submissionId" TEXT,
  "previousIds" TEXT[] NOT NULL,
  "requestDelivery" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ScheduledSend_userId_id_key" ON "ScheduledSend"("userId", "id");
CREATE INDEX "ScheduledSend_userId_accountId_state_idx" ON "ScheduledSend"("userId", "accountId", "state");
CREATE INDEX "ScheduledSend_state_releaseAt_idx" ON "ScheduledSend"("state", "releaseAt");
CREATE TABLE "MailDraftGuard" (
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountId" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "accountId", "draftId")
);
