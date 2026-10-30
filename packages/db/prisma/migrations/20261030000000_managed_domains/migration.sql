-- Refuse ambiguous pre-existing names rather than silently choosing an owner.
CREATE UNIQUE INDEX "Domain_name_lower_key" ON "Domain" (lower("name"));
CREATE UNIQUE INDEX "Address_domain_local_lower_key" ON "Address" ("domainId", lower("localPart"));
ALTER TABLE "Domain" ADD COLUMN "stalwartId" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "records" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "checkedAt" TIMESTAMP(3);
ALTER TABLE "Address" DROP CONSTRAINT "Address_domainId_userId_fkey";
ALTER TABLE "Address" ADD CONSTRAINT "Address_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
