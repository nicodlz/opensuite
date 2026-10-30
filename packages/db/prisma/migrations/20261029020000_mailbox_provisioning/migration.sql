CREATE TABLE "MailboxProvision" (
  "userId" TEXT PRIMARY KEY,
  "accountId" TEXT,
  "address" TEXT,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MailboxProvision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT mailbox_provision_state_check CHECK ("state" IN ('pending', 'issuing', 'active'))
);
