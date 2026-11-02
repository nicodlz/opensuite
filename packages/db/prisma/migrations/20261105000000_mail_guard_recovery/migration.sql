ALTER TABLE "MailDraftGuard"
  ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MailDraftGuard"
  ADD CONSTRAINT "MailDraftGuard_phase_check"
  CHECK ("phase" IN ('legacy', 'preparing', 'destroy', 'send', 'mutation', 'scheduled'));

CREATE INDEX "MailDraftGuard_phase_updatedAt_idx" ON "MailDraftGuard"("phase", "updatedAt");

ALTER TABLE "ScheduledSend"
  ADD CONSTRAINT "ScheduledSend_state_check"
  CHECK ("state" IN ('preparing', 'creating', 'pending', 'canceling', 'unknown', 'releasing', 'sent', 'canceled', 'failed'));
