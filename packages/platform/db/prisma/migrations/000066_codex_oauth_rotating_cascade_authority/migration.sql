BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Runtime table ACLs do not apply to referential actions. Protect the root
-- repository row and every rotating evidence row from DELETE cascades while
-- retaining the existing cascades for the non-LOGIN release owner and other
-- administrative maintenance callers.
CREATE FUNCTION "codex_oauth_runtime_referential_action_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user IN (
    'reviewrouter_api',
    'reviewrouter_web',
    'reviewrouter_worker',
    'reviewrouter_codex_effect_authority'
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'codex_oauth_runtime_referential_delete_forbidden'
        USING ERRCODE = '42501';
    END IF;

    -- These are precisely the RepositoryConnection columns changed by the
    -- Workspace/installation/SCM-identity parent FKs. The other
    -- repository identity columns remain repairable by the sanctioned routine.
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
       OR NEW."installationId" IS DISTINCT FROM OLD."installationId"
       OR NEW."gitlabInstallationId" IS DISTINCT FROM OLD."gitlabInstallationId"
       OR NEW."scmRepositoryIdentityId" IS DISTINCT FROM OLD."scmRepositoryIdentityId"
    THEN
      RAISE EXCEPTION 'codex_oauth_runtime_referential_update_forbidden'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "RepositoryConnection_runtime_referential_action_guard"
BEFORE UPDATE OF "id", "workspaceId", "installationId", "gitlabInstallationId", "scmRepositoryIdentityId"
OR DELETE ON "RepositoryConnection"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_runtime_referential_action_guard"();

DO $$
DECLARE evidence_table TEXT;
BEGIN
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
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION public."codex_oauth_runtime_referential_action_guard"()',
      evidence_table || '_cascade_guard',
      evidence_table
    );
  END LOOP;
END $$;

-- Complete upstream referential-action edge inventory (longer paths are the
-- transitive closure of these edges):
-- RepositoryConnection_workspaceId_fkey: Workspace -> RepositoryConnection
-- RepositoryConnection_installationId_fkey: GitHubInstallation -> RepositoryConnection
-- RepositoryConnection_gitlabInstallationId_fkey: GitLabInstallation -> RepositoryConnection
-- RepositoryConnection_scmRepositoryIdentityId_fkey: ScmRepositoryIdentity -> RepositoryConnection (key update; delete is RESTRICT)
-- CodexOAuthProviderInstance_workspaceId_fkey: Workspace -> ProviderInstance
-- CodexOAuthProviderInstance_repositoryId_fkey: RepositoryConnection -> ProviderInstance
-- CodexOAuthLease_workspaceId_fkey: Workspace -> Lease
-- CodexOAuthLease_repositoryId_fkey: RepositoryConnection -> Lease
-- CodexOAuthLease_providerInstanceRowId_fkey: ProviderInstance -> Lease
-- CodexOAuthSetupManifest_workspaceId_fkey: Workspace -> SetupManifest
-- CodexOAuthSetupManifest_repositoryId_fkey: RepositoryConnection -> SetupManifest
-- CodexOAuthSetupManifest_providerInstanceRowId_fkey: ProviderInstance -> SetupManifest
-- Restrict/NoAction edges from those nodes into payload claims, namespaces,
-- dispatch attempts, recovery requests, and writeback intents already stop
-- referential deletes. Root UPDATE/DELETE guards and evidence DELETE guards
-- cover every transitive path without weakening privileged maintenance.

