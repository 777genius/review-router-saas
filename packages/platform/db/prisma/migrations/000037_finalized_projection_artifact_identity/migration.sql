-- Preserve the content-addressed artifact ID while making each execution's
-- finalized artifact row the persistence identity.
BEGIN;

CREATE UNIQUE INDEX "FinalizedReviewProjectionArtifactV2_executionId_artifactId_key"
ON "FinalizedReviewProjectionArtifactV2"("executionId", "artifactId");

CREATE INDEX "FinalizedReviewProjectionArtifactV2_artifactId_idx"
ON "FinalizedReviewProjectionArtifactV2"("artifactId");

ALTER TABLE "ReviewCompletionProcess"
DROP CONSTRAINT "ReviewCompletionProcess_finalizedArtifactId_fkey";

ALTER TABLE "FinalizedReviewProjectionArtifactV2"
DROP CONSTRAINT "FinalizedReviewProjectionArtifactV2_pkey";

-- Reuse the existing executionId unique index so the primary-key cutover does
-- not rebuild or rescan the table.
ALTER TABLE "FinalizedReviewProjectionArtifactV2"
ADD CONSTRAINT "FinalizedReviewProjectionArtifactV2_pkey"
PRIMARY KEY USING INDEX "FinalizedReviewProjectionArtifactV2_executionId_key";

ALTER TABLE "ReviewCompletionProcess"
ADD CONSTRAINT "ReviewCompletionProcess_finalizedArtifactId_fkey"
FOREIGN KEY ("executionId", "finalizedArtifactId")
REFERENCES "FinalizedReviewProjectionArtifactV2"("executionId", "artifactId")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

COMMIT;
