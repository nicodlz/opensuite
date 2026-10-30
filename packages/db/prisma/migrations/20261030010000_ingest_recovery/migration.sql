ALTER TABLE "InboundRecipient" ADD COLUMN "importStartedAt" TIMESTAMP(3), ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "permanent" BOOLEAN NOT NULL DEFAULT false;

-- Existing in-flight and uncertain imports may predate the keyword and marker.
UPDATE "InboundRecipient" SET "legacy" = true WHERE "state" IN ('importing', 'uncertain');

-- Recover permanent classifications from errors written by earlier workers.
UPDATE "InboundRecipient" SET "permanent" = true
WHERE "state" = 'failed' AND "error" LIKE 'JMAP import: %'
  AND "error" ~ '"kind":"(set|method)"'
  AND "error" ~ '"type":"(invalidArguments|invalidProperties|invalidEmail|invalidKeywords|forbidden)"';

CREATE TABLE "InboundResolutionAudit" (
    "id" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousState" TEXT NOT NULL,
    "remoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboundResolutionAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InboundResolutionAudit_recipientKey_idx" ON "InboundResolutionAudit"("recipientKey");
CREATE TRIGGER inbound_resolution_audit_no_update_delete BEFORE UPDATE OR DELETE ON "InboundResolutionAudit"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER inbound_resolution_audit_no_truncate BEFORE TRUNCATE ON "InboundResolutionAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
