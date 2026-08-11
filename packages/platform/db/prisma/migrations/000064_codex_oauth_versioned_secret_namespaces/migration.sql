BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Upgrade the already-deployed recovery ledger without changing historical
-- migration checksums. Terminal evidence owns both parent rows permanently.
ALTER TABLE "CodexOAuthSetupRecoveryRequest"
  ADD COLUMN "databaseRecoveryWitness" TEXT,
  ADD CONSTRAINT "CodexOAuthSetupRecoveryRequest_database_recovery_witness_check"
    CHECK ("databaseRecoveryWitness" IS NULL OR "databaseRecoveryWitness" ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT "CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey",
  ADD CONSTRAINT "CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey"
    FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP CONSTRAINT "CodexOAuthSetupRecoveryRequest_latestManifestId_fkey",
  ADD CONSTRAINT "CodexOAuthSetupRecoveryRequest_latestManifestId_fkey"
    FOREIGN KEY ("latestManifestId") REFERENCES "CodexOAuthSetupManifest"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP CONSTRAINT "CodexOAuthSetupRecoveryRequest_contract_check",
  ADD CONSTRAINT "CodexOAuthSetupRecoveryRequest_contract_check" CHECK (
    (("mode" = 'forced_reseed'
       AND "acknowledgement" = 'all_prior_installers_and_writers_are_stopped')
     OR
     ("mode" = 'forced_reseed_account_switch'
       AND "acknowledgement" = 'all_prior_installers_and_writers_are_stopped_and_account_switch_is_intended'))
    AND "state" IN ('active', 'manifest_issued', 'completed', 'superseded')
  );

ALTER TABLE "CodexOAuthSetupManifest"
  ADD COLUMN "databaseRecoveryWitness" TEXT,
  ADD CONSTRAINT "CodexOAuthSetupManifest_database_recovery_witness_check"
    CHECK ("databaseRecoveryWitness" IS NULL OR "databaseRecoveryWitness" ~ '^[a-f0-9]{64}$');

ALTER TABLE "CodexOAuthProviderInstance"
  ADD COLUMN "activeSecretNamespaceId" TEXT,
  ADD COLUMN "activeSecretNamespaceEpoch" BIGINT,
  ADD COLUMN "activeSecretNamespaceName" TEXT,
  ADD COLUMN "activeAccountIdentityHash" TEXT;

ALTER TABLE "CodexOAuthWritebackIntent"
  ADD COLUMN "dispatchAttemptId" TEXT,
  ADD COLUMN "secretNamespaceId" TEXT,
  ADD COLUMN "dispatchAuthorizedAt" TIMESTAMPTZ(3),
  ADD COLUMN "providerResponseCode" INTEGER,
  ADD COLUMN "providerConfirmedAt" TIMESTAMPTZ(3),
  ADD COLUMN "namespaceRetiredAt" TIMESTAMPTZ(3),
  ADD COLUMN "databaseIncarnation" TEXT,
  ADD COLUMN "databaseRecoveryWitness" TEXT,
  ADD COLUMN "accountIdentityHash" TEXT,
  ADD COLUMN "accountIdentityAlgorithm" TEXT,
  ADD COLUMN "recoveryRequestRowId" TEXT,
  ADD COLUMN "recoveryResolvedAt" TIMESTAMPTZ(3),
  ADD COLUMN "executorOwner" TEXT,
  ADD COLUMN "executorLeaseExpiresAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_versioned_dispatch_check" CHECK (
    ("dispatchAttemptId" IS NULL AND "secretNamespaceId" IS NULL AND "dispatchAuthorizedAt" IS NULL) OR
    ("dispatchAttemptId" IS NOT NULL AND "secretNamespaceId" IS NOT NULL AND "dispatchAuthorizedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_provider_response_check" CHECK (
    "providerResponseCode" IS NULL OR "providerResponseCode" IN (201, 204)
  ),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_database_incarnation_check" CHECK (
    "databaseIncarnation" IS NULL OR "databaseIncarnation" ~ '^[1-9][0-9]+$'
  ),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_database_recovery_witness_check" CHECK (
    "databaseRecoveryWitness" IS NULL OR "databaseRecoveryWitness" ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_account_identity_check" CHECK (
    ("accountIdentityHash" IS NULL AND "accountIdentityAlgorithm" IS NULL) OR
    ("accountIdentityHash" IS NOT NULL AND "accountIdentityAlgorithm" = 'provider_issuer_subject_account_v1')
  ),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_recovery_resolution_check" CHECK (
    ("recoveryRequestRowId" IS NULL) = ("recoveryResolvedAt" IS NULL)
  ),
  ADD CONSTRAINT "CodexOAuthWritebackIntent_executor_lease_check" CHECK (
    ("dispatchAttemptId" IS NULL AND "executorOwner" IS NULL AND "executorLeaseExpiresAt" IS NULL) OR
    ("dispatchAttemptId" IS NOT NULL AND "executorOwner" IS NOT NULL
      AND "executorLeaseExpiresAt" IS NOT NULL
      AND "executorLeaseExpiresAt" > "dispatchAuthorizedAt")
  );

ALTER TABLE "CodexOAuthLease"
  ADD COLUMN "secretNamespaceId" TEXT,
  ADD COLUMN "secretNamespaceEpoch" BIGINT,
  ADD CONSTRAINT "CodexOAuthLease_secret_namespace_pair_check" CHECK (
    ("secretNamespaceId" IS NULL AND "secretNamespaceEpoch" IS NULL) OR
    ("secretNamespaceId" IS NOT NULL AND "secretNamespaceEpoch" IS NOT NULL)
  );

CREATE TABLE "CodexOAuthSetupPayloadClaim" (
  "id" TEXT PRIMARY KEY,
  "providerInstanceRowId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "githubRepositoryId" TEXT NOT NULL,
  "manifestId" TEXT NOT NULL,
  "manifestDigest" TEXT NOT NULL,
  "recoveryRequestId" TEXT,
  "recoveryEpoch" BIGINT NOT NULL,
  "operationId" TEXT NOT NULL,
  "payloadVersion" INTEGER NOT NULL,
  "canonicalizationVersion" INTEGER NOT NULL,
  "generationHash" TEXT NOT NULL,
  "accountIdentityHash" TEXT NOT NULL,
  "accountIdentityAlgorithm" TEXT NOT NULL,
  "authByteSize" INTEGER NOT NULL,
  "installerVersion" TEXT NOT NULL,
  "installerDigest" TEXT NOT NULL,
  "databaseIncarnation" TEXT NOT NULL,
  "databaseRecoveryWitness" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "claimVersion" INTEGER NOT NULL DEFAULT 1,
  "prepareReplayExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "recoveryExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedAttemptId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMPTZ(3),
  "activatedAt" TIMESTAMPTZ(3),
  CONSTRAINT "CodexOAuthSetupPayloadClaim_payload_check" CHECK (
    "payloadVersion" = 2 AND "canonicalizationVersion" = 1 AND
    "authByteSize" BETWEEN 1 AND 32768 AND
    "accountIdentityAlgorithm" = 'provider_issuer_subject_account_v1' AND
    "databaseIncarnation" ~ '^[1-9][0-9]+$' AND
    "databaseRecoveryWitness" ~ '^[a-f0-9]{64}$' AND
    "status" IN ('prepared','confirmed_candidate','active','superseded_predispatch','retired_confirmed','retired_active') AND
    "prepareReplayExpiresAt" <= "recoveryExpiresAt" AND
    (("status" IN ('confirmed_candidate','active','retired_confirmed','retired_active')
       AND "confirmedAttemptId" IS NOT NULL AND "confirmedAt" IS NOT NULL) OR
     ("status" IN ('prepared','superseded_predispatch')
       AND "confirmedAttemptId" IS NULL AND "confirmedAt" IS NULL)) AND
    (("status" IN ('active','retired_active') AND "activatedAt" IS NOT NULL) OR
     ("status" NOT IN ('active','retired_active') AND "activatedAt" IS NULL))
  )
);

CREATE TABLE "CodexOAuthSecretNamespace" (
  "id" TEXT PRIMARY KEY,
  "providerInstanceRowId" TEXT NOT NULL,
  "githubRepositoryId" TEXT NOT NULL,
  "namespaceEpoch" BIGINT NOT NULL,
  "secretName" TEXT NOT NULL,
  "databaseRecoveryWitness" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "permanentlyRetired" BOOLEAN NOT NULL DEFAULT false,
  "workflowPath" TEXT,
  "workflowSourceCommitSha" TEXT,
  "workflowSourceBlobSha" TEXT,
  "workflowSourceSha256" TEXT,
  "workflowSemanticSha256" TEXT,
  "workflowSourceTrust" TEXT,
  "attestedRepositoryId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMPTZ(3),
  "activatedAt" TIMESTAMPTZ(3),
  "retiredAt" TIMESTAMPTZ(3),
  CONSTRAINT "CodexOAuthSecretNamespace_lifecycle_check" CHECK (
    "status" IN ('dispatch_authorized','confirmed_candidate','active','retired_predispatch','retired_ambiguous','retired_superseded') AND
    (("status" IN ('retired_predispatch','retired_ambiguous','retired_superseded') AND "permanentlyRetired" AND "retiredAt" IS NOT NULL) OR
     ("status" NOT IN ('retired_predispatch','retired_ambiguous','retired_superseded') AND NOT "permanentlyRetired")) AND
    (("status" IN ('active','retired_superseded') AND "workflowPath" IS NOT NULL AND "workflowSourceCommitSha" IS NOT NULL AND
       "workflowSourceBlobSha" IS NOT NULL AND "workflowSourceSha256" IS NOT NULL AND
       "workflowSemanticSha256" IS NOT NULL AND "workflowSourceTrust" = 'trusted_default_branch_revision' AND
       "attestedRepositoryId" = "githubRepositoryId" AND
       "activatedAt" IS NOT NULL) OR "status" NOT IN ('active','retired_superseded')) AND
    (("status" = 'confirmed_candidate' AND "confirmedAt" IS NOT NULL) OR
     ("status" = 'dispatch_authorized' AND "confirmedAt" IS NULL) OR
     "status" NOT IN ('dispatch_authorized','confirmed_candidate'))
  ),
  CONSTRAINT "CodexOAuthSecretNamespace_name_check" CHECK (
    "secretName" ~ '^REVIEWROUTER_CODEX_AUTH_JSON_R[1-9][0-9]*_P[a-f0-9]{16}_E[1-9][0-9]*_[a-f0-9]{32}$'
  ),
  CONSTRAINT "CodexOAuthSecretNamespace_recovery_witness_check" CHECK (
    "databaseRecoveryWitness" ~ '^[a-f0-9]{64}$'
  )
);

