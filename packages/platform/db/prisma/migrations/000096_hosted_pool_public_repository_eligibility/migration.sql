-- Extend only repository visibility eligibility. CREATE OR REPLACE preserves
-- each existing function identity, owner, ACL and attached triggers.
-- Bodies and security attributes are copied from the latest definitions at
-- 000095: mint_guard from 000083; prepare_authority_complete from 000086.

CREATE OR REPLACE FUNCTION hosted_codex_comment_token_mint_guard()
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
        AND repository."visibility" IN ('public', 'private', 'internal')
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

CREATE OR REPLACE FUNCTION hosted_codex_comment_token_prepare_authority_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $prepare_authority$
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_custody_role_required';
  END IF;
  PERFORM 1
  FROM public."GitHubInstallation" installation
  JOIN public."RepositoryConnection" repository
    ON repository."id"=NEW."repositoryConnectionId"
   AND repository."installationId"=installation."id"
  JOIN public."HostedCodexPool" pool ON pool."id"=NEW."poolId"
  JOIN public."HostedCodexRepositoryBinding" binding
    ON binding."id"=NEW."repositoryBindingId"
  JOIN public."HostedCodexInvocationGrant" invocation_grant
    ON invocation_grant."id"=NEW."grantId"
  WHERE installation."id"=NEW."githubInstallationRowId"
    AND installation."status"=NEW."installationStatus"
    AND installation."repositorySelection"=NEW."installationSelection"
    AND installation."updatedAt"=NEW."installationUpdatedAt"
    AND installation."workspaceId"=NEW."installationWorkspaceId"
    AND installation."workspaceId"=NEW."workspaceId"
    AND installation."githubInstallationId"=NEW."githubInstallationId"
    AND repository."visibility" IN ('public','private','internal')
    AND repository."selected" AND NOT repository."archived"
    AND repository."updatedAt"=NEW."repositoryUpdatedAt"
    AND repository."githubRepositoryId"=NEW."githubRepositoryId"
    AND repository."fullName"=NEW."repositoryFullName"
    AND pool."authzEpoch"=NEW."poolAuthzEpoch"
    AND invocation_grant."authzEpoch"=pool."authzEpoch"
    AND binding."revision"=NEW."bindingRevision"
    AND invocation_grant."bindingRevision"=binding."revision"
  FOR SHARE OF installation, repository, pool, binding, invocation_grant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mint_insert_authority_invalid';
  END IF;
  RETURN NEW;
END
$prepare_authority$;
