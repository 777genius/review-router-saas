BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Active namespace identity remains immutable.  This helper only creates the
-- exact, transaction-local receipt consumed by the tombstone guard below.
CREATE FUNCTION "codex_oauth_v4_v5_reattestation_transition"(
  target_provider_row_id TEXT,
  target_namespace_id TEXT,
  target_namespace_epoch BIGINT,
  target_secret_name TEXT,
  target_repository_id TEXT,
  target_workflow_path TEXT,
  target_source_trust TEXT,
  old_commit_sha TEXT,
  old_blob_sha TEXT,
  old_source_sha256 TEXT,
  old_semantic_sha256 TEXT,
  new_commit_sha TEXT,
  new_blob_sha TEXT,
  new_source_sha256 TEXT,
  new_semantic_sha256 TEXT
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_array(
    target_provider_row_id, target_namespace_id, target_namespace_epoch,
    target_secret_name, target_repository_id, target_workflow_path,
    target_source_trust, 4, 5,
    old_commit_sha, old_blob_sha, old_source_sha256, old_semantic_sha256,
    new_commit_sha, new_blob_sha, new_source_sha256, new_semantic_sha256
  )::text;
END $$;

CREATE OR REPLACE FUNCTION "codex_oauth_secret_namespace_tombstone_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE initial_authority_matches BOOLEAN := FALSE;
DECLARE promotion_evidence_matches BOOLEAN := FALSE;
DECLARE active_reattestation_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM public."CodexOAuthProviderInstance" provider
      JOIN public."RepositoryConnection" repository ON repository."id" = provider."repositoryId"
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
      SELECT 1 FROM public."CodexOAuthSetupDispatchAttempt" attempt
      JOIN public."CodexOAuthSetupPayloadClaim" claim ON claim."id" = attempt."claimId"
      WHERE attempt."namespaceId" = OLD."id" AND attempt."status" = 'confirmed'
        AND claim."providerInstanceRowId" = OLD."providerInstanceRowId"
        AND claim."status" = 'prepared'
        AND claim."databaseRecoveryWitness" = OLD."databaseRecoveryWitness"
    ) INTO promotion_evidence_matches;
    IF NOT promotion_evidence_matches THEN
      SELECT EXISTS (
        SELECT 1 FROM public."CodexOAuthWritebackIntent" intent
        WHERE intent."secretNamespaceId" = OLD."id" AND intent."status" = 'pending'
          AND intent."providerResponseCode" IN (201,204) AND intent."providerConfirmedAt" IS NOT NULL
          AND intent."databaseRecoveryWitness" = OLD."databaseRecoveryWitness"
      ) INTO promotion_evidence_matches;
    END IF;
  ELSIF OLD."status" = 'confirmed_candidate' AND NEW."status" = 'active' THEN
    SELECT EXISTS (
      SELECT 1 FROM public."CodexOAuthSetupDispatchAttempt" attempt
      JOIN public."CodexOAuthSetupPayloadClaim" claim ON claim."confirmedAttemptId" = attempt."id"
      JOIN public."CodexOAuthProviderInstance" provider ON provider."id" = claim."providerInstanceRowId"
      WHERE attempt."namespaceId" = OLD."id" AND attempt."status" = 'confirmed'
        AND claim."status" = 'confirmed_candidate' AND provider."mutationOwner" = 'setup'
        AND provider."mutationOwnerId" = claim."manifestId"
    ) INTO promotion_evidence_matches;
    IF NOT promotion_evidence_matches THEN
      SELECT EXISTS (
        SELECT 1 FROM public."CodexOAuthWritebackIntent" intent
        JOIN public."CodexOAuthProviderInstance" provider ON provider."id" = intent."providerInstanceRowId"
        WHERE intent."secretNamespaceId" = OLD."id" AND intent."status" = 'pending'
          AND intent."providerResponseCode" IN (201,204) AND intent."providerConfirmedAt" IS NOT NULL
          AND provider."mutationOwner" = 'runtime' AND provider."mutationOwnerId" = intent."leaseId"
          AND provider."mutationEpoch" = intent."mutationEpoch"
      ) INTO promotion_evidence_matches;
    END IF;
  ELSE
    promotion_evidence_matches := TRUE;
  END IF;

  IF OLD."status" = 'active'
     AND NEW."status" = 'active'
     AND NEW."id" IS NOT DISTINCT FROM OLD."id"
     AND NEW."providerInstanceRowId" IS NOT DISTINCT FROM OLD."providerInstanceRowId"
     AND NEW."githubRepositoryId" IS NOT DISTINCT FROM OLD."githubRepositoryId"
     AND NEW."namespaceEpoch" IS NOT DISTINCT FROM OLD."namespaceEpoch"
     AND NEW."secretName" IS NOT DISTINCT FROM OLD."secretName"
     AND NEW."databaseRecoveryWitness" IS NOT DISTINCT FROM OLD."databaseRecoveryWitness"
     AND NEW."workflowPath" IS NOT DISTINCT FROM OLD."workflowPath"
     AND NEW."workflowSourceTrust" IS NOT DISTINCT FROM OLD."workflowSourceTrust"
     AND NEW."attestedRepositoryId" IS NOT DISTINCT FROM OLD."attestedRepositoryId"
     AND NEW."activatedAt" IS NOT DISTINCT FROM OLD."activatedAt"
     AND NEW."confirmedAt" IS NOT DISTINCT FROM OLD."confirmedAt"
     AND NEW."retiredAt" IS NOT DISTINCT FROM OLD."retiredAt"
     AND NEW."permanentlyRetired" IS NOT DISTINCT FROM OLD."permanentlyRetired"
  THEN
    active_reattestation_matches := public."codex_oauth_consume_database_authority"(
      'active_namespace_v4_v5_reattestation',
      public."codex_oauth_v4_v5_reattestation_transition"(
        OLD."providerInstanceRowId", OLD."id", OLD."namespaceEpoch", OLD."secretName",
        OLD."githubRepositoryId", OLD."workflowPath", OLD."workflowSourceTrust",
        OLD."workflowSourceCommitSha", OLD."workflowSourceBlobSha",
        OLD."workflowSourceSha256", OLD."workflowSemanticSha256",
        NEW."workflowSourceCommitSha", NEW."workflowSourceBlobSha",
        NEW."workflowSourceSha256", NEW."workflowSemanticSha256"
      ), 0
    );
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
       AND NOT (OLD."status" = 'confirmed_candidate' AND NEW."status" = 'active')
       AND NOT active_reattestation_matches)
     OR (OLD."status" = 'active' AND (
       NEW."workflowPath" IS DISTINCT FROM OLD."workflowPath"
       OR NEW."workflowSourceCommitSha" IS DISTINCT FROM OLD."workflowSourceCommitSha"
       OR NEW."workflowSourceBlobSha" IS DISTINCT FROM OLD."workflowSourceBlobSha"
       OR NEW."workflowSourceSha256" IS DISTINCT FROM OLD."workflowSourceSha256"
       OR NEW."workflowSemanticSha256" IS DISTINCT FROM OLD."workflowSemanticSha256"
       OR NEW."workflowSourceTrust" IS DISTINCT FROM OLD."workflowSourceTrust"
       OR NEW."attestedRepositoryId" IS DISTINCT FROM OLD."attestedRepositoryId"
       OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
     ) AND NOT active_reattestation_matches)
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