CREATE TABLE "CodexOAuthSetupDispatchAttempt" (
  "id" TEXT PRIMARY KEY,
  "claimId" TEXT NOT NULL,
  "namespaceId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "authorizedAt" TIMESTAMPTZ(3) NOT NULL,
  "dispatchExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "definiteResponseCode" INTEGER,
  "confirmedAt" TIMESTAMPTZ(3),
  "retiredAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodexOAuthSetupDispatchAttempt_lifecycle_check" CHECK (
    "ordinal" BETWEEN 1 AND 3 AND
    "status" IN ('dispatch_authorized','confirmed','retired_ambiguous','retired_confirmed') AND
    "dispatchExpiresAt" > "authorizedAt" AND
    ("definiteResponseCode" IS NULL OR "definiteResponseCode" IN (201,204)) AND
    (("status" IN ('confirmed','retired_confirmed') AND
      "definiteResponseCode" IN (201,204) AND "confirmedAt" IS NOT NULL) OR
      ("status" IN ('dispatch_authorized','retired_ambiguous') AND
       "definiteResponseCode" IS NULL AND "confirmedAt" IS NULL)) AND
    (("status" IN ('retired_ambiguous','retired_confirmed') AND "retiredAt" IS NOT NULL) OR
      "status" NOT IN ('retired_ambiguous','retired_confirmed'))
  )
);

CREATE UNIQUE INDEX "CodexOAuthSetupPayloadClaim_provider_operation_key"
  ON "CodexOAuthSetupPayloadClaim"("providerInstanceRowId", "operationId");
CREATE UNIQUE INDEX "CodexOAuthSetupPayloadClaim_provider_epoch_key"
  ON "CodexOAuthSetupPayloadClaim"("providerInstanceRowId", "recoveryEpoch");
CREATE UNIQUE INDEX "CodexOAuthSetupPayloadClaim_confirmedAttemptId_key"
  ON "CodexOAuthSetupPayloadClaim"("confirmedAttemptId");
CREATE INDEX "CodexOAuthSetupPayloadClaim_provider_status_idx"
  ON "CodexOAuthSetupPayloadClaim"("providerInstanceRowId", "status");

CREATE UNIQUE INDEX "CodexOAuthSecretNamespace_secretName_key"
  ON "CodexOAuthSecretNamespace"("secretName");
CREATE UNIQUE INDEX "CodexOAuthSecretNamespace_provider_epoch_key"
  ON "CodexOAuthSecretNamespace"("providerInstanceRowId", "namespaceEpoch");
CREATE INDEX "CodexOAuthSecretNamespace_provider_status_idx"
  ON "CodexOAuthSecretNamespace"("providerInstanceRowId", "status");
CREATE UNIQUE INDEX "CodexOAuthSecretNamespace_id_epoch_key"
  ON "CodexOAuthSecretNamespace"("id", "namespaceEpoch");
CREATE UNIQUE INDEX "CodexOAuthSecretNamespace_id_epoch_name_key"
  ON "CodexOAuthSecretNamespace"("id", "namespaceEpoch", "secretName");
CREATE UNIQUE INDEX "CodexOAuthSecretNamespace_provider_id_key"
  ON "CodexOAuthSecretNamespace"("providerInstanceRowId", "id");

CREATE UNIQUE INDEX "CodexOAuthSetupDispatchAttempt_namespaceId_key"
  ON "CodexOAuthSetupDispatchAttempt"("namespaceId");
CREATE UNIQUE INDEX "CodexOAuthSetupDispatchAttempt_claim_idempotency_key"
  ON "CodexOAuthSetupDispatchAttempt"("claimId", "idempotencyKey");
CREATE UNIQUE INDEX "CodexOAuthSetupDispatchAttempt_claim_ordinal_key"
  ON "CodexOAuthSetupDispatchAttempt"("claimId", "ordinal");
CREATE INDEX "CodexOAuthSetupDispatchAttempt_claim_status_idx"
  ON "CodexOAuthSetupDispatchAttempt"("claimId", "status");
CREATE UNIQUE INDEX "CodexOAuthProviderInstance_activeSecretNamespaceId_key"
  ON "CodexOAuthProviderInstance"("activeSecretNamespaceId");
CREATE UNIQUE INDEX "CodexOAuthWritebackIntent_dispatchAttemptId_key"
  ON "CodexOAuthWritebackIntent"("dispatchAttemptId");
CREATE UNIQUE INDEX "CodexOAuthWritebackIntent_secretNamespaceId_key"
  ON "CodexOAuthWritebackIntent"("secretNamespaceId");
-- Legacy intents have no database incarnation and remain immutable history.
-- Every V4 intent, including a positive no-op proof, has one and is unique per
-- finalized lease. The provider row lock serializes the friendly conflict path;
-- this index is the final race-proof backstop for every other SQL writer.
CREATE UNIQUE INDEX "CodexOAuthWritebackIntent_versioned_lease_key"
  ON "CodexOAuthWritebackIntent"("leaseId")
  WHERE "databaseIncarnation" IS NOT NULL;

ALTER TABLE "CodexOAuthSetupPayloadClaim"
  ADD CONSTRAINT "CodexOAuthSetupPayloadClaim_provider_fkey" FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthSetupPayloadClaim_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthSetupPayloadClaim_repository_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthSetupPayloadClaim_manifest_fkey" FOREIGN KEY ("manifestId") REFERENCES "CodexOAuthSetupManifest"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthSetupPayloadClaim_recovery_request_fkey"
    FOREIGN KEY ("providerInstanceRowId", "recoveryRequestId")
    REFERENCES "CodexOAuthSetupRecoveryRequest"("providerInstanceRowId", "recoveryRequestId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CodexOAuthSecretNamespace"
  ADD CONSTRAINT "CodexOAuthSecretNamespace_provider_fkey" FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE RESTRICT;

ALTER TABLE "CodexOAuthSetupDispatchAttempt"
  ADD CONSTRAINT "CodexOAuthSetupDispatchAttempt_claim_fkey" FOREIGN KEY ("claimId") REFERENCES "CodexOAuthSetupPayloadClaim"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthSetupDispatchAttempt_namespace_fkey" FOREIGN KEY ("namespaceId") REFERENCES "CodexOAuthSecretNamespace"("id") ON DELETE RESTRICT;

ALTER TABLE "CodexOAuthSetupPayloadClaim"
  ADD CONSTRAINT "CodexOAuthSetupPayloadClaim_confirmed_attempt_fkey" FOREIGN KEY ("confirmedAttemptId") REFERENCES "CodexOAuthSetupDispatchAttempt"("id") ON DELETE RESTRICT;

ALTER TABLE "CodexOAuthProviderInstance"
  ADD CONSTRAINT "CodexOAuthProviderInstance_active_namespace_fkey" FOREIGN KEY ("activeSecretNamespaceId") REFERENCES "CodexOAuthSecretNamespace"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthProviderInstance_active_namespace_epoch_fkey" FOREIGN KEY ("activeSecretNamespaceId", "activeSecretNamespaceEpoch") REFERENCES "CodexOAuthSecretNamespace"("id", "namespaceEpoch") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthProviderInstance_active_namespace_identity_fkey" FOREIGN KEY ("activeSecretNamespaceId", "activeSecretNamespaceEpoch", "activeSecretNamespaceName") REFERENCES "CodexOAuthSecretNamespace"("id", "namespaceEpoch", "secretName") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthProviderInstance_active_namespace_owner_fkey" FOREIGN KEY ("id", "activeSecretNamespaceId") REFERENCES "CodexOAuthSecretNamespace"("providerInstanceRowId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CodexOAuthProviderInstance_active_namespace_pair_check" CHECK (
    ("activeSecretNamespaceId" IS NULL AND "activeSecretNamespaceEpoch" IS NULL AND "activeSecretNamespaceName" IS NULL) OR
    ("activeSecretNamespaceId" IS NOT NULL AND "activeSecretNamespaceEpoch" IS NOT NULL AND "activeSecretNamespaceName" IS NOT NULL)
  );

ALTER TABLE "CodexOAuthLease"
  ADD CONSTRAINT "CodexOAuthLease_secret_namespace_epoch_fkey" FOREIGN KEY ("secretNamespaceId", "secretNamespaceEpoch") REFERENCES "CodexOAuthSecretNamespace"("id", "namespaceEpoch") ON DELETE RESTRICT;

ALTER TABLE "CodexOAuthWritebackIntent"
  ADD CONSTRAINT "CodexOAuthWritebackIntent_secret_namespace_fkey" FOREIGN KEY ("secretNamespaceId") REFERENCES "CodexOAuthSecretNamespace"("id") ON DELETE RESTRICT;

ALTER TABLE "CodexOAuthWritebackIntent"
  ADD CONSTRAINT "CodexOAuthWritebackIntent_recovery_request_fkey" FOREIGN KEY ("recoveryRequestRowId") REFERENCES "CodexOAuthSetupRecoveryRequest"("id") ON DELETE RESTRICT;

ALTER TABLE "CodexOAuthWritebackIntent"
  DROP CONSTRAINT "CodexOAuthWritebackIntent_providerInstanceRowId_fkey",
  ADD CONSTRAINT "CodexOAuthWritebackIntent_providerInstanceRowId_fkey" FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE RESTRICT,
  DROP CONSTRAINT "CodexOAuthWritebackIntent_leaseId_fkey",
  ADD CONSTRAINT "CodexOAuthWritebackIntent_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "CodexOAuthLease"("id") ON DELETE RESTRICT;

