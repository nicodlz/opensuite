ALTER TABLE "MailImportJob" ADD COLUMN "sourceKind" TEXT,
  ADD COLUMN "sourceDetails" JSONB,
  ADD COLUMN "sourceConfig" TEXT,
  ADD COLUMN "sourceExpiresAt" TIMESTAMP(3),
  ADD COLUMN "inventoryReady" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MailImportItem" ADD COLUMN "sourceRef" JSONB,
  ADD COLUMN "sourceRaw" TEXT;
