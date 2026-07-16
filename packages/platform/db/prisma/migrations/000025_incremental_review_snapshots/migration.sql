-- Preserve the repository scope that authorized each lease. Provider bindings
-- may be reconfigured after completion, while snapshot access remains valid.
ALTER TABLE "CodexOAuthLease"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "repositoryId" TEXT;

UPDATE "CodexOAuthLease" AS lease
SET
  "workspaceId" = provider."workspaceId",
  "repositoryId" = provider."repositoryId"
FROM "CodexOAuthProviderInstance" AS provider
WHERE lease."providerInstanceRowId" = provider."id";

ALTER TABLE "CodexOAuthLease"
  ALTER COLUMN "workspaceId" SET NOT NULL,
  ALTER COLUMN "repositoryId" SET NOT NULL;

CREATE INDEX "CodexOAuthLease_workspaceId_status_idx" ON "CodexOAuthLease"("workspaceId", "status");
CREATE INDEX "CodexOAuthLease_repositoryId_status_idx" ON "CodexOAuthLease"("repositoryId", "status");

ALTER TABLE "CodexOAuthLease" ADD CONSTRAINT "CodexOAuthLease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodexOAuthLease" ADD CONSTRAINT "CodexOAuthLease_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ReviewSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "reviewedHeadSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "compatibilityKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceRunAttempt" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSnapshot_workspaceId_repositoryId_pullRequestNumber_key" ON "ReviewSnapshot"("workspaceId", "repositoryId", "pullRequestNumber");

-- CreateIndex
CREATE INDEX "ReviewSnapshot_expiresAt_id_idx" ON "ReviewSnapshot"("expiresAt", "id");

-- CreateIndex
CREATE INDEX "ReviewSnapshot_workspaceId_expiresAt_idx" ON "ReviewSnapshot"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "ReviewSnapshot_repositoryId_expiresAt_idx" ON "ReviewSnapshot"("repositoryId", "expiresAt");

-- AddForeignKey
ALTER TABLE "ReviewSnapshot" ADD CONSTRAINT "ReviewSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSnapshot" ADD CONSTRAINT "ReviewSnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