-- V4 fields are part of the same epoch/owner fence as the original provider
-- state. This function is replaced only after those columns exist.
CREATE OR REPLACE FUNCTION "codex_oauth_provider_mutation_transition_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."latestGeneration" IS DISTINCT FROM OLD."latestGeneration"
     OR NEW."latestGenerationHash" IS DISTINCT FROM OLD."latestGenerationHash"
     OR NEW."activeLeaseId" IS DISTINCT FROM OLD."activeLeaseId"
     OR NEW."activeLeaseExpiresAt" IS DISTINCT FROM OLD."activeLeaseExpiresAt"
     OR NEW."activeSecretNamespaceId" IS DISTINCT FROM OLD."activeSecretNamespaceId"
     OR NEW."activeSecretNamespaceEpoch" IS DISTINCT FROM OLD."activeSecretNamespaceEpoch"
     OR NEW."activeSecretNamespaceName" IS DISTINCT FROM OLD."activeSecretNamespaceName"
     OR NEW."activeAccountIdentityHash" IS DISTINCT FROM OLD."activeAccountIdentityHash"
     OR NEW."mutationEpoch" IS DISTINCT FROM OLD."mutationEpoch"
     OR NEW."mutationOwner" IS DISTINCT FROM OLD."mutationOwner"
     OR NEW."mutationOwnerId" IS DISTINCT FROM OLD."mutationOwnerId"
  THEN
    IF NOT (
      (NEW."mutationEpoch" > OLD."mutationEpoch"
       AND NEW."mutationOwner" IN ('runtime', 'setup', 'recovery')
       AND NEW."mutationOwnerId" IS NOT NULL)
      OR
      (NEW."mutationEpoch" = OLD."mutationEpoch"
       AND OLD."mutationOwner" IN ('runtime', 'setup')
       AND OLD."mutationOwnerId" IS NOT NULL
       AND NEW."mutationOwner" IS NULL
       AND NEW."mutationOwnerId" IS NULL)
      OR
      (NEW."mutationEpoch" = OLD."mutationEpoch"
       AND OLD."mutationOwner" = 'setup'
       AND NEW."mutationOwner" = 'setup'
       AND OLD."mutationOwnerId" IS NOT NULL
       AND NEW."mutationOwnerId" = OLD."mutationOwnerId"
       AND OLD."state" IN ('setup_pending', 'unknown_auth_state', 'workflow_update_required')
       AND NEW."state" = 'workflow_update_required'
       AND NEW."latestGeneration" = OLD."latestGeneration"
       AND NEW."latestGenerationHash" IS NOT DISTINCT FROM OLD."latestGenerationHash"
       AND NEW."activeLeaseId" IS NOT DISTINCT FROM OLD."activeLeaseId"
       AND NEW."activeLeaseExpiresAt" IS NOT DISTINCT FROM OLD."activeLeaseExpiresAt"
       AND NEW."activeSecretNamespaceId" IS NOT DISTINCT FROM OLD."activeSecretNamespaceId"
       AND NEW."activeSecretNamespaceEpoch" IS NOT DISTINCT FROM OLD."activeSecretNamespaceEpoch"
       AND NEW."activeSecretNamespaceName" IS NOT DISTINCT FROM OLD."activeSecretNamespaceName"
       AND NEW."activeAccountIdentityHash" IS NOT DISTINCT FROM OLD."activeAccountIdentityHash")
      OR
      (NEW."mutationEpoch" = OLD."mutationEpoch"
       AND OLD."mutationOwner" = 'runtime'
       AND NEW."mutationOwner" = 'runtime'
       AND OLD."mutationOwnerId" IS NOT NULL
       AND NEW."mutationOwnerId" = NEW."activeLeaseId"
       AND NEW."latestGeneration" = OLD."latestGeneration"
       AND NEW."latestGenerationHash" IS NOT DISTINCT FROM OLD."latestGenerationHash"
       AND NEW."activeSecretNamespaceId" IS NOT DISTINCT FROM OLD."activeSecretNamespaceId"
       AND NEW."activeSecretNamespaceEpoch" IS NOT DISTINCT FROM OLD."activeSecretNamespaceEpoch"
       AND NEW."activeSecretNamespaceName" IS NOT DISTINCT FROM OLD."activeSecretNamespaceName"
       AND NEW."activeAccountIdentityHash" IS NOT DISTINCT FROM OLD."activeAccountIdentityHash")
    ) THEN
      RAISE EXCEPTION 'codex_oauth_provider_mutation_fence_required' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Every pre-versioned provider must pass through an explicit recovery
-- decision before it can issue another runtime lease. The old fixed secret
-- can still receive a delayed PUT, but V4 will never reference it after the
-- newly allocated R/P/E namespace is activated.
UPDATE "CodexOAuthProviderInstance"
SET "state" = 'unknown_auth_state',
    "activeLeaseId" = NULL,
    "activeLeaseExpiresAt" = NULL,
    "mutationEpoch" = "mutationEpoch" + 1,
    "mutationOwner" = 'recovery',
    "mutationOwnerId" = 'versioned-namespace-cutover:' || "id",
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "activeSecretNamespaceId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "CodexOAuthProviderIdentityQuarantine" q
    WHERE q."providerInstanceRowId" = "CodexOAuthProviderInstance"."id"
      AND q."resolvedAt" IS NULL
  );

-- Stable-name metadata checks performed before the versioned cutover are not
-- evidence of an authorized claim/attempt/namespace activation chain.
UPDATE "ProviderSetupState"
SET "state" = 'stale_or_invalid',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "providerKind" = 'codex'
  AND "authMode" = 'codex_subscription_oauth_rotating'
  AND "state" = 'configured';

