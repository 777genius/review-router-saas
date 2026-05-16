CREATE TYPE "ConflictReviewAttemptStatus" AS ENUM ('recorded', 'dispatched', 'started', 'completed', 'failed', 'skipped', 'stale');

CREATE TABLE "ConflictReviewAttempt" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "githubRepositoryId" BIGINT NOT NULL,
  "githubInstallationId" BIGINT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "headSha" TEXT NOT NULL,
  "baseRef" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "fallbackVersion" INTEGER NOT NULL,
  "dispatchId" TEXT NOT NULL,
  "dispatchNonceHash" TEXT NOT NULL,
  "dispatchEventType" TEXT NOT NULL,
  "status" "ConflictReviewAttemptStatus" NOT NULL DEFAULT 'recorded',
  "githubRunId" TEXT,
  "githubRunAttempt" TEXT,
  "configSnapshotId" TEXT,
  "safeErrorCode" TEXT,
  "safeErrorSummary" TEXT,
  "normalReviewRecheckNeeded" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ConflictReviewAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConflictReviewAttempt_dispatchId_key" ON "ConflictReviewAttempt"("dispatchId");
CREATE UNIQUE INDEX "ConflictReviewAttempt_repositoryId_pullRequestNumber_headSha_baseRef_baseSha_fallbackVersion_key" ON "ConflictReviewAttempt"("repositoryId", "pullRequestNumber", "headSha", "baseRef", "baseSha", "fallbackVersion");
CREATE INDEX "ConflictReviewAttempt_workspaceId_status_idx" ON "ConflictReviewAttempt"("workspaceId", "status");
CREATE INDEX "ConflictReviewAttempt_repositoryId_pullRequestNumber_status_idx" ON "ConflictReviewAttempt"("repositoryId", "pullRequestNumber", "status");
CREATE INDEX "ConflictReviewAttempt_githubRepositoryId_pullRequestNumber_headSha_idx" ON "ConflictReviewAttempt"("githubRepositoryId", "pullRequestNumber", "headSha");
CREATE INDEX "ConflictReviewAttempt_dispatchId_status_idx" ON "ConflictReviewAttempt"("dispatchId", "status");

ALTER TABLE "ConflictReviewAttempt" ADD CONSTRAINT "ConflictReviewAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConflictReviewAttempt" ADD CONSTRAINT "ConflictReviewAttempt_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
