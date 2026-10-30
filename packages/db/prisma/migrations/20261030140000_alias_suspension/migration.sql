ALTER TABLE "EmailAlias" ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Domain" ADD COLUMN "removalPending" BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION "requeue_aliases_on_user_state"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."disabled" IS DISTINCT FROM OLD."disabled" THEN
    UPDATE "EmailAlias" SET "ready" = false, "suspended" = false, "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userId" = NEW."id" AND "enabled" = true AND "deletedAt" IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "User_requeue_aliases" AFTER UPDATE OF "disabled" ON "User" FOR EACH ROW EXECUTE FUNCTION "requeue_aliases_on_user_state"();

CREATE FUNCTION "requeue_aliases_on_mailbox_state"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    UPDATE "EmailAlias" SET "ready" = false, "suspended" = false, "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userId" = NEW."userId" AND "enabled" = true AND "deletedAt" IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MailboxLink_requeue_aliases" AFTER INSERT OR UPDATE OF "status" ON "MailboxLink" FOR EACH ROW EXECUTE FUNCTION "requeue_aliases_on_mailbox_state"();
