SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "HostedCodexPoolStatus" AS ENUM ('active', 'draining', 'paused', 'tombstoned');
CREATE TYPE "HostedCodexAccountState" AS ENUM (
  'provisioning_pending', 'healthy', 'cooldown', 'quota_exhausted',
  'needs_reconnect', 'restore_quarantined', 'quarantined',
  'draining', 'paused', 'tombstoned'
);
CREATE TYPE "HostedCodexRepositoryBindingStatus" AS ENUM ('pending_activation', 'active', 'draining', 'paused', 'tombstoned');
CREATE TYPE "HostedCodexInvocationGrantStatus" AS ENUM ('issued', 'exhausted', 'expired', 'revoked');
CREATE TYPE "HostedCodexRelayRequestStatus" AS ENUM ('received', 'processing', 'response_started', 'succeeded', 'failed');
CREATE TYPE "HostedCodexGenerationReceiptKind" AS ENUM (
  'credential_created', 'activated', 'deactivated', 'tombstoned'
);

-- Required by the repository/workspace tenant foreign key below. This is
-- additive and does not rewrite RepositoryConnection.
CREATE UNIQUE INDEX "RepositoryConnection_id_workspaceId_key"
  ON "RepositoryConnection"("id", "workspaceId");

CREATE TABLE "HostedCodexPool" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "status" "HostedCodexPoolStatus" NOT NULL DEFAULT 'active',
  "authzEpoch" BIGINT NOT NULL DEFAULT 1,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "drainingAt" TIMESTAMP(3),
  "tombstonedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexPool_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexPool_positive_versions_check"
    CHECK ("authzEpoch" > 0 AND "revision" > 0),
  CONSTRAINT "HostedCodexPool_lifecycle_check" CHECK (
    ("status" <> 'draining' OR "drainingAt" IS NOT NULL)
    AND ("status" <> 'tombstoned' OR "tombstonedAt" IS NOT NULL)
    AND ("status" <> 'tombstoned' OR "isDefault" = false)
  )
);

CREATE UNIQUE INDEX "HostedCodexPool_id_workspaceId_key"
  ON "HostedCodexPool"("id", "workspaceId");
CREATE UNIQUE INDEX "HostedCodexPool_workspaceId_name_key"
  ON "HostedCodexPool"("workspaceId", "name");
CREATE UNIQUE INDEX "HostedCodexPool_one_default_per_workspace_key"
  ON "HostedCodexPool"("workspaceId") WHERE "isDefault" = true;
CREATE INDEX "HostedCodexPool_workspaceId_status_revision_idx"
  ON "HostedCodexPool"("workspaceId", "status", "revision");