CREATE FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"(
  target_provider_row_id TEXT,
  target_claim_id TEXT,
  target_attempt_id TEXT,
  target_namespace_id TEXT,
  target_namespace_epoch BIGINT,
  target_secret_name TEXT,
  target_repository_id TEXT,
  target_generation_hash TEXT,
  target_workflow_path TEXT,
  target_source_trust TEXT,
  expected_schema_version INTEGER,
  target_schema_version INTEGER,
  old_commit_sha TEXT,
  old_blob_sha TEXT,
  old_source_sha256 TEXT,
  old_semantic_sha256 TEXT,
  new_commit_sha TEXT,
  new_blob_sha TEXT,
  new_source_sha256 TEXT,
  new_semantic_sha256 TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE transition_key TEXT;
DECLARE affected_count INTEGER;
BEGIN
  IF caller_role NOT IN ('reviewrouter_web', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((
       SELECT relowner FROM pg_class
       WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass
     ))
  THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_role_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF expected_schema_version <> 4 OR target_schema_version <> 5
     OR target_source_trust <> 'trusted_default_branch_revision'
     OR target_repository_id !~ '^[1-9][0-9]*$'
     OR target_workflow_path !~ '^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$'
     OR old_commit_sha !~ '^[a-f0-9]{40}$'
     OR new_commit_sha !~ '^[a-f0-9]{40}$'
     OR old_blob_sha !~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
     OR new_blob_sha !~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
     OR old_source_sha256 !~ '^[a-f0-9]{64}$'
     OR new_source_sha256 !~ '^[a-f0-9]{64}$'
     OR old_semantic_sha256 !~ '^[a-f0-9]{64}$'
     OR new_semantic_sha256 !~ '^[a-f0-9]{64}$'
     OR old_source_sha256 = new_source_sha256
     OR old_semantic_sha256 = new_semantic_sha256
  THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public."CodexOAuthProviderInstance" provider
  JOIN public."RepositoryConnection" repository ON repository."id" = provider."repositoryId"
  WHERE provider."id" = target_provider_row_id
    AND provider."state" = 'active'
    AND provider."activeSecretNamespaceId" = target_namespace_id
    AND provider."activeSecretNamespaceEpoch" = target_namespace_epoch
    AND provider."activeSecretNamespaceName" = target_secret_name
    AND provider."latestGenerationHash" = target_generation_hash
    AND repository."githubRepositoryId"::text = target_repository_id
  FOR UPDATE OF provider;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_stale'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1
  FROM public."CodexOAuthSecretNamespace" namespace
  JOIN public."CodexOAuthSetupDispatchAttempt" attempt
    ON attempt."namespaceId" = namespace."id"
  JOIN public."CodexOAuthSetupPayloadClaim" claim
    ON claim."id" = attempt."claimId"
  WHERE namespace."id" = target_namespace_id
    AND namespace."providerInstanceRowId" = target_provider_row_id
    AND namespace."namespaceEpoch" = target_namespace_epoch
    AND namespace."secretName" = target_secret_name
    AND namespace."githubRepositoryId" = target_repository_id
    AND namespace."attestedRepositoryId" = target_repository_id
    AND namespace."status" = 'active'
    AND NOT namespace."permanentlyRetired"
    AND namespace."workflowPath" = target_workflow_path
    AND namespace."workflowSourceTrust" = target_source_trust
    AND namespace."workflowSourceCommitSha" = old_commit_sha
    AND namespace."workflowSourceBlobSha" = old_blob_sha
    AND namespace."workflowSourceSha256" = old_source_sha256
    AND namespace."workflowSemanticSha256" = old_semantic_sha256
    AND attempt."id" = target_attempt_id
    AND attempt."status" = 'confirmed'
    AND claim."id" = target_claim_id
    AND claim."status" = 'active'
    AND claim."confirmedAttemptId" = target_attempt_id
    AND claim."providerInstanceRowId" = target_provider_row_id
    AND claim."githubRepositoryId" = target_repository_id
    AND claim."generationHash" = target_generation_hash
  FOR UPDATE OF namespace, attempt, claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_stale'
      USING ERRCODE = '40001';
  END IF;

  transition_key := public."codex_oauth_v4_v5_reattestation_transition"(
    target_provider_row_id, target_namespace_id, target_namespace_epoch,
    target_secret_name, target_repository_id, target_workflow_path,
    target_source_trust, old_commit_sha, old_blob_sha, old_source_sha256,
    old_semantic_sha256, new_commit_sha, new_blob_sha, new_source_sha256,
    new_semantic_sha256
  );
  INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
    "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
  ) VALUES (
    caller_role, pg_backend_pid(), txid_current(),
    'active_namespace_v4_v5_reattestation', transition_key, 0
  );

  UPDATE public."CodexOAuthSecretNamespace"
  SET "workflowSourceCommitSha" = new_commit_sha,
      "workflowSourceBlobSha" = new_blob_sha,
      "workflowSourceSha256" = new_source_sha256,
      "workflowSemanticSha256" = new_semantic_sha256
  WHERE "id" = target_namespace_id
    AND "providerInstanceRowId" = target_provider_row_id
    AND "namespaceEpoch" = target_namespace_epoch
    AND "secretName" = target_secret_name
    AND "githubRepositoryId" = target_repository_id
    AND "attestedRepositoryId" = target_repository_id
    AND "status" = 'active'
    AND NOT "permanentlyRetired"
    AND "workflowPath" = target_workflow_path
    AND "workflowSourceTrust" = target_source_trust
    AND "workflowSourceCommitSha" = old_commit_sha
    AND "workflowSourceBlobSha" = old_blob_sha
    AND "workflowSourceSha256" = old_source_sha256
    AND "workflowSemanticSha256" = old_semantic_sha256;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public."CodexOAuthDatabaseAuthorityReceipt"
    WHERE "databaseRole" = caller_role
      AND "backendPid" = pg_backend_pid()
      AND "transactionId" = txid_current()
      AND "effect" = 'active_namespace_v4_v5_reattestation'
      AND "ownerId" = transition_key
      AND "effectCode" = 0
      AND "consumedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_stale'
      USING ERRCODE = '40001';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION "codex_oauth_v4_v5_reattestation_transition"(
  TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_secret_namespace_tombstone_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"(
  TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

DO $$
DECLARE runtime_role TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_release_migration') THEN
    ALTER FUNCTION "codex_oauth_v4_v5_reattestation_transition"(
      TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT,
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
    ) OWNER TO reviewrouter_release_migration;
    ALTER FUNCTION "codex_oauth_secret_namespace_tombstone_guard"()
      OWNER TO reviewrouter_release_migration;
    ALTER FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"(
      TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
    ) OWNER TO reviewrouter_release_migration;
  END IF;

  FOREACH runtime_role IN ARRAY ARRAY[
    'reviewrouter_api', 'reviewrouter_worker', 'reviewrouter_codex_effect_authority'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"' ||
        '(text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_web') THEN
    GRANT EXECUTE ON FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"(
      TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
    ) TO reviewrouter_web;
  END IF;
END $$;

COMMIT;
