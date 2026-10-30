CREATE TABLE "MailPushState" (
  "userId" TEXT NOT NULL,
  "generation" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "state" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  CONSTRAINT "MailPushState_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "MailPushState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Serialize the first/last subscription transition for each user, including
-- subscriptions removed by the push transport after a permanent failure.
CREATE FUNCTION mail_push_subscription_lock() RETURNS trigger AS $$
BEGIN
  IF COALESCE(NEW."product", OLD."product") = 'mail' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(COALESCE(NEW."userId", OLD."userId"), 78127));
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mail_push_subscription_lock BEFORE INSERT OR DELETE ON "PushSubscription"
  FOR EACH ROW EXECUTE FUNCTION mail_push_subscription_lock();
CREATE FUNCTION mail_push_subscription_cleanup() RETURNS trigger AS $$
BEGIN
  IF OLD."product" = 'mail' AND NOT EXISTS (
    SELECT 1 FROM "PushSubscription" WHERE "userId" = OLD."userId" AND "product" = 'mail'
  ) THEN
    DELETE FROM "MailPushState" WHERE "userId" = OLD."userId";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mail_push_subscription_cleanup AFTER DELETE ON "PushSubscription"
  FOR EACH ROW EXECUTE FUNCTION mail_push_subscription_cleanup();
