-- CreateTable
CREATE TABLE "GitHubUserAuthorization" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "appSlug" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubUserAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryPermissionCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubInstallationId" BIGINT NOT NULL,
    "permission" TEXT,
    "roleName" TEXT,
    "canManage" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryPermissionCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitHubUserAuthorization_githubUserId_idx" ON "GitHubUserAuthorization"("githubUserId");

-- CreateIndex
CREATE INDEX "GitHubUserAuthorization_revokedAt_idx" ON "GitHubUserAuthorization"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubUserAuthorization_userId_appSlug_key" ON "GitHubUserAuthorization"("userId", "appSlug");

-- CreateIndex
CREATE INDEX "RepositoryPermissionCache_userId_canManage_expiresAt_idx" ON "RepositoryPermissionCache"("userId", "canManage", "expiresAt");

-- CreateIndex
CREATE INDEX "RepositoryPermissionCache_repositoryId_idx" ON "RepositoryPermissionCache"("repositoryId");

-- CreateIndex
CREATE INDEX "RepositoryPermissionCache_githubInstallationId_idx" ON "RepositoryPermissionCache"("githubInstallationId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryPermissionCache_userId_repositoryId_key" ON "RepositoryPermissionCache"("userId", "repositoryId");

-- AddForeignKey
ALTER TABLE "GitHubUserAuthorization" ADD CONSTRAINT "GitHubUserAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryPermissionCache" ADD CONSTRAINT "RepositoryPermissionCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryPermissionCache" ADD CONSTRAINT "RepositoryPermissionCache_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
