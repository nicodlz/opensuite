DELETE FROM "Verification" WHERE "identifier" LIKE 'trust-device-%';

CREATE FUNCTION "guardTwoFactorEnabled"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM "TwoFactor" WHERE "userId" = NEW.id AND "verified" = true)
      OR EXISTS (SELECT 1 FROM "SecurityKey" WHERE "userId" = NEW.id)
    INTO expected;
  IF NEW."twoFactorEnabled" IS DISTINCT FROM expected THEN
    UPDATE "User" SET "twoFactorEnabled" = expected WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "User_guardTwoFactorEnabled" AFTER UPDATE OF "twoFactorEnabled" ON "User"
  FOR EACH ROW EXECUTE FUNCTION "guardTwoFactorEnabled"();
