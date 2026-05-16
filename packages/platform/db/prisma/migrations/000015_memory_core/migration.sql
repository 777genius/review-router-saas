CREATE TYPE "MemoryScope" AS ENUM ('repository', 'workspace', 'user_prefs');
CREATE TYPE "MemoryItemStatus" AS ENUM ('active', 'disabled', 'expired', 'deleted');
CREATE TYPE "MemoryIndexState" AS ENUM ('not_indexed', 'index_pending', 'indexed', 'index_failed', 'index_deleted');
CREATE TYPE "MemoryItemVisibility" AS ENUM ('repository_runtime', 'workspace_runtime', 'user_preference_runtime');
CREATE TYPE "MemoryRiskLevel" AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE "MemorySuggestionStatus" AS ENUM ('pending', 'confirmed', 'rejected', 'blocked', 'expired', 'superseded');

CREATE TABLE "MemoryItem" (
  "id" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT,
  "userId" TEXT,
  "scope" "MemoryScope" NOT NULL,
  "status" "MemoryItemStatus" NOT NULL DEFAULT 'active',
  "body" TEXT NOT NULL,
  "bodyVersion" INTEGER NOT NULL DEFAULT 1,
  "bodyHash" TEXT NOT NULL,
  "tags" JSONB NOT NULL,
  "riskLevel" "MemoryRiskLevel" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "source" JSONB NOT NULL,
  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "safetyPolicyVersion" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "confirmedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "visibility" "MemoryItemVisibility" NOT NULL,
  "originSuggestionId" TEXT,
  "indexState" "MemoryIndexState" NOT NULL DEFAULT 'index_pending',
  "indexVersion" INTEGER,

  CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryItem_scope_shape_chk" CHECK (
    (
      "scope" = 'repository'
      AND "repositoryId" IS NOT NULL
      AND "userId" IS NULL
      AND "visibility" = 'repository_runtime'
    )
    OR (
      "scope" = 'workspace'
      AND "repositoryId" IS NULL
      AND "userId" IS NULL
      AND "visibility" = 'workspace_runtime'
    )
    OR (
      "scope" = 'user_prefs'
      AND "repositoryId" IS NULL
      AND "userId" IS NOT NULL
      AND "visibility" = 'user_preference_runtime'
    )
  ),
  CONSTRAINT "MemoryItem_body_length_chk" CHECK (char_length("body") BETWEEN 1 AND 1000),
  CONSTRAINT "MemoryItem_versions_chk" CHECK (
    "schemaVersion" >= 1
    AND "bodyVersion" >= 1
    AND "policyVersion" >= 1
    AND "safetyPolicyVersion" >= 1
    AND "version" >= 1
    AND ("indexVersion" IS NULL OR "indexVersion" >= 1)
  ),
  CONSTRAINT "MemoryItem_confidence_chk" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "MemoryItem_deleted_index_chk" CHECK ("status" <> 'deleted' OR "indexState" = 'index_deleted')
);

CREATE TABLE "MemorySuggestion" (
  "id" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT,
  "userId" TEXT,
  "suggestedScope" "MemoryScope" NOT NULL,
  "suggestedBody" TEXT NOT NULL,
  "suggestedBodyVersion" INTEGER NOT NULL DEFAULT 1,
  "suggestedBodyHash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "source" JSONB NOT NULL,
  "safetyReport" JSONB NOT NULL,
  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "safetyPolicyVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "MemorySuggestionStatus" NOT NULL DEFAULT 'pending',
  "createdByActor" TEXT NOT NULL,
  "confirmationTokenHash" TEXT,
  "confirmationTokenExpiresAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "relatedMemoryItemId" TEXT,
  "relatedSuggestionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  "resolutionReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "MemorySuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemorySuggestion_scope_shape_chk" CHECK (
    (
      "suggestedScope" = 'repository'
      AND "repositoryId" IS NOT NULL
      AND "userId" IS NULL
    )
    OR (
      "suggestedScope" = 'workspace'
      AND "repositoryId" IS NULL
      AND "userId" IS NULL
    )
    OR (
      "suggestedScope" = 'user_prefs'
      AND "repositoryId" IS NULL
      AND "userId" IS NOT NULL
    )
  ),
  CONSTRAINT "MemorySuggestion_body_length_chk" CHECK (char_length("suggestedBody") BETWEEN 0 AND 1000),
  CONSTRAINT "MemorySuggestion_versions_chk" CHECK (
    "schemaVersion" >= 1
    AND "suggestedBodyVersion" >= 1
    AND "policyVersion" >= 1
    AND "safetyPolicyVersion" >= 1
    AND "version" >= 1
  ),
  CONSTRAINT "MemorySuggestion_terminal_resolution_chk" CHECK (
    (
      "status" = 'pending'
      AND "resolvedAt" IS NULL
      AND "resolvedBy" IS NULL
      AND "resolutionReason" IS NULL
      AND "relatedMemoryItemId" IS NULL
    )
    OR (
      "status" <> 'pending'
      AND "resolvedAt" IS NOT NULL
      AND "resolvedBy" IS NOT NULL
      AND "resolutionReason" IS NOT NULL
    )
  )
);

