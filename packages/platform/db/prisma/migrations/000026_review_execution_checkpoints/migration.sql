-- CreateEnum
CREATE TYPE "ReviewExecutionCheckpointState" AS ENUM ('active', 'finalized');

-- Bind completed review leases to the PR identity asserted by GitHub OIDC.
ALTER TABLE "CodexOAuthLease" ADD COLUMN "pullRequestNumber" INTEGER;
ALTER TABLE "CodexOAuthLease"
  ADD CONSTRAINT "CodexOAuthLease_pullRequestNumber_check" CHECK ("pullRequestNumber" IS NULL OR "pullRequestNumber" > 0);

-- CreateTable
CREATE TABLE "ReviewExecutionCheckpoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" "ReviewExecutionCheckpointState" NOT NULL DEFAULT 'active',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "baseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "compatibilityKey" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "plannedWorkKeys" TEXT[] NOT NULL,
    "acceptedBytes" INTEGER NOT NULL DEFAULT 0,
    "sourceRunId" TEXT NOT NULL,
    "sourceRunAttempt" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewExecutionCheckpoint_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReviewExecutionCheckpoint"
  ADD CONSTRAINT "ReviewExecutionCheckpoint_pullRequestNumber_check" CHECK ("pullRequestNumber" > 0),
  ADD CONSTRAINT "ReviewExecutionCheckpoint_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "ReviewExecutionCheckpoint_schemaVersion_check" CHECK ("schemaVersion" = 1),
  ADD CONSTRAINT "ReviewExecutionCheckpoint_acceptedBytes_check" CHECK ("acceptedBytes" >= 0),
  ADD CONSTRAINT "ReviewExecutionCheckpoint_plannedWorkKeys_check" CHECK (cardinality("plannedWorkKeys") BETWEEN 1 AND 200);

-- CreateTable
CREATE TABLE "ReviewExecutionBatchResult" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "workKey" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceRunAttempt" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewExecutionBatchResult_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReviewExecutionBatchResult"
  ADD CONSTRAINT "ReviewExecutionBatchResult_batchIndex_check" CHECK ("batchIndex" >= 0),
  ADD CONSTRAINT "ReviewExecutionBatchResult_byteCount_check" CHECK ("byteCount" > 0 AND "byteCount" <= 131072);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionCheckpoint_workspaceId_repositoryId_pullRequestNumber_key" ON "ReviewExecutionCheckpoint"("workspaceId", "repositoryId", "pullRequestNumber");

-- CreateIndex
CREATE INDEX "ReviewExecutionCheckpoint_expiresAt_id_idx" ON "ReviewExecutionCheckpoint"("expiresAt", "id");

-- CreateIndex
CREATE INDEX "ReviewExecutionCheckpoint_workspaceId_expiresAt_idx" ON "ReviewExecutionCheckpoint"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "ReviewExecutionCheckpoint_repositoryId_expiresAt_idx" ON "ReviewExecutionCheckpoint"("repositoryId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewExecutionBatchResult_checkpointId_workKey_key" ON "ReviewExecutionBatchResult"("checkpointId", "workKey");

-- CreateIndex
CREATE INDEX "ReviewExecutionBatchResult_checkpointId_batchIndex_idx" ON "ReviewExecutionBatchResult"("checkpointId", "batchIndex");

-- AddForeignKey
ALTER TABLE "ReviewExecutionCheckpoint" ADD CONSTRAINT "ReviewExecutionCheckpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewExecutionCheckpoint" ADD CONSTRAINT "ReviewExecutionCheckpoint_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewExecutionBatchResult" ADD CONSTRAINT "ReviewExecutionBatchResult_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "ReviewExecutionCheckpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
