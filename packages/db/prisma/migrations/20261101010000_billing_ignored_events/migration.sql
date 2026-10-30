ALTER TABLE "StripeEvent" ADD COLUMN "ignoredAt" TIMESTAMP(3);
ALTER TABLE "BillingCustomer" ADD COLUMN "metadataSyncedAt" TIMESTAMP(3);
