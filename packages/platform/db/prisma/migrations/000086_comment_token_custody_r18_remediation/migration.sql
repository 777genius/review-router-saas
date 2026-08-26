BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "HostedCodexCommentTokenMint"
  ADD COLUMN "revocationFailureCount" integer NOT NULL DEFAULT 0,
  ADD COLUMN "nextRevocationAt" timestamptz(3) NOT NULL DEFAULT '1970-01-01 00:00:00+00';

CREATE INDEX "HostedCodexCommentTokenMint_revocation_queue_idx"
  ON "HostedCodexCommentTokenMint" ("state", "nextRevocationAt", "id");

-- Complete the custody prepare guard with facts that must never be accepted as
-- caller-supplied snapshots. The original guard has already acquired locks in
-- gate -> installation/repository/pool/binding/grant order; this final check
-- repeats that order and validates the omitted live-row relationships.
CREATE FUNCTION hosted_codex_comment_token_prepare_authority_complete()
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
    AND repository."visibility" IN ('private','internal')
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
REVOKE ALL ON FUNCTION hosted_codex_comment_token_prepare_authority_complete()
  FROM PUBLIC;
CREATE TRIGGER "HostedCodexCommentTokenMint_zz_prepare_authority_complete"
BEFORE INSERT ON "HostedCodexCommentTokenMint"
FOR EACH ROW EXECUTE FUNCTION hosted_codex_comment_token_prepare_authority_complete();

CREATE FUNCTION hosted_codex_lock_comment_token_mint(p_mint_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $lock_mint$
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_custody_role_required';
  END IF;
  PERFORM 1 FROM public."HostedCodexCommentTokenMint" mint
    WHERE mint."id"=p_mint_id FOR UPDATE;
  RETURN FOUND;
END
$lock_mint$;
REVOKE ALL ON FUNCTION hosted_codex_lock_comment_token_mint(text) FROM PUBLIC;

ALTER FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb)
  RENAME TO hosted_codex_mutate_comment_token_mint_v85;

