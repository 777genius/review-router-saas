BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Authority enqueueing is privileged only for its monotonic issued ->
-- revoke_pending transition. Runtime callers retain no mint-table authority.
CREATE OR REPLACE FUNCTION hosted_codex_comment_token_authority_revoke_enqueue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_TABLE_NAME = 'HostedCodexRepositoryBinding' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "repositoryBindingId"=OLD."id" AND "state"='issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexPool' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "poolId"=OLD."id" AND "state"='issued';
  ELSIF TG_TABLE_NAME = 'RepositoryConnection' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "repositoryConnectionId"=OLD."id" AND "state"='issued';
  ELSIF TG_TABLE_NAME = 'GitHubInstallation' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "githubInstallationRowId"=OLD."id" AND "state"='issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexInvocationGrant' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "grantId"=OLD."id" AND "state"='issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexCommentRefreshCapability' THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "capabilityId"=OLD."id" AND "state"='issued';
  ELSIF TG_TABLE_NAME = 'HostedCodexRuntimeGate'
      AND (NEW."authzEpoch" IS DISTINCT FROM OLD."authzEpoch"
        OR NEW."revision" IS DISTINCT FROM OLD."revision") THEN
    UPDATE public."HostedCodexCommentTokenMint" SET "state"='revoke_pending',"revision"="revision"+1
      WHERE "state"='issued';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION hosted_codex_comment_token_authority_revoke_enqueue() FROM PUBLIC;

-- A delivery claim is a DB-clock-fenced, short crash-recovery lease. Releasing
-- an expired claim and installing its successor happen in this one transaction.
CREATE FUNCTION hosted_codex_claim_comment_token_delivery(
  p_mint_id text, p_token_hash text, p_delivery_claim_id_hash text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $claim$
DECLARE database_now timestamptz := clock_timestamp();
DECLARE changed_count integer;
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_custody_role_required';
  END IF;
  IF p_delivery_claim_id_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_delivery_claim_invalid';
  END IF;
  UPDATE public."HostedCodexCommentTokenMint" mint SET
    "deliveryClaimIdHash"=NULL,"deliveryClaimExpiresAt"=NULL,"revision"=mint."revision"+1
  WHERE mint."id"=p_mint_id AND mint."tokenHash"=p_token_hash
    AND mint."state"='issued' AND mint."deliveryClaimIdHash" IS NOT NULL
    AND mint."deliveryClaimExpiresAt"<=database_now;
  UPDATE public."HostedCodexCommentTokenMint" mint SET
    "deliveredAt"=database_now,"deliveryClaimIdHash"=p_delivery_claim_id_hash,
    "deliveryClaimExpiresAt"=LEAST(mint."tokenExpiresAt",database_now+interval '30 seconds'),
    "revision"=mint."revision"+1
  WHERE mint."id"=p_mint_id AND mint."tokenHash"=p_token_hash
    AND mint."state"='issued' AND mint."tokenExpiresAt">database_now
    AND mint."deliveryClaimIdHash" IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count=1;
END
$claim$;
REVOKE ALL ON FUNCTION hosted_codex_claim_comment_token_delivery(text,text,text) FROM PUBLIC;

-- Preserve the v83 routine bytes and interpose the short delivery-claim lease
-- without reopening generic table DML to the custody login.
ALTER FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb)
  RENAME TO hosted_codex_mutate_comment_token_mint_v83;
CREATE FUNCTION hosted_codex_mutate_comment_token_mint(
  p_operation text, p_arguments jsonb
) RETURNS SETOF public."HostedCodexCommentTokenMint"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $mutate$
BEGIN
  IF session_user <> 'reviewrouter_comment_token_custody'
     OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'hosted_codex_comment_token_mutation_authority_invalid';
  END IF;
  IF p_operation='read_locked' THEN
    RETURN QUERY SELECT mint.*
      FROM public."HostedCodexCommentTokenMint" mint
      WHERE mint."id"=p_arguments->>'mintId'
      FOR UPDATE;
    RETURN;
  END IF;
  IF p_operation='claim_delivery' THEN
    IF public.hosted_codex_claim_comment_token_delivery(
      p_arguments->>'mintId',p_arguments->>'tokenHash',p_arguments->>'deliveryClaimIdHash'
    ) THEN
      RETURN QUERY SELECT mint.* FROM public."HostedCodexCommentTokenMint" mint
        WHERE mint."id"=p_arguments->>'mintId';
    END IF;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.hosted_codex_mutate_comment_token_mint_v83(
    p_operation,p_arguments
  );
END
$mutate$;
REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint_v83(text,jsonb)
  FROM PUBLIC;

DO $acl$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker'] LOOP
    IF to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I','HostedCodexCommentTokenMint',runtime_role);
    END IF;
  END LOOP;
  IF to_regrole('reviewrouter_comment_token_custody') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION hosted_codex_mutate_comment_token_mint_v83(text,jsonb)
      FROM reviewrouter_comment_token_custody;
    GRANT EXECUTE ON FUNCTION hosted_codex_claim_comment_token_delivery(text,text,text)
      TO reviewrouter_comment_token_custody;
    GRANT EXECUTE ON FUNCTION hosted_codex_mutate_comment_token_mint(text,jsonb)
      TO reviewrouter_comment_token_custody;
  END IF;
END
$acl$;

COMMIT;