CREATE TABLE "MemoryUsageEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "memoryItemId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "bundleVersion" INTEGER,
  "dedupeKey" TEXT,
  "metadata" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryUsageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryUsageEvent_bundle_version_chk" CHECK ("bundleVersion" IS NULL OR "bundleVersion" >= 1)
);

CREATE INDEX "MemoryItem_workspaceId_scope_status_updatedAt_idx" ON "MemoryItem"("workspaceId", "scope", "status", "updatedAt");
CREATE INDEX "MemoryItem_workspaceId_repositoryId_status_updatedAt_idx" ON "MemoryItem"("workspaceId", "repositoryId", "status", "updatedAt");
CREATE INDEX "MemoryItem_workspaceId_userId_status_idx" ON "MemoryItem"("workspaceId", "userId", "status");
CREATE INDEX "MemoryItem_workspaceId_bodyHash_idx" ON "MemoryItem"("workspaceId", "bodyHash");
CREATE INDEX "MemoryItem_originSuggestionId_idx" ON "MemoryItem"("originSuggestionId");

CREATE UNIQUE INDEX "MemoryItem_active_body_hash_uq"
  ON "MemoryItem" ("workspaceId", "scope", COALESCE("repositoryId", ''), COALESCE("userId", ''), "bodyHash")
  WHERE "status" IN ('active', 'disabled');

CREATE INDEX "MemoryItem_active_repository_updated_idx"
  ON "MemoryItem" ("workspaceId", "repositoryId", "updatedAt" DESC, "id" DESC)
  WHERE "status" = 'active';

CREATE INDEX "MemorySuggestion_workspaceId_status_expiresAt_idx" ON "MemorySuggestion"("workspaceId", "status", "expiresAt");
CREATE INDEX "MemorySuggestion_workspaceId_repositoryId_status_updatedAt_idx" ON "MemorySuggestion"("workspaceId", "repositoryId", "status", "updatedAt");
CREATE INDEX "MemorySuggestion_workspaceId_userId_status_idx" ON "MemorySuggestion"("workspaceId", "userId", "status");
CREATE INDEX "MemorySuggestion_workspaceId_dedupeKey_idx" ON "MemorySuggestion"("workspaceId", "dedupeKey");
CREATE INDEX "MemorySuggestion_relatedMemoryItemId_idx" ON "MemorySuggestion"("relatedMemoryItemId");
CREATE INDEX "MemorySuggestion_relatedSuggestionId_idx" ON "MemorySuggestion"("relatedSuggestionId");

CREATE UNIQUE INDEX "MemorySuggestion_pending_dedupe_uq"
  ON "MemorySuggestion" ("workspaceId", "dedupeKey")
  WHERE "status" = 'pending';

CREATE INDEX "MemoryUsageEvent_workspaceId_occurredAt_idx" ON "MemoryUsageEvent"("workspaceId", "occurredAt");
CREATE INDEX "MemoryUsageEvent_repositoryId_occurredAt_idx" ON "MemoryUsageEvent"("repositoryId", "occurredAt");
CREATE INDEX "MemoryUsageEvent_memoryItemId_occurredAt_idx" ON "MemoryUsageEvent"("memoryItemId", "occurredAt");
CREATE UNIQUE INDEX "MemoryUsageEvent_dedupeKey_key" ON "MemoryUsageEvent"("dedupeKey");

ALTER TABLE "MemoryItem"
  ADD CONSTRAINT "MemoryItem_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryItem"
  ADD CONSTRAINT "MemoryItem_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryItem"
  ADD CONSTRAINT "MemoryItem_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemorySuggestion"
  ADD CONSTRAINT "MemorySuggestion_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemorySuggestion"
  ADD CONSTRAINT "MemorySuggestion_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemorySuggestion"
  ADD CONSTRAINT "MemorySuggestion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryUsageEvent"
  ADD CONSTRAINT "MemoryUsageEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryUsageEvent"
  ADD CONSTRAINT "MemoryUsageEvent_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemoryUsageEvent"
  ADD CONSTRAINT "MemoryUsageEvent_memoryItemId_fkey"
  FOREIGN KEY ("memoryItemId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
