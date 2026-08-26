BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "HostedCodexCommentTokenMintPurpose" AS ENUM ('initial', 'refresh');
CREATE TYPE "HostedCodexCommentTokenMintState" AS ENUM (
  'prepared', 'dispatching', 'issued', 'revoke_pending', 'outcome_unknown',
  'failed_no_token', 'revoked', 'expired'
);
CREATE TYPE "HostedCodexRuntimeClosureState" AS ENUM ('draining', 'complete');

CREATE TABLE "HostedCodexCommentTokenMint" (
  "id" TEXT NOT NULL,
  "purpose" "HostedCodexCommentTokenMintPurpose" NOT NULL,
  "state" "HostedCodexCommentTokenMintState" NOT NULL DEFAULT 'prepared',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "providerAttempt" SMALLINT NOT NULL DEFAULT 0,
  "ownerIdHash" TEXT NOT NULL,
  "fenceEpoch" BIGINT NOT NULL DEFAULT 1,
  "grantId" TEXT NOT NULL,
  "capabilityId" TEXT,
  "logicalKeyHash" TEXT NOT NULL,
  "requestFingerprintHash" TEXT NOT NULL,
  "requestIdHash" TEXT,
  "presentedTokenHash" TEXT,
  "runtimeAuthzEpoch" BIGINT NOT NULL,
  "runtimeGateRevision" BIGINT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "repositoryBindingId" TEXT NOT NULL,
  "bindingRevision" BIGINT NOT NULL,
  "bindingStateVersion" BIGINT NOT NULL,
  "poolId" TEXT NOT NULL,
  "poolRevision" BIGINT NOT NULL,
  "poolAuthzEpoch" BIGINT NOT NULL,
  "repositoryConnectionId" TEXT NOT NULL,
  "repositoryUpdatedAt" TIMESTAMP(3) NOT NULL,
  "githubInstallationRowId" TEXT NOT NULL,
  "installationUpdatedAt" TIMESTAMP(3) NOT NULL,
  "installationStatus" "GitHubInstallationStatus" NOT NULL,
  "installationSelection" TEXT NOT NULL,
  "installationWorkspaceId" TEXT NOT NULL,
  "githubInstallationId" BIGINT NOT NULL,
  "githubRepositoryId" BIGINT NOT NULL,
  "repositoryFullName" TEXT NOT NULL,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "dispatchAuthorizedUntil" TIMESTAMP(3),
  "dispatchStartedAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "deliveryClaimIdHash" TEXT,
  "deliveryClaimExpiresAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "unsafeUntil" TIMESTAMP(3),
  "tokenHash" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "secretCiphertext" BYTEA,
  "secretEncryptedDataKey" BYTEA,
  "secretIv" BYTEA,
  "secretAuthTag" BYTEA,
  "secretKeyId" TEXT,
  "secretAadHash" TEXT,
  "terminalEvidenceHash" TEXT,
  "revocationEvidenceHash" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexCommentTokenMint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexCommentTokenMint_grant_fkey" FOREIGN KEY ("grantId")
    REFERENCES "HostedCodexInvocationGrant"("id") ON DELETE RESTRICT,
  CONSTRAINT "HostedCodexCommentTokenMint_shape_check" CHECK (
    "revision" > 0 AND "providerAttempt" BETWEEN 0 AND 1 AND "fenceEpoch" > 0
    AND "runtimeAuthzEpoch" > 0 AND "runtimeGateRevision" > 0
    AND "bindingRevision" > 0 AND "bindingStateVersion" > 0
    AND "poolRevision" > 0 AND "poolAuthzEpoch" > 0
    AND "githubInstallationId" > 0 AND "githubRepositoryId" > 0
    AND "ownerIdHash" ~ '^[a-f0-9]{64}$'
    AND "logicalKeyHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprintHash" ~ '^[a-f0-9]{64}$'
    AND ("requestIdHash" IS NULL OR "requestIdHash" ~ '^[a-f0-9]{64}$')
    AND ("presentedTokenHash" IS NULL OR "presentedTokenHash" ~ '^[a-f0-9]{64}$')
    AND ("tokenHash" IS NULL OR "tokenHash" ~ '^[a-f0-9]{64}$')
    AND ("terminalEvidenceHash" IS NULL OR "terminalEvidenceHash" ~ '^[a-f0-9]{64}$')
    AND ("revocationEvidenceHash" IS NULL OR "revocationEvidenceHash" ~ '^[a-f0-9]{64}$')
    AND ("deliveryClaimIdHash" IS NULL OR "deliveryClaimIdHash" ~ '^[a-f0-9]{64}$')
    AND (("deliveryClaimIdHash" IS NULL) = ("deliveryClaimExpiresAt" IS NULL))
    AND ("dispatchAuthorizedUntil" IS NULL OR "unsafeUntil" IS NULL OR "dispatchAuthorizedUntil" <= "unsafeUntil")
    AND ("tokenExpiresAt" IS NULL OR "unsafeUntil" IS NULL OR "tokenExpiresAt" <= "unsafeUntil")
    AND (("purpose" = 'initial' AND "capabilityId" IS NULL AND "requestIdHash" IS NULL AND "presentedTokenHash" IS NULL)
      OR ("purpose" = 'refresh' AND "capabilityId" IS NOT NULL AND "requestIdHash" IS NOT NULL AND "presentedTokenHash" IS NOT NULL))
    AND (("secretCiphertext" IS NULL AND "secretEncryptedDataKey" IS NULL AND "secretIv" IS NULL
          AND "secretAuthTag" IS NULL AND "secretKeyId" IS NULL AND "secretAadHash" IS NULL)
      OR ("secretCiphertext" IS NOT NULL AND "secretEncryptedDataKey" IS NOT NULL AND "secretIv" IS NOT NULL
          AND "secretAuthTag" IS NOT NULL AND "secretKeyId" IS NOT NULL AND "secretAadHash" ~ '^[a-f0-9]{64}$'))
    AND (("state" = 'prepared' AND "providerAttempt" = 0 AND "dispatchStartedAt" IS NULL AND "tokenHash" IS NULL)
      OR ("state" = 'dispatching' AND "providerAttempt" = 1 AND "dispatchStartedAt" IS NOT NULL
          AND "dispatchAuthorizedUntil" IS NOT NULL AND "unsafeUntil" IS NOT NULL AND "tokenHash" IS NULL)
      OR ("state" = 'issued' AND "providerAttempt" = 1 AND "tokenHash" IS NOT NULL AND "tokenExpiresAt" IS NOT NULL
          AND "secretCiphertext" IS NOT NULL AND "capturedAt" IS NOT NULL AND "finalizedAt" IS NOT NULL)
      OR ("state" = 'revoke_pending' AND "providerAttempt" = 1 AND "tokenHash" IS NOT NULL AND "tokenExpiresAt" IS NOT NULL)
      OR ("state" = 'outcome_unknown' AND "providerAttempt" = 1 AND "unsafeUntil" IS NOT NULL)
      OR ("state" = 'failed_no_token' AND "tokenHash" IS NULL AND "completedAt" IS NOT NULL
          AND "terminalEvidenceHash" IS NOT NULL)
      OR ("state" = 'revoked' AND "completedAt" IS NOT NULL AND "revocationEvidenceHash" IS NOT NULL
          AND "secretCiphertext" IS NULL AND "secretEncryptedDataKey" IS NULL AND "secretIv" IS NULL
          AND "secretAuthTag" IS NULL AND "secretKeyId" IS NULL AND "secretAadHash" IS NULL)
      OR ("state" = 'expired' AND "completedAt" IS NOT NULL AND "terminalEvidenceHash" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "HostedCodexCommentTokenMint_logical_key" ON "HostedCodexCommentTokenMint"("logicalKeyHash");
CREATE UNIQUE INDEX "HostedCodexCommentTokenMint_initial_grant_key" ON "HostedCodexCommentTokenMint"("grantId") WHERE "purpose" = 'initial';
CREATE UNIQUE INDEX "HostedCodexCommentTokenMint_refresh_request_key" ON "HostedCodexCommentTokenMint"("capabilityId", "requestIdHash") WHERE "purpose" = 'refresh';
CREATE UNIQUE INDEX "HostedCodexCommentTokenMint_token_hash_key" ON "HostedCodexCommentTokenMint"("tokenHash") WHERE "tokenHash" IS NOT NULL;
CREATE INDEX "HostedCodexCommentTokenMint_drain_idx" ON "HostedCodexCommentTokenMint"("state", "unsafeUntil", "tokenExpiresAt");
CREATE INDEX "HostedCodexCommentTokenMint_authority_idx" ON "HostedCodexCommentTokenMint"("runtimeAuthzEpoch", "repositoryBindingId", "poolId", "repositoryConnectionId", "githubInstallationRowId");

ALTER TABLE "HostedCodexCommentRefreshUse" ADD COLUMN "mintId" TEXT;
ALTER TABLE "HostedCodexCommentRefreshUse" ADD CONSTRAINT "HostedCodexCommentRefreshUse_mint_fkey"
  FOREIGN KEY ("mintId") REFERENCES "HostedCodexCommentTokenMint"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "HostedCodexCommentRefreshUse_mint_key" ON "HostedCodexCommentRefreshUse"("mintId");

-- Provider revocation proof is append-only and cannot be forged by direct mint
-- DML. Only the SECURITY DEFINER finalizer below may create it.
CREATE TABLE "HostedCodexCommentTokenRevocationProof" (
  "mintId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "ownerIdHash" TEXT NOT NULL,
  "fenceEpoch" BIGINT NOT NULL,
  "receiptAuthority" TEXT NOT NULL,
  "receiptResult" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexCommentTokenRevocationProof_pkey" PRIMARY KEY ("mintId"),
  CONSTRAINT "HostedCodexCommentTokenRevocationProof_mint_fkey" FOREIGN KEY ("mintId")
    REFERENCES "HostedCodexCommentTokenMint"("id") ON DELETE RESTRICT,
  CONSTRAINT "HostedCodexCommentTokenRevocationProof_shape_check" CHECK (
    "tokenHash" ~ '^[a-f0-9]{64}$' AND "evidenceHash" ~ '^[a-f0-9]{64}$'
    AND "ownerIdHash" ~ '^[a-f0-9]{64}$' AND "fenceEpoch" > 0
    AND "receiptAuthority" = 'github_token_delete'
    AND "receiptResult" IN ('revoked','already_invalid'))
);

CREATE FUNCTION hosted_codex_comment_refresh_use_mint_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."mintId" IS DISTINCT FROM OLD."mintId" THEN
    RAISE EXCEPTION 'hosted_codex_comment_refresh_use_mint_immutable';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW."mintId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM public."HostedCodexCommentTokenMint" mint
    WHERE mint."id" = NEW."mintId" AND mint."purpose" = 'refresh'
      AND mint."capabilityId" = NEW."capabilityId" AND mint."requestIdHash" = NEW."requestIdHash"
  )) THEN RAISE EXCEPTION 'hosted_codex_comment_refresh_use_mint_required'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER "HostedCodexCommentRefreshUse_mint_guard"
  BEFORE INSERT OR UPDATE ON "HostedCodexCommentRefreshUse"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_refresh_use_mint_guard();

CREATE TABLE "HostedCodexRuntimeClosure" (
  "id" TEXT NOT NULL,
  "gateRevision" BIGINT NOT NULL,
  "closedAuthzEpoch" BIGINT NOT NULL,
  "state" "HostedCodexRuntimeClosureState" NOT NULL DEFAULT 'draining',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "actorHash" TEXT NOT NULL,
  "reasonHash" TEXT NOT NULL,
  "legacyBarrier" BOOLEAN NOT NULL DEFAULT TRUE,
  "legacyUnsafeUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexRuntimeClosure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexRuntimeClosure_gate_revision_key" UNIQUE ("gateRevision"),
  CONSTRAINT "HostedCodexRuntimeClosure_shape_check" CHECK (
    "gateRevision" > 0 AND "closedAuthzEpoch" > 0 AND "revision" > 0
    AND "actorHash" ~ '^[a-f0-9]{64}$' AND "reasonHash" ~ '^[a-f0-9]{64}$'
    AND (("state" = 'draining' AND "completedAt" IS NULL) OR ("state" = 'complete' AND "completedAt" IS NOT NULL))
  )
);

-- The migration starts closed. Existing issuer processes and pre-ledger bearer
-- tokens are quarantined for the provider TTL plus skew before activation.
UPDATE "HostedCodexRuntimeGate"
SET "status" = 'closed',
    "authzEpoch" = "authzEpoch" + 1,
    "revision" = "revision" + 1,
    "reasonCode" = 'migration_000083_closed',
    "changedAt" = GREATEST(
      clock_timestamp(),
      "changedAt" + INTERVAL '1 millisecond'
    ),
    "changedByHash" = '550647576b36ed5a602a9e6dca0f2a486838834d99e6316367f68e926ffb8d6f'
WHERE "id" = 'global' AND "status" = 'active';

INSERT INTO "HostedCodexRuntimeClosure" (
  "id", "gateRevision", "closedAuthzEpoch", "actorHash", "reasonHash", "legacyUnsafeUntil"
)
SELECT 'runtime-closure-' || "revision", "revision", "authzEpoch",
  '550647576b36ed5a602a9e6dca0f2a486838834d99e6316367f68e926ffb8d6f',
  '550647576b36ed5a602a9e6dca0f2a486838834d99e6316367f68e926ffb8d6f',
  clock_timestamp() + INTERVAL '61 minutes'
FROM "HostedCodexRuntimeGate" WHERE "id" = 'global' AND "status" = 'closed';

CREATE FUNCTION hosted_codex_comment_token_mint_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'hosted_codex_comment_token_mint_delete_forbidden'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'prepared' OR NEW."providerAttempt" <> 0
      OR NEW."dispatchStartedAt" IS NOT NULL OR NEW."dispatchAuthorizedUntil" IS NOT NULL
      OR NEW."unsafeUntil" IS NOT NULL OR NEW."tokenHash" IS NOT NULL
      OR NEW."tokenExpiresAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL
      OR NEW."terminalEvidenceHash" IS NOT NULL OR NEW."revocationEvidenceHash" IS NOT NULL
      OR NEW."secretCiphertext" IS NOT NULL THEN
      RAISE EXCEPTION 'hosted_codex_comment_token_mint_insert_shape_invalid';
    END IF;
    -- This gate share lock is held to transaction end. A concurrent activation
    -- must wait and then re-observe this insert, closing the invisible-insert race.
    PERFORM 1 FROM public."HostedCodexRuntimeGate" gate
      WHERE gate."id" = 'global' AND gate."status" = 'active'
        AND gate."authzEpoch" = NEW."runtimeAuthzEpoch"
        AND gate."revision" = NEW."runtimeGateRevision" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'hosted_codex_comment_token_mint_insert_authority_invalid'; END IF;
    PERFORM 1
      FROM public."GitHubInstallation" installation
      JOIN public."RepositoryConnection" repository ON repository."id" = NEW."repositoryConnectionId"
      JOIN public."HostedCodexPool" pool ON pool."id" = NEW."poolId"
      JOIN public."HostedCodexRepositoryBinding" binding ON binding."id" = NEW."repositoryBindingId"
      JOIN public."HostedCodexInvocationGrant" invocation_grant ON invocation_grant."id" = NEW."grantId"
      WHERE installation."id" = NEW."githubInstallationRowId"
        AND installation."status" = 'active' AND installation."status" = NEW."installationStatus"
        AND installation."workspaceId" = NEW."workspaceId"
        AND installation."workspaceId" = NEW."installationWorkspaceId"
        AND installation."repositorySelection" = NEW."installationSelection"
        AND installation."githubInstallationId" = NEW."githubInstallationId"
        AND installation."updatedAt" = NEW."installationUpdatedAt"
        AND repository."installationId" = installation."id" AND repository."provider" = 'github'
        AND repository."selected" AND NOT repository."archived"
        AND repository."visibility" IN ('private', 'internal')
        AND repository."githubRepositoryId" = NEW."githubRepositoryId"
        AND repository."fullName" = NEW."repositoryFullName"
        AND repository."updatedAt" = NEW."repositoryUpdatedAt"
        AND pool."status" = 'active' AND pool."revision" = NEW."poolRevision"
        AND pool."authzEpoch" = NEW."poolAuthzEpoch"
        AND binding."status" = 'active' AND binding."revision" = NEW."bindingRevision"
        AND binding."stateVersion" = NEW."bindingStateVersion"
        AND binding."workspaceId" = NEW."workspaceId" AND binding."poolId" = NEW."poolId"
        AND binding."repositoryConnectionId" = NEW."repositoryConnectionId"
        AND binding."attestedGithubRepositoryId" = NEW."githubRepositoryId"
        AND invocation_grant."status" = 'issued' AND invocation_grant."revokedAt" IS NULL
        AND invocation_grant."expiresAt" > clock_timestamp()
        AND invocation_grant."runtimeAuthzEpoch" = NEW."runtimeAuthzEpoch"
        AND invocation_grant."authzEpoch" = pool."authzEpoch"
        AND invocation_grant."bindingRevision" = binding."revision"
        AND invocation_grant."repositoryBindingId" = NEW."repositoryBindingId"
        AND invocation_grant."workspaceId" = NEW."workspaceId" AND invocation_grant."poolId" = NEW."poolId"
        AND invocation_grant."repositoryConnectionId" = NEW."repositoryConnectionId"
      FOR SHARE OF installation, repository, pool, binding, invocation_grant;
    IF NOT FOUND THEN RAISE EXCEPTION 'hosted_codex_comment_token_mint_insert_authority_invalid'; END IF;
    IF NEW."purpose" = 'refresh' THEN
      PERFORM 1 FROM public."HostedCodexCommentRefreshCapability" capability
        WHERE capability."id" = NEW."capabilityId" AND capability."grantId" = NEW."grantId"
          AND capability."capabilityTokenHash" = NEW."presentedTokenHash"
          AND capability."expiresAt" > clock_timestamp() AND capability."revokedAt" IS NULL
        FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'hosted_codex_comment_token_mint_insert_capability_invalid'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId" OR NEW."capabilityId" IS DISTINCT FROM OLD."capabilityId"
     OR NEW."logicalKeyHash" IS DISTINCT FROM OLD."logicalKeyHash"
     OR NEW."requestFingerprintHash" IS DISTINCT FROM OLD."requestFingerprintHash"
     OR NEW."requestIdHash" IS DISTINCT FROM OLD."requestIdHash" OR NEW."presentedTokenHash" IS DISTINCT FROM OLD."presentedTokenHash"
     OR NEW."runtimeAuthzEpoch" IS DISTINCT FROM OLD."runtimeAuthzEpoch" OR NEW."runtimeGateRevision" IS DISTINCT FROM OLD."runtimeGateRevision"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."repositoryBindingId" IS DISTINCT FROM OLD."repositoryBindingId"
     OR NEW."bindingRevision" IS DISTINCT FROM OLD."bindingRevision" OR NEW."bindingStateVersion" IS DISTINCT FROM OLD."bindingStateVersion"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId" OR NEW."poolRevision" IS DISTINCT FROM OLD."poolRevision"
     OR NEW."poolAuthzEpoch" IS DISTINCT FROM OLD."poolAuthzEpoch" OR NEW."repositoryConnectionId" IS DISTINCT FROM OLD."repositoryConnectionId"
     OR NEW."repositoryUpdatedAt" IS DISTINCT FROM OLD."repositoryUpdatedAt" OR NEW."githubInstallationRowId" IS DISTINCT FROM OLD."githubInstallationRowId"
     OR NEW."installationUpdatedAt" IS DISTINCT FROM OLD."installationUpdatedAt" OR NEW."githubInstallationId" IS DISTINCT FROM OLD."githubInstallationId"
     OR NEW."installationStatus" IS DISTINCT FROM OLD."installationStatus"
     OR NEW."installationSelection" IS DISTINCT FROM OLD."installationSelection"
     OR NEW."installationWorkspaceId" IS DISTINCT FROM OLD."installationWorkspaceId"
     OR NEW."githubRepositoryId" IS DISTINCT FROM OLD."githubRepositoryId" OR NEW."repositoryFullName" IS DISTINCT FROM OLD."repositoryFullName"
     OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."revision" <> OLD."revision" + 1 OR NEW."providerAttempt" < OLD."providerAttempt"
     OR (OLD."dispatchAuthorizedUntil" IS NOT NULL AND NEW."dispatchAuthorizedUntil" IS DISTINCT FROM OLD."dispatchAuthorizedUntil")
     OR (OLD."dispatchStartedAt" IS NOT NULL AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt")
     OR (OLD."unsafeUntil" IS NOT NULL AND (NEW."unsafeUntil" IS NULL OR NEW."unsafeUntil" < OLD."unsafeUntil"))
     OR (OLD."tokenExpiresAt" IS NOT NULL AND NEW."tokenExpiresAt" IS DISTINCT FROM OLD."tokenExpiresAt")
     OR (OLD."tokenHash" IS NOT NULL AND NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash")
     OR (OLD."capturedAt" IS NOT NULL AND NEW."capturedAt" IS DISTINCT FROM OLD."capturedAt")
     OR (OLD."finalizedAt" IS NOT NULL AND NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt")
     OR (OLD."terminalEvidenceHash" IS NOT NULL AND NEW."terminalEvidenceHash" IS DISTINCT FROM OLD."terminalEvidenceHash"
       AND NOT (OLD."state" IN ('expired','outcome_unknown') AND NEW."state" = 'revoke_pending' AND NEW."terminalEvidenceHash" IS NULL))
     OR (OLD."revocationEvidenceHash" IS NOT NULL AND NEW."revocationEvidenceHash" IS DISTINCT FROM OLD."revocationEvidenceHash") THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mint_identity_or_revision_invalid';
  END IF;
  IF (NEW."terminalEvidenceHash" IS DISTINCT FROM OLD."terminalEvidenceHash"
      AND NOT (OLD."state" IN ('expired','outcome_unknown') AND NEW."state" = 'revoke_pending'
        AND NEW."terminalEvidenceHash" IS NULL)
      AND NEW."state" NOT IN ('failed_no_token','expired'))
     OR (NEW."revocationEvidenceHash" IS DISTINCT FROM OLD."revocationEvidenceHash"
      AND NEW."state" <> 'revoked')
     OR (OLD."secretCiphertext" IS NOT NULL AND NEW."secretCiphertext" IS DISTINCT FROM OLD."secretCiphertext"
      AND NEW."state" NOT IN ('revoked','expired'))
     OR (OLD."secretEncryptedDataKey" IS NOT NULL AND NEW."secretEncryptedDataKey" IS DISTINCT FROM OLD."secretEncryptedDataKey"
      AND NEW."state" NOT IN ('revoked','expired'))
     OR (OLD."secretIv" IS NOT NULL AND NEW."secretIv" IS DISTINCT FROM OLD."secretIv"
      AND NEW."state" NOT IN ('revoked','expired'))
     OR (OLD."secretAuthTag" IS NOT NULL AND NEW."secretAuthTag" IS DISTINCT FROM OLD."secretAuthTag"
      AND NEW."state" NOT IN ('revoked','expired'))
     OR (OLD."secretKeyId" IS NOT NULL AND NEW."secretKeyId" IS DISTINCT FROM OLD."secretKeyId"
      AND NEW."state" NOT IN ('revoked','expired'))
     OR (OLD."secretAadHash" IS NOT NULL AND NEW."secretAadHash" IS DISTINCT FROM OLD."secretAadHash"
      AND NEW."state" NOT IN ('revoked','expired')) THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mint_evidence_replacement_forbidden';
  END IF;
  IF NEW."state" IS NOT DISTINCT FROM OLD."state" AND OLD."state" <> 'prepared' AND NOT (
    (OLD."state" = 'issued'
      AND ((OLD."deliveryClaimIdHash" IS NULL AND NEW."deliveryClaimIdHash" IS NOT NULL
            AND NEW."deliveryClaimExpiresAt" IS NOT NULL AND NEW."deliveredAt" IS NOT NULL)
        OR (OLD."deliveryClaimIdHash" IS NOT NULL AND NEW."deliveryClaimIdHash" IS NULL
            AND NEW."deliveryClaimExpiresAt" IS NULL))
      AND NEW."providerAttempt" = OLD."providerAttempt"
      AND NEW."tokenHash" IS NOT DISTINCT FROM OLD."tokenHash"
      AND NEW."tokenExpiresAt" IS NOT DISTINCT FROM OLD."tokenExpiresAt"
      AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt")
    OR
    OLD."state" = 'revoke_pending'
    AND NEW."providerAttempt" = OLD."providerAttempt"
    AND NEW."tokenHash" IS NOT DISTINCT FROM OLD."tokenHash"
    AND NEW."tokenExpiresAt" IS NOT DISTINCT FROM OLD."tokenExpiresAt"
    AND (NEW."capturedAt" IS NOT DISTINCT FROM OLD."capturedAt"
      OR (OLD."capturedAt" IS NULL AND NEW."capturedAt" IS NOT NULL))
    AND NEW."finalizedAt" IS NOT DISTINCT FROM OLD."finalizedAt"
    AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt"
    AND NEW."terminalEvidenceHash" IS NOT DISTINCT FROM OLD."terminalEvidenceHash"
    AND NEW."revocationEvidenceHash" IS NOT DISTINCT FROM OLD."revocationEvidenceHash"
  ) THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mint_same_state_transition_invalid';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND (
     (OLD."state" = 'prepared' AND NEW."state" NOT IN ('dispatching','failed_no_token'))
     OR (OLD."state" = 'dispatching' AND NEW."state" NOT IN ('issued','revoke_pending','outcome_unknown'))
     OR (OLD."state" = 'issued' AND NEW."state" NOT IN ('issued','revoke_pending','expired'))
     OR (OLD."state" = 'revoke_pending' AND NEW."state" NOT IN ('revoke_pending','revoked','expired'))
     OR (OLD."state" = 'outcome_unknown' AND NEW."state" NOT IN ('outcome_unknown','expired','revoke_pending'))
     OR (OLD."state" = 'outcome_unknown' AND NEW."state" = 'revoke_pending' AND (
         OLD."providerAttempt" <> 1 OR OLD."tokenHash" IS NOT NULL OR NEW."tokenHash" IS NULL
         OR NEW."secretCiphertext" IS NULL OR NEW."completedAt" IS NOT NULL
         OR NEW."terminalEvidenceHash" IS NOT NULL))
     OR (OLD."state" = 'outcome_unknown' AND NEW."state" = 'expired' AND (
         NEW."terminalEvidenceHash" IS NULL OR OLD."unsafeUntil" IS NULL
         OR clock_timestamp() < OLD."unsafeUntil"))
     OR (OLD."state" IN ('issued','revoke_pending') AND NEW."state" = 'expired' AND (
         OLD."tokenExpiresAt" IS NULL
         OR clock_timestamp() < GREATEST(OLD."tokenExpiresAt" + INTERVAL '1 minute', OLD."unsafeUntil")))
     OR (OLD."state" IN ('failed_no_token','revoked') AND NEW."state" <> OLD."state")
     OR (OLD."state" = 'expired' AND NEW."state" NOT IN ('expired','revoke_pending'))
     OR (OLD."state" = 'expired' AND NEW."state" = 'revoke_pending' AND (
         OLD."providerAttempt" <> 1 OR OLD."tokenHash" IS NOT NULL OR NEW."tokenHash" IS NULL
         OR NEW."secretCiphertext" IS NULL OR NEW."completedAt" IS NOT NULL
         OR NEW."terminalEvidenceHash" IS NOT NULL))) THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mint_transition_invalid';
  END IF;
  IF NEW."state" = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM public."HostedCodexCommentTokenRevocationProof" proof
    WHERE proof."mintId" = NEW."id" AND proof."tokenHash" = NEW."tokenHash"
      AND proof."evidenceHash" = NEW."revocationEvidenceHash"
  ) THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_revocation_proof_invalid';
  END IF;
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER "HostedCodexCommentTokenMint_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HostedCodexCommentTokenMint"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_mint_guard();

-- Runtime custody may lock authority rows only through these narrow routines.
-- Granting direct UPDATE merely to satisfy SELECT ... FOR SHARE would also make
-- the authority tables writable by the bearer-token process.
CREATE FUNCTION hosted_codex_lock_comment_token_runtime_gate()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $lock_gate$
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_lock_authority_invalid';
  END IF;
  PERFORM 1 FROM public."HostedCodexRuntimeGate" gate
  WHERE gate."id" = 'global' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_runtime_gate_missing';
  END IF;
END
$lock_gate$;
REVOKE ALL ON FUNCTION hosted_codex_lock_comment_token_runtime_gate() FROM PUBLIC;

CREATE FUNCTION hosted_codex_comment_token_authority_snapshot(p_grant_id text)
RETURNS TABLE (
  "gateStatus" text,
  "runtimeAuthzEpoch" bigint,
  "runtimeGateRevision" bigint,
  "grantId" text,
  "grantInvocationId" text,
  "grantStatus" text,
  "grantRevokedAt" timestamp(3) without time zone,
  "grantExpiresAt" timestamp(3) without time zone,
  "grantRuntimeAuthzEpoch" bigint,
  "grantAuthzEpoch" bigint,
  "grantBindingRevision" bigint,
  "workspaceId" text,
  "capabilityId" text,
  "capabilityTokenHash" text,
  "capabilityExpiresAt" timestamp(3) without time zone,
  "capabilityRevokedAt" timestamp(3) without time zone,
  "capabilityMaxUses" integer,
  "capabilityUseCount" integer,
  "bindingId" text,
  "bindingStatus" text,
  "bindingRevision" bigint,
  "bindingStateVersion" bigint,
  "attestedGithubRepositoryId" bigint,
  "poolId" text,
  "poolStatus" text,
  "poolRevision" bigint,
  "poolAuthzEpoch" bigint,
  "repositoryConnectionId" text,
  "repositoryProvider" text,
  "repositorySelected" boolean,
  "repositoryArchived" boolean,
  "repositoryVisibility" text,
  "repositoryUpdatedAt" timestamp(3) without time zone,
  "githubRepositoryId" bigint,
  "repositoryFullName" text,
  "installationRowId" text,
  "installationStatus" text,
  "installationSelection" text,
  "installationUpdatedAt" timestamp(3) without time zone,
  "installationWorkspaceId" text,
  "githubInstallationId" bigint
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $authority$
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_lock_authority_invalid';
  END IF;
  PERFORM public.hosted_codex_lock_comment_token_runtime_gate();
  RETURN QUERY
  SELECT gate."status"::text, gate."authzEpoch", gate."revision",
    invocation_grant."id", invocation_grant."invocationId",
    invocation_grant."status"::text,
    invocation_grant."revokedAt", invocation_grant."expiresAt",
    invocation_grant."runtimeAuthzEpoch", invocation_grant."authzEpoch",
    invocation_grant."bindingRevision", invocation_grant."workspaceId",
    capability."id", capability."capabilityTokenHash", capability."expiresAt",
    capability."revokedAt", capability."maxUses", capability."useCount",
    binding."id", binding."status"::text,
    binding."revision", binding."stateVersion", binding."attestedGithubRepositoryId",
    pool."id", pool."status"::text, pool."revision", pool."authzEpoch",
    repository."id", repository."provider"::text, repository."selected",
    repository."archived", repository."visibility"::text, repository."updatedAt",
    repository."githubRepositoryId", repository."fullName", installation."id",
    installation."status"::text, installation."repositorySelection",
    installation."updatedAt", installation."workspaceId",
    installation."githubInstallationId"
  FROM public."HostedCodexRuntimeGate" gate
  JOIN public."HostedCodexInvocationGrant" invocation_grant
    ON invocation_grant."id" = p_grant_id
  JOIN public."HostedCodexRepositoryBinding" binding
    ON binding."id" = invocation_grant."repositoryBindingId"
  JOIN public."HostedCodexPool" pool ON pool."id" = binding."poolId"
  JOIN public."RepositoryConnection" repository
    ON repository."id" = binding."repositoryConnectionId"
  JOIN public."GitHubInstallation" installation
    ON installation."id" = repository."installationId"
  LEFT JOIN public."HostedCodexCommentRefreshCapability" capability
    ON capability."grantId" = invocation_grant."id"
  WHERE gate."id" = 'global'
  FOR SHARE OF installation, repository, pool, binding, invocation_grant;
END
$authority$;
REVOKE ALL ON FUNCTION hosted_codex_comment_token_authority_snapshot(text) FROM PUBLIC;

-- The custody login has no direct mint DML. Every mutation is expressed as a
-- named protocol operation with a closed set of writable fields; the row guard
-- above remains the second, database-authoritative transition fence.
CREATE FUNCTION hosted_codex_mutate_comment_token_mint(
  p_operation text, p_arguments jsonb
) RETURNS SETOF public."HostedCodexCommentTokenMint"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $mutate$
DECLARE database_now timestamptz := clock_timestamp();
DECLARE gate_status text;
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody'
     OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mutation_authority_invalid';
  END IF;

  IF p_operation = 'prepare' THEN
    RETURN QUERY INSERT INTO public."HostedCodexCommentTokenMint" (
      "id","purpose","ownerIdHash","logicalKeyHash","requestFingerprintHash",
      "grantId","capabilityId","requestIdHash","presentedTokenHash",
      "runtimeAuthzEpoch","runtimeGateRevision","workspaceId","repositoryBindingId",
      "bindingRevision","bindingStateVersion","poolId","poolRevision","poolAuthzEpoch",
      "repositoryConnectionId","repositoryUpdatedAt","githubInstallationRowId",
      "installationUpdatedAt","installationStatus","installationSelection",
      "installationWorkspaceId","githubInstallationId","githubRepositoryId",
      "repositoryFullName","preparedAt","leaseExpiresAt")
    VALUES (
      p_arguments->>'mintId',(p_arguments->>'purpose')::public."HostedCodexCommentTokenMintPurpose",
      p_arguments->>'ownerIdHash',p_arguments->>'logicalKeyHash',p_arguments->>'requestFingerprintHash',
      p_arguments->>'grantId',nullif(p_arguments->>'capabilityId',''),
      nullif(p_arguments->>'requestIdHash',''),nullif(p_arguments->>'presentedTokenHash',''),
      (p_arguments->>'runtimeAuthzEpoch')::bigint,(p_arguments->>'runtimeGateRevision')::bigint,
      p_arguments->>'workspaceId',p_arguments->>'repositoryBindingId',
      (p_arguments->>'bindingRevision')::bigint,(p_arguments->>'bindingStateVersion')::bigint,
      p_arguments->>'poolId',(p_arguments->>'poolRevision')::bigint,
      (p_arguments->>'poolAuthzEpoch')::bigint,p_arguments->>'repositoryConnectionId',
      (p_arguments->>'repositoryUpdatedAt')::timestamptz,p_arguments->>'githubInstallationRowId',
      (p_arguments->>'installationUpdatedAt')::timestamptz,
      (p_arguments->>'installationStatus')::public."GitHubInstallationStatus",
      p_arguments->>'installationSelection',
      p_arguments->>'installationWorkspaceId',(p_arguments->>'githubInstallationId')::bigint,
      (p_arguments->>'githubRepositoryId')::bigint,p_arguments->>'repositoryFullName',
      database_now,(p_arguments->>'leaseExpiresAt')::timestamptz)
    RETURNING *;
  ELSIF p_operation = 'reclaim_prepared' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "ownerIdHash"=p_arguments->>'ownerIdHash',"fenceEpoch"=mint."fenceEpoch"+1,
      "leaseExpiresAt"=(p_arguments->>'leaseExpiresAt')::timestamptz,
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='prepared'
      AND (mint."ownerIdHash"=p_arguments->>'ownerIdHash' OR mint."leaseExpiresAt"<=database_now)
    RETURNING mint.*;
  ELSIF p_operation = 'authorize_dispatch' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"='dispatching',"providerAttempt"=1,"dispatchStartedAt"=database_now,
      "dispatchAuthorizedUntil"=(p_arguments->>'dispatchAuthorizedUntil')::timestamptz,
      "unsafeUntil"=(p_arguments->>'unsafeUntil')::timestamptz,
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='prepared'
      AND mint."ownerIdHash"=p_arguments->>'ownerIdHash' AND mint."leaseExpiresAt">database_now
    RETURNING mint.*;
  ELSIF p_operation = 'release_prepared' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "leaseExpiresAt"=database_now,"errorCode"=p_arguments->>'errorCode',
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='prepared'
      AND mint."ownerIdHash"=p_arguments->>'ownerIdHash'
    RETURNING mint.*;
  ELSIF p_operation = 'claim_delivery' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "deliveredAt"=database_now,"deliveryClaimIdHash"=p_arguments->>'deliveryClaimIdHash',
      "deliveryClaimExpiresAt"=mint."tokenExpiresAt"+interval '1 minute',
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='issued'
      AND mint."tokenHash"=p_arguments->>'tokenHash' AND mint."tokenExpiresAt">database_now
      AND mint."deliveryClaimIdHash" IS NULL
    RETURNING mint.*;
  ELSIF p_operation = 'release_delivery' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "deliveryClaimIdHash"=NULL,"deliveryClaimExpiresAt"=NULL,
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."tokenHash"=p_arguments->>'tokenHash'
      AND mint."deliveryClaimIdHash"=p_arguments->>'deliveryClaimIdHash'
    RETURNING mint.*;
  ELSIF p_operation = 'capture_known_token' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"=(p_arguments->>'state')::public."HostedCodexCommentTokenMintState",
      "tokenHash"=p_arguments->>'tokenHash',
      "tokenExpiresAt"=(p_arguments->>'tokenExpiresAt')::timestamptz,
      "secretCiphertext"=decode(p_arguments->>'secretCiphertext','base64'),
      "secretEncryptedDataKey"=decode(p_arguments->>'secretEncryptedDataKey','base64'),
      "secretIv"=decode(p_arguments->>'secretIv','base64'),
      "secretAuthTag"=decode(p_arguments->>'secretAuthTag','base64'),
      "secretKeyId"=p_arguments->>'secretKeyId',"secretAadHash"=p_arguments->>'secretAadHash',
      "capturedAt"=database_now,"finalizedAt"=database_now,"leaseExpiresAt"=database_now,
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='dispatching'
      AND mint."ownerIdHash"=p_arguments->>'ownerIdHash'
      AND mint."fenceEpoch"=(p_arguments->>'fenceEpoch')::bigint
      AND p_arguments->>'state' IN ('issued','revoke_pending')
    RETURNING mint.*;
  ELSIF p_operation = 'enqueue_issued_revocation' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"='revoke_pending',"revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='issued'
      AND mint."tokenHash"=p_arguments->>'tokenHash'
    RETURNING mint.*;
  ELSIF p_operation = 'stage_revocation' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"='revoke_pending',"tokenHash"=p_arguments->>'tokenHash',
      "tokenExpiresAt"=(p_arguments->>'tokenExpiresAt')::timestamptz,
      "unsafeUntil"=greatest(mint."unsafeUntil",(p_arguments->>'unsafeUntil')::timestamptz),
      "secretCiphertext"=CASE WHEN p_arguments?'secretCiphertext' THEN decode(p_arguments->>'secretCiphertext','base64') ELSE mint."secretCiphertext" END,
      "secretEncryptedDataKey"=CASE WHEN p_arguments?'secretEncryptedDataKey' THEN decode(p_arguments->>'secretEncryptedDataKey','base64') ELSE mint."secretEncryptedDataKey" END,
      "secretIv"=CASE WHEN p_arguments?'secretIv' THEN decode(p_arguments->>'secretIv','base64') ELSE mint."secretIv" END,
      "secretAuthTag"=CASE WHEN p_arguments?'secretAuthTag' THEN decode(p_arguments->>'secretAuthTag','base64') ELSE mint."secretAuthTag" END,
      "secretKeyId"=coalesce(p_arguments->>'secretKeyId',mint."secretKeyId"),
      "secretAadHash"=coalesce(p_arguments->>'secretAadHash',mint."secretAadHash"),
      "errorCode"=p_arguments->>'errorCode',"completedAt"=NULL,"terminalEvidenceHash"=NULL,
      "leaseExpiresAt"=database_now,
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND (
      (mint."state" IN ('dispatching','outcome_unknown','expired') AND mint."tokenHash" IS NULL)
      OR (mint."state" IN ('issued','revoke_pending') AND mint."tokenHash"=p_arguments->>'tokenHash'
        AND mint."tokenExpiresAt"=(p_arguments->>'tokenExpiresAt')::timestamptz))
    RETURNING mint.*;
  ELSIF p_operation = 'claim_revocations' THEN
    SELECT gate."status"::text INTO gate_status FROM public."HostedCodexRuntimeGate" gate
      WHERE gate."id"='global' FOR SHARE;
    IF gate_status NOT IN ('closed','active') THEN
      RAISE EXCEPTION 'hosted_codex_comment_mint_runtime_gate_invalid';
    END IF;
    RETURN QUERY WITH candidates AS (
      SELECT mint."id" FROM public."HostedCodexCommentTokenMint" mint
      WHERE (mint."state"='revoke_pending' OR (gate_status='closed' AND mint."state"='issued'))
        AND greatest(mint."tokenExpiresAt"+interval '1 minute',mint."unsafeUntil")>database_now
        AND mint."secretCiphertext" IS NOT NULL AND mint."secretEncryptedDataKey" IS NOT NULL
        AND mint."secretIv" IS NOT NULL AND mint."secretAuthTag" IS NOT NULL
        AND mint."secretKeyId" IS NOT NULL AND mint."secretAadHash" IS NOT NULL
        AND mint."leaseExpiresAt"<=database_now
      ORDER BY greatest(mint."tokenExpiresAt"+interval '1 minute',mint."unsafeUntil"),mint."id"
      FOR UPDATE SKIP LOCKED LIMIT (p_arguments->>'limit')::integer
    ) UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"='revoke_pending',"ownerIdHash"=p_arguments->>'ownerIdHash',
      "fenceEpoch"=mint."fenceEpoch"+1,
      "leaseExpiresAt"=(p_arguments->>'leaseExpiresAt')::timestamptz,
      "revision"=mint."revision"+1
    FROM candidates WHERE mint."id"=candidates."id" RETURNING mint.*;
  ELSIF p_operation = 'release_revocation' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "leaseExpiresAt"=database_now+interval '5 seconds',"errorCode"=p_arguments->>'errorCode',
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='revoke_pending'
      AND mint."ownerIdHash"=p_arguments->>'ownerIdHash'
      AND mint."fenceEpoch"=(p_arguments->>'fenceEpoch')::bigint
    RETURNING mint.*;
  ELSIF p_operation = 'outcome_unknown' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"='outcome_unknown',"completedAt"=database_now,
      "unsafeUntil"=greatest(mint."unsafeUntil",coalesce((p_arguments->>'unsafeUntil')::timestamptz,mint."unsafeUntil")),
      "errorCode"=p_arguments->>'errorCode',"revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='dispatching'
      AND mint."ownerIdHash"=p_arguments->>'ownerIdHash'
    RETURNING mint.*;
  ELSE
    RAISE EXCEPTION 'hosted_codex_comment_token_mutation_operation_invalid';
  END IF;
END
$mutate$;
REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb) FROM PUBLIC;

CREATE FUNCTION hosted_codex_finalize_comment_token_revocation(
  p_mint_id text, p_token_hash text, p_evidence_hash text,
  p_owner_id_hash text, p_fence_epoch bigint,
  p_receipt_authority text, p_receipt_result text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $finalize$
DECLARE changed_count integer;
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody'
     OR p_owner_id_hash !~ '^[a-f0-9]{64}$' OR p_fence_epoch < 1
     OR p_receipt_authority <> 'github_token_delete'
     OR p_receipt_result NOT IN ('revoked','already_invalid')
     OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_evidence_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_revocation_proof_shape_invalid';
  END IF;
  INSERT INTO public."HostedCodexCommentTokenRevocationProof" (
    "mintId", "tokenHash", "evidenceHash", "ownerIdHash", "fenceEpoch",
    "receiptAuthority", "receiptResult", "recordedAt")
  SELECT mint."id", p_token_hash, p_evidence_hash, p_owner_id_hash, p_fence_epoch,
    p_receipt_authority, p_receipt_result, clock_timestamp()
  FROM public."HostedCodexCommentTokenMint" mint
  WHERE mint."id" = p_mint_id AND mint."state" = 'revoke_pending'
    AND mint."tokenHash" = p_token_hash
    AND mint."ownerIdHash" = p_owner_id_hash
    AND mint."fenceEpoch" = p_fence_epoch
  ON CONFLICT ("mintId") DO NOTHING;
  UPDATE public."HostedCodexCommentTokenMint" mint
  SET "state" = 'revoked', "revocationEvidenceHash" = p_evidence_hash,
      "completedAt" = clock_timestamp(), "secretCiphertext" = NULL,
      "secretEncryptedDataKey" = NULL, "secretIv" = NULL, "secretAuthTag" = NULL,
      "secretKeyId" = NULL, "secretAadHash" = NULL, "revision" = mint."revision" + 1
  WHERE mint."id" = p_mint_id AND mint."state" = 'revoke_pending'
    AND mint."tokenHash" = p_token_hash
    AND mint."ownerIdHash" = p_owner_id_hash
    AND mint."fenceEpoch" = p_fence_epoch;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 1 THEN
    DELETE FROM public."HostedCodexCommentTokenRevocationProof" WHERE "mintId" = p_mint_id;
    RAISE EXCEPTION 'hosted_codex_comment_mint_revoke_finalize_conflict';
  END IF;
  RETURN TRUE;
END
$finalize$;
REVOKE ALL ON FUNCTION hosted_codex_finalize_comment_token_revocation(text,text,text,text,bigint,text,text) FROM PUBLIC;
DO $acl$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker'] LOOP
    IF to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I', 'HostedCodexCommentTokenMint', runtime_role);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', 'HostedCodexCommentTokenRevocationProof', runtime_role);
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I', 'HostedCodexRuntimeClosure', runtime_role);
    END IF;
  END LOOP;
  IF to_regrole('reviewrouter_comment_token_custody') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public."HostedCodexRuntimeGate", public."GitHubInstallation", public."RepositoryConnection", public."HostedCodexPool", public."HostedCodexRepositoryBinding", public."HostedCodexInvocationGrant", public."HostedCodexCommentRefreshCapability", public."HostedCodexCommentRefreshUse", public."HostedCodexCommentTokenMint" TO reviewrouter_comment_token_custody';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public."HostedCodexCommentTokenMint" FROM reviewrouter_comment_token_custody';
    EXECUTE 'GRANT INSERT ON TABLE public."HostedCodexCommentRefreshUse" TO reviewrouter_comment_token_custody';
    EXECUTE 'GRANT UPDATE ("useCount", "lastUsedAt", "revision", "updatedAt") ON TABLE public."HostedCodexCommentRefreshCapability" TO reviewrouter_comment_token_custody';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hosted_codex_finalize_comment_token_revocation(text,text,text,text,bigint,text,text) TO reviewrouter_comment_token_custody';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hosted_codex_mutate_comment_token_mint(text,jsonb) TO reviewrouter_comment_token_custody';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hosted_codex_lock_comment_token_runtime_gate() TO reviewrouter_comment_token_custody';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hosted_codex_comment_token_authority_snapshot(text) TO reviewrouter_comment_token_custody';
  END IF;
END
$acl$;

CREATE FUNCTION hosted_codex_runtime_closure_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'hosted_codex_runtime_closure_delete_forbidden'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'draining' OR NEW."completedAt" IS NOT NULL
      OR NOT EXISTS (
      SELECT 1 FROM public."HostedCodexRuntimeGate" gate
      WHERE gate."id" = 'global' AND gate."status" = 'closed'
        AND gate."revision" = NEW."gateRevision"
        AND gate."authzEpoch" = NEW."closedAuthzEpoch"
    ) THEN RAISE EXCEPTION 'hosted_codex_runtime_closure_insert_invalid'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."gateRevision" IS DISTINCT FROM OLD."gateRevision"
     OR NEW."closedAuthzEpoch" IS DISTINCT FROM OLD."closedAuthzEpoch" OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."actorHash" IS DISTINCT FROM OLD."actorHash" OR NEW."reasonHash" IS DISTINCT FROM OLD."reasonHash"
     OR (NEW."legacyUnsafeUntil" IS DISTINCT FROM OLD."legacyUnsafeUntil" AND NOT (
       OLD."state" = 'draining' AND NEW."state" = 'draining'
       AND OLD."legacyBarrier" AND NOT NEW."legacyBarrier"
       AND NEW."legacyUnsafeUntil" >= clock_timestamp() + INTERVAL '61 minutes'
     )) OR (NEW."legacyBarrier" IS DISTINCT FROM OLD."legacyBarrier" AND NOT (
       OLD."state" = 'draining' AND NEW."state" = 'draining'
       AND OLD."legacyBarrier" AND NOT NEW."legacyBarrier"
       AND NEW."legacyUnsafeUntil" IS DISTINCT FROM OLD."legacyUnsafeUntil"
       AND NEW."legacyUnsafeUntil" >= clock_timestamp() + INTERVAL '61 minutes'
     )) OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."revision" <> OLD."revision" + 1 OR OLD."state" = 'complete' THEN
    RAISE EXCEPTION 'hosted_codex_runtime_closure_transition_invalid';
  END IF;
  IF NEW."state" = 'complete' AND (
    NOT EXISTS (SELECT 1 FROM public."HostedCodexRuntimeGate" gate
      WHERE gate."id" = 'global' AND gate."status" = 'closed'
        AND gate."revision" = NEW."gateRevision"
        AND gate."authzEpoch" = NEW."closedAuthzEpoch")
    OR NEW."legacyBarrier" OR clock_timestamp() < NEW."legacyUnsafeUntil" OR EXISTS (
      SELECT 1 FROM public."HostedCodexCommentTokenMint" mint
      WHERE mint."state" IN ('dispatching','issued','revoke_pending','outcome_unknown')
         OR (mint."state" = 'prepared' AND mint."leaseExpiresAt" > clock_timestamp())
         OR (mint."tokenExpiresAt" IS NOT NULL AND GREATEST(mint."tokenExpiresAt" + INTERVAL '1 minute', mint."unsafeUntil") > clock_timestamp()
             AND mint."state" NOT IN ('revoked','expired','failed_no_token'))
    )
    OR EXISTS (
      SELECT 1 FROM public."HostedCodexCommentTokenMint" delivery
      WHERE delivery."state" = 'issued'
        AND delivery."deliveryClaimIdHash" IS NOT NULL
        AND delivery."deliveryClaimExpiresAt" > clock_timestamp()
    )
  ) THEN RAISE EXCEPTION 'hosted_codex_runtime_closure_unsafe'; END IF;
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER "HostedCodexRuntimeClosure_guard" BEFORE INSERT OR UPDATE OR DELETE ON "HostedCodexRuntimeClosure"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_runtime_closure_guard();

-- Forward-only replacement: 000081 is immutable even when this guard evolves.
CREATE OR REPLACE FUNCTION hosted_codex_runtime_gate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hosted_codex_runtime_gate_delete_forbidden';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."revision" <> OLD."revision" + 1
     OR NEW."authzEpoch" <> OLD."authzEpoch" + 1
     OR NEW."changedByHash" !~ '^[a-f0-9]{64}$'
     OR NEW."reasonCode" IS NULL OR btrim(NEW."reasonCode") = ''
     OR (NEW."reasonCode" IS NOT DISTINCT FROM OLD."reasonCode"
       AND NEW."status" = OLD."status") THEN
    RAISE EXCEPTION 'hosted_codex_runtime_gate_transition_invalid';
  END IF;
  NEW."changedAt" := GREATEST(
    clock_timestamp(),
    OLD."changedAt" + INTERVAL '1 millisecond'
  );
  RETURN NEW;
END
$guard$;

-- Activation is impossible until the most recent closure has completed.
CREATE FUNCTION hosted_codex_runtime_gate_activation_barrier()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF NEW."status" = 'active' AND OLD."status" <> 'active' AND (
    NOT EXISTS (
      SELECT 1 FROM public."HostedCodexRuntimeClosure" closure
      WHERE closure."gateRevision" = OLD."revision"
        AND closure."closedAuthzEpoch" = OLD."authzEpoch"
        AND closure."state" = 'complete'
        AND NOT closure."legacyBarrier"
        AND clock_timestamp() >= closure."legacyUnsafeUntil"
    ) OR EXISTS (
      SELECT 1 FROM public."HostedCodexCommentTokenMint" mint
      WHERE mint."state" IN ('dispatching','issued','revoke_pending','outcome_unknown')
         OR (mint."state" = 'prepared' AND mint."leaseExpiresAt" > clock_timestamp())
         OR (mint."tokenExpiresAt" IS NOT NULL AND GREATEST(mint."tokenExpiresAt" + INTERVAL '1 minute', mint."unsafeUntil") > clock_timestamp()
             AND mint."state" NOT IN ('revoked','expired','failed_no_token'))
    )
    OR EXISTS (
      SELECT 1 FROM public."HostedCodexCommentTokenMint" delivery
      WHERE delivery."state" = 'issued'
        AND delivery."deliveryClaimIdHash" IS NOT NULL
        AND delivery."deliveryClaimExpiresAt" > clock_timestamp()
    )
  ) THEN RAISE EXCEPTION 'hosted_codex_runtime_closure_incomplete'; END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER "HostedCodexRuntimeGate_activation_barrier" BEFORE UPDATE ON "HostedCodexRuntimeGate"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_runtime_gate_activation_barrier();

-- If a mutable authority change linearizes after finalization, the already
-- issued bearer is durably moved behind the revocation barrier.
CREATE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_TABLE_NAME = 'HostedCodexRepositoryBinding' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
      WHERE "repositoryBindingId" = OLD."id" AND "state" = 'issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexPool' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
      WHERE "poolId" = OLD."id" AND "state" = 'issued';
  ELSIF TG_TABLE_NAME = 'RepositoryConnection' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
      WHERE "repositoryConnectionId" = OLD."id" AND "state" = 'issued';
  ELSIF TG_TABLE_NAME = 'GitHubInstallation' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
      WHERE "githubInstallationRowId" = OLD."id" AND "state" = 'issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexInvocationGrant' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
      WHERE "grantId" = OLD."id" AND "state" = 'issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexCommentRefreshCapability' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
      WHERE "capabilityId" = OLD."id" AND "state" = 'issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexRuntimeGate' THEN
    IF NEW."authzEpoch" IS DISTINCT FROM OLD."authzEpoch"
       OR NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      UPDATE public."HostedCodexCommentTokenMint" SET "state" = 'revoke_pending', "revision" = "revision" + 1
        WHERE "state" = 'issued';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER "HostedCodexRepositoryBinding_comment_token_revoke"
  AFTER UPDATE OF "status", "revision", "stateVersion", "workspaceId", "poolId", "repositoryConnectionId", "attestedGithubRepositoryId"
  ON "HostedCodexRepositoryBinding"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();
CREATE TRIGGER "HostedCodexPool_comment_token_revoke"
  AFTER UPDATE OF "status", "revision", "authzEpoch" ON "HostedCodexPool"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();
CREATE TRIGGER "RepositoryConnection_comment_token_revoke"
  AFTER UPDATE OF "provider", "selected", "archived", "visibility", "githubRepositoryId", "fullName", "installationId"
  ON "RepositoryConnection"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();
CREATE TRIGGER "GitHubInstallation_comment_token_revoke"
  AFTER UPDATE OF "status", "repositorySelection", "githubInstallationId", "workspaceId"
  ON "GitHubInstallation"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();
CREATE TRIGGER "HostedCodexInvocationGrant_comment_token_revoke"
  AFTER UPDATE OF "status", "revokedAt", "expiresAt", "runtimeAuthzEpoch", "authzEpoch", "bindingRevision", "workspaceId", "poolId", "repositoryConnectionId"
  ON "HostedCodexInvocationGrant"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();
CREATE TRIGGER "HostedCodexCommentRefreshCapability_comment_token_revoke"
  AFTER UPDATE OF "capabilityTokenHash", "expiresAt", "revokedAt"
  ON "HostedCodexCommentRefreshCapability"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();
CREATE TRIGGER "HostedCodexRuntimeGate_comment_token_revoke"
  AFTER UPDATE OF "status", "authzEpoch", "revision" ON "HostedCodexRuntimeGate"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue();

COMMIT;
