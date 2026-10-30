DROP INDEX "EmailAlias_address_lower_key";
ALTER TABLE "EmailAlias" ADD CONSTRAINT "EmailAlias_address_lowercase" CHECK ("address" = lower("address"));
ALTER TABLE "EmailAlias" ADD COLUMN "detachedByDomain" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "aliasSyncToken" TEXT,
  ADD COLUMN "aliasSyncUntil" TIMESTAMP(3);
ALTER TABLE "Domain" DROP COLUMN "enabled";
