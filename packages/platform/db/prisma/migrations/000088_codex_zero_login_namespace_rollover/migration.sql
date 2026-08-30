BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "CodexOAuthNamespaceRolloverIntent" (
  "id" text PRIMARY KEY,
  "operationId" text NOT NULL UNIQUE,
  "activeGlobalSlot" integer UNIQUE,
  "workspaceId" text NOT NULL,
  "repositoryId" text NOT NULL,
  "providerInstanceRowId" text NOT NULL,
  "providerInstanceId" text NOT NULL,
  "githubRepositoryId" text NOT NULL,
  "repositoryFullName" text NOT NULL,
  "state" text NOT NULL,
  "sourceRunId" text NOT NULL,
  "sourceRunAttempt" text NOT NULL,
  "expectedRerunAttempt" text NOT NULL,
  "sourceActionCommitSha" text NOT NULL,
  "sourceWorkflowCommitSha" text NOT NULL,
  "sourceDefaultHeadSha" text NOT NULL,
  "sourceActiveNamespaceId" text,
  "verifiedScheduleCompletedAt" timestamptz(3) NOT NULL,
  "releaseEvidenceId" text NOT NULL,
  "releaseEvidenceDigest" text NOT NULL,
  "targetActionCommitSha" text NOT NULL,
  "targetWorkflowSchemaVersion" integer NOT NULL,
  "renderOverlapEvidenceJson" jsonb NOT NULL,
  "candidateNamespaceId" text NOT NULL UNIQUE,
  "candidateNamespaceEpoch" bigint NOT NULL,
  "encryptedPayloadDigest" text,
  "writebackIdempotencyKey" text,
  "writebackGeneration" integer,
  "writebackGenerationHash" text,
  "writebackAccountIdentityHash" text,
  "executorOwner" text,
  "executorLeaseExpiresAt" timestamptz(3),
  "providerResponseCode" integer,
  "setupPullRequestUrl" text,
  "setupPullRequestNumber" integer,
  "setupPullRequestHeadSha" text,
  "setupPullRequestBaseBranch" text,
  "safeErrorCode" text,
  "createdAt" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" timestamptz(3) NOT NULL,
  "providerConfirmedAt" timestamptz(3),
  "setupPullRequestOpenedAt" timestamptz(3),
  "abortedAt" timestamptz(3),
  "activatedAt" timestamptz(3),
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_workspace_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT,
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_repository_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE RESTRICT,
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_provider_fkey"
    FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id") ON DELETE RESTRICT,
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_candidate_fkey"
    FOREIGN KEY ("candidateNamespaceId") REFERENCES "CodexOAuthSecretNamespace"("id") ON DELETE RESTRICT,
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_active_slot_check"
    CHECK ("activeGlobalSlot" IS NULL OR "activeGlobalSlot" = 1),
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_schema_v5_check"
    CHECK ("targetWorkflowSchemaVersion" = 5),
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_sha_check"
    CHECK ("sourceActionCommitSha" ~ '^[a-f0-9]{40}$'
      AND "sourceWorkflowCommitSha" ~ '^[a-f0-9]{40}$'
      AND "sourceDefaultHeadSha" ~ '^[a-f0-9]{40}$'
      AND "targetActionCommitSha" ~ '^[a-f0-9]{40}$'),
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_attempt_check"
    CHECK ("sourceRunAttempt" ~ '^[1-9][0-9]*$'
      AND "expectedRerunAttempt" ~ '^[1-9][0-9]*$'
      AND "expectedRerunAttempt"::numeric = "sourceRunAttempt"::numeric + 1),
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_state_check"
    CHECK ("state" IN ('prepared','put_authorized','provider_confirmed',
      'setup_pr_open','activated','aborted','provider_outcome_unknown')),
  CONSTRAINT "CodexOAuthNamespaceRolloverIntent_exact_rerun_key"
    UNIQUE ("providerInstanceRowId", "sourceRunId", "expectedRerunAttempt")
);

