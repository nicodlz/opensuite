CREATE TABLE "BillingGrant" (
  "userId" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "BillingGrant_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "BillingGrant_plan_check" CHECK ("plan" IN ('plus', 'pro', 'unlimited')),
  CONSTRAINT "BillingGrant_reason_check" CHECK (length(trim("reason")) > 0),
  CONSTRAINT "BillingGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
REVOKE ALL ON "BillingGrant" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensuite_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON "BillingGrant" FROM opensuite_app;
    GRANT SELECT ON "BillingGrant" TO opensuite_app;
  END IF;
END $$;
