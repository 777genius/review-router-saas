ALTER TABLE "ReviewExecutionCheckpoint"
  ADD COLUMN "acceptedFindings" INTEGER NOT NULL DEFAULT 0;

UPDATE "ReviewExecutionCheckpoint" checkpoint
SET "acceptedFindings" = COALESCE((
  SELECT SUM(jsonb_array_length(batch."payload" -> 'findings'))::INTEGER
  FROM "ReviewExecutionBatchResult" batch
  WHERE batch."checkpointId" = checkpoint."id"
), 0);

ALTER TABLE "ReviewExecutionCheckpoint"
  ADD CONSTRAINT "ReviewExecutionCheckpoint_acceptedFindings_check"
  CHECK ("acceptedFindings" BETWEEN 0 AND 1000);