CREATE INDEX "CodexOAuthNamespaceRolloverIntent_provider_state_idx"
  ON "CodexOAuthNamespaceRolloverIntent" ("providerInstanceRowId", "state");

-- Defense in depth for the security-critical facts that must be derived from
-- live rows in the same transaction. No namespace is allocated here: prepare
-- can bind only a pre-existing E+1 candidate.
CREATE FUNCTION codex_oauth_zero_login_rollover_prepare_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE active_epoch bigint;
DECLARE max_epoch bigint;
BEGIN
  IF NEW."state" NOT IN ('prepared','provider_confirmed') OR NEW."activeGlobalSlot" <> 1 THEN
    RAISE EXCEPTION 'codex_zero_login_rollover_initial_state_invalid';
  END IF;
  SELECT provider."activeSecretNamespaceEpoch" INTO active_epoch
  FROM public."CodexOAuthProviderInstance" provider
  JOIN public."RepositoryConnection" repository
    ON repository."id" = provider."repositoryId"
  JOIN public."CodexOAuthSecretNamespace" candidate
    ON candidate."id" = NEW."candidateNamespaceId"
   AND candidate."providerInstanceRowId" = provider."id"
  WHERE provider."id" = NEW."providerInstanceRowId"
    AND provider."providerInstanceId" = NEW."providerInstanceId"
    AND provider."workspaceId" = NEW."workspaceId"
    AND provider."repositoryId" = NEW."repositoryId"
    AND repository."fullName" = NEW."repositoryFullName"
    AND repository."githubRepositoryId"::text = NEW."githubRepositoryId"
    AND candidate."namespaceEpoch" = NEW."candidateNamespaceEpoch"
    AND candidate."status" IN ('dispatch_authorized','confirmed_candidate')
    AND NOT candidate."permanentlyRetired"
  FOR UPDATE OF provider, candidate;
  SELECT max(namespace."namespaceEpoch") INTO max_epoch
  FROM public."CodexOAuthSecretNamespace" namespace
  WHERE namespace."providerInstanceRowId"=NEW."providerInstanceRowId";
  IF (NEW."state"='prepared' AND active_epoch IS NULL)
    OR NEW."candidateNamespaceEpoch" <> max_epoch
    OR NEW."candidateNamespaceEpoch" <= COALESCE(active_epoch, 0)
    OR EXISTS (
      SELECT 1 FROM public."CodexOAuthSecretNamespace" namespace
      WHERE namespace."providerInstanceRowId"=NEW."providerInstanceRowId"
        AND namespace."id"<>NEW."candidateNamespaceId"
        AND namespace."namespaceEpoch">COALESCE(active_epoch, 0)
        AND namespace."namespaceEpoch"<NEW."candidateNamespaceEpoch"
        AND NOT namespace."permanentlyRetired"
    ) THEN
    RAISE EXCEPTION 'codex_zero_login_rollover_candidate_not_existing_e_plus_1';
  END IF;
  IF NEW."state"='provider_confirmed' AND NOT EXISTS (
    SELECT 1 FROM public."CodexOAuthSetupDispatchAttempt" attempt
    JOIN public."CodexOAuthSetupPayloadClaim" claim ON claim."confirmedAttemptId"=attempt."id"
    JOIN public."CodexOAuthProviderInstance" provider ON provider."id"=claim."providerInstanceRowId"
    WHERE attempt."namespaceId"=NEW."candidateNamespaceId"
      AND attempt."status"='confirmed' AND claim."status"='confirmed_candidate'
      AND claim."confirmedAttemptId"=attempt."id"
      AND claim."accountIdentityAlgorithm"='provider_issuer_subject_account_v1'
      AND claim."accountIdentityHash"=provider."activeAccountIdentityHash"
      AND claim."generationHash"=provider."latestGenerationHash"
      AND claim."databaseRecoveryWitness"=(
        SELECT namespace."databaseRecoveryWitness"
        FROM public."CodexOAuthSecretNamespace" namespace
        WHERE namespace."id"=NEW."candidateNamespaceId"
      )
      AND provider."mutationOwner"='setup'
      AND provider."mutationOwnerId"=claim."manifestId"
  ) THEN RAISE EXCEPTION 'codex_zero_login_rollover_confirmed_candidate_unproven'; END IF;
  IF jsonb_array_length(NEW."renderOverlapEvidenceJson"->'services') <> 3 THEN
    RAISE EXCEPTION 'codex_zero_login_rollover_render_overlap_incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."renderOverlapEvidenceJson"->'services') service
    WHERE service->>'state' <> 'live'
       OR service->>'liveSaasCommitSha' !~ '^[a-f0-9]{40}$'
       OR service->>'canonicalEnvironmentDigest' !~ '^[a-f0-9]{64}$'
       OR NOT (service->'observedAllowedActionRefs' ?
         ('777genius/review-router@' || NEW."targetActionCommitSha"))
       OR NOT (service->'observedAllowedActionRefs' ?
         ('777genius/review-router@' || NEW."sourceActionCommitSha"))
  ) OR NOT ARRAY['web','api','worker']::text[] <@ ARRAY(
    SELECT service->>'service'
    FROM jsonb_array_elements(NEW."renderOverlapEvidenceJson"->'services') service
  ) THEN
    RAISE EXCEPTION 'codex_zero_login_rollover_render_overlap_incomplete';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION codex_oauth_zero_login_rollover_prepare_guard() FROM PUBLIC;
