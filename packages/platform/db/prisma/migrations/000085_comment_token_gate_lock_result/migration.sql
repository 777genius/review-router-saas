BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Prisma's PostgreSQL driver cannot deserialize a void-valued projection.
-- Preserve the same narrow lock authority while returning a typed result that
-- the custody adapter can safely project at every call site.
DROP FUNCTION hosted_codex_lock_comment_token_runtime_gate();
CREATE FUNCTION hosted_codex_lock_comment_token_runtime_gate()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
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
  RETURN true;
END
$lock_gate$;
REVOKE ALL ON FUNCTION hosted_codex_lock_comment_token_runtime_gate() FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('reviewrouter_comment_token_custody') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION hosted_codex_lock_comment_token_runtime_gate()
      TO reviewrouter_comment_token_custody;
  END IF;
END
$acl$;

COMMIT;
