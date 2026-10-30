ALTER TABLE "CheckoutClaim" ADD COLUMN "pendingEmail" TEXT;
CREATE UNIQUE INDEX "CheckoutClaim_pendingEmail_key" ON "CheckoutClaim"("pendingEmail");

ALTER TABLE "Subscription" ADD COLUMN "stripeCreatedAt" TIMESTAMP(3);