CREATE TRIGGER "CodexOAuthNamespaceRolloverIntent_prepare_guard"
BEFORE INSERT ON "CodexOAuthNamespaceRolloverIntent"
FOR EACH ROW EXECUTE FUNCTION codex_oauth_zero_login_rollover_prepare_guard();

-- An uncertain provider PUT is terminal for the candidate name. No automatic
-- retry or state transition can return it to the active path.
CREATE FUNCTION codex_oauth_zero_login_rollover_retire_unknown()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $retire$
BEGIN
  IF NEW."state" = 'provider_outcome_unknown' AND OLD."state" <> NEW."state" THEN
    UPDATE public."CodexOAuthSecretNamespace"
      SET "status"='retired_ambiguous', "permanentlyRetired"=true,
          "retiredAt"=clock_timestamp()
      WHERE "id"=NEW."candidateNamespaceId"
        AND NOT "permanentlyRetired";
    IF NOT FOUND AND NOT EXISTS (
      SELECT 1 FROM public."CodexOAuthSecretNamespace"
      WHERE "id"=NEW."candidateNamespaceId"
        AND "status"='retired_ambiguous' AND "permanentlyRetired"
    ) THEN
      RAISE EXCEPTION 'codex_zero_login_rollover_candidate_retirement_conflict';
    END IF;
    NEW."activeGlobalSlot" := NULL;
  END IF;
  RETURN NEW;
END
$retire$;
REVOKE ALL ON FUNCTION codex_oauth_zero_login_rollover_retire_unknown() FROM PUBLIC;
CREATE TRIGGER "CodexOAuthNamespaceRolloverIntent_retire_unknown"
BEFORE UPDATE ON "CodexOAuthNamespaceRolloverIntent"
FOR EACH ROW EXECUTE FUNCTION codex_oauth_zero_login_rollover_retire_unknown();

