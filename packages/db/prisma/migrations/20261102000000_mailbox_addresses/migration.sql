ALTER TABLE "Address" ADD COLUMN "mailboxManaged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ready" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "removalPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastAccountId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Address_mailboxManaged_ready_updatedAt_idx" ON "Address"("mailboxManaged", "ready", "updatedAt");

-- Adopt existing extra mailbox records into reconciliation while leaving any
-- explicit record of a user's primary address under the primary lifecycle.
UPDATE "Address" AS a
SET "mailboxManaged" = true, "lastAccountId" = m."accountId"
FROM "Domain" AS d, "User" AS u
LEFT JOIN "MailboxLink" AS m ON m."userId" = u."id"
WHERE a."domainId" = d."id" AND a."userId" = u."id" AND a."isAlias" = false
  AND lower(a."localPart" || '@' || d."name") <> lower(u."email");
