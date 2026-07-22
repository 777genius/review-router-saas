ALTER TYPE "ReviewPublicationOperationStateV2" ADD VALUE IF NOT EXISTS 'superseded_no_effect';
ALTER TYPE "ReviewPublicationOperationStateV2" ADD VALUE IF NOT EXISTS 'failed_no_effect';
ALTER TYPE "ReviewPublicationOperationStateV2" ADD VALUE IF NOT EXISTS 'stale_compensated';
ALTER TYPE "ReviewPublicationOperationStateV2" ADD VALUE IF NOT EXISTS 'stale_visible';

ALTER TABLE "ReviewPublicationOperationV2"
  ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextEligibleAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastErrorCode" TEXT;

ALTER TABLE "ReviewPublicationExternalEffectV2"
  ADD COLUMN "observedObjectHash" TEXT;

UPDATE "ReviewPublicationExternalEffectV2"
SET "observedObjectHash" = "reportRequestHash"
WHERE "observedObjectHash" IS NULL;

ALTER TABLE "ReviewPublicationExternalEffectV2"
  ALTER COLUMN "observedObjectHash" SET NOT NULL;

CREATE INDEX "ReviewPublicationOperationV2_state_nextEligibleAt_publicationOperationId_idx"
  ON "ReviewPublicationOperationV2"("state", "nextEligibleAt", "publicationOperationId");
