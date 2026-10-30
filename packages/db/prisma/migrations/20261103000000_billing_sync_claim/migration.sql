ALTER TABLE "CheckoutClaim" ADD COLUMN "pendingUserId" TEXT;
ALTER TABLE "CheckoutClaim" ADD COLUMN "signupLeaseUntil" TIMESTAMP(3);
ALTER TABLE "CheckoutClaim" ADD COLUMN "signupLeaseToken" TEXT;
CREATE UNIQUE INDEX "CheckoutClaim_pendingUserId_key" ON "CheckoutClaim"("pendingUserId");
CREATE TABLE "BillingSyncState" (
  "id" TEXT NOT NULL,
  "lastCompletedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  CONSTRAINT "BillingSyncState_pkey" PRIMARY KEY ("id")
);
