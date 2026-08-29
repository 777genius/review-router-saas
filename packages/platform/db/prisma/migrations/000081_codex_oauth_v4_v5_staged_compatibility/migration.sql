BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- 000079/000080 did not retain the exact V4 bytes after replacing an active
-- namespace with V5.  Applying this bridge after such a replacement would
-- create an unprovable compatibility gap, so admission fails closed instead
-- of synthesizing predecessor evidence.
DO $compatibility_admission$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."CodexOAuthProviderInstance" provider
    JOIN public."CodexOAuthSecretNamespace" namespace
      ON namespace."id" = provider."activeSecretNamespaceId"
    WHERE provider."state" = 'active'
      AND namespace."status" = 'active'
      AND NOT namespace."permanentlyRetired"
      AND namespace."workflowSchemaVersion" = 5
  ) THEN
    RAISE EXCEPTION 'codex_oauth_v4_v5_compatibility_predecessor_evidence_missing'
      USING ERRCODE = '55000';
  END IF;
END
$compatibility_admission$;

CREATE TABLE public."CodexOAuthWorkflowCompatibility" (
  "namespaceId" TEXT PRIMARY KEY,
  "workflowPath" TEXT NOT NULL,
  "workflowSourceCommitSha" TEXT NOT NULL,
  "workflowSourceBlobSha" TEXT NOT NULL,
  "workflowSourceSha256" TEXT NOT NULL,
  "workflowSemanticSha256" TEXT NOT NULL,
  "workflowSourceTrust" TEXT NOT NULL,
  "workflowSchemaVersion" INTEGER NOT NULL,
  "attestedRepositoryId" TEXT NOT NULL,
  "retireAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodexOAuthWorkflowCompatibility_namespace_fkey"
    FOREIGN KEY ("namespaceId") REFERENCES public."CodexOAuthSecretNamespace"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "CodexOAuthWorkflowCompatibility_v4_check"
    CHECK ("workflowSchemaVersion" = 4),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_trust_check"
    CHECK ("workflowSourceTrust" = 'trusted_default_branch_revision'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_path_check"
    CHECK ("workflowPath" ~ '^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_commit_check"
    CHECK ("workflowSourceCommitSha" ~ '^[a-f0-9]{40}$'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_blob_check"
    CHECK ("workflowSourceBlobSha" ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_source_digest_check"
    CHECK ("workflowSourceSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_semantic_digest_check"
    CHECK ("workflowSemanticSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_repository_check"
    CHECK ("attestedRepositoryId" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "CodexOAuthWorkflowCompatibility_retirement_check"
    CHECK ("retireAt" > "createdAt" AND "retireAt" <= "createdAt" + interval '25 hours')
);

CREATE INDEX "CodexOAuthWorkflowCompatibility_retire_at_idx"
  ON public."CodexOAuthWorkflowCompatibility"("retireAt");

CREATE FUNCTION public."codex_oauth_workflow_compatibility_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'codex_oauth_workflow_compatibility_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."CodexOAuthSecretNamespace" namespace
    JOIN public."CodexOAuthProviderInstance" provider
      ON provider."id" = namespace."providerInstanceRowId"
    WHERE namespace."id" = NEW."namespaceId"
      AND namespace."status" = 'active'
      AND NOT namespace."permanentlyRetired"
      AND namespace."workflowPath" = NEW."workflowPath"
      AND namespace."workflowSourceCommitSha" = NEW."workflowSourceCommitSha"
      AND namespace."workflowSourceBlobSha" = NEW."workflowSourceBlobSha"
      AND namespace."workflowSourceSha256" = NEW."workflowSourceSha256"
      AND namespace."workflowSemanticSha256" = NEW."workflowSemanticSha256"
      AND namespace."workflowSourceTrust" = NEW."workflowSourceTrust"
      AND namespace."workflowSchemaVersion" = 4
      AND namespace."attestedRepositoryId" = NEW."attestedRepositoryId"
      AND provider."state" = 'active'
      AND provider."activeSecretNamespaceId" = namespace."id"
      AND provider."activeSecretNamespaceEpoch" = namespace."namespaceEpoch"
      AND provider."activeSecretNamespaceName" = namespace."secretName"
      AND provider."mutationOwner" IS NULL
      AND provider."mutationOwnerId" IS NULL
      AND provider."activeLeaseId" IS NULL
  ) THEN
    RAISE EXCEPTION 'codex_oauth_workflow_compatibility_authority_invalid'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthWorkflowCompatibility_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."CodexOAuthWorkflowCompatibility"
FOR EACH ROW EXECUTE FUNCTION public."codex_oauth_workflow_compatibility_guard"();

-- Establish the rollback floor before removing the predecessor entry point.
-- REVOKE rejects every new old-consumer call; DROP then takes the routine DDL
-- lock and therefore waits for any already-running invocation to drain.
REVOKE EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"(
  TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

DO $v4_consumer_rollback_floor$
DECLARE runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker',
    'reviewrouter_codex_effect_authority'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"' ||
        '(text,text,text,text,bigint,text,text,text,text,text,integer,integer,' ||
        'text,text,text,text,text,text,text,text) FROM %I',
        runtime_role
      );
      IF has_function_privilege(
        runtime_role,
        'public.codex_oauth_reattest_active_namespace_v4_to_v5(text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text)',
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION 'codex_oauth_v4_consumer_rollback_floor_incomplete'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
END
$v4_consumer_rollback_floor$;

DROP FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"(
  TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"(
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
  new_semantic_sha256 TEXT,
  compatibility_window_seconds INTEGER
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
DECLARE compatibility_created_at TIMESTAMPTZ(3);
BEGIN
  SELECT table_owner.rolname INTO STRICT canonical_table_owner
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_roles table_owner ON table_owner.oid = relation.relowner
  WHERE relation.oid = 'public."CodexOAuthSecretNamespace"'::regclass;
  SELECT function_owner.rolname INTO STRICT canonical_function_owner
  FROM pg_catalog.pg_proc routine
  JOIN pg_catalog.pg_roles function_owner ON function_owner.oid = routine.proowner
  WHERE routine.oid =
    'public.codex_oauth_reattest_active_namespace_v4_to_v5(text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text,integer)'::regprocedure;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reviewrouter_web') THEN
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
     OR compatibility_window_seconds <> 90000
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
  JOIN public."CodexOAuthSetupPayloadClaim" claim ON claim."id" = attempt."claimId"
  WHERE attempt."id" = target_attempt_id
    AND attempt."status" = 'confirmed'
    AND claim."id" = target_claim_id
    AND claim."status" = 'active'
    AND claim."confirmedAttemptId" = target_attempt_id
    AND claim."providerInstanceRowId" = target_provider_row_id
    AND claim."githubRepositoryId" = target_repository_id
    AND claim."generationHash" = target_generation_hash
    AND attempt."namespaceId" = target_namespace_id
    AND (SELECT count(*) FROM public."CodexOAuthSetupPayloadClaim" active_claim
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
    AND (SELECT count(*) FROM public."CodexOAuthSecretNamespace" active_namespace
         WHERE active_namespace."providerInstanceRowId" = target_provider_row_id
           AND active_namespace."status" = 'active') = 1
  FOR UPDATE OF namespace;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public."CodexOAuthWorkflowCompatibility"
    WHERE "namespaceId" = target_namespace_id
  ) THEN
    RAISE EXCEPTION 'codex_oauth_active_namespace_reattestation_stale'
      USING ERRCODE = '40001';
  END IF;

  -- Start the fixed window at the activation insertion point, after every
  -- serialization lock.  One millisecond-normalized database-clock value is
  -- reused for both columns.
  compatibility_created_at := date_trunc('milliseconds', clock_timestamp());

  INSERT INTO public."CodexOAuthWorkflowCompatibility" (
    "namespaceId", "workflowPath", "workflowSourceCommitSha",
    "workflowSourceBlobSha", "workflowSourceSha256", "workflowSemanticSha256",
    "workflowSourceTrust", "workflowSchemaVersion", "attestedRepositoryId",
    "retireAt", "createdAt"
  ) VALUES (
    target_namespace_id, target_workflow_path, old_commit_sha, old_blob_sha,
    old_source_sha256, old_semantic_sha256, target_source_trust,
    expected_schema_version, target_repository_id,
    compatibility_created_at + make_interval(secs => compatibility_window_seconds),
    compatibility_created_at
  );

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

REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."codex_oauth_workflow_compatibility_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"(
  TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC;

DO $ownership$
DECLARE canonical_owner TEXT;
BEGIN
  SELECT owner.rolname INTO STRICT canonical_owner
  FROM pg_class relation JOIN pg_roles owner ON owner.oid = relation.relowner
  WHERE relation.oid = 'public."CodexOAuthSecretNamespace"'::regclass;
  EXECUTE format('ALTER TABLE public."CodexOAuthWorkflowCompatibility" OWNER TO %I', canonical_owner);
  EXECUTE format('ALTER FUNCTION public."codex_oauth_workflow_compatibility_guard"() OWNER TO %I', canonical_owner);
  EXECUTE format(
    'ALTER FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"' ||
    '(text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text,integer) OWNER TO %I',
    canonical_owner
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_web') THEN
    REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM reviewrouter_web;
    GRANT SELECT ON TABLE public."CodexOAuthWorkflowCompatibility" TO reviewrouter_web;
    GRANT EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"(
      TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
    ) TO reviewrouter_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_api') THEN
    REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM reviewrouter_api;
    GRANT SELECT ON TABLE public."CodexOAuthWorkflowCompatibility" TO reviewrouter_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_worker') THEN
    REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM reviewrouter_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_codex_effect_authority') THEN
    REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM reviewrouter_codex_effect_authority;
  END IF;
END
$ownership$;

COMMIT;
