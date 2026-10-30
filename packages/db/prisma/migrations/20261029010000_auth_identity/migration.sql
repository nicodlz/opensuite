ALTER TABLE "User" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user', ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD CONSTRAINT user_role_check CHECK ("role" IN ('user', 'admin'));
ALTER TABLE "AuditEvent" ALTER COLUMN "userId" DROP NOT NULL;
CREATE TABLE "TwoFactor" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL UNIQUE,
  "secret" TEXT NOT NULL, "backupCodes" TEXT NOT NULL, "verified" BOOLEAN NOT NULL DEFAULT true,
  "failedVerificationCount" INTEGER NOT NULL DEFAULT 0, "lockedUntil" TIMESTAMP(3),
  CONSTRAINT "TwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "MailboxLink" (
  "userId" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL UNIQUE, "address" TEXT NOT NULL UNIQUE,
  "credentialId" TEXT NOT NULL, "secret" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MailboxLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT mailbox_status_check CHECK ("status" IN ('active', 'disabling', 'disabled')),
  CONSTRAINT mailbox_secret_envelope CHECK ("secret" ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$')
);
