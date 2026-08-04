ALTER TABLE "ReviewContextGatewaySession"
ADD COLUMN "openingIntentHash" TEXT
DEFAULT '4d29442a15edaf0c8d2a044f12e695b0a514842ab5d4a566c2a26e451a55c19b';

UPDATE "ReviewContextGatewaySession"
SET "openingIntentHash" =
  '4d29442a15edaf0c8d2a044f12e695b0a514842ab5d4a566c2a26e451a55c19b'
WHERE "openingIntentHash" IS NULL;

ALTER TABLE "ReviewContextGatewaySession"
ALTER COLUMN "openingIntentHash" SET NOT NULL;

CREATE UNIQUE INDEX "ReviewContextGatewaySession_attemptId_openingIntentHash_key"
ON "ReviewContextGatewaySession"("attemptId", "openingIntentHash");

CREATE FUNCTION "reviewContextGatewaySessionOpeningCompatibility"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'review-context-opening:' || NEW."attemptId",
      0
    )
  );

  IF NEW."openingIntentHash" =
      '4d29442a15edaf0c8d2a044f12e695b0a514842ab5d4a566c2a26e451a55c19b'
    AND EXISTS (
      SELECT 1
      FROM "ReviewContextGatewaySession" AS existing
      WHERE existing."attemptId" = NEW."attemptId"
    )
  THEN
    RAISE EXCEPTION 'duplicate legacy context gateway attempt: %', NEW."attemptId"
      USING
        ERRCODE = 'unique_violation',
        CONSTRAINT = 'ReviewContextGatewaySession_legacy_attempt_key';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReviewContextGatewaySession_opening_compatibility"
BEFORE INSERT ON "ReviewContextGatewaySession"
FOR EACH ROW
EXECUTE FUNCTION "reviewContextGatewaySessionOpeningCompatibility"();

DROP INDEX "ReviewContextGatewaySession_attemptId_key";

-- The legacy default and compatibility trigger are rollout bridges. A later
-- contract migration may remove them after all pre-000052 writers are retired.
