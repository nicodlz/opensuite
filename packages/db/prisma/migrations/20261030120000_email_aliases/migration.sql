ALTER TABLE "Domain" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "defaultAliasDomainId" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_defaultAliasDomainId_fkey" FOREIGN KEY ("defaultAliasDomainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EmailAlias" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "domainId" TEXT NOT NULL,
  "addressId" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "localPart" TEXT NOT NULL,
  "website" TEXT,
  "note" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "ready" BOOLEAN NOT NULL DEFAULT false,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "EmailAlias_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailAlias_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmailAlias_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmailAlias_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailAlias_addressId_key" ON "EmailAlias"("addressId");
CREATE UNIQUE INDEX "EmailAlias_address_key" ON "EmailAlias"("address");
CREATE UNIQUE INDEX "EmailAlias_address_lower_key" ON "EmailAlias"(lower("address"));
CREATE UNIQUE INDEX "EmailAlias_userId_requestId_key" ON "EmailAlias"("userId", "requestId");
CREATE INDEX "EmailAlias_userId_idx" ON "EmailAlias"("userId");

CREATE TABLE "AliasApiKey" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AliasApiKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AliasApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AliasApiKey_prefix_key" ON "AliasApiKey"("prefix");
CREATE INDEX "AliasApiKey_userId_idx" ON "AliasApiKey"("userId");
