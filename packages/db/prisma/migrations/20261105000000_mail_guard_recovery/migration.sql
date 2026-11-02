ALTER TABLE "MailDraftGuard"
  ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "mutationState" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MailDraftGuard"
  ADD CONSTRAINT "MailDraftGuard_phase_check"
  CHECK ("phase" IN ('legacy', 'preparing', 'destroy', 'send', 'mutation', 'scheduled')),
  ADD CONSTRAINT "MailDraftGuard_mutation_state_check"
  CHECK ("phase" <> 'mutation' OR "mutationState" IS NOT NULL);

CREATE INDEX "MailDraftGuard_phase_updatedAt_idx" ON "MailDraftGuard"("phase", "updatedAt");

ALTER TABLE "ScheduledSend"
  ADD CONSTRAINT "ScheduledSend_state_check"
  CHECK ("state" IN ('preparing', 'creating', 'pending', 'canceling', 'unknown', 'releasing', 'sent', 'canceled', 'failed'));