CREATE OR REPLACE FUNCTION "codex_oauth_secret_namespace_tombstone_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE initial_authority_matches BOOLEAN := FALSE;
DECLARE promotion_evidence_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthProviderInstance" provider
      JOIN "RepositoryConnection" repository ON repository."id" = provider."repositoryId"
      WHERE provider."id" = NEW."providerInstanceRowId"
        AND repository."githubRepositoryId"::text = NEW."githubRepositoryId"
        AND provider."mutationOwner" IN ('setup','runtime')
        AND provider."mutationOwnerId" IS NOT NULL
    ) INTO initial_authority_matches;
    IF NEW."status" <> 'dispatch_authorized' OR NEW."permanentlyRetired"
       OR NEW."confirmedAt" IS NOT NULL OR NEW."activatedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL
       OR NEW."workflowPath" IS NOT NULL OR NEW."workflowSourceCommitSha" IS NOT NULL
       OR NEW."workflowSourceBlobSha" IS NOT NULL OR NEW."workflowSourceSha256" IS NOT NULL
       OR NEW."workflowSemanticSha256" IS NOT NULL OR NEW."workflowSourceTrust" IS NOT NULL
       OR NEW."attestedRepositoryId" IS NOT NULL OR NOT initial_authority_matches
    THEN RAISE EXCEPTION 'codex_oauth_secret_namespace_initial_state_invalid' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_secret_namespace_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'dispatch_authorized' AND NEW."status" = 'confirmed_candidate' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupDispatchAttempt" attempt
      JOIN "CodexOAuthSetupPayloadClaim" claim ON claim."id" = attempt."claimId"
      WHERE attempt."namespaceId" = OLD."id" AND attempt."status" = 'confirmed'
        AND claim."providerInstanceRowId" = OLD."providerInstanceRowId"
        AND claim."status" = 'prepared'
        AND claim."databaseRecoveryWitness" = OLD."databaseRecoveryWitness"
    ) INTO promotion_evidence_matches;
    -- Runtime namespaces are instead proved by their exact pending intent.
    IF NOT promotion_evidence_matches THEN
      SELECT EXISTS (
        SELECT 1 FROM "CodexOAuthWritebackIntent" intent
        WHERE intent."secretNamespaceId" = OLD."id" AND intent."status" = 'pending'
          AND intent."providerResponseCode" IN (201,204) AND intent."providerConfirmedAt" IS NOT NULL
          AND intent."databaseRecoveryWitness" = OLD."databaseRecoveryWitness"
      ) INTO promotion_evidence_matches;
    END IF;
  ELSIF OLD."status" = 'confirmed_candidate' AND NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupDispatchAttempt" attempt
      JOIN "CodexOAuthSetupPayloadClaim" claim ON claim."confirmedAttemptId" = attempt."id"
      JOIN "CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
      WHERE attempt."namespaceId" = OLD."id" AND attempt."status" = 'confirmed'
        AND claim."status" = 'confirmed_candidate' AND provider."mutationOwner" = 'setup'
        AND provider."mutationOwnerId" = claim."manifestId"
    ) INTO promotion_evidence_matches;
    IF NOT promotion_evidence_matches THEN
      SELECT EXISTS (
        SELECT 1 FROM "CodexOAuthWritebackIntent" intent
        JOIN "CodexOAuthProviderInstance" provider ON provider."id" = intent."providerInstanceRowId"
        WHERE intent."secretNamespaceId" = OLD."id" AND intent."status" = 'pending'
          AND intent."providerResponseCode" IN (201,204) AND intent."providerConfirmedAt" IS NOT NULL
          AND provider."mutationOwner" = 'runtime' AND provider."mutationOwnerId" = intent."leaseId"
          AND provider."mutationEpoch" = intent."mutationEpoch"
      ) INTO promotion_evidence_matches;
    END IF;
  ELSE
    promotion_evidence_matches := TRUE;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."providerInstanceRowId" IS DISTINCT FROM OLD."providerInstanceRowId"
     OR NEW."githubRepositoryId" IS DISTINCT FROM OLD."githubRepositoryId"
     OR NEW."namespaceEpoch" IS DISTINCT FROM OLD."namespaceEpoch"
     OR NEW."secretName" IS DISTINCT FROM OLD."secretName"
     OR NEW."databaseRecoveryWitness" IS DISTINCT FROM OLD."databaseRecoveryWitness"
     OR (NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" AND NOT (
       OLD."confirmedAt" IS NULL AND NEW."confirmedAt" IS NOT NULL
       AND OLD."status" = 'dispatch_authorized' AND NEW."status" = 'confirmed_candidate'
     ))
     OR (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt")
     OR ((NEW."workflowPath" IS DISTINCT FROM OLD."workflowPath"
       OR NEW."workflowSourceCommitSha" IS DISTINCT FROM OLD."workflowSourceCommitSha"
       OR NEW."workflowSourceBlobSha" IS DISTINCT FROM OLD."workflowSourceBlobSha"
       OR NEW."workflowSourceSha256" IS DISTINCT FROM OLD."workflowSourceSha256"
       OR NEW."workflowSemanticSha256" IS DISTINCT FROM OLD."workflowSemanticSha256"
       OR NEW."workflowSourceTrust" IS DISTINCT FROM OLD."workflowSourceTrust"
       OR NEW."attestedRepositoryId" IS DISTINCT FROM OLD."attestedRepositoryId"
       OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt")
       AND NOT (OLD."status" = 'confirmed_candidate' AND NEW."status" = 'active'))
     OR (OLD."status" = 'active' AND (
       NEW."workflowPath" IS DISTINCT FROM OLD."workflowPath"
       OR NEW."workflowSourceCommitSha" IS DISTINCT FROM OLD."workflowSourceCommitSha"
       OR NEW."workflowSourceBlobSha" IS DISTINCT FROM OLD."workflowSourceBlobSha"
       OR NEW."workflowSourceSha256" IS DISTINCT FROM OLD."workflowSourceSha256"
       OR NEW."workflowSemanticSha256" IS DISTINCT FROM OLD."workflowSemanticSha256"
       OR NEW."workflowSourceTrust" IS DISTINCT FROM OLD."workflowSourceTrust"
       OR NEW."attestedRepositoryId" IS DISTINCT FROM OLD."attestedRepositoryId"
       OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
     ))
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'dispatch_authorized' AND NEW."status" IN ('confirmed_candidate','retired_predispatch','retired_ambiguous')
         AND (NEW."status" <> 'confirmed_candidate' OR promotion_evidence_matches))
       OR (OLD."status" = 'confirmed_candidate' AND NEW."status" IN ('active','retired_ambiguous')
         AND (NEW."status" <> 'active' OR promotion_evidence_matches))
       OR (OLD."status" = 'active' AND NEW."status" = 'retired_superseded')
     ))
     OR (OLD."permanentlyRetired" AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'codex_oauth_secret_namespace_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthSecretNamespace_tombstone_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthSecretNamespace"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_secret_namespace_tombstone_guard"();

CREATE OR REPLACE FUNCTION "codex_oauth_setup_claim_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE promotion_evidence_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'prepared' OR NEW."confirmedAttemptId" IS NOT NULL
       OR NEW."confirmedAt" IS NOT NULL OR NEW."activatedAt" IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM "CodexOAuthSetupManifest" manifest
         JOIN "CodexOAuthProviderInstance" provider ON provider."id" = manifest."providerInstanceRowId"
         JOIN "RepositoryConnection" repository ON repository."id" = manifest."repositoryId"
         WHERE manifest."id" = NEW."manifestId"
           AND manifest."providerInstanceRowId" = NEW."providerInstanceRowId"
           AND manifest."workspaceId" = NEW."workspaceId"
           AND manifest."repositoryId" = NEW."repositoryId"
           AND repository."githubRepositoryId"::text = NEW."githubRepositoryId"
           AND manifest."status" = 'fetched'
           AND manifest."mutationEpoch" = NEW."recoveryEpoch"
           AND manifest."databaseRecoveryWitness" = NEW."databaseRecoveryWitness"
           AND provider."mutationOwner" = 'setup'
           AND provider."mutationOwnerId" = manifest."id"
           AND provider."mutationEpoch" = manifest."mutationEpoch"
       )
    THEN RAISE EXCEPTION 'codex_oauth_setup_claim_initial_state_invalid' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_setup_claim_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'prepared' AND NEW."status" = 'confirmed_candidate' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupDispatchAttempt" attempt
      JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
      WHERE attempt."id" = NEW."confirmedAttemptId" AND attempt."claimId" = OLD."id"
        AND attempt."status" = 'confirmed' AND namespace."status" = 'confirmed_candidate'
        AND namespace."providerInstanceRowId" = OLD."providerInstanceRowId"
        AND namespace."databaseRecoveryWitness" = OLD."databaseRecoveryWitness"
    ) INTO promotion_evidence_matches;
  ELSIF OLD."status" = 'confirmed_candidate' AND NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupDispatchAttempt" attempt
      JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
      JOIN "CodexOAuthProviderInstance" provider ON provider."id" = OLD."providerInstanceRowId"
      WHERE attempt."id" = OLD."confirmedAttemptId" AND attempt."status" = 'confirmed'
        AND namespace."status" = 'active' AND provider."state" = 'active'
        AND provider."activeSecretNamespaceId" = namespace."id"
        AND provider."activeAccountIdentityHash" = OLD."accountIdentityHash"
    ) INTO promotion_evidence_matches;
  ELSE
    promotion_evidence_matches := TRUE;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."providerInstanceRowId" IS DISTINCT FROM OLD."providerInstanceRowId"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId"
     OR NEW."githubRepositoryId" IS DISTINCT FROM OLD."githubRepositoryId"
     OR NEW."manifestId" IS DISTINCT FROM OLD."manifestId"
     OR NEW."manifestDigest" IS DISTINCT FROM OLD."manifestDigest"
     OR NEW."recoveryRequestId" IS DISTINCT FROM OLD."recoveryRequestId"
     OR NEW."recoveryEpoch" IS DISTINCT FROM OLD."recoveryEpoch"
     OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
     OR NEW."payloadVersion" IS DISTINCT FROM OLD."payloadVersion"
     OR NEW."canonicalizationVersion" IS DISTINCT FROM OLD."canonicalizationVersion"
     OR NEW."generationHash" IS DISTINCT FROM OLD."generationHash"
     OR NEW."accountIdentityHash" IS DISTINCT FROM OLD."accountIdentityHash"
     OR NEW."accountIdentityAlgorithm" IS DISTINCT FROM OLD."accountIdentityAlgorithm"
     OR NEW."authByteSize" IS DISTINCT FROM OLD."authByteSize"
     OR NEW."installerVersion" IS DISTINCT FROM OLD."installerVersion"
     OR NEW."installerDigest" IS DISTINCT FROM OLD."installerDigest"
     OR NEW."databaseIncarnation" IS DISTINCT FROM OLD."databaseIncarnation"
     OR NEW."databaseRecoveryWitness" IS DISTINCT FROM OLD."databaseRecoveryWitness"
     OR NEW."claimVersion" IS DISTINCT FROM OLD."claimVersion"
     OR NEW."prepareReplayExpiresAt" IS DISTINCT FROM OLD."prepareReplayExpiresAt"
     OR NEW."recoveryExpiresAt" IS DISTINCT FROM OLD."recoveryExpiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."confirmedAttemptId" IS DISTINCT FROM OLD."confirmedAttemptId" AND NOT (
       OLD."confirmedAttemptId" IS NULL AND NEW."confirmedAttemptId" IS NOT NULL
       AND OLD."status" = 'prepared' AND NEW."status" = 'confirmed_candidate'
     ))
     OR (NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" AND NOT (
       OLD."confirmedAt" IS NULL AND NEW."confirmedAt" IS NOT NULL
       AND OLD."status" = 'prepared' AND NEW."status" = 'confirmed_candidate'
     ))
     OR (NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" AND NOT (
       OLD."activatedAt" IS NULL AND NEW."activatedAt" IS NOT NULL
       AND OLD."status" = 'confirmed_candidate' AND NEW."status" = 'active'
     ))
     OR (OLD."confirmedAttemptId" IS NOT NULL AND NEW."confirmedAttemptId" IS DISTINCT FROM OLD."confirmedAttemptId")
     OR (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt")
     OR (OLD."activatedAt" IS NOT NULL AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt")
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'prepared' AND NEW."status" IN ('confirmed_candidate','superseded_predispatch')
         AND (NEW."status" <> 'confirmed_candidate' OR promotion_evidence_matches))
       OR (OLD."status" = 'confirmed_candidate' AND NEW."status" IN ('active','retired_confirmed')
         AND (NEW."status" <> 'active' OR promotion_evidence_matches))
       OR (OLD."status" = 'active' AND NEW."status" = 'retired_active')
     ))
     OR (OLD."status" IN ('superseded_predispatch','retired_confirmed','retired_active')
         AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'codex_oauth_setup_claim_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthSetupPayloadClaim_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthSetupPayloadClaim"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_setup_claim_evidence_guard"();

-- Provider writes must serialize against repository identity changes. Elevate
-- only this trigger guard, pin name resolution, schema-qualify protected reads,
-- and keep direct execution unavailable. In production the canonical release
-- caller owns the catalog, so its implicit owner privileges must not be narrowed.
CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE repository_record RECORD;
DECLARE identity_changed BOOLEAN := FALSE;
DECLARE repair_allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    identity_changed :=
      NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR
      NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId" OR
      NEW."providerInstanceId" IS DISTINCT FROM OLD."providerInstanceId" OR
      NEW."authMode" IS DISTINCT FROM OLD."authMode" OR
      NEW."secretName" IS DISTINCT FROM OLD."secretName";
    repair_allowed := identity_changed
      AND OLD."mutationOwner" = 'recovery'
      AND EXISTS (
        SELECT 1 FROM public."CodexOAuthProviderIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = OLD."id" AND q."resolvedAt" IS NULL
      );
    IF identity_changed AND NOT repair_allowed THEN
      RAISE EXCEPTION 'codex_oauth_provider_identity_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "workspaceId", "provider", "githubRepositoryId" INTO repository_record
  FROM public."RepositoryConnection" WHERE "id" = NEW."repositoryId" FOR SHARE;
  IF NOT FOUND OR repository_record."provider"::text <> 'github'
     OR repository_record."githubRepositoryId" IS NULL
     OR NEW."workspaceId" <> repository_record."workspaceId"
     OR NEW."providerInstanceId" <> 'codex-rotating:' || repository_record."githubRepositoryId"::text
     OR NEW."authMode" <> 'codex_subscription_oauth_rotating'
     OR NEW."secretName" <> 'REVIEWROUTER_CODEX_AUTH_JSON'
  THEN RAISE EXCEPTION 'codex_oauth_provider_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A forced recovery may attach an unresolved terminal writeback to its exact
-- recovery request after the provider epoch advances. All other stale child
-- mutations remain rejected by the original fence contract. This guard stays
-- security-invoker because its locked parent is itself runtime-writable; it
-- needs no elevated access.
CREATE OR REPLACE FUNCTION "codex_oauth_child_identity_fence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p RECORD;
DECLARE lease_record RECORD;
DECLARE was_active BOOLEAN := FALSE;
DECLARE is_active BOOLEAN := FALSE;
DECLARE row_changed BOOLEAN := TRUE;
DECLARE owner_matches BOOLEAN := FALSE;
DECLARE recovery_resolution_matches BOOLEAN := FALSE;
BEGIN
  SELECT * INTO p FROM "CodexOAuthProviderInstance"
  WHERE "id" = NEW."providerInstanceRowId" FOR SHARE;
  IF NOT FOUND OR NEW."providerInstanceId" <> p."providerInstanceId" THEN
    RAISE EXCEPTION 'codex_oauth_child_provider_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('CodexOAuthLease', 'CodexOAuthSetupManifest') AND (
    to_jsonb(NEW)->>'workspaceId' <> p."workspaceId" OR
    to_jsonb(NEW)->>'repositoryId' <> p."repositoryId"
  ) THEN RAISE EXCEPTION 'codex_oauth_child_natural_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'CodexOAuthSetupManifest' AND TG_OP = 'INSERT' AND (
    to_jsonb(NEW)->>'status' <> 'issued'
    OR to_jsonb(NEW)->>'lastFetchedAt' IS NOT NULL
    OR to_jsonb(NEW)->>'consumedAt' IS NOT NULL
    OR to_jsonb(NEW)->>'confirmationJson' IS NOT NULL
    OR to_jsonb(NEW)->>'payloadVersion' IS NOT NULL
    OR to_jsonb(NEW)->>'payloadGenerationHash' IS NOT NULL
    OR to_jsonb(NEW)->>'payloadAccountFingerprint' IS NOT NULL
    OR to_jsonb(NEW)->>'payloadByteSize' IS NOT NULL
    OR to_jsonb(NEW)->>'payloadClaimedAt' IS NOT NULL
    OR to_jsonb(NEW)->>'recoveryExpiresAt' IS NOT NULL
    OR to_jsonb(NEW)->>'mutationEpoch' IS NULL
    OR p."mutationOwner" <> 'setup' OR p."mutationOwnerId" <> to_jsonb(NEW)->>'id'
    OR p."mutationEpoch"::text <> to_jsonb(NEW)->>'mutationEpoch'
    OR p."providerInstanceId" <> to_jsonb(NEW)->>'providerInstanceId'
  ) THEN
    RAISE EXCEPTION 'codex_oauth_setup_manifest_initial_state_invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'CodexOAuthWritebackIntent' THEN
    SELECT "providerInstanceRowId", "providerInstanceId", "mutationEpoch" INTO lease_record
    FROM "CodexOAuthLease" WHERE "id" = NEW."leaseId";
    IF NOT FOUND OR lease_record."providerInstanceRowId" <> NEW."providerInstanceRowId"
       OR lease_record."providerInstanceId" <> NEW."providerInstanceId"
    THEN RAISE EXCEPTION 'codex_oauth_child_lease_ownership_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'CodexOAuthSetupManifest' THEN
    IF TG_OP = 'UPDATE' AND
       to_jsonb(NEW)->>'databaseRecoveryWitness' IS DISTINCT FROM
       to_jsonb(OLD)->>'databaseRecoveryWitness'
    THEN
      RAISE EXCEPTION 'codex_oauth_setup_manifest_recovery_witness_immutable' USING ERRCODE = '23514';
    END IF;
    is_active := NEW."status" IN ('issued', 'fetched');
    owner_matches := p."mutationOwner" = 'setup' AND p."mutationOwnerId" = NEW."id";
    IF TG_OP = 'UPDATE' THEN was_active := OLD."status" IN ('issued', 'fetched'); END IF;
  ELSIF TG_TABLE_NAME = 'CodexOAuthLease' THEN
    is_active := NEW."status" IN ('preleased', 'finalized');
    owner_matches := p."mutationOwner" = 'runtime'
      AND p."mutationOwnerId" IN (NEW."id", NEW."leaseKey");
    IF TG_OP = 'UPDATE' THEN was_active := OLD."status" IN ('preleased', 'finalized'); END IF;
  ELSE
    is_active := NEW."status" = 'pending';
    owner_matches := p."mutationOwner" = 'runtime' AND p."mutationOwnerId" = NEW."leaseId"
      AND lease_record."mutationEpoch" = p."mutationEpoch";
    IF TG_OP = 'UPDATE' THEN was_active := OLD."status" = 'pending'; END IF;
  END IF;

  IF TG_TABLE_NAME = 'CodexOAuthWritebackIntent' AND TG_OP = 'UPDATE'
     AND OLD."status" = 'remote_outcome_unknown'
     AND NEW."status" = 'remote_outcome_unknown'
     AND to_jsonb(OLD)->>'recoveryRequestRowId' IS NULL
     AND to_jsonb(NEW)->>'recoveryRequestRowId' IS NOT NULL
     AND p."mutationOwner" = 'recovery'
  THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupRecoveryRequest" recovery
      WHERE recovery."id" = to_jsonb(NEW)->>'recoveryRequestRowId'
        AND recovery."providerInstanceRowId" = p."id"
        AND recovery."mutationEpoch" = p."mutationEpoch"
        AND recovery."state" = 'active'
    ) INTO recovery_resolution_matches;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    row_changed := (to_jsonb(NEW) - 'mutationEpoch') IS DISTINCT FROM
      (to_jsonb(OLD) - 'mutationEpoch');
  END IF;
  IF NEW."mutationEpoch" IS NOT NULL AND NEW."mutationEpoch" <> p."mutationEpoch" THEN
    IF NOT (
      TG_OP = 'UPDATE' AND NEW."mutationEpoch" < p."mutationEpoch"
      AND ((was_active AND NOT is_active) OR recovery_resolution_matches)
    ) THEN
      RAISE EXCEPTION 'codex_oauth_child_mutation_epoch_mismatch' USING ERRCODE = '40001';
    END IF;
  ELSIF (is_active OR (TG_OP = 'UPDATE' AND was_active AND row_changed))
        AND (COALESCE(NEW."mutationEpoch", 0) <= 0 OR NOT owner_matches)
  THEN
    RAISE EXCEPTION 'codex_oauth_child_mutation_owner_mismatch' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "codex_oauth_setup_manifest_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE promotion_evidence_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_setup_manifest_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'issued' AND NEW."status" = 'fetched' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthProviderInstance" provider
      WHERE provider."id" = OLD."providerInstanceRowId"
        AND provider."mutationOwner" = 'setup' AND provider."mutationOwnerId" = OLD."id"
        AND provider."mutationEpoch" = OLD."mutationEpoch"
    ) AND NEW."lastFetchedAt" IS NOT NULL
      AND NEW."recoveryExpiresAt" IS NOT NULL
      INTO promotion_evidence_matches;
  ELSIF OLD."status" = 'fetched' AND NEW."status" = 'consumed' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupPayloadClaim" claim
      JOIN "CodexOAuthSetupDispatchAttempt" attempt ON attempt."id" = claim."confirmedAttemptId"
      JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
      JOIN "CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
      WHERE claim."manifestId" = OLD."id" AND claim."status" = 'active'
        AND attempt."claimId" = claim."id" AND attempt."status" = 'confirmed'
        AND namespace."status" = 'active'
        AND provider."activeSecretNamespaceId" = namespace."id"
        AND provider."activeAccountIdentityHash" = claim."accountIdentityHash"
        AND claim."databaseRecoveryWitness" = OLD."databaseRecoveryWitness"
    ) AND NEW."consumedAt" IS NOT NULL INTO promotion_evidence_matches;
  ELSIF OLD."status" IN ('issued','fetched') AND NEW."status" = 'recovered' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupRecoveryRequest" recovery
      JOIN "CodexOAuthProviderInstance" provider
        ON provider."id" = recovery."providerInstanceRowId"
      WHERE recovery."providerInstanceRowId" = OLD."providerInstanceRowId"
        AND recovery."recoveryRequestId" = NEW."confirmationJson"->>'recoveryRequestId'
        AND recovery."state" = 'active'
        AND provider."mutationOwner" = 'recovery'
        AND provider."mutationOwnerId" = 'setup-recovery:' || recovery."recoveryRequestId"
        AND provider."mutationEpoch" = recovery."mutationEpoch"
        AND NEW."confirmationJson"->>'acknowledgedSecretMayHaveChanged' = 'true'
        AND NEW."confirmationJson"->>'recoveryEpoch' = recovery."mutationEpoch"::text
    ) AND NEW."consumedAt" IS NOT NULL INTO promotion_evidence_matches;
  ELSIF OLD."status" = 'issued' AND NEW."status" IN ('expired','superseded') THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthProviderInstance" provider
      WHERE provider."id" = OLD."providerInstanceRowId"
        AND provider."mutationEpoch" >= OLD."mutationEpoch"
    ) INTO promotion_evidence_matches;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT promotion_evidence_matches THEN
    RAISE EXCEPTION 'codex_oauth_setup_manifest_promotion_evidence_invalid' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('consumed','expired','superseded','recovered') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'codex_oauth_setup_manifest_terminal_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthSetupManifest_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthSetupManifest"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_setup_manifest_evidence_guard"();

