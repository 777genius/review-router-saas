BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Authority receipts are one-shot transaction capabilities. The original
-- authorizers used ON CONFLICT to refresh a receipt, which could reset a
-- consumed capability inside the same transaction. Only the single consume
-- transition from NULL to a timestamp is now permitted.
CREATE FUNCTION "codex_oauth_database_authority_receipt_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_receipt_replay_forbidden'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."databaseRole" IS DISTINCT FROM OLD."databaseRole"
     OR NEW."backendPid" IS DISTINCT FROM OLD."backendPid"
     OR NEW."transactionId" IS DISTINCT FROM OLD."transactionId"
     OR NEW."effect" IS DISTINCT FROM OLD."effect"
     OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
     OR NEW."effectCode" IS DISTINCT FROM OLD."effectCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL
  THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_receipt_replay_forbidden'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthDatabaseAuthorityReceipt_one_shot_guard"
BEFORE UPDATE OR DELETE ON "CodexOAuthDatabaseAuthorityReceipt"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_database_authority_receipt_guard"();

-- Provider identity repair requires evidence that the isolated effect signer
-- authorized this exact provider in this backend and transaction. Quarantine
-- rows and recovery owner flags remain necessary, but are never sufficient.
CREATE FUNCTION "codex_oauth_authorize_provider_identity_repair"(
  target_provider_instance_row_id TEXT,
  target_signature TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
DECLARE inserted_count INTEGER;
BEGIN
  IF caller_role NOT IN ('reviewrouter_web', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((
       SELECT relowner FROM pg_class
       WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass
     ))
  THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_role_forbidden'
      USING ERRCODE = '42501';
  END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey"
  WHERE "singleton" = TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) || public."codex_oauth_database_authority_challenge"(
      'provider_identity_repair', target_provider_instance_row_id, 0
    ) || chr(31) || authority_key,
    'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."CodexOAuthProviderInstance" provider
    JOIN public."CodexOAuthProviderIdentityQuarantine" quarantine
      ON quarantine."providerInstanceRowId" = provider."id"
     AND quarantine."resolvedAt" IS NULL
    WHERE provider."id" = target_provider_instance_row_id
      AND provider."mutationOwner" = 'recovery'
      AND provider."mutationOwnerId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'codex_oauth_provider_quarantine_recovery_required'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
    "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
  ) VALUES (
    caller_role, pg_backend_pid(), txid_current(),
    'provider_identity_repair', target_provider_instance_row_id, 0
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_receipt_replay_forbidden'
      USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE repository_record RECORD;
DECLARE identity_changed BOOLEAN := FALSE;
DECLARE repair_evidence_matches BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    identity_changed :=
      NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR
      NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId" OR
      NEW."providerInstanceId" IS DISTINCT FROM OLD."providerInstanceId" OR
      NEW."authMode" IS DISTINCT FROM OLD."authMode" OR
      NEW."secretName" IS DISTINCT FROM OLD."secretName";
    IF identity_changed THEN
      SELECT COALESCE(OLD."mutationOwner" = 'recovery', FALSE) AND EXISTS (
        SELECT 1
        FROM public."CodexOAuthProviderIdentityQuarantine" quarantine
        WHERE quarantine."providerInstanceRowId" = OLD."id"
          AND quarantine."resolvedAt" IS NULL
      ) INTO repair_evidence_matches;
      IF repair_evidence_matches THEN
        repair_evidence_matches := public."codex_oauth_consume_database_authority"(
          'provider_identity_repair', OLD."id", 0
        );
      END IF;
      IF NOT repair_evidence_matches THEN
        RAISE EXCEPTION 'codex_oauth_provider_identity_authority_required'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  SELECT "workspaceId", "provider", "githubRepositoryId"
  INTO repository_record
  FROM public."RepositoryConnection"
  WHERE "id" = NEW."repositoryId"
  FOR SHARE;
  IF NOT FOUND OR repository_record."provider"::text <> 'github'
     OR repository_record."githubRepositoryId" IS NULL
     OR NEW."workspaceId" <> repository_record."workspaceId"
     OR NEW."providerInstanceId" <> 'codex-rotating:' || repository_record."githubRepositoryId"::text
     OR NEW."authMode" <> 'codex_subscription_oauth_rotating'
     OR NEW."secretName" <> 'REVIEWROUTER_CODEX_AUTH_JSON'
  THEN
    RAISE EXCEPTION 'codex_oauth_provider_identity_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "codex_oauth_repair_quarantined_provider"(
  target_provider_instance_row_id TEXT,
  target_github_repository_id BIGINT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE provider_record RECORD;
DECLARE repository_record RECORD;
BEGIN
  SELECT * INTO provider_record
  FROM public."CodexOAuthProviderInstance"
  WHERE "id" = target_provider_instance_row_id
  FOR UPDATE;
  IF NOT FOUND OR provider_record."mutationOwner" <> 'recovery'
     OR NOT EXISTS (
       SELECT 1 FROM public."CodexOAuthProviderIdentityQuarantine" quarantine
       WHERE quarantine."providerInstanceRowId" = provider_record."id"
         AND quarantine."resolvedAt" IS NULL
     )
  THEN
    RAISE EXCEPTION 'codex_oauth_provider_quarantine_recovery_required'
      USING ERRCODE = '40001';
  END IF;
  SELECT * INTO repository_record
  FROM public."RepositoryConnection"
  WHERE "id" = provider_record."repositoryId"
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_oauth_provider_quarantine_repository_invalid';
  END IF;
  IF repository_record."provider"::text <> 'github'
     OR repository_record."githubRepositoryId" IS NULL
  THEN
    IF COALESCE(target_github_repository_id, 0) <= 0 THEN
      RAISE EXCEPTION 'codex_oauth_provider_quarantine_repository_identity_required';
    END IF;
    SET CONSTRAINTS "RepositoryConnection_codex_oauth_identity_guard" DEFERRED;
    UPDATE public."RepositoryConnection"
    SET "provider" = 'github',
        "githubRepositoryId" = target_github_repository_id,
        "externalRepositoryId" = target_github_repository_id::text
    WHERE "id" = repository_record."id";
    SELECT * INTO repository_record
    FROM public."RepositoryConnection"
    WHERE "id" = provider_record."repositoryId";
  ELSIF repository_record."externalRepositoryId"
        IS DISTINCT FROM repository_record."githubRepositoryId"::text
  THEN
    SET CONSTRAINTS "RepositoryConnection_codex_oauth_identity_guard" DEFERRED;
    UPDATE public."RepositoryConnection"
    SET "externalRepositoryId" = repository_record."githubRepositoryId"::text
    WHERE "id" = repository_record."id";
    SELECT * INTO repository_record
    FROM public."RepositoryConnection"
    WHERE "id" = provider_record."repositoryId";
  END IF;
  UPDATE public."CodexOAuthProviderInstance"
  SET "workspaceId" = repository_record."workspaceId",
      "providerInstanceId" = 'codex-rotating:' || repository_record."githubRepositoryId"::text,
      "authMode" = 'codex_subscription_oauth_rotating',
      "secretName" = 'REVIEWROUTER_CODEX_AUTH_JSON'
  WHERE "id" = provider_record."id";
  UPDATE public."CodexOAuthProviderIdentityQuarantine"
  SET "resolvedAt" = CURRENT_TIMESTAMP
  WHERE "providerInstanceRowId" = provider_record."id";
END $$;

REVOKE EXECUTE ON FUNCTION "codex_oauth_database_authority_receipt_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_authorize_provider_identity_repair"(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_provider_identity_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_provider"(TEXT, BIGINT) FROM PUBLIC;

DO $$
DECLARE runtime_role TEXT;
DECLARE evidence_table TEXT;
DECLARE protected_column RECORD;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      FOREACH evidence_table IN ARRAY ARRAY[
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
        EXECUTE format(
          'REVOKE DELETE ON TABLE public.%I FROM %I',
          evidence_table, runtime_role
        );
      END LOOP;
      EXECUTE format(
        'REVOKE UPDATE ON TABLE public."CodexOAuthProviderInstance" FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT UPDATE ("state","latestGeneration","latestGenerationHash",' ||
        '"activeLeaseId","activeLeaseExpiresAt","mutationEpoch",' ||
        '"mutationOwner","mutationOwnerId","activeSecretNamespaceId",' ||
        '"activeSecretNamespaceEpoch","activeSecretNamespaceName",' ||
        '"activeAccountIdentityHash","updatedAt") ' ||
        'ON TABLE public."CodexOAuthProviderInstance" TO %I',
        runtime_role
      );
      FOREACH evidence_table IN ARRAY ARRAY[
        'CodexOAuthChildIdentityQuarantine',
        'CodexOAuthProviderIdentityQuarantine'
      ] LOOP
        EXECUTE format(
          'REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I',
          evidence_table, runtime_role
        );
        FOR protected_column IN
          SELECT attribute.attname
          FROM pg_attribute attribute
          WHERE attribute.attrelid = format('public.%I', evidence_table)::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        LOOP
          EXECUTE format(
            'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM %I',
            protected_column.attname,
            protected_column.attname,
            protected_column.attname,
            evidence_table,
            runtime_role
          );
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_web') THEN
    GRANT EXECUTE ON FUNCTION "codex_oauth_authorize_provider_identity_repair"(TEXT, TEXT)
      TO reviewrouter_web;
    GRANT EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_provider"(TEXT, BIGINT)
      TO reviewrouter_web;
  END IF;
END $$;

COMMIT;
