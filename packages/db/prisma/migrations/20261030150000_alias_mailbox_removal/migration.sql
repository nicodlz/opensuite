ALTER TABLE "EmailAlias" ADD COLUMN "lastAccountId" TEXT;
UPDATE "EmailAlias" AS a SET "lastAccountId" = COALESCE(m."accountId", p."accountId")
  FROM "User" AS u LEFT JOIN "MailboxLink" AS m ON m."userId" = u."id"
  LEFT JOIN "MailboxProvision" AS p ON p."userId" = u."id" WHERE a."userId" = u."id";
UPDATE "EmailAlias" AS a SET "ready" = false, "suspended" = false,
  "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
  WHERE a."enabled" = true AND a."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "MailboxLink" AS m WHERE m."userId" = a."userId");

CREATE OR REPLACE FUNCTION "requeue_aliases_on_mailbox_state"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id TEXT; previous_account TEXT;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    owner_id := OLD."userId";
    previous_account := OLD."accountId";
  ELSE
    owner_id := NEW."userId";
    previous_account := NEW."accountId";
  END IF;
  IF TG_OP <> 'UPDATE' OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."accountId" IS DISTINCT FROM OLD."accountId" THEN
    UPDATE "EmailAlias" SET "ready" = false, "suspended" = false, "lastAccountId" = COALESCE("lastAccountId", previous_account), "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userId" = owner_id AND "enabled" = true AND "deletedAt" IS NULL;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER "MailboxLink_requeue_aliases" ON "MailboxLink";
CREATE TRIGGER "MailboxLink_requeue_aliases" AFTER INSERT OR UPDATE OF "status", "accountId" OR DELETE ON "MailboxLink" FOR EACH ROW EXECUTE FUNCTION "requeue_aliases_on_mailbox_state"();