CREATE FUNCTION codex_oauth_zero_login_rollover_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $state_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'codex_zero_login_rollover_delete_forbidden';
  END IF;
  IF OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
    OR OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."operationId" IS DISTINCT FROM NEW."operationId"
    OR OLD."repositoryId" IS DISTINCT FROM NEW."repositoryId"
    OR OLD."githubRepositoryId" IS DISTINCT FROM NEW."githubRepositoryId"
    OR OLD."repositoryFullName" IS DISTINCT FROM NEW."repositoryFullName"
    OR OLD."providerInstanceRowId" IS DISTINCT FROM NEW."providerInstanceRowId"
    OR OLD."providerInstanceId" IS DISTINCT FROM NEW."providerInstanceId"
    OR OLD."sourceRunId" IS DISTINCT FROM NEW."sourceRunId"
    OR OLD."sourceRunAttempt" IS DISTINCT FROM NEW."sourceRunAttempt"
    OR OLD."expectedRerunAttempt" IS DISTINCT FROM NEW."expectedRerunAttempt"
    OR OLD."sourceActionCommitSha" IS DISTINCT FROM NEW."sourceActionCommitSha"
    OR OLD."sourceWorkflowCommitSha" IS DISTINCT FROM NEW."sourceWorkflowCommitSha"
    OR OLD."sourceDefaultHeadSha" IS DISTINCT FROM NEW."sourceDefaultHeadSha"
    OR OLD."sourceActiveNamespaceId" IS DISTINCT FROM NEW."sourceActiveNamespaceId"
    OR OLD."verifiedScheduleCompletedAt" IS DISTINCT FROM NEW."verifiedScheduleCompletedAt"
    OR OLD."releaseEvidenceDigest" IS DISTINCT FROM NEW."releaseEvidenceDigest"
    OR OLD."releaseEvidenceId" IS DISTINCT FROM NEW."releaseEvidenceId"
    OR OLD."renderOverlapEvidenceJson" IS DISTINCT FROM NEW."renderOverlapEvidenceJson"
    OR OLD."targetActionCommitSha" IS DISTINCT FROM NEW."targetActionCommitSha"
    OR OLD."targetWorkflowSchemaVersion" IS DISTINCT FROM NEW."targetWorkflowSchemaVersion"
    OR OLD."candidateNamespaceId" IS DISTINCT FROM NEW."candidateNamespaceId"
    OR OLD."candidateNamespaceEpoch" IS DISTINCT FROM NEW."candidateNamespaceEpoch"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN RAISE EXCEPTION 'codex_zero_login_rollover_immutable_identity_changed'; END IF;
  IF (OLD."encryptedPayloadDigest" IS NOT NULL AND OLD."encryptedPayloadDigest" IS DISTINCT FROM NEW."encryptedPayloadDigest")
    OR (OLD."writebackIdempotencyKey" IS NOT NULL AND OLD."writebackIdempotencyKey" IS DISTINCT FROM NEW."writebackIdempotencyKey")
    OR (OLD."writebackGeneration" IS NOT NULL AND OLD."writebackGeneration" IS DISTINCT FROM NEW."writebackGeneration")
    OR (OLD."writebackGenerationHash" IS NOT NULL AND OLD."writebackGenerationHash" IS DISTINCT FROM NEW."writebackGenerationHash")
    OR (OLD."writebackAccountIdentityHash" IS NOT NULL AND OLD."writebackAccountIdentityHash" IS DISTINCT FROM NEW."writebackAccountIdentityHash")
    OR (OLD."executorOwner" IS NOT NULL AND OLD."executorOwner" IS DISTINCT FROM NEW."executorOwner")
    OR (OLD."executorLeaseExpiresAt" IS NOT NULL AND OLD."executorLeaseExpiresAt" IS DISTINCT FROM NEW."executorLeaseExpiresAt")
    OR (OLD."providerResponseCode" IS NOT NULL AND OLD."providerResponseCode" IS DISTINCT FROM NEW."providerResponseCode")
    OR (OLD."providerConfirmedAt" IS NOT NULL AND OLD."providerConfirmedAt" IS DISTINCT FROM NEW."providerConfirmedAt")
    OR (OLD."setupPullRequestUrl" IS NOT NULL AND OLD."setupPullRequestUrl" IS DISTINCT FROM NEW."setupPullRequestUrl")
    OR (OLD."setupPullRequestNumber" IS NOT NULL AND OLD."setupPullRequestNumber" IS DISTINCT FROM NEW."setupPullRequestNumber")
    OR (OLD."setupPullRequestHeadSha" IS NOT NULL AND OLD."setupPullRequestHeadSha" IS DISTINCT FROM NEW."setupPullRequestHeadSha")
    OR (OLD."setupPullRequestBaseBranch" IS NOT NULL AND OLD."setupPullRequestBaseBranch" IS DISTINCT FROM NEW."setupPullRequestBaseBranch")
    OR (OLD."setupPullRequestOpenedAt" IS NOT NULL AND OLD."setupPullRequestOpenedAt" IS DISTINCT FROM NEW."setupPullRequestOpenedAt")
  THEN RAISE EXCEPTION 'codex_zero_login_rollover_staged_evidence_changed'; END IF;
  IF NOT (
    (OLD."state"='prepared' AND NEW."state" IN ('put_authorized','provider_confirmed','aborted')) OR
    (OLD."state"='put_authorized' AND NEW."state" IN ('provider_confirmed','aborted','provider_outcome_unknown')) OR
    (OLD."state"='provider_confirmed' AND NEW."state" = 'setup_pr_open') OR
    (OLD."state"='setup_pr_open' AND NEW."state" = 'activated')
  ) THEN RAISE EXCEPTION 'codex_zero_login_rollover_transition_invalid'; END IF;
  IF OLD."state"='put_authorized' AND NEW."state"='provider_confirmed'
    AND NOT EXISTS (
      SELECT 1 FROM public."CodexOAuthWritebackIntent" intent
      JOIN public."CodexOAuthSecretNamespace" candidate
        ON candidate."id"=intent."secretNamespaceId"
      WHERE intent."id"=OLD."id" AND intent."status"='pending'
        AND intent."providerResponseCode" IN (201,204)
        AND intent."providerConfirmedAt" IS NOT NULL
        AND candidate."id"=OLD."candidateNamespaceId"
        AND candidate."status"='confirmed_candidate'
    )
  THEN RAISE EXCEPTION 'codex_zero_login_rollover_provider_confirmation_unproven'; END IF;
  IF OLD."state"='put_authorized' AND NEW."state"='aborted'
    AND NOT EXISTS (
      SELECT 1 FROM public."CodexOAuthWritebackIntent" intent
      JOIN public."CodexOAuthSecretNamespace" candidate
        ON candidate."id"=intent."secretNamespaceId"
      WHERE intent."id"=OLD."id" AND intent."status"='failed'
        AND candidate."status"='retired_predispatch'
        AND candidate."permanentlyRetired"
    )
  THEN RAISE EXCEPTION 'codex_zero_login_rollover_predispatch_abort_unproven'; END IF;
  IF NEW."state"='setup_pr_open' AND (
    NEW."setupPullRequestNumber" IS NULL OR NEW."setupPullRequestUrl" IS NULL
    OR NEW."setupPullRequestHeadSha" !~ '^[a-f0-9]{40}$'
    OR NEW."setupPullRequestBaseBranch" IS NULL
  ) THEN RAISE EXCEPTION 'codex_zero_login_rollover_setup_pr_unproven'; END IF;
  IF NEW."state"='activated' AND NOT EXISTS (
    SELECT 1 FROM public."CodexOAuthSecretNamespace" candidate
    JOIN public."CodexOAuthProviderInstance" provider
      ON provider."id"=candidate."providerInstanceRowId"
    WHERE candidate."id"=OLD."candidateNamespaceId"
      AND candidate."status"='active'
      AND candidate."workflowSourceTrust"='trusted_default_branch_revision'
      AND provider."activeSecretNamespaceId"=candidate."id"
      AND provider."state"='active'
  ) THEN RAISE EXCEPTION 'codex_zero_login_rollover_activation_unproven'; END IF;
  IF (NEW."state" IN ('prepared','put_authorized','provider_confirmed','setup_pr_open'))
      IS DISTINCT FROM (NEW."activeGlobalSlot" = 1)
  THEN RAISE EXCEPTION 'codex_zero_login_rollover_active_slot_state_invalid'; END IF;
  RETURN NEW;
