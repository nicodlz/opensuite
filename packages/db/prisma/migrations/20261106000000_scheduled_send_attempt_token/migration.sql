ALTER TABLE "ScheduledSend" DROP CONSTRAINT "ScheduledSend_lease_check";
ALTER TABLE "ScheduledSend" ADD CONSTRAINT "ScheduledSend_lease_check"
  CHECK (
    ("leaseToken" IS NULL) = ("leaseUntil" IS NULL)
    AND ("state" <> 'preparing' OR "leaseToken" IS NOT NULL)
    AND ("state" IN ('preparing', 'creating', 'unknown', 'canceling') OR "leaseToken" IS NULL)
  );
