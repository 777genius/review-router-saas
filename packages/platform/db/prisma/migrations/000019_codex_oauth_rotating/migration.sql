CREATE TABLE "CodexOAuthProviderInstance" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "providerInstanceId" TEXT NOT NULL,
  "authMode" TEXT NOT NULL,
  "secretName" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'setup_pending',
  "latestGeneration" INTEGER NOT NULL DEFAULT 1,
  "latestGenerationHash" TEXT,
  "generationHashSalt" TEXT NOT NULL,
  "accountFingerprintSalt" TEXT NOT NULL,
  "activeLeaseId" TEXT,
  "activeLeaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodexOAuthProviderInstance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexOAuthLease" (
  "id" TEXT NOT NULL,
  "providerInstanceRowId" TEXT NOT NULL,
  "providerInstanceId" TEXT NOT NULL,
  "githubRunId" TEXT NOT NULL,
  "githubRunAttempt" TEXT NOT NULL,
  "leaseKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'preleased',
  "restoredGenerationHash" TEXT,
  "nextGeneration" INTEGER,
  "writebackPreflightKeyId" TEXT,
  "writebackPreflightedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalizedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CodexOAuthLease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexOAuthWritebackIntent" (
  "id" TEXT NOT NULL,
  "providerInstanceRowId" TEXT NOT NULL,
  "leaseId" TEXT NOT NULL,
  "providerInstanceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "latestGenerationHash" TEXT NOT NULL,
  "encryptedPayloadDigest" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "safeErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CodexOAuthWritebackIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodexOAuthSetupManifest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "providerInstanceRowId" TEXT NOT NULL,
  "providerInstanceId" TEXT NOT NULL,
  "setupNonce" TEXT NOT NULL,
  "manifestJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastFetchedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "CodexOAuthSetupManifest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodexOAuthProviderInstance_providerInstanceId_key"
  ON "CodexOAuthProviderInstance"("providerInstanceId");
CREATE UNIQUE INDEX "CodexOAuthProviderInstance_repositoryId_authMode_key"
  ON "CodexOAuthProviderInstance"("repositoryId", "authMode");
CREATE INDEX "CodexOAuthProviderInstance_workspaceId_state_idx"
  ON "CodexOAuthProviderInstance"("workspaceId", "state");
CREATE INDEX "CodexOAuthProviderInstance_repositoryId_state_idx"
  ON "CodexOAuthProviderInstance"("repositoryId", "state");
CREATE INDEX "CodexOAuthProviderInstance_activeLeaseExpiresAt_idx"
  ON "CodexOAuthProviderInstance"("activeLeaseExpiresAt");

CREATE UNIQUE INDEX "CodexOAuthLease_leaseKey_key"
  ON "CodexOAuthLease"("leaseKey");
CREATE INDEX "CodexOAuthLease_providerInstanceId_status_idx"
  ON "CodexOAuthLease"("providerInstanceId", "status");
CREATE INDEX "CodexOAuthLease_expiresAt_idx"
  ON "CodexOAuthLease"("expiresAt");

CREATE UNIQUE INDEX "CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key"
  ON "CodexOAuthWritebackIntent"("providerInstanceId", "idempotencyKey");
CREATE INDEX "CodexOAuthWritebackIntent_providerInstanceId_status_idx"
  ON "CodexOAuthWritebackIntent"("providerInstanceId", "status");
CREATE INDEX "CodexOAuthWritebackIntent_leaseId_status_idx"
  ON "CodexOAuthWritebackIntent"("leaseId", "status");

CREATE UNIQUE INDEX "CodexOAuthSetupManifest_setupNonce_key"
  ON "CodexOAuthSetupManifest"("setupNonce");
CREATE INDEX "CodexOAuthSetupManifest_repositoryId_status_idx"
  ON "CodexOAuthSetupManifest"("repositoryId", "status");
CREATE INDEX "CodexOAuthSetupManifest_providerInstanceId_status_idx"
  ON "CodexOAuthSetupManifest"("providerInstanceId", "status");
CREATE INDEX "CodexOAuthSetupManifest_expiresAt_idx"
  ON "CodexOAuthSetupManifest"("expiresAt");

ALTER TABLE "CodexOAuthProviderInstance"
  ADD CONSTRAINT "CodexOAuthProviderInstance_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthProviderInstance"
  ADD CONSTRAINT "CodexOAuthProviderInstance_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthLease"
  ADD CONSTRAINT "CodexOAuthLease_providerInstanceRowId_fkey"
  FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthWritebackIntent"
  ADD CONSTRAINT "CodexOAuthWritebackIntent_providerInstanceRowId_fkey"
  FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthWritebackIntent"
  ADD CONSTRAINT "CodexOAuthWritebackIntent_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "CodexOAuthLease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthSetupManifest"
  ADD CONSTRAINT "CodexOAuthSetupManifest_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthSetupManifest"
  ADD CONSTRAINT "CodexOAuthSetupManifest_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthSetupManifest"
  ADD CONSTRAINT "CodexOAuthSetupManifest_providerInstanceRowId_fkey"
  FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
