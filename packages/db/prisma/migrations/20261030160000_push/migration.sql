ALTER TABLE "User" ADD COLUMN "pushShowDetails" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "PushSubscription" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "product" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL, "p256dh" TEXT NOT NULL, "auth" TEXT NOT NULL,
  "userAgent" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSuccessAt" TIMESTAMP(3), "failureCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3), CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PushSubscription_product_check" CHECK ("product" IN ('mail','calendar','drive')),
  CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_product_idx" ON "PushSubscription"("userId", "product");
CREATE TABLE "PushTag" (
  "userId" TEXT NOT NULL, "product" TEXT NOT NULL, "tag" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushTag_pkey" PRIMARY KEY ("userId", "product", "tag"),
  CONSTRAINT "PushTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PushTag_expiresAt_idx" ON "PushTag"("expiresAt");
