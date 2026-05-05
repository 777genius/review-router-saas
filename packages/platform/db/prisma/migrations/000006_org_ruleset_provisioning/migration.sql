CREATE TYPE "OrgRulesetProvisioningStatus" AS ENUM ('requested', 'processing', 'configured', 'failed');
CREATE TYPE "OrgRulesetScope" AS ENUM ('selected_repositories', 'all_repositories');
CREATE TYPE "OrgRulesetEnforcement" AS ENUM ('evaluate', 'active');

CREATE TABLE "OrgRulesetProvisioning" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "githubInstallationId" BIGINT NOT NULL,
  "organizationLogin" TEXT NOT NULL,
  "status" "OrgRulesetProvisioningStatus" NOT NULL DEFAULT 'requested',
  "scope" "OrgRulesetScope" NOT NULL,
  "enforcement" "OrgRulesetEnforcement" NOT NULL,
  "sourceRepositoryId" TEXT,
  "sourceGithubRepositoryId" BIGINT,
  "sourceRepositoryFullName" TEXT,
  "sourceWorkflowPath" TEXT NOT NULL,
  "sourceWorkflowRef" TEXT NOT NULL,
  "sourceWorkflowSha" TEXT,
  "rulesetId" BIGINT,
  "rulesetUrl" TEXT,
  "targetRepositoryIds" JSONB NOT NULL,
  "safeErrorCode" TEXT,
  "safeErrorSummary" TEXT,
  "requestedBy" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  "lastAttemptAt" TIMESTAMP(3),
  "configuredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrgRulesetProvisioning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgRulesetProvisioning_workspaceId_key" ON "OrgRulesetProvisioning"("workspaceId");
CREATE INDEX "OrgRulesetProvisioning_githubInstallationId_status_idx" ON "OrgRulesetProvisioning"("githubInstallationId", "status");
CREATE INDEX "OrgRulesetProvisioning_installationId_status_idx" ON "OrgRulesetProvisioning"("installationId", "status");
CREATE INDEX "OrgRulesetProvisioning_sourceRepositoryId_idx" ON "OrgRulesetProvisioning"("sourceRepositoryId");
CREATE INDEX "OrgRulesetProvisioning_workspaceId_status_idx" ON "OrgRulesetProvisioning"("workspaceId", "status");

ALTER TABLE "OrgRulesetProvisioning"
  ADD CONSTRAINT "OrgRulesetProvisioning_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrgRulesetProvisioning"
  ADD CONSTRAINT "OrgRulesetProvisioning_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "GitHubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrgRulesetProvisioning"
  ADD CONSTRAINT "OrgRulesetProvisioning_sourceRepositoryId_fkey"
  FOREIGN KEY ("sourceRepositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
