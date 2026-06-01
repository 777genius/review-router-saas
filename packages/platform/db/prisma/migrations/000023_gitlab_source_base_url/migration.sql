ALTER TABLE "GitLabInstallation"
ADD COLUMN "sourceBaseUrl" TEXT NOT NULL DEFAULT 'https://gitlab.com';

DROP INDEX IF EXISTS "GitLabInstallation_workspaceId_namespacePath_key";

CREATE UNIQUE INDEX "GitLabInstallation_workspaceId_sourceBaseUrl_namespacePath_key"
ON "GitLabInstallation"("workspaceId", "sourceBaseUrl", "namespacePath");
