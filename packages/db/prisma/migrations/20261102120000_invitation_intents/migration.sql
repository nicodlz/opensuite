CREATE TABLE "InvitationSeries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "organizer" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "eventId" TEXT,
    "calendar" TEXT,
    "eventSnapshot" TEXT,
    "pendingId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvitationSeries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvitationSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvitationSeries_userId_accountId_uid_key" ON "InvitationSeries"("userId", "accountId", "uid");
CREATE INDEX "InvitationSeries_userId_idx" ON "InvitationSeries"("userId");

CREATE TABLE "InvitationOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "calendar" TEXT NOT NULL,
    "organizerCalendar" TEXT,
    "baseSnapshot" TEXT,
    "participation" TEXT,
    "recurrenceId" TEXT,
    "draftId" TEXT,
    "identityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvitationOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvitationOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InvitationOperation_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "InvitationSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "InvitationOperation_userId_seriesId_idx" ON "InvitationOperation"("userId", "seriesId");

CREATE INDEX "InboundRecipient_destination_remoteId_idx" ON "InboundRecipient"("destination", "remoteId");
