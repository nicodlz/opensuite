ALTER TABLE "InboundRecipient" ADD COLUMN "claimedAt" TIMESTAMP(3), ADD COLUMN "claimOwner" TEXT;

-- Earlier workers encoded the JSON document as a JSON string scalar.
UPDATE "InboundMessage"
SET "notification" = ("notification" #>> '{}')::jsonb
WHERE jsonb_typeof("notification") = 'string';
