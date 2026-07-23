ALTER TABLE "ReviewInvocationLeaseV2"
  ADD COLUMN "preparedManifestCanonicalJson" TEXT,
  ADD COLUMN "preparedManifestKey" TEXT,
  ADD COLUMN "providerVoteIdentityHash" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ReviewInvocationLeaseV2"
  ) THEN
    RAISE EXCEPTION 'review_invocation_prepared_manifest_backfill_required';
  END IF;
END $$;

ALTER TABLE "ReviewInvocationLeaseV2"
  ALTER COLUMN "providerVoteIdentityHash" SET NOT NULL,
  DROP CONSTRAINT "ReviewInvocationLeaseV2_valid_purpose",
  ADD CONSTRAINT "ReviewInvocationLeaseV2_valid_purpose" CHECK (
    (
      "purpose" = 'provider_execution'
      AND "attemptId" IS NOT NULL
      AND "sourceObservationId" IS NULL
      AND "preparedManifestCanonicalJson" IS NOT NULL
      AND "preparedManifestKey" IS NOT NULL
    ) OR (
      "purpose" = 'observation_adoption'
      AND "attemptId" IS NULL
      AND "sourceObservationId" IS NOT NULL
      AND "preparedManifestCanonicalJson" IS NULL
      AND "preparedManifestKey" IS NULL
    )
  );
