CREATE TYPE "ScmProvider" AS ENUM ('github', 'gitlab');

CREATE TYPE "GitLabInstallationStatus" AS ENUM ('pending', 'active', 'removed', 'permission_error', 'sync_error');

ALTER TABLE "User" ALTER COLUMN "githubUserId" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "githubLogin" DROP NOT NULL;

CREATE TABLE "UserExternalIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ScmProvider" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "primaryEmail" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserExternalIdentity_pkey" PRIMARY KEY ("id")
);

INSERT INTO "UserExternalIdentity" (
    "id",
    "userId",
    "provider",
    "externalUserId",
    "login",
    "primaryEmail",
    "avatarUrl",
    "createdAt",
    "updatedAt"
)
SELECT
    'github_' || "id",
    "id",
    'github'::"ScmProvider",
    "githubUserId"::TEXT,
    "githubLogin",
    "primaryEmail",
    "avatarUrl",
    "createdAt",
    "updatedAt"
FROM "User"
WHERE "githubUserId" IS NOT NULL AND "githubLogin" IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE "GitLabInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "namespaceId" TEXT,
    "namespacePath" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "status" "GitLabInstallationStatus" NOT NULL DEFAULT 'active',
    "installedByUserId" TEXT,
    "selectedProjects" INTEGER NOT NULL DEFAULT 0,
    "installSummary" JSONB,
    "lastInstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitLabInstallation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RepositoryConnection" ADD COLUMN "provider" "ScmProvider" NOT NULL DEFAULT 'github';
ALTER TABLE "RepositoryConnection" ADD COLUMN "externalRepositoryId" TEXT;
ALTER TABLE "RepositoryConnection" ADD COLUMN "gitlabInstallationId" TEXT;

UPDATE "RepositoryConnection"
SET "externalRepositoryId" = "githubRepositoryId"::TEXT
WHERE "externalRepositoryId" IS NULL;

ALTER TABLE "RepositoryConnection" ALTER COLUMN "externalRepositoryId" SET NOT NULL;
ALTER TABLE "RepositoryConnection" ALTER COLUMN "installationId" DROP NOT NULL;
ALTER TABLE "RepositoryConnection" ALTER COLUMN "githubRepositoryId" DROP NOT NULL;

DROP INDEX IF EXISTS "RepositoryConnection_workspaceId_fullName_key";
DROP INDEX IF EXISTS "RepositoryConnection_workspaceId_selected_fullName_idx";

CREATE UNIQUE INDEX "UserExternalIdentity_provider_externalUserId_key" ON "UserExternalIdentity"("provider", "externalUserId");
CREATE UNIQUE INDEX "UserExternalIdentity_userId_provider_key" ON "UserExternalIdentity"("userId", "provider");
CREATE INDEX "UserExternalIdentity_provider_login_idx" ON "UserExternalIdentity"("provider", "login");

CREATE UNIQUE INDEX "GitLabInstallation_workspaceId_namespacePath_key" ON "GitLabInstallation"("workspaceId", "namespacePath");
CREATE INDEX "GitLabInstallation_workspaceId_status_idx" ON "GitLabInstallation"("workspaceId", "status");
CREATE INDEX "GitLabInstallation_namespaceId_idx" ON "GitLabInstallation"("namespaceId");

CREATE UNIQUE INDEX "RepositoryConnection_provider_externalRepositoryId_key" ON "RepositoryConnection"("provider", "externalRepositoryId");
CREATE UNIQUE INDEX "RepositoryConnection_workspaceId_provider_fullName_key" ON "RepositoryConnection"("workspaceId", "provider", "fullName");
CREATE INDEX "RepositoryConnection_gitlabInstallationId_idx" ON "RepositoryConnection"("gitlabInstallationId");
CREATE INDEX "RepositoryConnection_workspaceId_provider_selected_fullName_idx" ON "RepositoryConnection"("workspaceId", "provider", "selected", "fullName");

ALTER TABLE "UserExternalIdentity" ADD CONSTRAINT "UserExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitLabInstallation" ADD CONSTRAINT "GitLabInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitLabInstallation" ADD CONSTRAINT "GitLabInstallation_installedByUserId_fkey" FOREIGN KEY ("installedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_gitlabInstallationId_fkey" FOREIGN KEY ("gitlabInstallationId") REFERENCES "GitLabInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