CREATE OR REPLACE FUNCTION "codex_oauth_setup_recovery_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest_authority_matches BOOLEAN := FALSE;
DECLARE completion_authority_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'active'
       OR NEW."latestManifestId" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM "CodexOAuthProviderInstance" provider
         WHERE provider."id" = NEW."providerInstanceRowId"
           AND provider."mutationOwner" = 'recovery'
           AND provider."mutationOwnerId" = 'setup-recovery:' || NEW."recoveryRequestId"
           AND provider."mutationEpoch" = NEW."mutationEpoch"
       )
    THEN
      RAISE EXCEPTION 'codex_oauth_setup_recovery_initial_state_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_setup_recovery_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF NEW."latestManifestId" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupManifest" manifest
      WHERE manifest."id" = NEW."latestManifestId"
        AND manifest."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND manifest."mutationEpoch" = NEW."mutationEpoch" + 1
        AND manifest."databaseRecoveryWitness" IS NOT DISTINCT FROM
            NEW."databaseRecoveryWitness"
    ) INTO manifest_authority_matches;
  END IF;
  IF OLD."state" = 'manifest_issued' AND NEW."state" = 'completed' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "CodexOAuthSetupManifest" manifest
      JOIN "CodexOAuthSetupPayloadClaim" claim
        ON claim."manifestId" = manifest."id"
      JOIN "CodexOAuthSetupDispatchAttempt" attempt
        ON attempt."id" = claim."confirmedAttemptId" AND attempt."claimId" = claim."id"
      JOIN "CodexOAuthSecretNamespace" namespace
        ON namespace."id" = attempt."namespaceId"
      JOIN "CodexOAuthProviderInstance" provider
        ON provider."id" = manifest."providerInstanceRowId"
      WHERE manifest."id" = NEW."latestManifestId"
        AND manifest."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND manifest."mutationEpoch" = NEW."mutationEpoch" + 1
        AND manifest."status" = 'consumed' AND manifest."consumedAt" IS NOT NULL
        AND manifest."databaseRecoveryWitness" = NEW."databaseRecoveryWitness"
        AND claim."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND claim."recoveryRequestId" = NEW."recoveryRequestId"
        AND claim."recoveryEpoch" = manifest."mutationEpoch"
        AND claim."status" = 'active' AND claim."activatedAt" IS NOT NULL
        AND claim."databaseRecoveryWitness" = NEW."databaseRecoveryWitness"
        AND attempt."status" = 'confirmed' AND attempt."confirmedAt" IS NOT NULL
        AND namespace."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND namespace."status" = 'active' AND namespace."activatedAt" IS NOT NULL
        AND namespace."databaseRecoveryWitness" = NEW."databaseRecoveryWitness"
        AND provider."state" = 'active'
        AND provider."activeSecretNamespaceId" = namespace."id"
        AND provider."activeSecretNamespaceEpoch" = namespace."namespaceEpoch"
        AND provider."activeSecretNamespaceName" = namespace."secretName"
        AND provider."activeAccountIdentityHash" = claim."accountIdentityHash"
        AND provider."mutationOwner" IS NULL AND provider."mutationOwnerId" IS NULL
    ) INTO completion_authority_matches;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."providerInstanceRowId" IS DISTINCT FROM OLD."providerInstanceRowId"
     OR NEW."recoveryRequestId" IS DISTINCT FROM OLD."recoveryRequestId"
     OR NEW."actor" IS DISTINCT FROM OLD."actor"
     OR NEW."acknowledgement" IS DISTINCT FROM OLD."acknowledgement"
     OR NEW."mutationEpoch" IS DISTINCT FROM OLD."mutationEpoch"
     OR NEW."databaseRecoveryWitness" IS DISTINCT FROM OLD."databaseRecoveryWitness"
     OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
     OR (NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
       (OLD."state" = 'active' AND NEW."state" = 'manifest_issued'
        AND OLD."latestManifestId" IS NULL
        AND NEW."latestManifestId" IS NOT NULL
        AND NEW."completedAt" IS NULL
        AND manifest_authority_matches)
       OR (OLD."state" = 'manifest_issued' AND NEW."state" = 'completed'
       AND NEW."latestManifestId" = OLD."latestManifestId"
        AND NEW."completedAt" IS NOT NULL
        AND manifest_authority_matches AND completion_authority_matches)
       OR (OLD."state" IN ('active','manifest_issued') AND NEW."state" = 'superseded'
        AND NEW."latestManifestId" IS NOT DISTINCT FROM OLD."latestManifestId"
        AND NEW."completedAt" IS NOT NULL)
     ))
     OR (NEW."state" = 'active'
         AND (NEW."latestManifestId" IS NOT NULL OR NEW."completedAt" IS NOT NULL))
     OR (NEW."state" = 'manifest_issued'
         AND (NEW."latestManifestId" IS NULL OR NEW."completedAt" IS NOT NULL
              OR NOT manifest_authority_matches))
    OR (NEW."state" = 'completed'
         AND (NEW."latestManifestId" IS NULL OR NEW."completedAt" IS NULL
              OR NOT manifest_authority_matches OR NOT completion_authority_matches))
     OR (NEW."state" = OLD."state" AND (
         NEW."latestManifestId" IS DISTINCT FROM OLD."latestManifestId"
         OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"))
     OR (OLD."state" IN ('completed', 'superseded') AND (
         NEW."state" IS DISTINCT FROM OLD."state"
         OR NEW."latestManifestId" IS DISTINCT FROM OLD."latestManifestId"
         OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"))
  THEN
    RAISE EXCEPTION 'codex_oauth_setup_recovery_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthSetupRecoveryRequest_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthSetupRecoveryRequest"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_setup_recovery_evidence_guard"();

-- Provider success is not ordinary relational data. The application login may
-- stage pending work, but it cannot mint an effect receipt without a signature
-- from the isolated effect-authority login. The signature is bound to the
-- runtime role, backend, transaction, effect, owner, and effect code, so it is
-- neither transferable nor replayable. Runtime and effect-authority roles have
-- no access to the signing key or receipt tables.
CREATE TABLE "CodexOAuthDatabaseAuthorityKey" (
  "singleton" BOOLEAN NOT NULL DEFAULT TRUE,
  "keyMaterial" TEXT NOT NULL DEFAULT (
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  ),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodexOAuthDatabaseAuthorityKey_pkey" PRIMARY KEY ("singleton"),
  CONSTRAINT "CodexOAuthDatabaseAuthorityKey_singleton_check" CHECK ("singleton")
);

INSERT INTO "CodexOAuthDatabaseAuthorityKey" ("singleton") VALUES (TRUE);

CREATE TABLE "CodexOAuthDatabaseAuthorityReceipt" (
  "databaseRole" TEXT NOT NULL,
  "backendPid" INTEGER NOT NULL,
  "transactionId" BIGINT NOT NULL,
  "effect" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "effectCode" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMPTZ(3),
  CONSTRAINT "CodexOAuthDatabaseAuthorityReceipt_pkey"
    PRIMARY KEY ("databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode")
);

CREATE FUNCTION "codex_oauth_database_authority_challenge"(
  target_effect TEXT,
  target_owner_id TEXT,
  target_effect_code INTEGER
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_array(
    session_user,
    pg_backend_pid(),
    txid_current(),
    target_effect,
    target_owner_id,
    target_effect_code
  )::text;
END
$$;

CREATE FUNCTION "codex_oauth_sign_database_authority"(
  target_challenge TEXT
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
BEGIN
  IF caller_role NOT IN ('reviewrouter_codex_effect_authority', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public."CodexOAuthDatabaseAuthorityKey"'::regclass))
  THEN
    RAISE EXCEPTION 'codex_oauth_database_effect_authority_role_forbidden' USING ERRCODE = '42501';
  END IF;
  IF target_challenge IS NULL OR octet_length(target_challenge) > 4096 THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_challenge_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey"
  WHERE "singleton" = TRUE;
  RETURN encode(sha256(convert_to(
    authority_key || chr(31) || target_challenge || chr(31) || authority_key,
    'UTF8'
  )), 'hex');
END $$;

CREATE FUNCTION "codex_oauth_authorize_setup_confirmation"(
  target_attempt_id TEXT,
  target_response_code INTEGER,
  target_signature TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
BEGIN
  IF caller_role NOT IN ('reviewrouter_web', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass))
  THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_role_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey"
  WHERE "singleton" = TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) || public."codex_oauth_database_authority_challenge"(
      'setup_confirmation', target_attempt_id, target_response_code
    ) || chr(31) || authority_key,
    'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid' USING ERRCODE = '42501';
  END IF;
  IF target_response_code NOT IN (201, 204) OR NOT EXISTS (
    SELECT 1
    FROM public."CodexOAuthSetupDispatchAttempt" attempt
    JOIN public."CodexOAuthSetupPayloadClaim" claim ON claim."id" = attempt."claimId"
    JOIN public."CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
    JOIN public."CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
    WHERE attempt."id" = target_attempt_id
      AND attempt."status" = 'dispatch_authorized'
      AND attempt."dispatchExpiresAt" > clock_timestamp()
      AND claim."status" = 'prepared'
      AND namespace."status" = 'dispatch_authorized'
      AND namespace."providerInstanceRowId" = claim."providerInstanceRowId"
      AND provider."mutationOwner" = 'setup'
      AND provider."mutationOwnerId" = claim."manifestId"
      AND provider."mutationEpoch" = claim."recoveryEpoch"
  ) THEN
    RAISE EXCEPTION 'codex_oauth_setup_confirmation_authority_invalid' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
    "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
  ) VALUES (
    caller_role, pg_backend_pid(), txid_current(), 'setup_confirmation', target_attempt_id, target_response_code
  )
  ON CONFLICT ("databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode")
  DO UPDATE SET "createdAt" = clock_timestamp(), "consumedAt" = NULL;
END $$;

CREATE FUNCTION "codex_oauth_authorize_runtime_confirmation"(
  target_intent_id TEXT,
  target_executor_owner TEXT,
  target_response_code INTEGER,
  target_signature TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
BEGIN
  IF caller_role NOT IN ('reviewrouter_api', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass))
  THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_role_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey"
  WHERE "singleton" = TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) || public."codex_oauth_database_authority_challenge"(
      'runtime_confirmation', target_intent_id, target_response_code
    ) || chr(31) || authority_key,
    'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid' USING ERRCODE = '42501';
  END IF;
  IF target_response_code NOT IN (201, 204) OR NOT EXISTS (
    SELECT 1
    FROM public."CodexOAuthWritebackIntent" intent
    JOIN public."CodexOAuthProviderInstance" provider ON provider."id" = intent."providerInstanceRowId"
    WHERE intent."id" = target_intent_id
      AND intent."status" = 'pending'
      AND intent."providerResponseCode" IS NULL
      AND intent."providerConfirmedAt" IS NULL
      AND intent."executorOwner" = target_executor_owner
      AND intent."executorLeaseExpiresAt" > clock_timestamp()
      AND provider."mutationOwner" = 'runtime'
      AND provider."mutationOwnerId" = intent."leaseId"
      AND provider."mutationEpoch" = intent."mutationEpoch"
  ) THEN
    RAISE EXCEPTION 'codex_oauth_runtime_confirmation_authority_invalid' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
    "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
  ) VALUES (
    caller_role, pg_backend_pid(), txid_current(), 'runtime_confirmation', target_intent_id, target_response_code
  )
  ON CONFLICT ("databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode")
  DO UPDATE SET "createdAt" = clock_timestamp(), "consumedAt" = NULL;
END $$;

CREATE FUNCTION "codex_oauth_authorize_runtime_completion"(
  target_intent_id TEXT,
  target_signature TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
BEGIN
  IF caller_role NOT IN ('reviewrouter_api', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass))
  THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_role_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey"
  WHERE "singleton" = TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) || public."codex_oauth_database_authority_challenge"(
      'runtime_completion', target_intent_id, 0
    ) || chr(31) || authority_key,
    'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."CodexOAuthWritebackIntent" intent
    JOIN public."CodexOAuthProviderInstance" provider ON provider."id" = intent."providerInstanceRowId"
    JOIN public."CodexOAuthLease" lease ON lease."id" = intent."leaseId"
    WHERE intent."id" = target_intent_id
      AND intent."status" = 'pending'
      AND lease."providerInstanceRowId" = intent."providerInstanceRowId"
      AND provider."mutationOwner" = 'runtime'
      AND provider."mutationOwnerId" = intent."leaseId"
      AND provider."mutationEpoch" = intent."mutationEpoch"
      AND (
        (intent."providerResponseCode" IN (201, 204)
         AND intent."providerConfirmedAt" IS NOT NULL
         AND intent."executorOwner" IS NOT NULL
         AND intent."executorLeaseExpiresAt" > clock_timestamp())
        OR
        (intent."dispatchAttemptId" IS NULL
         AND intent."secretNamespaceId" IS NULL
         AND intent."providerResponseCode" IS NULL
         AND intent."providerConfirmedAt" IS NULL)
      )
  ) THEN
    RAISE EXCEPTION 'codex_oauth_runtime_completion_authority_invalid' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
    "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
  ) VALUES (
    caller_role, pg_backend_pid(), txid_current(), 'runtime_completion', target_intent_id, 0
  )
  ON CONFLICT ("databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode")
  DO UPDATE SET "createdAt" = clock_timestamp(), "consumedAt" = NULL;
