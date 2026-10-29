CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "notification" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'received',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboundRecipient" (
    "idempotencyKey" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "addresses" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "remoteId" TEXT,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboundRecipient_pkey" PRIMARY KEY ("idempotencyKey")
);
CREATE INDEX "InboundRecipient_messageId_idx" ON "InboundRecipient"("messageId");
ALTER TABLE "InboundRecipient" ADD CONSTRAINT "InboundRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "InboundMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
