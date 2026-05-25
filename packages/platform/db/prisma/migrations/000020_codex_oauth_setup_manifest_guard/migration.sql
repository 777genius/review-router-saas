CREATE TABLE IF NOT EXISTS "CodexOAuthSetupManifest" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "CodexOAuthSetupManifest_setupNonce_key"
  ON "CodexOAuthSetupManifest"("setupNonce");
CREATE INDEX IF NOT EXISTS "CodexOAuthSetupManifest_repositoryId_status_idx"
  ON "CodexOAuthSetupManifest"("repositoryId", "status");
CREATE INDEX IF NOT EXISTS "CodexOAuthSetupManifest_providerInstanceId_status_idx"
  ON "CodexOAuthSetupManifest"("providerInstanceId", "status");
CREATE INDEX IF NOT EXISTS "CodexOAuthSetupManifest_expiresAt_idx"
  ON "CodexOAuthSetupManifest"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'CodexOAuthSetupManifest_workspaceId_fkey'
      AND conrelid = '"CodexOAuthSetupManifest"'::regclass
  ) THEN
    ALTER TABLE "CodexOAuthSetupManifest"
      ADD CONSTRAINT "CodexOAuthSetupManifest_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'CodexOAuthSetupManifest_repositoryId_fkey'
      AND conrelid = '"CodexOAuthSetupManifest"'::regclass
  ) THEN
    ALTER TABLE "CodexOAuthSetupManifest"
      ADD CONSTRAINT "CodexOAuthSetupManifest_repositoryId_fkey"
      FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'CodexOAuthSetupManifest_providerInstanceRowId_fkey'
      AND conrelid = '"CodexOAuthSetupManifest"'::regclass
  ) THEN
    ALTER TABLE "CodexOAuthSetupManifest"
      ADD CONSTRAINT "CodexOAuthSetupManifest_providerInstanceRowId_fkey"
      FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