CREATE FUNCTION hosted_codex_mutate_comment_token_mint(
  p_operation text, p_arguments jsonb
) RETURNS SETOF public."HostedCodexCommentTokenMint"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $mutate$
DECLARE database_now timestamptz := clock_timestamp();
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody'
     OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mutation_authority_invalid';
  END IF;
  IF p_operation='recover_stale' THEN
    IF jsonb_typeof(p_arguments->'limit') IS DISTINCT FROM 'number'
       OR p_arguments->>'limit' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'hosted_codex_comment_token_recovery_batch_invalid';
    END IF;
    IF (p_arguments->>'limit')::integer NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'hosted_codex_comment_token_recovery_batch_invalid';
    END IF;
    RETURN QUERY WITH candidates AS MATERIALIZED (
      SELECT mint."id", mint."state" AS original_state
      FROM public."HostedCodexCommentTokenMint" mint
      WHERE (mint."state"='prepared' AND mint."leaseExpiresAt"<=database_now)
         OR (mint."state"='dispatching'
          AND mint."leaseExpiresAt"<=database_now
          AND mint."dispatchAuthorizedUntil"<=database_now
          AND mint."unsafeUntil"<=database_now)
         OR (mint."state"='outcome_unknown' AND mint."unsafeUntil"<=database_now)
         OR (mint."state"='revoke_pending'
          AND greatest(mint."tokenExpiresAt"+interval '1 minute',mint."unsafeUntil")<=database_now)
      ORDER BY CASE mint."state"
          WHEN 'prepared' THEN mint."leaseExpiresAt"
          WHEN 'dispatching' THEN greatest(
            mint."leaseExpiresAt",mint."dispatchAuthorizedUntil",mint."unsafeUntil"
          )
          WHEN 'outcome_unknown' THEN mint."unsafeUntil"
          WHEN 'revoke_pending' THEN greatest(
            mint."tokenExpiresAt"+interval '1 minute',mint."unsafeUntil"
          )
        END,
        CASE mint."state"
          WHEN 'prepared' THEN 0
          WHEN 'dispatching' THEN 1
          WHEN 'outcome_unknown' THEN 2
          WHEN 'revoke_pending' THEN 3
        END,
        mint."id"
      FOR UPDATE OF mint SKIP LOCKED
      LIMIT (p_arguments->>'limit')::integer
    ) UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"=CASE candidates.original_state
        WHEN 'prepared' THEN 'failed_no_token'
        WHEN 'dispatching' THEN 'outcome_unknown'
        WHEN 'outcome_unknown' THEN 'expired'
        WHEN 'revoke_pending' THEN 'expired'
      END::public."HostedCodexCommentTokenMintState",
      "completedAt"=database_now,
      "terminalEvidenceHash"=CASE candidates.original_state
        WHEN 'prepared' THEN encode(pg_catalog.sha256(convert_to(
          'startup_recovery:prepared:'||mint."id",'UTF8')),'hex')
        WHEN 'outcome_unknown' THEN encode(pg_catalog.sha256(convert_to(
          'startup_recovery:outcome_unknown:'||mint."id",'UTF8')),'hex')
        WHEN 'revoke_pending' THEN encode(pg_catalog.sha256(convert_to(
          'startup_recovery:revoke_pending_expired:'||mint."id"||':'||
          greatest(mint."tokenExpiresAt"+interval '1 minute',mint."unsafeUntil")::text,
          'UTF8')),'hex')
        ELSE mint."terminalEvidenceHash"
      END,
      "errorCode"=CASE candidates.original_state
        WHEN 'prepared' THEN 'startup_recovery_prepared_lease_expired'
        WHEN 'dispatching' THEN 'startup_recovery_dispatch_ambiguity_elapsed'
        WHEN 'outcome_unknown' THEN 'startup_recovery_ambiguity_lifetime_elapsed'
        WHEN 'revoke_pending' THEN 'startup_recovery_revocation_safe_horizon_elapsed'
      END,
      "secretCiphertext"=CASE WHEN candidates.original_state='revoke_pending' THEN NULL ELSE mint."secretCiphertext" END,
      "secretEncryptedDataKey"=CASE WHEN candidates.original_state='revoke_pending' THEN NULL ELSE mint."secretEncryptedDataKey" END,
      "secretIv"=CASE WHEN candidates.original_state='revoke_pending' THEN NULL ELSE mint."secretIv" END,
      "secretAuthTag"=CASE WHEN candidates.original_state='revoke_pending' THEN NULL ELSE mint."secretAuthTag" END,
      "secretKeyId"=CASE WHEN candidates.original_state='revoke_pending' THEN NULL ELSE mint."secretKeyId" END,
      "secretAadHash"=CASE WHEN candidates.original_state='revoke_pending' THEN NULL ELSE mint."secretAadHash" END,
      "leaseExpiresAt"=database_now,"revision"=mint."revision"+1
    FROM candidates WHERE mint."id"=candidates."id" RETURNING mint.*;
    RETURN;
  END IF;
  IF p_operation='claim_revocations' THEN
    RETURN QUERY WITH candidates AS (
      SELECT mint."id" FROM public."HostedCodexCommentTokenMint" mint
      CROSS JOIN public."HostedCodexRuntimeGate" gate
      WHERE gate."id"='global' AND gate."status" IN ('closed','active')
        AND (mint."state"='revoke_pending' OR (gate."status"='closed' AND mint."state"='issued'))
        AND greatest(mint."tokenExpiresAt"+interval '1 minute',mint."unsafeUntil")>database_now
        AND mint."secretCiphertext" IS NOT NULL AND mint."secretEncryptedDataKey" IS NOT NULL
        AND mint."secretIv" IS NOT NULL AND mint."secretAuthTag" IS NOT NULL
        AND mint."secretKeyId" IS NOT NULL AND mint."secretAadHash" IS NOT NULL
        AND mint."leaseExpiresAt"<=database_now AND mint."nextRevocationAt"<=database_now
      ORDER BY mint."nextRevocationAt", mint."revocationFailureCount", mint."id"
      FOR UPDATE OF mint SKIP LOCKED LIMIT (p_arguments->>'limit')::integer
    ) UPDATE public."HostedCodexCommentTokenMint" mint SET
      "state"='revoke_pending',"ownerIdHash"=p_arguments->>'ownerIdHash',
      "fenceEpoch"=mint."fenceEpoch"+1,
      "leaseExpiresAt"=(p_arguments->>'leaseExpiresAt')::timestamptz,
      "revision"=mint."revision"+1
    FROM candidates WHERE mint."id"=candidates."id" RETURNING mint.*;
    RETURN;
  END IF;
  IF p_operation='release_revocation' THEN
    RETURN QUERY UPDATE public."HostedCodexCommentTokenMint" mint SET
      "revocationFailureCount"=least(mint."revocationFailureCount"+1,16),
      "nextRevocationAt"=database_now + least(
        interval '5 minutes',
        interval '5 seconds' * power(2,least(mint."revocationFailureCount",6))
      ),
      "leaseExpiresAt"=database_now,"errorCode"=p_arguments->>'errorCode',
      "revision"=mint."revision"+1
    WHERE mint."id"=p_arguments->>'mintId' AND mint."state"='revoke_pending'
      AND mint."ownerIdHash"=p_arguments->>'ownerIdHash'
      AND mint."fenceEpoch"=(p_arguments->>'fenceEpoch')::bigint
    RETURNING mint.*;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.hosted_codex_mutate_comment_token_mint_v85(
    p_operation,p_arguments
  );
END
$mutate$;

REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint_v85(text,jsonb)
  FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('reviewrouter_comment_token_custody') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint_v85(text,jsonb)
      FROM reviewrouter_comment_token_custody;
    GRANT EXECUTE ON FUNCTION hosted_codex_lock_comment_token_mint(text)
      TO reviewrouter_comment_token_custody;
    GRANT EXECUTE ON FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb)
      TO reviewrouter_comment_token_custody;
  END IF;
END
$acl$;

COMMIT;
