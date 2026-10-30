ALTER TABLE "Address" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "removedAt" TIMESTAMP(3);
UPDATE "Address" SET "active" = true WHERE "mailboxManaged" = true AND "ready" = true AND "removalPending" = false;
