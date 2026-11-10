-- A durable linkage identity, distinct from address, credentials and account aliases.
-- The volatile default gives each existing row its own UUID during the backfill.
ALTER TABLE "MailboxLink" ADD COLUMN "bindingId" UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "MailboxLink_bindingId_key" ON "MailboxLink"("bindingId");
