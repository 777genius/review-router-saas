ALTER TABLE "ReviewRequestedIntent"
ADD COLUMN "rerunPredecessorRequestId" TEXT;

CREATE INDEX "ReviewRequestedIntent_repositoryConnectionId_sourceRunId_sourceRunAttempt_idx"
ON "ReviewRequestedIntent"("repositoryConnectionId", "sourceRunId", "sourceRunAttempt");

CREATE INDEX "ReviewRequestedIntent_rerunPredecessorRequestId_idx"
ON "ReviewRequestedIntent"("rerunPredecessorRequestId");
