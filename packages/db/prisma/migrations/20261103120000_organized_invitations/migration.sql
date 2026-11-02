-- CreateTable
CREATE TABLE "OrganizedSeries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "organizer" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "eventId" TEXT,
    "calendar" TEXT,
    "snapshot" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "pendingId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizedSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizedOperation" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "calendar" TEXT NOT NULL,
    "baseSnapshot" TEXT,
    "sequence" INTEGER NOT NULL,
    "cancelled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizedOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizedDelivery" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "calendar" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "draftId" TEXT,
    "identityId" TEXT,

    CONSTRAINT "OrganizedDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizedResponse" (
    "seriesId" TEXT NOT NULL,
    "attendee" TEXT NOT NULL,
    "occurrence" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "partstat" TEXT NOT NULL,

    CONSTRAINT "OrganizedResponse_pkey" PRIMARY KEY ("seriesId","attendee","occurrence")
);

-- CreateTable
CREATE TABLE "OrganizedReplyScan" (
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "uid" TEXT,
    "outcome" TEXT NOT NULL,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "nextAttemptAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizedReplyScan_pkey" PRIMARY KEY ("userId","accountId","messageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizedSeries_userId_accountId_uid_key" ON "OrganizedSeries"("userId", "accountId", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizedSeries_userId_accountId_eventId_key" ON "OrganizedSeries"("userId", "accountId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizedDelivery_operationId_recipient_key" ON "OrganizedDelivery"("operationId", "recipient");

-- CreateIndex
CREATE INDEX "OrganizedReplyScan_userId_accountId_outcome_messageId_idx" ON "OrganizedReplyScan"("userId", "accountId", "outcome", "messageId");

-- AddForeignKey
ALTER TABLE "OrganizedSeries" ADD CONSTRAINT "OrganizedSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizedOperation" ADD CONSTRAINT "OrganizedOperation_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "OrganizedSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizedDelivery" ADD CONSTRAINT "OrganizedDelivery_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "OrganizedOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizedResponse" ADD CONSTRAINT "OrganizedResponse_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "OrganizedSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizedReplyScan" ADD CONSTRAINT "OrganizedReplyScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
