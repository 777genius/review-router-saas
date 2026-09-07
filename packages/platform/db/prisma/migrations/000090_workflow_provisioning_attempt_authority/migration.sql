-- One current setup attempt per repository. Preserve the same deterministic
-- winner used by the read models before introducing the uniqueness constraint.
DELETE FROM "WorkflowProvisioning" AS older
USING "WorkflowProvisioning" AS newer
WHERE older."repositoryId" = newer."repositoryId"
  AND (older."updatedAt", older.id) < (newer."updatedAt", newer.id);

ALTER TABLE "WorkflowProvisioning"
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "installationId" TEXT;

UPDATE "WorkflowProvisioning" AS p
SET "attemptId" = p.id,
    "installationId" = r."installationId",
    "workspaceId" = r."workspaceId",
    status = CASE WHEN p."workspaceId" <> r."workspaceId"
      THEN 'not_started'::"WorkflowProvisioningStatus" ELSE p.status END,
    "pullRequestUrl" = CASE WHEN p."workspaceId" <> r."workspaceId"
      THEN NULL ELSE p."pullRequestUrl" END,
    "errorMessage" = CASE WHEN p."workspaceId" <> r."workspaceId"
      THEN NULL ELSE p."errorMessage" END
FROM "RepositoryConnection" AS r WHERE r.id = p."repositoryId";

ALTER TABLE "WorkflowProvisioning" ALTER COLUMN "attemptId" SET NOT NULL;
DROP INDEX "WorkflowProvisioning_repositoryId_branch_key";
CREATE UNIQUE INDEX "WorkflowProvisioning_repositoryId_key"
  ON "WorkflowProvisioning"("repositoryId");