END $$;

CREATE FUNCTION "codex_oauth_consume_database_authority"(
  target_effect TEXT,
  target_owner_id TEXT,
  target_effect_code INTEGER
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE consumed_count INTEGER;
BEGIN
  UPDATE public."CodexOAuthDatabaseAuthorityReceipt"
  SET "consumedAt" = clock_timestamp()
  WHERE "databaseRole" = session_user
    AND "backendPid" = pg_backend_pid()
    AND "transactionId" = txid_current()
    AND "effect" = target_effect
    AND "ownerId" = target_owner_id
    AND "effectCode" = target_effect_code
    AND "consumedAt" IS NULL;
  GET DIAGNOSTICS consumed_count = ROW_COUNT;
  RETURN consumed_count = 1;
END $$;

CREATE OR REPLACE FUNCTION "codex_oauth_setup_attempt_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE promotion_evidence_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'dispatch_authorized' OR NEW."definiteResponseCode" IS NOT NULL
       OR NEW."confirmedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM "CodexOAuthSetupPayloadClaim" claim
         JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = NEW."namespaceId"
         JOIN "CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
         WHERE claim."id" = NEW."claimId" AND claim."status" = 'prepared'
           AND namespace."status" = 'dispatch_authorized'
           AND namespace."providerInstanceRowId" = claim."providerInstanceRowId"
           AND namespace."githubRepositoryId" = claim."githubRepositoryId"
           AND namespace."databaseRecoveryWitness" = claim."databaseRecoveryWitness"
           AND provider."mutationOwner" = 'setup' AND provider."mutationOwnerId" = claim."manifestId"
           AND provider."mutationEpoch" = claim."recoveryEpoch"
       )
    THEN RAISE EXCEPTION 'codex_oauth_setup_attempt_initial_state_invalid' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_setup_attempt_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'dispatch_authorized' AND NEW."status" = 'confirmed' THEN
    SELECT EXISTS (
      SELECT 1 FROM "CodexOAuthSetupPayloadClaim" claim
      JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = OLD."namespaceId"
      JOIN "CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
      WHERE claim."id" = OLD."claimId" AND claim."status" = 'prepared'
        AND namespace."status" = 'dispatch_authorized'
        AND provider."mutationOwner" = 'setup' AND provider."mutationOwnerId" = claim."manifestId"
        AND provider."mutationEpoch" = claim."recoveryEpoch"
    ) INTO promotion_evidence_matches;
    IF promotion_evidence_matches AND NOT "codex_oauth_consume_database_authority"(
      'setup_confirmation', OLD."id", NEW."definiteResponseCode"
    ) THEN
      RAISE EXCEPTION 'codex_oauth_database_authority_receipt_required' USING ERRCODE = '42501';
    END IF;
  ELSE
    promotion_evidence_matches := TRUE;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."claimId" IS DISTINCT FROM OLD."claimId"
     OR NEW."namespaceId" IS DISTINCT FROM OLD."namespaceId"
     OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."authorizedAt" IS DISTINCT FROM OLD."authorizedAt"
     OR NEW."dispatchExpiresAt" IS DISTINCT FROM OLD."dispatchExpiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."definiteResponseCode" IS DISTINCT FROM OLD."definiteResponseCode" AND NOT (
       OLD."definiteResponseCode" IS NULL AND NEW."definiteResponseCode" IN (201,204)
       AND OLD."status" = 'dispatch_authorized' AND NEW."status" = 'confirmed'
     ))
     OR (NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" AND NOT (
       OLD."confirmedAt" IS NULL AND NEW."confirmedAt" IS NOT NULL
       AND OLD."status" = 'dispatch_authorized' AND NEW."status" = 'confirmed'
     ))
     OR (NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" AND NOT (
       OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL
       AND ((OLD."status" = 'dispatch_authorized' AND NEW."status" = 'retired_ambiguous')
         OR (OLD."status" = 'confirmed' AND NEW."status" = 'retired_confirmed'))
     ))
     OR (OLD."definiteResponseCode" IS NOT NULL AND NEW."definiteResponseCode" IS DISTINCT FROM OLD."definiteResponseCode")
     OR (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt")
     OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       OLD."status" = 'dispatch_authorized' AND NEW."status" IN ('confirmed','retired_ambiguous')
         AND (NEW."status" <> 'confirmed' OR promotion_evidence_matches)
       OR (OLD."status" = 'confirmed' AND NEW."status" = 'retired_confirmed')
     ))
     OR (OLD."status" IN ('retired_ambiguous','retired_confirmed') AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'codex_oauth_setup_attempt_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION "codex_oauth_secret_namespace_tombstone_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_setup_claim_evidence_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_setup_attempt_evidence_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_setup_recovery_evidence_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_setup_manifest_evidence_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_repository_identity_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_provider_identity_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_provider_mutation_transition_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_child_identity_fence_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_child"(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_provider"(TEXT, BIGINT) FROM PUBLIC;

CREATE TRIGGER "CodexOAuthSetupDispatchAttempt_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthSetupDispatchAttempt"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_setup_attempt_evidence_guard"();

CREATE OR REPLACE FUNCTION "codex_oauth_runtime_writeback_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quarantine_repair_allowed BOOLEAN := FALSE;
DECLARE completion_evidence_matches BOOLEAN := FALSE;
DECLARE no_op_completion_evidence_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending'
       OR NEW."providerResponseCode" IS NOT NULL
       OR NEW."providerConfirmedAt" IS NOT NULL
       OR NEW."namespaceRetiredAt" IS NOT NULL
       OR NEW."completedAt" IS NOT NULL
       OR NEW."recoveryRequestRowId" IS NOT NULL
       OR NEW."recoveryResolvedAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'codex_oauth_runtime_writeback_initial_state_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_runtime_writeback_delete_forbidden' USING ERRCODE = '23514';
  END IF;
  IF OLD."providerResponseCode" IS NULL
     AND NEW."providerResponseCode" IN (201,204)
     AND OLD."providerConfirmedAt" IS NULL
     AND NEW."providerConfirmedAt" IS NOT NULL
     AND NOT "codex_oauth_consume_database_authority"(
       'runtime_confirmation', OLD."id", NEW."providerResponseCode"
     )
  THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_receipt_required' USING ERRCODE = '42501';
  END IF;
  IF NEW."leaseId" IS DISTINCT FROM OLD."leaseId"
     OR NEW."providerInstanceId" IS DISTINCT FROM OLD."providerInstanceId"
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM "CodexOAuthChildIdentityQuarantine" q
      JOIN "CodexOAuthProviderInstance" p
        ON p."id" = q."providerInstanceRowId"
      JOIN "CodexOAuthLease" replacement
        ON replacement."id" = NEW."leaseId"
      WHERE q."childKind" = 'writeback_intent'
        AND q."childId" = OLD."id"
        AND q."resolvedAt" IS NULL
        AND q."evidenceJson"->'child'->>'id' = OLD."id"
        AND q."evidenceJson"->'child'->>'leaseId' = OLD."leaseId"
        AND q."evidenceJson"->'child'->>'providerInstanceId' = OLD."providerInstanceId"
        AND p."id" = OLD."providerInstanceRowId"
        AND p."mutationOwner" = 'recovery'
        AND NEW."providerInstanceRowId" = OLD."providerInstanceRowId"
        AND NEW."providerInstanceId" = p."providerInstanceId"
        AND replacement."providerInstanceRowId" = p."id"
        AND replacement."providerInstanceId" = p."providerInstanceId"
    ) INTO quarantine_repair_allowed;
    IF NOT quarantine_repair_allowed THEN
      RAISE EXCEPTION 'codex_oauth_runtime_writeback_evidence_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" = 'completed' THEN
    IF NOT "codex_oauth_consume_database_authority"(
      'runtime_completion', OLD."id", 0
    ) THEN
      RAISE EXCEPTION 'codex_oauth_database_authority_receipt_required' USING ERRCODE = '42501';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM "CodexOAuthLease" lease
      JOIN "CodexOAuthSecretNamespace" namespace
        ON namespace."id" = NEW."secretNamespaceId"
      JOIN "CodexOAuthProviderInstance" provider
        ON provider."id" = NEW."providerInstanceRowId"
      WHERE lease."id" = NEW."leaseId"
        AND lease."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND lease."providerInstanceId" = NEW."providerInstanceId"
        AND lease."status" = 'completed'
        AND lease."secretNamespaceId" = NEW."secretNamespaceId"
        AND namespace."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND namespace."status" = 'active'
        AND provider."providerInstanceId" = NEW."providerInstanceId"
        AND provider."state" = 'active'
        AND provider."activeSecretNamespaceId" = NEW."secretNamespaceId"
        AND provider."mutationOwner" IS NULL
        AND provider."mutationOwnerId" IS NULL
    ) INTO completion_evidence_matches;
    SELECT EXISTS (
      SELECT 1
      FROM "CodexOAuthLease" lease
      JOIN "CodexOAuthProviderInstance" provider ON provider."id" = NEW."providerInstanceRowId"
      JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = provider."activeSecretNamespaceId"
      WHERE NEW."dispatchAttemptId" IS NULL AND NEW."secretNamespaceId" IS NULL
        AND OLD."dispatchAttemptId" IS NULL AND OLD."secretNamespaceId" IS NULL
        AND NEW."providerResponseCode" IS NULL AND NEW."providerConfirmedAt" IS NULL
        AND NEW."safeErrorCode" = 'unchanged_generation_positive_proof_v1'
        AND lease."id" = NEW."leaseId" AND lease."status" = 'completed'
        AND lease."providerInstanceRowId" = NEW."providerInstanceRowId"
        AND lease."providerInstanceId" = NEW."providerInstanceId"
        AND lease."restoredGenerationHash" = NEW."latestGenerationHash"
        AND lease."mutationEpoch" = NEW."mutationEpoch"
        AND lease."secretNamespaceId" = provider."activeSecretNamespaceId"
        AND lease."secretNamespaceEpoch" = provider."activeSecretNamespaceEpoch"
        AND provider."providerInstanceId" = NEW."providerInstanceId"
        AND provider."state" = 'active' AND provider."latestGeneration" = NEW."generation"
        AND provider."latestGenerationHash" = NEW."latestGenerationHash"
        AND provider."activeAccountIdentityHash" = NEW."accountIdentityHash"
        AND provider."mutationEpoch" = NEW."mutationEpoch" + 1
        AND provider."mutationOwner" IS NULL AND provider."mutationOwnerId" IS NULL
        AND namespace."status" = 'active'
        AND namespace."databaseRecoveryWitness" = NEW."databaseRecoveryWitness"
    ) INTO no_op_completion_evidence_matches;
  END IF;
  IF (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."providerInstanceRowId" IS DISTINCT FROM OLD."providerInstanceRowId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
       OR NEW."generation" IS DISTINCT FROM OLD."generation"
       OR NEW."latestGenerationHash" IS DISTINCT FROM OLD."latestGenerationHash"
       OR NEW."encryptedPayloadDigest" IS DISTINCT FROM OLD."encryptedPayloadDigest"
       OR NEW."keyId" IS DISTINCT FROM OLD."keyId"
       OR NEW."mutationEpoch" IS DISTINCT FROM OLD."mutationEpoch"
       OR NEW."dispatchAttemptId" IS DISTINCT FROM OLD."dispatchAttemptId"
       OR NEW."secretNamespaceId" IS DISTINCT FROM OLD."secretNamespaceId"
       OR NEW."dispatchAuthorizedAt" IS DISTINCT FROM OLD."dispatchAuthorizedAt"
       OR NEW."databaseIncarnation" IS DISTINCT FROM OLD."databaseIncarnation"
       OR NEW."databaseRecoveryWitness" IS DISTINCT FROM OLD."databaseRecoveryWitness"
       OR NEW."accountIdentityHash" IS DISTINCT FROM OLD."accountIdentityHash"
       OR NEW."accountIdentityAlgorithm" IS DISTINCT FROM OLD."accountIdentityAlgorithm"
       OR NEW."executorOwner" IS DISTINCT FROM OLD."executorOwner"
       OR NEW."executorLeaseExpiresAt" IS DISTINCT FROM OLD."executorLeaseExpiresAt"
       OR (NEW."providerResponseCode" IS DISTINCT FROM OLD."providerResponseCode" AND NOT (
         OLD."providerResponseCode" IS NULL AND NEW."providerResponseCode" IN (201,204)
         AND OLD."providerConfirmedAt" IS NULL AND NEW."providerConfirmedAt" IS NOT NULL
         AND OLD."status" = 'pending' AND NEW."status" = 'pending'
       ))
       OR (NEW."providerConfirmedAt" IS DISTINCT FROM OLD."providerConfirmedAt" AND NOT (
         OLD."providerConfirmedAt" IS NULL AND NEW."providerConfirmedAt" IS NOT NULL
         AND OLD."providerResponseCode" IS NULL AND NEW."providerResponseCode" IN (201,204)
         AND OLD."status" = 'pending' AND NEW."status" = 'pending'
       ))
       OR (NEW."completedAt" IS DISTINCT FROM OLD."completedAt" AND NOT (
         OLD."completedAt" IS NULL AND NEW."completedAt" IS NOT NULL
         AND OLD."status" = 'pending' AND NEW."status" IN ('completed','failed')
       ))
       OR (NEW."namespaceRetiredAt" IS DISTINCT FROM OLD."namespaceRetiredAt" AND NOT (
         OLD."namespaceRetiredAt" IS NULL AND NEW."namespaceRetiredAt" IS NOT NULL
         AND OLD."status" = 'pending' AND NEW."status" IN ('failed','remote_outcome_unknown')
       ))
       OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
         OLD."status" = 'pending' AND (
           (NEW."status" = 'completed'
            AND NEW."completedAt" IS NOT NULL
            AND (
              (OLD."providerResponseCode" IN (201,204)
               AND OLD."providerConfirmedAt" IS NOT NULL
               AND NEW."providerResponseCode" = OLD."providerResponseCode"
               AND NEW."providerConfirmedAt" = OLD."providerConfirmedAt"
               AND completion_evidence_matches)
              OR
              (OLD."providerResponseCode" IS NULL
               AND OLD."providerConfirmedAt" IS NULL
               AND NEW."providerResponseCode" IS NULL
               AND NEW."providerConfirmedAt" IS NULL
               AND no_op_completion_evidence_matches)
            ))
           OR NEW."status" IN ('failed','remote_outcome_unknown')
         )
       ))
       OR (NEW."safeErrorCode" IS DISTINCT FROM OLD."safeErrorCode" AND NOT (
         OLD."status" = 'pending' AND (
           (NEW."status" = 'pending'
             AND OLD."providerConfirmedAt" IS NULL AND NEW."providerConfirmedAt" IS NOT NULL
             AND NEW."providerResponseCode" IN (201,204))
           OR (NEW."status" = 'completed'
             AND NEW."safeErrorCode" = 'unchanged_generation_positive_proof_v1'
             AND no_op_completion_evidence_matches)
           OR NEW."status" IN ('failed','remote_outcome_unknown')
         )
       ))
       OR (OLD."recoveryRequestRowId" IS NOT NULL AND
           (NEW."recoveryRequestRowId" IS DISTINCT FROM OLD."recoveryRequestRowId" OR
            NEW."recoveryResolvedAt" IS DISTINCT FROM OLD."recoveryResolvedAt"))
       OR (OLD."status" IN ('completed','failed') AND NEW IS DISTINCT FROM OLD
           AND NOT quarantine_repair_allowed)
       OR (OLD."status" = 'remote_outcome_unknown' AND NOT (
         NEW."status" = 'remote_outcome_unknown'
         AND OLD."recoveryRequestRowId" IS NULL
         AND OLD."recoveryResolvedAt" IS NULL
         AND NEW."recoveryRequestRowId" IS NOT NULL
         AND NEW."recoveryResolvedAt" IS NOT NULL
         AND (to_jsonb(NEW) - ARRAY['recoveryRequestRowId','recoveryResolvedAt','updatedAt'])
             IS NOT DISTINCT FROM
             (to_jsonb(OLD) - ARRAY['recoveryRequestRowId','recoveryResolvedAt','updatedAt'])
       ))
  ) THEN
    RAISE EXCEPTION 'codex_oauth_runtime_writeback_evidence_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthWritebackIntent_runtime_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "CodexOAuthWritebackIntent"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_runtime_writeback_evidence_guard"();

