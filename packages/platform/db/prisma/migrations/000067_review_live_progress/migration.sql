ALTER TABLE "ReviewExecutionV2"
  ADD COLUMN "assignmentManifestVersion" INTEGER,
  ADD COLUMN "assignmentManifestHash" TEXT,
  ADD COLUMN "assignmentManifestJson" JSONB;

ALTER TABLE "ReviewExecutionV2"
  ADD CONSTRAINT "ReviewExecutionV2_assignment_manifest_all_or_none"
  CHECK (
    ("assignmentManifestVersion" IS NULL AND "assignmentManifestHash" IS NULL AND "assignmentManifestJson" IS NULL)
    OR
    ("assignmentManifestVersion" IS NOT NULL AND "assignmentManifestHash" IS NOT NULL AND "assignmentManifestJson" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "ReviewExecutionV2"
  VALIDATE CONSTRAINT "ReviewExecutionV2_assignment_manifest_all_or_none";

CREATE TYPE "ReviewProgressPhaseV1" AS ENUM (
  'preparing',
  'reviewing',
  'assembling',
  'publishing',
  'terminal'
);

CREATE TYPE "ReviewProgressTerminalOutcomeV1" AS ENUM (
  'complete',
  'complete_with_gaps',
  'failed',
  'cancelled',
  'superseded'
);

CREATE TABLE "ReviewExecutionProgressV1" (
  "executionId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "scmRepositoryIdentityId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "generation" BIGINT NOT NULL,
  "headSha" TEXT NOT NULL,
  "planHash" TEXT NOT NULL,
  "sourceExecutionVersion" BIGINT NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "phase" "ReviewProgressPhaseV1" NOT NULL,
  "requiredTotal" INTEGER NOT NULL,
  "requiredSatisfied" INTEGER NOT NULL,
  "requiredExhausted" INTEGER NOT NULL,
  "requiredCancelled" INTEGER NOT NULL,
  "retryingUnits" INTEGER NOT NULL,
  "recoveredUnits" INTEGER NOT NULL,
  "snapshotJson" JSONB NOT NULL,
  "eligibleFileCount" INTEGER,
  "coveredFileCount" INTEGER,
  "uncoveredFileCount" INTEGER,
  "excludedFileCount" INTEGER,
  "desiredVersion" BIGINT NOT NULL DEFAULT 1,
  "terminalOutcome" "ReviewProgressTerminalOutcomeV1",
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewExecutionProgressV1_pkey" PRIMARY KEY ("executionId"),
  CONSTRAINT "ReviewExecutionProgressV1_counts_non_negative" CHECK (
    "requiredTotal" >= 0 AND "requiredSatisfied" >= 0 AND
    "requiredExhausted" >= 0 AND "requiredCancelled" >= 0 AND
    "retryingUnits" >= 0 AND "recoveredUnits" >= 0 AND
    "requiredSatisfied" + "requiredExhausted" + "requiredCancelled" <= "requiredTotal"
  ),
  CONSTRAINT "ReviewExecutionProgressV1_coverage_all_or_none" CHECK (
    ("eligibleFileCount" IS NULL AND "coveredFileCount" IS NULL AND "uncoveredFileCount" IS NULL AND "excludedFileCount" IS NULL)
    OR
    (
      "eligibleFileCount" IS NOT NULL AND "coveredFileCount" IS NOT NULL AND
      "uncoveredFileCount" IS NOT NULL AND "excludedFileCount" IS NOT NULL AND
      "eligibleFileCount" >= 0 AND "coveredFileCount" >= 0 AND
      "uncoveredFileCount" >= 0 AND "excludedFileCount" >= 0 AND
      "coveredFileCount" <= "eligibleFileCount"
    )
  )
);

CREATE UNIQUE INDEX "ReviewExecutionProgressV1_scope_generation_key"
  ON "ReviewExecutionProgressV1"("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber", "generation");
CREATE INDEX "ReviewExecutionProgressV1_scope_generation_idx"
  ON "ReviewExecutionProgressV1"("workspaceId", "repositoryConnectionId", "pullRequestNumber", "generation");
CREATE INDEX "ReviewExecutionProgressV1_source_version_idx"
  ON "ReviewExecutionProgressV1"("sourceExecutionVersion", "updatedAt");

CREATE TABLE "ReviewProgressPublicationV1" (
  "workspaceId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "scmRepositoryIdentityId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  "activeExecutionId" TEXT NOT NULL,
  "activeGeneration" BIGINT NOT NULL,
  "activeHeadSha" TEXT NOT NULL,
  "activePlanHash" TEXT NOT NULL,
  "desiredVersion" BIGINT NOT NULL DEFAULT 1,
  "publishedVersion" BIGINT NOT NULL DEFAULT 0,
  "commentId" BIGINT,
  "publishedBodyHash" TEXT,
  "nextPublishAt" TIMESTAMP(3) NOT NULL,
  "lastPublishedAt" TIMESTAMP(3),
  "claimId" TEXT,
  "claimOwnerIdHash" TEXT,
  "claimUntil" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewProgressPublicationV1_pkey" PRIMARY KEY ("workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber"),
  CONSTRAINT "ReviewProgressPublicationV1_claim_all_or_none" CHECK (
    ("claimId" IS NULL AND "claimOwnerIdHash" IS NULL AND "claimUntil" IS NULL)
    OR
    ("claimId" IS NOT NULL AND "claimOwnerIdHash" IS NOT NULL AND "claimUntil" IS NOT NULL)
  ),
  CONSTRAINT "ReviewProgressPublicationV1_version_order" CHECK ("publishedVersion" <= "desiredVersion"),
  CONSTRAINT "ReviewProgressPublicationV1_non_negative" CHECK (
    "version" >= 0 AND "desiredVersion" >= 0 AND "publishedVersion" >= 0 AND "failureCount" >= 0
  )
);

CREATE UNIQUE INDEX "ReviewProgressPublicationV1_claimId_key" ON "ReviewProgressPublicationV1"("claimId");
CREATE INDEX "ReviewProgressPublicationV1_claim_due_idx" ON "ReviewProgressPublicationV1"("claimUntil", "nextPublishAt");
CREATE INDEX "ReviewProgressPublicationV1_active_execution_idx" ON "ReviewProgressPublicationV1"("activeExecutionId");
CREATE INDEX "ReviewProgressPublicationV1_due_partial_idx"
  ON "ReviewProgressPublicationV1"("nextPublishAt", "claimUntil", "updatedAt")
  WHERE "desiredVersion" > "publishedVersion";

CREATE TABLE "ReviewProgressInstallationBudgetV1" (
  "githubInstallationId" BIGINT NOT NULL,
  "nextMutationAt" TIMESTAMP(3) NOT NULL,
  "cooldownUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewProgressInstallationBudgetV1_pkey" PRIMARY KEY ("githubInstallationId")
);