END
$state_guard$;
REVOKE ALL ON FUNCTION codex_oauth_zero_login_rollover_state_guard() FROM PUBLIC;
CREATE TRIGGER "CodexOAuthNamespaceRolloverIntent_state_guard"
BEFORE UPDATE ON "CodexOAuthNamespaceRolloverIntent"
FOR EACH ROW EXECUTE FUNCTION codex_oauth_zero_login_rollover_state_guard();
CREATE TRIGGER "CodexOAuthNamespaceRolloverIntent_delete_guard"
BEFORE DELETE ON "CodexOAuthNamespaceRolloverIntent"
FOR EACH ROW EXECUTE FUNCTION codex_oauth_zero_login_rollover_state_guard();

-- Preserve the normal API-only runtime-completion authority and its short
-- executor lease. Rollover activation gets a separate web-callable authority
-- below so web can never mint an ordinary runtime-completion receipt.
CREATE OR REPLACE FUNCTION "codex_oauth_authorize_runtime_completion"(
  target_intent_id TEXT, target_signature TEXT
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $completion$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
BEGIN
  IF caller_role NOT IN ('reviewrouter_api', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass))
  THEN RAISE EXCEPTION 'codex_oauth_database_authority_role_forbidden' USING ERRCODE = '42501'; END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey" WHERE "singleton"=TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) || public."codex_oauth_database_authority_challenge"(
      'runtime_completion', target_intent_id, 0
    ) || chr(31) || authority_key, 'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."CodexOAuthWritebackIntent" intent
    JOIN public."CodexOAuthProviderInstance" provider ON provider."id"=intent."providerInstanceRowId"
    JOIN public."CodexOAuthLease" lease ON lease."id"=intent."leaseId"
    WHERE intent."id"=target_intent_id AND intent."status"='pending'
      AND lease."providerInstanceRowId"=intent."providerInstanceRowId"
      AND provider."mutationOwner"='runtime'
      AND provider."mutationOwnerId"=intent."leaseId"
      AND provider."mutationEpoch"=intent."mutationEpoch"
      AND (
        (intent."providerResponseCode" IN (201,204)
         AND intent."providerConfirmedAt" IS NOT NULL
         AND intent."executorOwner" IS NOT NULL
         AND intent."executorLeaseExpiresAt" > clock_timestamp())
        OR (intent."dispatchAttemptId" IS NULL
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
  ) ON CONFLICT ("databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode")
  DO UPDATE SET "createdAt"=clock_timestamp(), "consumedAt"=NULL;
END
$completion$;

REVOKE EXECUTE ON FUNCTION "codex_oauth_authorize_runtime_completion"(TEXT, TEXT) FROM PUBLIC;

-- A merged setup PR can take days, so this durable authority deliberately has
-- no executor TTL. It is narrower than runtime completion: the exact rollover,
-- provider fence, finalized lease, confirmed candidate, provider response and
-- immutable setup-PR identity must all still agree in the same transaction.
CREATE FUNCTION "codex_oauth_authorize_rollover_completion"(
  target_intent_id TEXT,
  target_rollover_id TEXT,
  target_signature TEXT
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $rollover_completion$
DECLARE caller_role TEXT := session_user;
DECLARE authority_key TEXT;
DECLARE expected_signature TEXT;
DECLARE inserted_count INTEGER;
BEGIN
  IF caller_role NOT IN ('reviewrouter_web', 'reviewrouter_release_migration')
     AND caller_role <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public."CodexOAuthDatabaseAuthorityReceipt"'::regclass))
  THEN RAISE EXCEPTION 'codex_oauth_database_authority_role_forbidden' USING ERRCODE = '42501'; END IF;
  SELECT "keyMaterial" INTO STRICT authority_key
  FROM public."CodexOAuthDatabaseAuthorityKey" WHERE "singleton"=TRUE;
  expected_signature := encode(sha256(convert_to(
    authority_key || chr(31) || public."codex_oauth_database_authority_challenge"(
      'runtime_completion', target_intent_id, 0
    ) || chr(31) || authority_key, 'UTF8'
  )), 'hex');
  IF target_signature IS NULL OR target_signature <> expected_signature THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_signature_invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."CodexOAuthNamespaceRolloverIntent" rollover
    JOIN public."CodexOAuthWritebackIntent" intent ON intent."id"=rollover."id"
    JOIN public."CodexOAuthProviderInstance" provider ON provider."id"=rollover."providerInstanceRowId"
    JOIN public."CodexOAuthLease" lease ON lease."id"=intent."leaseId"
    JOIN public."CodexOAuthSecretNamespace" candidate ON candidate."id"=rollover."candidateNamespaceId"
    WHERE rollover."id"=target_rollover_id
      AND intent."id"=target_intent_id
      AND rollover."state"='setup_pr_open'
      AND rollover."activeGlobalSlot"=1
      AND rollover."providerInstanceRowId"=intent."providerInstanceRowId"
      AND rollover."candidateNamespaceId"=intent."secretNamespaceId"
      AND rollover."executorOwner"=intent."executorOwner"
      AND rollover."providerResponseCode"=intent."providerResponseCode"
      AND rollover."providerConfirmedAt"=intent."providerConfirmedAt"
      AND rollover."providerResponseCode" IN (201,204)
      AND rollover."setupPullRequestNumber" IS NOT NULL
      AND rollover."setupPullRequestUrl" IS NOT NULL
      AND rollover."setupPullRequestHeadSha" ~ '^[a-f0-9]{40}$'
      AND rollover."setupPullRequestBaseBranch" IS NOT NULL
      AND intent."status"='pending'
      AND intent."providerConfirmedAt" IS NOT NULL
      AND intent."executorOwner" IS NOT NULL
      AND lease."providerInstanceRowId"=intent."providerInstanceRowId"
      AND lease."status"='finalized'
      AND provider."activeLeaseId"=lease."id"
      AND provider."mutationOwner"='runtime'
      AND provider."mutationOwnerId"=intent."leaseId"
      AND provider."mutationEpoch"=intent."mutationEpoch"
      AND candidate."providerInstanceRowId"=provider."id"
      AND candidate."status"='confirmed_candidate'
      AND NOT candidate."permanentlyRetired"
  ) THEN
    RAISE EXCEPTION 'codex_oauth_rollover_completion_authority_invalid' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public."CodexOAuthDatabaseAuthorityReceipt" (
    "databaseRole", "backendPid", "transactionId", "effect", "ownerId", "effectCode"
  ) VALUES (
    caller_role, pg_backend_pid(), txid_current(), 'runtime_completion', target_intent_id, 0
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'codex_oauth_database_authority_receipt_replay_forbidden' USING ERRCODE = '42501';
  END IF;
END
$rollover_completion$;

REVOKE EXECUTE ON FUNCTION "codex_oauth_authorize_rollover_completion"(TEXT, TEXT, TEXT) FROM PUBLIC;

-- The new evidence ledger is not covered by historical grants. Runtime roles
-- get only the operations required by their service; nobody gets DELETE.
REVOKE ALL ON TABLE "CodexOAuthNamespaceRolloverIntent" FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reviewrouter_api') THEN
    REVOKE ALL ON TABLE "CodexOAuthNamespaceRolloverIntent" FROM reviewrouter_api;
    GRANT SELECT, INSERT, UPDATE ON TABLE "CodexOAuthNamespaceRolloverIntent" TO reviewrouter_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reviewrouter_web') THEN
    REVOKE ALL ON TABLE "CodexOAuthNamespaceRolloverIntent" FROM reviewrouter_web;
    GRANT SELECT, UPDATE ON TABLE "CodexOAuthNamespaceRolloverIntent" TO reviewrouter_web;
    GRANT EXECUTE ON FUNCTION "codex_oauth_authorize_rollover_completion"(TEXT, TEXT, TEXT) TO reviewrouter_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reviewrouter_worker') THEN
    REVOKE ALL ON TABLE "CodexOAuthNamespaceRolloverIntent" FROM reviewrouter_worker;
  END IF;
END
$acl$;

COMMIT;
