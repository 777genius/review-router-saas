ALTER TYPE "ReviewInvestigationObligationKindV1" ADD VALUE 'finding_revalidation' BEFORE 'context_critic';

CREATE TABLE "ReviewInvestigationReplayEvidenceCheckpoint" (
  "checkpointId" TEXT NOT NULL,
  "checkpointHash" TEXT NOT NULL,
  "sourceInvestigationId" TEXT NOT NULL,
  "sourceInvestigationVersion" BIGINT NOT NULL,
  "sourceDossierDigest" TEXT NOT NULL,
  "scopeHash" TEXT NOT NULL,
  "reviewRevisionHash" TEXT NOT NULL,
  "stableReviewUnitKey" TEXT NOT NULL,
  "providerVoteLaneId" TEXT NOT NULL,
  "contractHash" TEXT NOT NULL,
  "policyHash" TEXT NOT NULL,
  "producerReleaseId" TEXT NOT NULL,
  "producerReleaseHash" TEXT NOT NULL,
  "runtimeProfileHash" TEXT NOT NULL,
  "receiptSetHash" TEXT NOT NULL,
  "contextAttestationSetHash" TEXT NOT NULL,
  "sourceState" "ReviewInvestigationStateV1" NOT NULL,
  "sourceConclusion" "ReviewInvestigationConclusionV1",
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewInvestigationReplayEvidenceCheckpoint_pkey" PRIMARY KEY ("checkpointId")
);

CREATE UNIQUE INDEX "ReviewInvestigationReplayCheckpoint_hash_key" ON "ReviewInvestigationReplayEvidenceCheckpoint"("checkpointHash");
CREATE UNIQUE INDEX "ReviewInvestigationReplayCheckpoint_source_version_key" ON "ReviewInvestigationReplayEvidenceCheckpoint"("sourceInvestigationId", "sourceInvestigationVersion");
CREATE INDEX "ReviewInvestigationReplayCheckpoint_revision_unit_idx" ON "ReviewInvestigationReplayEvidenceCheckpoint"("reviewRevisionHash", "stableReviewUnitKey");
CREATE INDEX "ReviewInvestigationReplayCheckpoint_expiry_idx" ON "ReviewInvestigationReplayEvidenceCheckpoint"("expiresAt", "checkpointId");

ALTER TABLE "ReviewInvestigation" ADD COLUMN "replayEvidenceCheckpointId" TEXT;
CREATE UNIQUE INDEX "ReviewInvestigation_replayEvidenceCheckpointId_key" ON "ReviewInvestigation"("replayEvidenceCheckpointId");

ALTER TABLE "ReviewInvestigationReplayEvidenceCheckpoint"
  ADD CONSTRAINT "ReviewInvestigationReplayCheckpoint_source_fkey"
  FOREIGN KEY ("sourceInvestigationId") REFERENCES "ReviewInvestigation"("investigationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewInvestigation"
  ADD CONSTRAINT "ReviewInvestigation_replayEvidenceCheckpoint_fkey"
  FOREIGN KEY ("replayEvidenceCheckpointId") REFERENCES "ReviewInvestigationReplayEvidenceCheckpoint"("checkpointId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
