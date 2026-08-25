BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "HostedCodexInvocationGrant"
  ADD COLUMN "maxResponseBytes" INTEGER NOT NULL DEFAULT 8000000,
  ADD COLUMN "maxOutputTokens" INTEGER NOT NULL DEFAULT 32768,
  ADD CONSTRAINT "HostedCodexInvocationGrant_output_budget_check"
    CHECK (
      "maxResponseBytes" BETWEEN 1 AND 104857600
      AND "maxOutputTokens" BETWEEN 1 AND 100000
    );

CREATE FUNCTION hosted_codex_invocation_output_budget_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF NEW."maxResponseBytes" IS DISTINCT FROM OLD."maxResponseBytes"
     OR NEW."maxOutputTokens" IS DISTINCT FROM OLD."maxOutputTokens" THEN
    RAISE EXCEPTION 'hosted_codex_grant_output_budget_immutable';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexInvocationGrant_output_budget_guard"
  BEFORE UPDATE ON "HostedCodexInvocationGrant"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_invocation_output_budget_guard();

COMMIT;
