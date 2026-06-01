ALTER TABLE "RepositoryConnection"
ADD COLUMN "sourceBaseUrl" TEXT NOT NULL DEFAULT 'https://github.com';

UPDATE "RepositoryConnection"
SET "sourceBaseUrl" = 'https://gitlab.com'
WHERE "provider" = 'gitlab';

DROP INDEX IF EXISTS "RepositoryConnection_provider_externalRepositoryId_key";
DROP INDEX IF EXISTS "RepositoryConnection_workspaceId_provider_fullName_key";
DROP INDEX IF EXISTS "RepositoryConnection_workspaceId_provider_selected_fullName_idx";

CREATE UNIQUE INDEX "RepositoryConnection_provider_externalRepositoryId_sourceBaseUrl_key"
ON "RepositoryConnection"("provider", "externalRepositoryId", "sourceBaseUrl");

CREATE UNIQUE INDEX "RepositoryConnection_workspaceId_provider_fullName_sourceBaseUrl_key"
ON "RepositoryConnection"("workspaceId", "provider", "fullName", "sourceBaseUrl");

CREATE INDEX "RepositoryConnection_workspaceId_provider_sourceBaseUrl_selected_fullName_idx"
ON "RepositoryConnection"("workspaceId", "provider", "sourceBaseUrl", "selected", "fullName");
