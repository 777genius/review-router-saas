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