ALTER TABLE "HostedCodexPool"
  ADD CONSTRAINT "HostedCodexPool_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexAccount" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "accountFingerprint" TEXT NOT NULL,
  "state" "HostedCodexAccountState" NOT NULL DEFAULT 'provisioning_pending',
  "cooldownUntil" TIMESTAMP(3),
  "healthVersion" BIGINT NOT NULL DEFAULT 0,
  "activeGeneration" BIGINT,
  "lastHealthyAt" TIMESTAMP(3),
  "drainingAt" TIMESTAMP(3),
  "tombstonedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexAccount_priority_health_generation_check" CHECK (
    "priority" >= 0 AND "healthVersion" >= 0
    AND ("activeGeneration" IS NULL OR "activeGeneration" > 0)
  ),
  CONSTRAINT "HostedCodexAccount_fingerprint_check"
    CHECK (length("accountFingerprint") BETWEEN 16 AND 255),
  CONSTRAINT "HostedCodexAccount_state_check" CHECK (
    ("state" = 'provisioning_pending' OR "activeGeneration" IS NOT NULL)
    AND ("state" <> 'cooldown' OR "cooldownUntil" IS NOT NULL)
    AND ("state" <> 'draining' OR "drainingAt" IS NOT NULL)
    AND ("state" <> 'tombstoned' OR "tombstonedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "HostedCodexAccount_id_workspaceId_poolId_key"
  ON "HostedCodexAccount"("id", "workspaceId", "poolId");
CREATE UNIQUE INDEX "HostedCodexAccount_workspaceId_accountFingerprint_key"
  ON "HostedCodexAccount"("workspaceId", "accountFingerprint");
CREATE UNIQUE INDEX "HostedCodexAccount_poolId_label_key"
  ON "HostedCodexAccount"("poolId", "label");
CREATE INDEX "HostedCodexAccount_healthy_priority_idx"
  ON "HostedCodexAccount"("workspaceId", "poolId", "state", "cooldownUntil", "priority", "id");
CREATE INDEX "HostedCodexAccount_health_cas_idx"
  ON "HostedCodexAccount"("workspaceId", "poolId", "healthVersion");

ALTER TABLE "HostedCodexAccount"
  ADD CONSTRAINT "HostedCodexAccount_pool_tenant_fkey"
  FOREIGN KEY ("poolId", "workspaceId")
  REFERENCES "HostedCodexPool"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexCredentialVersion" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "generation" BIGINT NOT NULL,
  "databaseIncarnation" TEXT NOT NULL,
  "envelopeVersion" INTEGER NOT NULL,
  "encryptionAlgorithm" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "aadHash" TEXT NOT NULL,
  "generationHash" TEXT NOT NULL,
  "ciphertextHash" TEXT NOT NULL,
  "encryptedCiphertext" TEXT NOT NULL,
  "envelopeMetadata" JSONB NOT NULL,
  "credentialExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexCredentialVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexCredentialVersion_positive_generation_check"
    CHECK ("generation" > 0 AND "envelopeVersion" > 0),
  CONSTRAINT "HostedCodexCredentialVersion_database_incarnation_check"
    CHECK (length("databaseIncarnation") BETWEEN 16 AND 255),
  CONSTRAINT "HostedCodexCredentialVersion_hashes_check" CHECK (
    "aadHash" ~ '^[a-f0-9]{64}$'
    AND "generationHash" ~ '^[a-f0-9]{64}$'
    AND "ciphertextHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "HostedCodexCredentialVersion_envelope_check" CHECK (
    length("encryptedCiphertext") > 0
    AND jsonb_typeof("envelopeMetadata") = 'object'
    AND NOT ("envelopeMetadata" ?| ARRAY['plaintext', 'accessToken', 'refreshToken', 'secret'])
  )
);

CREATE UNIQUE INDEX "HostedCodexCredentialVersion_accountId_generation_key"
  ON "HostedCodexCredentialVersion"("accountId", "generation");
CREATE UNIQUE INDEX "HostedCodexCredentialVersion_account_incarnation_generation_key"
  ON "HostedCodexCredentialVersion"("accountId", "databaseIncarnation", "generation");
CREATE UNIQUE INDEX "HostedCodexCredentialVersion_identity_key"
  ON "HostedCodexCredentialVersion"("id", "accountId", "workspaceId", "poolId", "generation");
CREATE INDEX "HostedCodexCredentialVersion_tenant_generation_idx"
  ON "HostedCodexCredentialVersion"("workspaceId", "poolId", "accountId", "generation");
CREATE INDEX "HostedCodexCredentialVersion_incarnation_key_created_idx"
  ON "HostedCodexCredentialVersion"("databaseIncarnation", "keyId", "createdAt");
CREATE INDEX "HostedCodexCredentialVersion_keyId_createdAt_idx"
  ON "HostedCodexCredentialVersion"("keyId", "createdAt");

ALTER TABLE "HostedCodexCredentialVersion"
  ADD CONSTRAINT "HostedCodexCredentialVersion_account_tenant_fkey"
  FOREIGN KEY ("accountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexRepositoryBinding" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "status" "HostedCodexRepositoryBindingStatus" NOT NULL DEFAULT 'pending_activation',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "stateVersion" BIGINT NOT NULL DEFAULT 1,
  "workflowPath" TEXT,
  "workflowActionRef" TEXT,
  "workflowSourceCommitSha" TEXT,
  "workflowSourceBlobSha" TEXT,
  "workflowSourceSha256" TEXT,
  "workflowSemanticSha256" TEXT,
  "workflowSourceTrust" TEXT,
  "attestedGithubRepositoryId" BIGINT,
  "attestedBindingRevision" BIGINT,
  "activatedAt" TIMESTAMP(3),
  "drainingAt" TIMESTAMP(3),
  "tombstonedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexRepositoryBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexRepositoryBinding_revision_check"
    CHECK ("revision" > 0 AND "stateVersion" > 0),
  CONSTRAINT "HostedCodexRepositoryBinding_active_attestation_check" CHECK (
    "status" <> 'active' OR (
      "workflowPath" ~ '^[.]github/workflows/[A-Za-z0-9._/-]+[.]ya?ml$'
      AND "workflowActionRef" ~ '^[^@[:space:]]+@[a-f0-9]{40}$'
      AND "workflowSourceCommitSha" ~ '^[a-f0-9]{40}$'
      AND "workflowSourceBlobSha" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
      AND "workflowSourceSha256" ~ '^[a-f0-9]{64}$'
      AND "workflowSemanticSha256" ~ '^[a-f0-9]{64}$'
      AND "workflowSourceTrust" = 'trusted_default_branch_revision'
      AND "attestedGithubRepositoryId" IS NOT NULL
      AND "attestedBindingRevision" = "revision"
      AND "activatedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "HostedCodexRepositoryBinding_lifecycle_check" CHECK (
    ("status" <> 'draining' OR "drainingAt" IS NOT NULL)
    AND ("status" <> 'tombstoned' OR "tombstonedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "HostedCodexRepositoryBinding_repositoryConnectionId_key"
  ON "HostedCodexRepositoryBinding"("repositoryConnectionId");
CREATE UNIQUE INDEX "HostedCodexRepositoryBinding_identity_key"
  ON "HostedCodexRepositoryBinding"("id", "workspaceId", "poolId", "repositoryConnectionId");
CREATE UNIQUE INDEX "HostedCodexRepositoryBinding_revision_scope_key"
  ON "HostedCodexRepositoryBinding"(
    "id", "workspaceId", "poolId", "repositoryConnectionId", "revision"
  );
CREATE INDEX "HostedCodexRepositoryBinding_tenant_status_revision_idx"
  ON "HostedCodexRepositoryBinding"("workspaceId", "poolId", "status", "revision");
CREATE INDEX "HostedCodexRepositoryBinding_state_cas_idx"
  ON "HostedCodexRepositoryBinding"("workspaceId", "status", "stateVersion");

ALTER TABLE "HostedCodexRepositoryBinding"
  ADD CONSTRAINT "HostedCodexRepositoryBinding_pool_tenant_fkey"
  FOREIGN KEY ("poolId", "workspaceId")
  REFERENCES "HostedCodexPool"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexRepositoryBinding_repository_tenant_fkey"
  FOREIGN KEY ("repositoryConnectionId", "workspaceId")
  REFERENCES "RepositoryConnection"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexInvocationGrant" (
  "id" TEXT NOT NULL,
  "invocationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "repositoryBindingId" TEXT NOT NULL,
  "activeAccountId" TEXT NOT NULL,
  "primaryAccountId" TEXT NOT NULL,
  "backupAccountId" TEXT,
  "reviewRequestId" TEXT NOT NULL,
  "providerInvocationKey" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "runAttempt" INTEGER NOT NULL,
  "model" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "policyFingerprint" TEXT NOT NULL,
  "runtimeConfigVersion" INTEGER NOT NULL,
  "bindingRevision" BIGINT NOT NULL,
  "authzEpoch" BIGINT NOT NULL,
  "capabilityTokenHash" TEXT NOT NULL,
  "status" "HostedCodexInvocationGrantStatus" NOT NULL DEFAULT 'issued',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "maxRequests" INTEGER NOT NULL,
  "maxConcurrentRequests" INTEGER NOT NULL,
  "maxRequestBytes" INTEGER NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "inFlight" INTEGER NOT NULL DEFAULT 0,
  "firstSuccessfulResponseAt" TIMESTAMP(3),
  "failoverCount" INTEGER NOT NULL DEFAULT 0,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexInvocationGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexInvocationGrant_capability_hash_check"
    CHECK (
      "capabilityTokenHash" ~ '^[a-f0-9]{64}$'
      AND "policyFingerprint" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "HostedCodexInvocationGrant_budget_check" CHECK (
    "runAttempt" > 0 AND "runtimeConfigVersion" > 0
    AND "bindingRevision" > 0 AND "authzEpoch" > 0
    AND "maxRequests" > 0 AND "maxConcurrentRequests" > 0
    AND "maxConcurrentRequests" <= "maxRequests" AND "maxRequestBytes" > 0
    AND "requestCount" >= 0
    AND "requestCount" <= "maxRequests" AND "inFlight" >= 0
    AND "inFlight" <= "maxConcurrentRequests" AND "revision" > 0
  ),
  CONSTRAINT "HostedCodexInvocationGrant_ttl_check" CHECK (
    "expiresAt" > "issuedAt"
    AND ("firstSuccessfulResponseAt" IS NULL OR "firstSuccessfulResponseAt" >= "issuedAt")
  ),
  CONSTRAINT "HostedCodexInvocationGrant_failover_check" CHECK (
    ("failoverCount" = 0 AND "activeAccountId" = "primaryAccountId")
    OR
    ("failoverCount" = 1 AND "backupAccountId" IS NOT NULL
      AND "backupAccountId" <> "primaryAccountId"
      AND "activeAccountId" = "backupAccountId")
  ),
  CONSTRAINT "HostedCodexInvocationGrant_revocation_check" CHECK (
    ("status" = 'revoked') = ("revokedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "HostedCodexInvocationGrant_capabilityTokenHash_key"
  ON "HostedCodexInvocationGrant"("capabilityTokenHash");
CREATE UNIQUE INDEX "HostedCodexInvocationGrant_invocationId_key"
  ON "HostedCodexInvocationGrant"("invocationId");
CREATE UNIQUE INDEX "HostedCodexInvocationGrant_id_workspaceId_poolId_key"
  ON "HostedCodexInvocationGrant"("id", "workspaceId", "poolId");
CREATE UNIQUE INDEX "HostedCodexInvocationGrant_comment_refresh_scope_key"
  ON "HostedCodexInvocationGrant"(
    "id", "invocationId", "repositoryBindingId", "workspaceId", "poolId", "repositoryConnectionId"
  );
CREATE INDEX "HostedCodexInvocationGrant_reviewRequestId_idx"
  ON "HostedCodexInvocationGrant"("reviewRequestId");
CREATE INDEX "HostedCodexInvocationGrant_providerInvocationKey_idx"
  ON "HostedCodexInvocationGrant"("providerInvocationKey");
CREATE INDEX "HostedCodexInvocationGrant_expiry_reconcile_idx"
  ON "HostedCodexInvocationGrant"("status", "expiresAt", "id");
CREATE INDEX "HostedCodexInvocationGrant_sticky_account_idx"
  ON "HostedCodexInvocationGrant"("workspaceId", "poolId", "activeAccountId", "status", "expiresAt");
CREATE INDEX "HostedCodexInvocationGrant_cas_idx"
  ON "HostedCodexInvocationGrant"("revision", "requestCount", "inFlight");

ALTER TABLE "HostedCodexInvocationGrant"
  ADD CONSTRAINT "HostedCodexInvocationGrant_binding_tenant_fkey"
  FOREIGN KEY ("repositoryBindingId", "workspaceId", "poolId", "repositoryConnectionId", "bindingRevision")
  REFERENCES "HostedCodexRepositoryBinding"("id", "workspaceId", "poolId", "repositoryConnectionId", "revision")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexInvocationGrant_account_tenant_fkey"
  FOREIGN KEY ("activeAccountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexInvocationGrant_primary_account_tenant_fkey"
  FOREIGN KEY ("primaryAccountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexInvocationGrant_backup_account_tenant_fkey"
  FOREIGN KEY ("backupAccountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexRelayRequest" (
  "id" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "idempotencyKeyHash" TEXT NOT NULL,
  "requestHash" TEXT,
  "status" "HostedCodexRelayRequestStatus" NOT NULL DEFAULT 'received',
  "requestBytes" INTEGER NOT NULL,
  "responseBytes" INTEGER,
  "responseHash" TEXT,
  "errorCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "successfulResponseStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexRelayRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexRelayRequest_identity_check" CHECK (
    "ordinal" > 0 AND "requestBytes" > 0
    AND "idempotencyKeyHash" ~ '^[a-f0-9]{64}$'
    AND ("requestHash" IS NULL OR "requestHash" ~ '^[a-f0-9]{64}$')
    AND ("responseHash" IS NULL OR "responseHash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "HostedCodexRelayRequest_status_evidence_check" CHECK (
    ("status" = 'received' AND "startedAt" IS NULL AND "completedAt" IS NULL
      AND "successfulResponseStartedAt" IS NULL
      AND "requestHash" IS NULL AND "responseBytes" IS NULL
      AND "responseHash" IS NULL AND "errorCode" IS NULL)
    OR
    ("status" = 'processing' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL
      AND "successfulResponseStartedAt" IS NULL
      AND "responseBytes" IS NULL AND "responseHash" IS NULL
      AND "errorCode" IS NULL)
    OR
    ("status" = 'response_started' AND "startedAt" IS NOT NULL
      AND "successfulResponseStartedAt" IS NOT NULL AND "completedAt" IS NULL
      AND "requestHash" IS NOT NULL
      AND "responseBytes" IS NOT NULL AND "responseBytes" >= 0
      AND "responseHash" IS NULL AND "errorCode" IS NULL)
    OR
    ("status" = 'succeeded' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
      AND "successfulResponseStartedAt" IS NOT NULL
      AND "requestHash" IS NOT NULL AND "responseBytes" >= 0
      AND "responseHash" IS NOT NULL AND "errorCode" IS NULL)
    OR
    ("status" = 'failed' AND "requestHash" IS NOT NULL
      AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "HostedCodexRelayRequest_grantId_ordinal_key"
  ON "HostedCodexRelayRequest"("grantId", "ordinal");
CREATE UNIQUE INDEX "HostedCodexRelayRequest_grantId_idempotencyKeyHash_key"
  ON "HostedCodexRelayRequest"("grantId", "idempotencyKeyHash");
CREATE INDEX "HostedCodexRelayRequest_grantId_requestHash_idx"
  ON "HostedCodexRelayRequest"("grantId", "requestHash");
CREATE INDEX "HostedCodexRelayRequest_status_receivedAt_idx"
  ON "HostedCodexRelayRequest"("status", "receivedAt");
CREATE INDEX "HostedCodexRelayRequest_grant_status_ordinal_idx"
  ON "HostedCodexRelayRequest"("grantId", "status", "ordinal");

ALTER TABLE "HostedCodexRelayRequest"
  ADD CONSTRAINT "HostedCodexRelayRequest_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "HostedCodexInvocationGrant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexCommentRefreshCapability" (
  "id" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "invocationId" TEXT NOT NULL,
  "repositoryBindingId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "capabilityTokenHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "maxUses" INTEGER NOT NULL,
  "useCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexCommentRefreshCapability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexCommentRefreshCapability_hash_check"
    CHECK ("capabilityTokenHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "HostedCodexCommentRefreshCapability_budget_check" CHECK (
    "maxUses" > 0 AND "useCount" >= 0 AND "useCount" <= "maxUses"
    AND "revision" > 0 AND "expiresAt" > "issuedAt"
    AND (("useCount" = 0 AND "lastUsedAt" IS NULL)
      OR ("useCount" > 0 AND "lastUsedAt" IS NOT NULL))
    AND ("revokedAt" IS NULL OR "revokedAt" >= "issuedAt")
  )
);

CREATE UNIQUE INDEX "HostedCodexCommentRefreshCapability_capabilityTokenHash_key"
  ON "HostedCodexCommentRefreshCapability"("capabilityTokenHash");
CREATE UNIQUE INDEX "HostedCodexCommentRefreshCapability_grantId_key"
  ON "HostedCodexCommentRefreshCapability"("grantId");
CREATE UNIQUE INDEX "HostedCodexCommentRefreshCapability_scope_key"
  ON "HostedCodexCommentRefreshCapability"(
    "id", "grantId", "invocationId", "repositoryBindingId",
    "workspaceId", "poolId", "repositoryConnectionId"
  );
CREATE UNIQUE INDEX "HostedCodexCommentRefreshCapability_one_per_grant_scope_key"
  ON "HostedCodexCommentRefreshCapability"(
    "grantId", "invocationId", "repositoryBindingId",
    "workspaceId", "poolId", "repositoryConnectionId"
  );
CREATE INDEX "HostedCodexCommentRefreshCapability_expiry_idx"
  ON "HostedCodexCommentRefreshCapability"("expiresAt", "revokedAt", "id");
CREATE INDEX "HostedCodexCommentRefreshCapability_scope_idx"
  ON "HostedCodexCommentRefreshCapability"(
    "workspaceId", "repositoryConnectionId", "repositoryBindingId", "invocationId"
  );
CREATE INDEX "HostedCodexCommentRefreshCapability_cas_idx"
  ON "HostedCodexCommentRefreshCapability"("grantId", "revision", "useCount");

ALTER TABLE "HostedCodexCommentRefreshCapability"
  ADD CONSTRAINT "HostedCodexCommentRefreshCapability_grant_scope_fkey"
  FOREIGN KEY (
    "grantId", "invocationId", "repositoryBindingId",
    "workspaceId", "poolId", "repositoryConnectionId"
  ) REFERENCES "HostedCodexInvocationGrant"(
    "id", "invocationId", "repositoryBindingId",
    "workspaceId", "poolId", "repositoryConnectionId"
  ) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexCommentRefreshUse" (
  "id" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "invocationId" TEXT NOT NULL,
  "repositoryBindingId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "requestIdHash" TEXT NOT NULL,
  "presentedTokenHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexCommentRefreshUse_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexCommentRefreshUse_values_check" CHECK (
    "ordinal" > 0
    AND "requestIdHash" ~ '^[a-f0-9]{64}$'
    AND "presentedTokenHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "HostedCodexCommentRefreshUse_capabilityId_ordinal_key"
  ON "HostedCodexCommentRefreshUse"("capabilityId", "ordinal");
CREATE UNIQUE INDEX "HostedCodexCommentRefreshUse_capabilityId_requestIdHash_key"
  ON "HostedCodexCommentRefreshUse"("capabilityId", "requestIdHash");
CREATE INDEX "HostedCodexCommentRefreshUse_tenant_history_idx"
  ON "HostedCodexCommentRefreshUse"("workspaceId", "repositoryConnectionId", "usedAt");

ALTER TABLE "HostedCodexCommentRefreshUse"
  ADD CONSTRAINT "HostedCodexCommentRefreshUse_capability_scope_fkey"
  FOREIGN KEY (
    "capabilityId", "grantId", "invocationId", "repositoryBindingId",
    "workspaceId", "poolId", "repositoryConnectionId"
  ) REFERENCES "HostedCodexCommentRefreshCapability"(
    "id", "grantId", "invocationId", "repositoryBindingId",
    "workspaceId", "poolId", "repositoryConnectionId"
  ) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexMutationFence" (
  "accountId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "fenceEpoch" BIGINT NOT NULL,
  "ownerIdHash" TEXT NOT NULL,
  "expectedGeneration" BIGINT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexMutationFence_pkey" PRIMARY KEY ("accountId"),
  CONSTRAINT "HostedCodexMutationFence_values_check" CHECK (
    "fenceEpoch" > 0 AND "expectedGeneration" >= 0
    AND "ownerIdHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "HostedCodexMutationFence_accountId_fenceEpoch_key"
  ON "HostedCodexMutationFence"("accountId", "fenceEpoch");
CREATE UNIQUE INDEX "HostedCodexMutationFence_accountId_workspaceId_poolId_key"
  ON "HostedCodexMutationFence"("accountId", "workspaceId", "poolId");
CREATE INDEX "HostedCodexMutationFence_expiry_idx"
  ON "HostedCodexMutationFence"("expiresAt", "accountId");
CREATE INDEX "HostedCodexMutationFence_cas_idx"
  ON "HostedCodexMutationFence"("workspaceId", "poolId", "expectedGeneration", "fenceEpoch");

ALTER TABLE "HostedCodexMutationFence"
  ADD CONSTRAINT "HostedCodexMutationFence_account_tenant_fkey"
  FOREIGN KEY ("accountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedCodexGenerationReceipt" (
  "id" TEXT NOT NULL,
  "credentialVersionId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "generation" BIGINT NOT NULL,
  "kind" "HostedCodexGenerationReceiptKind" NOT NULL,
  "mutationFenceEpoch" BIGINT NOT NULL,
  "actorIdHash" TEXT NOT NULL,
  "receiptHash" TEXT NOT NULL,
  "previousReceiptHash" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexGenerationReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexGenerationReceipt_values_check" CHECK (
    "generation" > 0 AND "mutationFenceEpoch" > 0
    AND "actorIdHash" ~ '^[a-f0-9]{64}$'
    AND "receiptHash" ~ '^[a-f0-9]{64}$'
    AND ("previousReceiptHash" IS NULL OR "previousReceiptHash" ~ '^[a-f0-9]{64}$')
    AND "previousReceiptHash" IS DISTINCT FROM "receiptHash"
  )
);

CREATE UNIQUE INDEX "HostedCodexGenerationReceipt_receiptHash_key"
  ON "HostedCodexGenerationReceipt"("receiptHash");
CREATE UNIQUE INDEX "HostedCodexGenerationReceipt_generation_kind_key"
  ON "HostedCodexGenerationReceipt"("accountId", "generation", "kind");
CREATE INDEX "HostedCodexGenerationReceipt_tenant_history_idx"
  ON "HostedCodexGenerationReceipt"("workspaceId", "poolId", "accountId", "occurredAt");
CREATE INDEX "HostedCodexGenerationReceipt_previousReceiptHash_idx"
  ON "HostedCodexGenerationReceipt"("previousReceiptHash");

ALTER TABLE "HostedCodexGenerationReceipt"
  ADD CONSTRAINT "HostedCodexGenerationReceipt_credential_tenant_fkey"
  FOREIGN KEY ("credentialVersionId", "accountId", "workspaceId", "poolId", "generation")
  REFERENCES "HostedCodexCredentialVersion"("id", "accountId", "workspaceId", "poolId", "generation")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexGenerationReceipt_previousReceiptHash_fkey"
  FOREIGN KEY ("previousReceiptHash") REFERENCES "HostedCodexGenerationReceipt"("receiptHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION hosted_codex_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  RAISE EXCEPTION 'hosted_codex_delete_forbidden:%', TG_TABLE_NAME;
END
$guard$;

CREATE TRIGGER "HostedCodexPool_delete_guard"
  BEFORE DELETE ON "HostedCodexPool"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();
CREATE TRIGGER "HostedCodexAccount_delete_guard"
  BEFORE DELETE ON "HostedCodexAccount"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();
CREATE TRIGGER "HostedCodexRepositoryBinding_delete_guard"
  BEFORE DELETE ON "HostedCodexRepositoryBinding"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();
CREATE TRIGGER "HostedCodexInvocationGrant_delete_guard"
  BEFORE DELETE ON "HostedCodexInvocationGrant"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();
CREATE TRIGGER "HostedCodexRelayRequest_delete_guard"
  BEFORE DELETE ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();
CREATE TRIGGER "HostedCodexCommentRefreshCapability_delete_guard"
  BEFORE DELETE ON "HostedCodexCommentRefreshCapability"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();

CREATE OR REPLACE FUNCTION hosted_codex_immutable_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  RAISE EXCEPTION 'hosted_codex_immutable_evidence:%', TG_TABLE_NAME;
END
$guard$;

CREATE TRIGGER "HostedCodexCredentialVersion_immutable_guard"
  BEFORE UPDATE OR DELETE ON "HostedCodexCredentialVersion"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_immutable_evidence_guard();
CREATE TRIGGER "HostedCodexGenerationReceipt_immutable_guard"
  BEFORE UPDATE OR DELETE ON "HostedCodexGenerationReceipt"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_immutable_evidence_guard();
CREATE TRIGGER "HostedCodexCommentRefreshUse_immutable_guard"
  BEFORE UPDATE OR DELETE ON "HostedCodexCommentRefreshUse"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_immutable_evidence_guard();

CREATE OR REPLACE FUNCTION hosted_codex_pool_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_pool_identity_immutable';
  END IF;
  IF OLD."status" = 'tombstoned' AND NEW."status" <> 'tombstoned' THEN
    RAISE EXCEPTION 'hosted_codex_pool_tombstone_terminal';
  END IF;
  IF OLD."status" = 'draining' AND NEW."status" NOT IN ('draining', 'tombstoned') THEN
    RAISE EXCEPTION 'hosted_codex_pool_drain_terminal';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexPool_lifecycle_guard"
  BEFORE UPDATE ON "HostedCodexPool"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_pool_lifecycle_guard();

CREATE OR REPLACE FUNCTION hosted_codex_binding_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  evidence_changed BOOLEAN;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."repositoryConnectionId" IS DISTINCT FROM OLD."repositoryConnectionId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_binding_identity_immutable';
  END IF;
  IF OLD."status" = 'tombstoned' AND NEW."status" <> 'tombstoned' THEN
    RAISE EXCEPTION 'hosted_codex_binding_tombstone_terminal';
  END IF;
  IF OLD."status" = 'draining' AND NEW."status" NOT IN ('draining', 'tombstoned') THEN
    RAISE EXCEPTION 'hosted_codex_binding_drain_terminal';
  END IF;

  evidence_changed :=
    NEW."workflowPath" IS DISTINCT FROM OLD."workflowPath"
    OR NEW."workflowActionRef" IS DISTINCT FROM OLD."workflowActionRef"
    OR NEW."workflowSourceCommitSha" IS DISTINCT FROM OLD."workflowSourceCommitSha"
    OR NEW."workflowSourceBlobSha" IS DISTINCT FROM OLD."workflowSourceBlobSha"
    OR NEW."workflowSourceSha256" IS DISTINCT FROM OLD."workflowSourceSha256"
    OR NEW."workflowSemanticSha256" IS DISTINCT FROM OLD."workflowSemanticSha256"
    OR NEW."workflowSourceTrust" IS DISTINCT FROM OLD."workflowSourceTrust"
    OR NEW."attestedGithubRepositoryId" IS DISTINCT FROM OLD."attestedGithubRepositoryId"
    OR NEW."attestedBindingRevision" IS DISTINCT FROM OLD."attestedBindingRevision"
    OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt";

  IF OLD."status" = 'active' AND evidence_changed THEN
    RAISE EXCEPTION 'hosted_codex_binding_active_attestation_immutable';
  END IF;
  IF OLD."status" = 'pending_activation' AND NEW."status" = 'active'
     AND NEW."revision" IS DISTINCT FROM OLD."revision" THEN
    RAISE EXCEPTION 'hosted_codex_binding_activation_revision_changed';
  END IF;
  IF NEW."status" = 'active' AND NOT EXISTS (
    SELECT 1
    FROM public."RepositoryConnection" repository
    WHERE repository."id" = NEW."repositoryConnectionId"
      AND repository."workspaceId" = NEW."workspaceId"
      AND repository."githubRepositoryId" = NEW."attestedGithubRepositoryId"
  ) THEN
    RAISE EXCEPTION 'hosted_codex_binding_repository_attestation_mismatch';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."revision" IS DISTINCT FROM OLD."revision"
     OR NEW."drainingAt" IS DISTINCT FROM OLD."drainingAt"
     OR NEW."tombstonedAt" IS DISTINCT FROM OLD."tombstonedAt"
     OR evidence_changed THEN
    IF NEW."stateVersion" <> OLD."stateVersion" + 1 THEN
      RAISE EXCEPTION 'hosted_codex_binding_state_cas_required';
    END IF;
  ELSIF NEW."stateVersion" IS DISTINCT FROM OLD."stateVersion" THEN
    RAISE EXCEPTION 'hosted_codex_binding_state_version_spurious';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexRepositoryBinding_lifecycle_guard"
  BEFORE UPDATE ON "HostedCodexRepositoryBinding"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_binding_lifecycle_guard();

CREATE OR REPLACE FUNCTION hosted_codex_account_generation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
    OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
    OR NEW."accountFingerprint" IS DISTINCT FROM OLD."accountFingerprint"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'hosted_codex_account_identity_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."state" = 'tombstoned' AND NEW."state" <> 'tombstoned' THEN
    RAISE EXCEPTION 'hosted_codex_account_tombstone_terminal';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."state" = 'draining' AND NEW."state" NOT IN ('draining', 'tombstoned') THEN
    RAISE EXCEPTION 'hosted_codex_account_drain_terminal';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."priority" IS DISTINCT FROM OLD."priority"
       OR NEW."state" IS DISTINCT FROM OLD."state"
       OR NEW."cooldownUntil" IS DISTINCT FROM OLD."cooldownUntil"
       OR NEW."activeGeneration" IS DISTINCT FROM OLD."activeGeneration"
       OR NEW."lastHealthyAt" IS DISTINCT FROM OLD."lastHealthyAt"
       OR NEW."drainingAt" IS DISTINCT FROM OLD."drainingAt"
       OR NEW."tombstonedAt" IS DISTINCT FROM OLD."tombstonedAt" THEN
      IF NEW."healthVersion" <> OLD."healthVersion" + 1 THEN
        RAISE EXCEPTION 'hosted_codex_account_health_cas_required';
      END IF;
    ELSIF NEW."healthVersion" IS DISTINCT FROM OLD."healthVersion" THEN
      RAISE EXCEPTION 'hosted_codex_account_health_version_spurious';
    END IF;
  END IF;

  IF NEW."activeGeneration" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public."HostedCodexCredentialVersion" credential
    WHERE credential."accountId" = NEW."id"
      AND credential."workspaceId" = NEW."workspaceId"
      AND credential."poolId" = NEW."poolId"
      AND credential."generation" = NEW."activeGeneration"
  ) THEN
    RAISE EXCEPTION 'hosted_codex_active_generation_missing';
  END IF;

  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexAccount_generation_guard"
  BEFORE INSERT OR UPDATE ON "HostedCodexAccount"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_account_generation_guard();

CREATE OR REPLACE FUNCTION hosted_codex_invocation_grant_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."failoverCount" <> 0
       OR NEW."activeAccountId" IS DISTINCT FROM NEW."primaryAccountId"
       OR NEW."backupAccountId" IS NOT NULL
          AND NEW."backupAccountId" = NEW."primaryAccountId"
       OR NEW."firstSuccessfulResponseAt" IS NOT NULL THEN
      RAISE EXCEPTION 'hosted_codex_grant_invalid_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."invocationId" IS DISTINCT FROM OLD."invocationId"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."repositoryConnectionId" IS DISTINCT FROM OLD."repositoryConnectionId"
     OR NEW."repositoryBindingId" IS DISTINCT FROM OLD."repositoryBindingId"
     OR NEW."primaryAccountId" IS DISTINCT FROM OLD."primaryAccountId"
     OR NEW."backupAccountId" IS DISTINCT FROM OLD."backupAccountId"
     OR NEW."reviewRequestId" IS DISTINCT FROM OLD."reviewRequestId"
     OR NEW."providerInvocationKey" IS DISTINCT FROM OLD."providerInvocationKey"
     OR NEW."runId" IS DISTINCT FROM OLD."runId"
     OR NEW."runAttempt" IS DISTINCT FROM OLD."runAttempt"
     OR NEW."model" IS DISTINCT FROM OLD."model"
     OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
     OR NEW."policyFingerprint" IS DISTINCT FROM OLD."policyFingerprint"
     OR NEW."runtimeConfigVersion" IS DISTINCT FROM OLD."runtimeConfigVersion"
     OR NEW."bindingRevision" IS DISTINCT FROM OLD."bindingRevision"
     OR NEW."authzEpoch" IS DISTINCT FROM OLD."authzEpoch"
     OR NEW."capabilityTokenHash" IS DISTINCT FROM OLD."capabilityTokenHash"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."maxRequests" IS DISTINCT FROM OLD."maxRequests"
     OR NEW."maxConcurrentRequests" IS DISTINCT FROM OLD."maxConcurrentRequests"
     OR NEW."maxRequestBytes" IS DISTINCT FROM OLD."maxRequestBytes"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_grant_identity_immutable';
  END IF;

  IF OLD."firstSuccessfulResponseAt" IS NOT NULL
     AND NEW."firstSuccessfulResponseAt" IS DISTINCT FROM OLD."firstSuccessfulResponseAt" THEN
    RAISE EXCEPTION 'hosted_codex_first_success_immutable';
  END IF;

  IF NEW."activeAccountId" IS DISTINCT FROM OLD."activeAccountId" THEN
    IF OLD."firstSuccessfulResponseAt" IS NOT NULL
       OR NEW."firstSuccessfulResponseAt" IS NOT NULL
       OR OLD."failoverCount" <> 0
       OR NEW."failoverCount" <> 1
       OR OLD."activeAccountId" IS DISTINCT FROM OLD."primaryAccountId"
       OR OLD."backupAccountId" IS NULL
       OR NEW."activeAccountId" IS DISTINCT FROM OLD."backupAccountId" THEN
      RAISE EXCEPTION 'hosted_codex_grant_failover_forbidden';
    END IF;
  ELSIF NEW."failoverCount" IS DISTINCT FROM OLD."failoverCount"
        OR NEW."primaryAccountId" IS DISTINCT FROM OLD."primaryAccountId"
        OR NEW."backupAccountId" IS DISTINCT FROM OLD."backupAccountId" THEN
    RAISE EXCEPTION 'hosted_codex_grant_failover_evidence_invalid';
  END IF;

  IF OLD."status" <> 'issued' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'hosted_codex_grant_terminal_status';
  END IF;

  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexInvocationGrant_transition_guard"
  BEFORE INSERT OR UPDATE ON "HostedCodexInvocationGrant"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_invocation_grant_guard();

CREATE OR REPLACE FUNCTION hosted_codex_comment_refresh_capability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."invocationId" IS DISTINCT FROM OLD."invocationId"
     OR NEW."repositoryBindingId" IS DISTINCT FROM OLD."repositoryBindingId"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."repositoryConnectionId" IS DISTINCT FROM OLD."repositoryConnectionId"
     OR NEW."capabilityTokenHash" IS DISTINCT FROM OLD."capabilityTokenHash"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."maxUses" IS DISTINCT FROM OLD."maxUses"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_identity_immutable';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_cas_required';
  END IF;
  IF OLD."revokedAt" IS NOT NULL
     AND NEW."useCount" IS DISTINCT FROM OLD."useCount" THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_revoked';
  END IF;
  IF NEW."useCount" = OLD."useCount" + 1 THEN
    IF NEW."lastUsedAt" IS NULL
       OR NEW."lastUsedAt" IS NOT DISTINCT FROM OLD."lastUsedAt" THEN
      RAISE EXCEPTION 'hosted_codex_comment_refresh_use_evidence_required';
    END IF;
  ELSIF NEW."useCount" = OLD."useCount" THEN
    IF NEW."lastUsedAt" IS DISTINCT FROM OLD."lastUsedAt" THEN
      RAISE EXCEPTION 'hosted_codex_comment_refresh_last_use_spurious';
    END IF;
  ELSE
    RAISE EXCEPTION 'hosted_codex_comment_refresh_use_count_invalid';
  END IF;

  IF OLD."revokedAt" IS NOT NULL
     AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_revocation_immutable';
  END IF;
  IF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NULL
     AND NEW."useCount" = OLD."useCount" THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_no_effect_update';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexCommentRefreshCapability_transition_guard"
  BEFORE UPDATE ON "HostedCodexCommentRefreshCapability"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_refresh_capability_guard();

CREATE OR REPLACE FUNCTION hosted_codex_comment_refresh_consume()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $consume$
DECLARE
  consumed_capability_id TEXT;
BEGIN
  SET CONSTRAINTS
    "HostedCodexCommentRefreshCapability_ledger_consistency",
    "HostedCodexCommentRefreshUse_ledger_consistency"
    DEFERRED;
  NEW."usedAt" := clock_timestamp();
  UPDATE public."HostedCodexCommentRefreshCapability" AS capability
  SET "useCount" = capability."useCount" + 1,
      "lastUsedAt" = NEW."usedAt",
      "revision" = capability."revision" + 1,
      "updatedAt" = NEW."usedAt"
  WHERE capability."id" = NEW."capabilityId"
    AND capability."grantId" = NEW."grantId"
    AND capability."invocationId" = NEW."invocationId"
    AND capability."repositoryBindingId" = NEW."repositoryBindingId"
    AND capability."workspaceId" = NEW."workspaceId"
    AND capability."poolId" = NEW."poolId"
    AND capability."repositoryConnectionId" = NEW."repositoryConnectionId"
    AND capability."capabilityTokenHash" = NEW."presentedTokenHash"
    AND capability."revokedAt" IS NULL
    AND capability."expiresAt" > NEW."usedAt"
    AND capability."useCount" < capability."maxUses"
    AND NEW."ordinal" = capability."useCount" + 1
  RETURNING capability."id" INTO consumed_capability_id;

  IF consumed_capability_id IS NULL THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_consume_denied';
  END IF;
  RETURN NEW;
END
$consume$;

CREATE TRIGGER "HostedCodexCommentRefreshUse_consume_guard"
  BEFORE INSERT ON "HostedCodexCommentRefreshUse"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_refresh_consume();

CREATE OR REPLACE FUNCTION hosted_codex_comment_refresh_ledger_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $consistency$
DECLARE
  target_capability_id TEXT;
  expected_use_count INTEGER;
  actual_use_count BIGINT;
BEGIN
  target_capability_id := COALESCE(
    to_jsonb(NEW)->>'capabilityId',
    to_jsonb(NEW)->>'id'
  );
  SELECT capability."useCount" INTO expected_use_count
  FROM public."HostedCodexCommentRefreshCapability" capability
  WHERE capability."id" = target_capability_id;
  SELECT count(*) INTO actual_use_count
  FROM public."HostedCodexCommentRefreshUse" use_receipt
  WHERE use_receipt."capabilityId" = target_capability_id;
  IF expected_use_count IS DISTINCT FROM actual_use_count THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_ledger_mismatch';
  END IF;
  RETURN NEW;
END
$consistency$;

CREATE CONSTRAINT TRIGGER "HostedCodexCommentRefreshCapability_ledger_consistency"
  AFTER INSERT OR UPDATE ON "HostedCodexCommentRefreshCapability"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_refresh_ledger_consistency();
CREATE CONSTRAINT TRIGGER "HostedCodexCommentRefreshUse_ledger_consistency"
  AFTER INSERT ON "HostedCodexCommentRefreshUse"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_refresh_ledger_consistency();

CREATE OR REPLACE FUNCTION hosted_codex_relay_admission_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $admit$
DECLARE
  admitted_grant_id TEXT;
BEGIN
  UPDATE public."HostedCodexInvocationGrant" AS target_grant
  SET "requestCount" = target_grant."requestCount" + 1,
      "inFlight" = target_grant."inFlight" + 1,
      "revision" = target_grant."revision" + 1,
      "status" = CASE
        WHEN target_grant."requestCount" + 1 = target_grant."maxRequests" THEN 'exhausted'::public."HostedCodexInvocationGrantStatus"
        ELSE target_grant."status"
      END,
      "updatedAt" = clock_timestamp()
  WHERE target_grant."id" = NEW."grantId"
    AND target_grant."status" = 'issued'
    AND target_grant."expiresAt" > clock_timestamp()
    AND target_grant."requestCount" < target_grant."maxRequests"
    AND target_grant."inFlight" < target_grant."maxConcurrentRequests"
    AND NEW."requestBytes" <= target_grant."maxRequestBytes"
  RETURNING target_grant."id" INTO admitted_grant_id;

  IF admitted_grant_id IS NULL THEN
    RAISE EXCEPTION 'hosted_codex_relay_admission_denied';
  END IF;
  RETURN NEW;
END
$admit$;

CREATE TRIGGER "HostedCodexRelayRequest_admission_guard"
  BEFORE INSERT ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_admission_guard();

CREATE OR REPLACE FUNCTION hosted_codex_relay_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
     OR NEW."idempotencyKeyHash" IS DISTINCT FROM OLD."idempotencyKeyHash"
     OR NEW."requestBytes" IS DISTINCT FROM OLD."requestBytes"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'hosted_codex_relay_request_identity_immutable';
  END IF;

  IF OLD."requestHash" IS NOT NULL
     AND NEW."requestHash" IS DISTINCT FROM OLD."requestHash" THEN
    RAISE EXCEPTION 'hosted_codex_relay_request_hash_immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'received'
       AND NEW."status" NOT IN ('processing', 'response_started', 'succeeded', 'failed') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'processing'
       AND NEW."status" NOT IN ('response_started', 'succeeded', 'failed') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'response_started'
       AND NEW."status" NOT IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_terminal_status';
    END IF;
  END IF;

  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexRelayRequest_transition_guard"
  BEFORE UPDATE ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_request_guard();

CREATE OR REPLACE FUNCTION hosted_codex_relay_completion_accounting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $complete$
DECLARE
  completed_grant_id TEXT;
BEGIN
  IF NEW."status" NOT IN ('succeeded', 'failed')
     OR (TG_OP = 'UPDATE' AND OLD."status" IN ('succeeded', 'failed')) THEN
    RETURN NEW;
  END IF;

  UPDATE public."HostedCodexInvocationGrant" AS target_grant
  SET "inFlight" = target_grant."inFlight" - 1,
      "revision" = target_grant."revision" + 1,
      "updatedAt" = clock_timestamp()
  WHERE target_grant."id" = NEW."grantId"
    AND target_grant."inFlight" > 0
  RETURNING target_grant."id" INTO completed_grant_id;

  IF completed_grant_id IS NULL THEN
    RAISE EXCEPTION 'hosted_codex_relay_completion_accounting_conflict';
  END IF;
  RETURN NEW;
END
$complete$;

CREATE TRIGGER "HostedCodexRelayRequest_completion_accounting"
  AFTER INSERT OR UPDATE OF "status" ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_completion_accounting();

CREATE OR REPLACE FUNCTION hosted_codex_relay_success_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fence$
DECLARE
  success_at TIMESTAMP(3);
BEGIN
  IF NEW."successfulResponseStartedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  success_at := COALESCE(NEW."successfulResponseStartedAt", clock_timestamp());
  UPDATE public."HostedCodexInvocationGrant"
  SET "firstSuccessfulResponseAt" = success_at,
      "revision" = "revision" + 1,
      "updatedAt" = clock_timestamp()
  WHERE "id" = NEW."grantId"
    AND "firstSuccessfulResponseAt" IS NULL;
  RETURN NEW;
END
$fence$;

CREATE TRIGGER "HostedCodexRelayRequest_success_fence"
  AFTER INSERT OR UPDATE OF "successfulResponseStartedAt"
  ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_success_fence();

-- Deliberately no backfill: hosted pools are provisioned explicitly and no
-- existing provider secret rows are copied into this encrypted envelope model.
-- Deliberately no down migration: credential and relay evidence is retained.