CREATE FUNCTION "codex_oauth_provider_identity_transition"(
  provider_row_id TEXT,
  old_workspace_id TEXT,
  old_repository_id TEXT,
  old_provider_instance_id TEXT,
  old_auth_mode TEXT,
  old_secret_name TEXT,
  new_workspace_id TEXT,
  new_repository_id TEXT,
  new_provider_instance_id TEXT,
  new_auth_mode TEXT,
  new_secret_name TEXT
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_array(
    provider_row_id,
    old_workspace_id,
    old_repository_id,
    old_provider_instance_id,
    old_auth_mode,
    old_secret_name,
    new_workspace_id,
    new_repository_id,
    new_provider_instance_id,
    new_auth_mode,
    new_secret_name
  )::text;
END $$;

CREATE FUNCTION "codex_oauth_provider_identity_repair_challenge"(
  provider_row_id TEXT,
  old_workspace_id TEXT,
  old_repository_id TEXT,
  old_provider_instance_id TEXT,
  old_auth_mode TEXT,
  old_secret_name TEXT,
  old_repository_provider TEXT,
  old_github_repository_id BIGINT,
  old_external_repository_id TEXT,
  new_workspace_id TEXT,
  new_repository_id TEXT,
  new_provider_instance_id TEXT,
  new_auth_mode TEXT,
  new_secret_name TEXT,
  new_github_repository_id BIGINT
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public."codex_oauth_database_authority_challenge"(
    'provider_identity_repair_v2',
    jsonb_build_array(
      public."codex_oauth_provider_identity_transition"(
        provider_row_id, old_workspace_id, old_repository_id,
        old_provider_instance_id, old_auth_mode, old_secret_name,
        new_workspace_id, new_repository_id, new_provider_instance_id,
        new_auth_mode, new_secret_name
      ),
      old_repository_provider,
      old_github_repository_id,
      old_external_repository_id,
      'github',
      new_github_repository_id,
      new_github_repository_id::text
    )::text,
    0
  );
END $$;

-- Remove the split authorize-then-repair surface. Only the routine below can
-- mint the exact transition receipt, consume it through the identity trigger,
-- and resolve the quarantine row in one transaction.
DROP FUNCTION "codex_oauth_authorize_provider_identity_repair"(TEXT, TEXT);
DROP FUNCTION "codex_oauth_repair_quarantined_provider"(TEXT, BIGINT);

CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE repository_record RECORD;
DECLARE transition_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR
    NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR
    NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId" OR
    NEW."providerInstanceId" IS DISTINCT FROM OLD."providerInstanceId" OR
    NEW."authMode" IS DISTINCT FROM OLD."authMode" OR
    NEW."secretName" IS DISTINCT FROM OLD."secretName"
  ) THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" THEN
      RAISE EXCEPTION 'codex_oauth_provider_identity_authority_required'
        USING ERRCODE = '42501';
    END IF;
    transition_key := public."codex_oauth_provider_identity_transition"(
      OLD."id", OLD."workspaceId", OLD."repositoryId",
      OLD."providerInstanceId", OLD."authMode", OLD."secretName",
      NEW."workspaceId", NEW."repositoryId", NEW."providerInstanceId",
      NEW."authMode", NEW."secretName"
    );
    IF NOT (
      COALESCE(OLD."mutationOwner" = 'recovery', FALSE)
      AND EXISTS (
        SELECT 1
        FROM public."CodexOAuthProviderIdentityQuarantine" quarantine
        WHERE quarantine."providerInstanceRowId" = OLD."id"
          AND quarantine."resolvedAt" IS NULL
      )
      AND public."codex_oauth_consume_database_authority"(
        'provider_identity_repair_v2', transition_key, 0
      )
    ) THEN
      RAISE EXCEPTION 'codex_oauth_provider_identity_authority_required'
        USING ERRCODE = '42501';
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

CREATE FUNCTION "codex_oauth_repair_quarantined_provider"(
  provider_row_id TEXT,
  old_workspace_id TEXT,
  old_repository_id TEXT,
  old_provider_instance_id TEXT,
  old_auth_mode TEXT,
  old_secret_name TEXT,
  old_repository_provider TEXT,
  old_github_repository_id BIGINT,
  old_external_repository_id TEXT,
  new_workspace_id TEXT,
  new_repository_id TEXT,
  new_provider_instance_id TEXT,
  new_auth_mode TEXT,
  new_secret_name TEXT,
  new_github_repository_id BIGINT,
  target_signature TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE caller_role TEXT := session_user;
DECLARE provider_record RECORD;
DECLARE repository_record RECORD;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
DECLARE transition_key TEXT;
DECLARE affected_count INTEGER;
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

  SELECT provider.* INTO provider_record
  FROM public."CodexOAuthProviderInstance" provider
  JOIN public."CodexOAuthProviderIdentityQuarantine" quarantine
    ON quarantine."providerInstanceRowId" = provider."id"
   AND quarantine."resolvedAt" IS NULL
  WHERE provider."id" = provider_row_id
  FOR UPDATE OF provider, quarantine;
  IF NOT FOUND OR provider_record."mutationOwner" <> 'recovery'
     OR provider_record."workspaceId" IS DISTINCT FROM old_workspace_id
     OR provider_record."repositoryId" IS DISTINCT FROM old_repository_id
     OR provider_record."providerInstanceId" IS DISTINCT FROM old_provider_instance_id
     OR provider_record."authMode" IS DISTINCT FROM old_auth_mode
     OR provider_record."secretName" IS DISTINCT FROM old_secret_name
  THEN
    RAISE EXCEPTION 'codex_oauth_provider_quarantine_recovery_required'
      USING ERRCODE = '40001';
  END IF;

  IF new_repository_id IS DISTINCT FROM old_repository_id
     OR new_provider_instance_id IS DISTINCT FROM
        'codex-rotating:' || new_github_repository_id::text
     OR new_auth_mode <> 'codex_subscription_oauth_rotating'
     OR new_secret_name <> 'REVIEWROUTER_CODEX_AUTH_JSON'
     OR COALESCE(new_github_repository_id, 0) <= 0
  THEN
    RAISE EXCEPTION 'codex_oauth_provider_repair_target_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO repository_record
  FROM public."RepositoryConnection"
  WHERE "id" = old_repository_id
  FOR UPDATE;
  IF NOT FOUND
     OR repository_record."workspaceId" IS DISTINCT FROM new_workspace_id
     OR repository_record."provider"::text IS DISTINCT FROM old_repository_provider
     OR repository_record."githubRepositoryId" IS DISTINCT FROM old_github_repository_id
     OR repository_record."externalRepositoryId" IS DISTINCT FROM old_external_repository_id
  THEN
    RAISE EXCEPTION 'codex_oauth_provider_repair_repository_changed'
      USING ERRCODE = '40001';
  END IF;

  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey"
  WHERE "singleton" = TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) ||
    public."codex_oauth_provider_identity_repair_challenge"(
      provider_row_id, old_workspace_id, old_repository_id,
      old_provider_instance_id, old_auth_mode, old_secret_name,
      old_repository_provider, old_github_repository_id,
      old_external_repository_id, new_workspace_id, new_repository_id,
      new_provider_instance_id, new_auth_mode, new_secret_name,
      new_github_repository_id
    ) || chr(31) || authority_key,
    'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid'
      USING ERRCODE = '42501';
  END IF;

  SET CONSTRAINTS "RepositoryConnection_codex_oauth_identity_guard" DEFERRED;
  UPDATE public."RepositoryConnection"
  SET "provider" = 'github',
      "githubRepositoryId" = new_github_repository_id,
      "externalRepositoryId" = new_github_repository_id::text
  WHERE "id" = old_repository_id;

  transition_key := public."codex_oauth_provider_identity_transition"(
    provider_row_id, old_workspace_id, old_repository_id,
    old_provider_instance_id, old_auth_mode, old_secret_name,
    new_workspace_id, new_repository_id, new_provider_instance_id,
    new_auth_mode, new_secret_name
  );
  -- A repository-only quarantine can leave the provider identity canonical.
  -- In that case the signed repair still authorizes the parent repair, but no
  -- provider trigger fires and no provider-transition receipt may be minted.
  IF old_workspace_id IS DISTINCT FROM new_workspace_id
     OR old_repository_id IS DISTINCT FROM new_repository_id
     OR old_provider_instance_id IS DISTINCT FROM new_provider_instance_id
     OR old_auth_mode IS DISTINCT FROM new_auth_mode
     OR old_secret_name IS DISTINCT FROM new_secret_name
  THEN
    INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
      "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
    ) VALUES (
      caller_role, pg_backend_pid(), txid_current(),
      'provider_identity_repair_v2', transition_key, 0
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> 1 THEN
      RAISE EXCEPTION 'codex_oauth_database_authority_receipt_replay_forbidden'
        USING ERRCODE = '42501';
    END IF;

    UPDATE public."CodexOAuthProviderInstance"
    SET "workspaceId" = new_workspace_id,
        "repositoryId" = new_repository_id,
        "providerInstanceId" = new_provider_instance_id,
        "authMode" = new_auth_mode,
        "secretName" = new_secret_name
    WHERE "id" = provider_row_id;

    IF NOT EXISTS (
      SELECT 1 FROM public."CodexOAuthDatabaseAuthorityReceipt"
      WHERE "databaseRole" = caller_role
        AND "backendPid" = pg_backend_pid()
        AND "transactionId" = txid_current()
        AND "effect" = 'provider_identity_repair_v2'
        AND "ownerId" = transition_key
        AND "effectCode" = 0
        AND "consumedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'codex_oauth_provider_identity_authority_required'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public."CodexOAuthProviderIdentityQuarantine"
  SET "resolvedAt" = clock_timestamp()
  WHERE "providerInstanceRowId" = provider_row_id
    AND "resolvedAt" IS NULL;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'codex_oauth_provider_quarantine_recovery_required'
      USING ERRCODE = '40001';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION "codex_oauth_runtime_referential_action_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_provider_identity_transition"(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_provider_identity_repair_challenge"(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_provider_identity_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_provider"(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT
) FROM PUBLIC;

DO $$
DECLARE owned_function REGPROCEDURE;
DECLARE runtime_role TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_release_migration') THEN
    FOREACH owned_function IN ARRAY ARRAY[
      'public.codex_oauth_runtime_referential_action_guard()'::regprocedure,
      'public.codex_oauth_provider_identity_transition(text,text,text,text,text,text,text,text,text,text,text)'::regprocedure,
      'public.codex_oauth_provider_identity_repair_challenge(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint)'::regprocedure,
      'public.codex_oauth_provider_identity_guard()'::regprocedure,
      'public.codex_oauth_repair_quarantined_provider(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint,text)'::regprocedure
    ] LOOP
      EXECUTE format('ALTER FUNCTION %s OWNER TO reviewrouter_release_migration', owned_function);
    END LOOP;
  END IF;

  FOREACH runtime_role IN ARRAY ARRAY[
    'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker',
    'reviewrouter_codex_effect_authority'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public."codex_oauth_provider_identity_repair_challenge"' ||
        '(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public."codex_oauth_repair_quarantined_provider"' ||
        '(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint,text) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_web') THEN
    GRANT EXECUTE ON FUNCTION "codex_oauth_provider_identity_repair_challenge"(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT,
      TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT
    ) TO reviewrouter_web;
    GRANT EXECUTE ON FUNCTION "codex_oauth_repair_quarantined_provider"(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT,
      TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT
    ) TO reviewrouter_web;
  END IF;
END $$;

COMMIT;