REVOKE EXECUTE ON FUNCTION "codex_oauth_runtime_writeback_evidence_guard"() FROM PUBLIC;
REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityKey" FROM PUBLIC;
REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityReceipt" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_database_authority_challenge"(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_sign_database_authority"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_authorize_setup_confirmation"(TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_authorize_runtime_confirmation"(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_authorize_runtime_completion"(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_consume_database_authority"(TEXT, TEXT, INTEGER) FROM PUBLIC;

-- Runtime roles are provisioned before this migration in hosted environments.
-- Conditional grants keep self-hosted owner connections usable without
-- creating hosted identities as a side effect of schema migration.
DO $$
DECLARE runtime_role TEXT;
DECLARE runtime_table TEXT;
DECLARE owned_function REGPROCEDURE;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_release_migration') THEN
    FOR owned_function IN
      SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'codex_oauth_%'
    LOOP
      EXECUTE format(
        'ALTER FUNCTION %s OWNER TO reviewrouter_release_migration',
        owned_function
      );
    END LOOP;
  END IF;
  FOREACH runtime_role IN ARRAY ARRAY['reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
      FOR owned_function IN
        SELECT p.oid::regprocedure
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'codex_oauth_%'
      LOOP
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          owned_function,
          runtime_role
        );
      END LOOP;
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION "codex_oauth_database_authority_challenge"(TEXT, TEXT, INTEGER) TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION "codex_oauth_consume_database_authority"(TEXT, TEXT, INTEGER) TO %I',
        runtime_role
      );
      FOREACH runtime_table IN ARRAY ARRAY[
        'CodexOAuthChildIdentityQuarantine',
        'CodexOAuthLease',
        'CodexOAuthProviderIdentityQuarantine',
        'CodexOAuthProviderInstance',
        'CodexOAuthSecretNamespace',
        'CodexOAuthSetupDispatchAttempt',
        'CodexOAuthSetupManifest',
        'CodexOAuthSetupPayloadClaim',
        'CodexOAuthSetupRecoveryRequest',
        'CodexOAuthWritebackIntent'
      ] LOOP
        EXECUTE format('REVOKE DELETE ON TABLE %I FROM %I', runtime_table, runtime_role);
      END LOOP;
      EXECUTE format(
        'REVOKE ALL ON TABLE %I FROM %I',
        'CodexOAuthDatabaseAuthorityKey',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON TABLE %I FROM %I',
        'CodexOAuthDatabaseAuthorityReceipt',
        runtime_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_web') THEN
    GRANT EXECUTE ON FUNCTION "codex_oauth_authorize_setup_confirmation"(TEXT, INTEGER, TEXT) TO reviewrouter_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_api') THEN
    GRANT EXECUTE ON FUNCTION "codex_oauth_authorize_runtime_confirmation"(TEXT, TEXT, INTEGER, TEXT) TO reviewrouter_api;
    GRANT EXECUTE ON FUNCTION "codex_oauth_authorize_runtime_completion"(TEXT, TEXT) TO reviewrouter_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_codex_effect_authority') THEN
    GRANT USAGE ON SCHEMA public TO reviewrouter_codex_effect_authority;
    GRANT EXECUTE ON FUNCTION "codex_oauth_sign_database_authority"(TEXT) TO reviewrouter_codex_effect_authority;
    REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityKey" FROM reviewrouter_codex_effect_authority;
    REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityReceipt" FROM reviewrouter_codex_effect_authority;
  END IF;
END $$;

COMMIT;

-- Namespace tombstones are intentionally permanent. Deleting a GitHub secret
-- cannot make its name reusable because an unbounded delayed PUT can recreate it.
