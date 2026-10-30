CREATE TABLE "SecurityKey" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "publicKey" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "SecurityKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SecurityKey_credentialId_key" ON "SecurityKey"("credentialId");
CREATE INDEX "SecurityKey_userId_idx" ON "SecurityKey"("userId");

-- Keep the sign-in gate consistent even when TOTP verification and key
-- removal race in separate requests. Unverified enrolments are not factors.
CREATE FUNCTION "lockFactorOwner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN owner_id := OLD."userId";
  ELSE owner_id := NEW."userId";
  END IF;
  PERFORM 1 FROM "User" WHERE "id" = owner_id FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE FUNCTION "syncTwoFactorEnabled"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN owner_id := OLD."userId";
  ELSE owner_id := NEW."userId";
  END IF;
  UPDATE "User" SET "twoFactorEnabled" = (
    EXISTS (SELECT 1 FROM "TwoFactor" WHERE "userId" = owner_id AND "verified" = true)
    OR EXISTS (SELECT 1 FROM "SecurityKey" WHERE "userId" = owner_id)
  ) WHERE "id" = owner_id;
  RETURN NULL;
END $$;
CREATE TRIGGER "TwoFactor_lockOwner" BEFORE INSERT OR UPDATE OF "verified" OR DELETE ON "TwoFactor"
  FOR EACH ROW EXECUTE FUNCTION "lockFactorOwner"();
CREATE TRIGGER "SecurityKey_lockOwner" BEFORE INSERT OR DELETE ON "SecurityKey"
  FOR EACH ROW EXECUTE FUNCTION "lockFactorOwner"();
CREATE TRIGGER "TwoFactor_syncEnabled" AFTER INSERT OR UPDATE OF "verified" OR DELETE ON "TwoFactor"
  FOR EACH ROW EXECUTE FUNCTION "syncTwoFactorEnabled"();
CREATE TRIGGER "SecurityKey_syncEnabled" AFTER INSERT OR DELETE ON "SecurityKey"
  FOR EACH ROW EXECUTE FUNCTION "syncTwoFactorEnabled"();
UPDATE "User" AS u SET "twoFactorEnabled" = EXISTS (
  SELECT 1 FROM "TwoFactor" AS t WHERE t."userId" = u."id" AND t."verified" = true
);
