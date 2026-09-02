BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Re-state the security-definer trust boundary from 000079 with one additive
-- invariant: re-attestation may linearize only while no established provider
-- mutation owner (setup, recovery, or runtime) and no runtime lease exists.
CREATE OR REPLACE FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"(
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
DECLARE canonical_table_owner TEXT;
DECLARE canonical_function_owner TEXT;
DECLARE transition_key TEXT;
DECLARE affected_count INTEGER;
BEGIN
  SELECT table_owner.rolname INTO STRICT canonical_table_owner
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_roles table_owner ON table_owner.oid = relation.relowner
  WHERE relation.oid = 'public."CodexOAuthSecretNamespace"'::regclass;
  SELECT function_owner.rolname INTO STRICT canonical_function_owner
  FROM pg_catalog.pg_proc routine
  JOIN pg_catalog.pg_roles function_owner ON function_owner.oid = routine.proowner
  WHERE routine.oid =
    'public.codex_oauth_reattest_active_namespace_v4_to_v5(text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text)'::regprocedure;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
             WHERE rolname = 'reviewrouter_web') THEN
    IF caller_role <> 'reviewrouter_web' THEN
      RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_role_forbidden'
        USING ERRCODE = '42501';
    END IF;
  ELSIF canonical_function_owner <> canonical_table_owner
        OR caller_role <> canonical_function_owner THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_role_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF expected_schema_version IS NULL OR target_schema_version IS NULL
     OR target_provider_row_id IS NULL OR target_claim_id IS NULL
     OR target_attempt_id IS NULL OR target_namespace_id IS NULL
     OR target_namespace_epoch IS NULL OR target_secret_name IS NULL
     OR target_repository_id IS NULL OR target_generation_hash IS NULL
     OR target_workflow_path IS NULL OR target_source_trust IS NULL
     OR old_commit_sha IS NULL OR old_blob_sha IS NULL
     OR old_source_sha256 IS NULL OR old_semantic_sha256 IS NULL
     OR new_commit_sha IS NULL OR new_blob_sha IS NULL
     OR new_source_sha256 IS NULL OR new_semantic_sha256 IS NULL
     OR expected_schema_version <> 4 OR target_schema_version <> 5
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
    AND provider."activeSecretNamespaceId" = target_namespace_id
    AND provider."activeSecretNamespaceEpoch" = target_namespace_epoch
    AND provider."activeSecretNamespaceName" = target_secret_name
    AND provider."latestGenerationHash" = target_generation_hash
    AND provider."mutationOwner" IS NULL
    AND provider."mutationOwnerId" IS NULL
    AND provider."activeLeaseId" IS NULL
    AND repository."githubRepositoryId"::text = target_repository_id
  FOR UPDATE OF provider;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_stale'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1
  FROM public."CodexOAuthSetupDispatchAttempt" attempt
  JOIN public."CodexOAuthSetupPayloadClaim" claim
    ON claim."id" = attempt."claimId"
  WHERE attempt."id" = target_attempt_id
    AND attempt."status" = 'confirmed'
    AND claim."id" = target_claim_id
    AND claim."status" = 'active'
    AND claim."confirmedAttemptId" = target_attempt_id
    AND claim."providerInstanceRowId" = target_provider_row_id
    AND claim."githubRepositoryId" = target_repository_id
    AND (SELECT count(*)
         FROM public."CodexOAuthSetupPayloadClaim" active_claim
         WHERE active_claim."providerInstanceRowId" = target_provider_row_id
           AND active_claim."status" = 'active') = 1
  FOR UPDATE OF attempt, claim;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_stale'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1
  FROM public."CodexOAuthSecretNamespace" namespace
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
    AND namespace."workflowSchemaVersion" = expected_schema_version
    AND namespace."workflowSourceCommitSha" = old_commit_sha
    AND namespace."workflowSourceBlobSha" = old_blob_sha
    AND namespace."workflowSourceSha256" = old_source_sha256
    AND namespace."workflowSemanticSha256" = old_semantic_sha256
    AND (SELECT count(*)
         FROM public."CodexOAuthSecretNamespace" active_namespace
         WHERE active_namespace."providerInstanceRowId" = target_provider_row_id
           AND active_namespace."status" = 'active') = 1
  FOR UPDATE OF namespace;
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
      "workflowSemanticSha256" = new_semantic_sha256,
      "workflowSchemaVersion" = target_schema_version
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
    AND "workflowSchemaVersion" = expected_schema_version
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

COMMIT;
