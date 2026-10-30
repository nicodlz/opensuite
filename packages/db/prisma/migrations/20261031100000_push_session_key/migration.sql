ALTER TABLE "PushSubscription" ADD COLUMN "vapidFingerprint" TEXT, ADD COLUMN "sessionId" TEXT;
CREATE INDEX "PushSubscription_userId_sessionId_idx" ON "PushSubscription"("userId", "sessionId");
-- Legacy rows cannot be attributed to a session or a VAPID key. Re-enrol them.
DELETE FROM "PushSubscription";
