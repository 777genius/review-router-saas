BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "HostedCodexUpstreamEffectAttempt"
  ADD COLUMN "credentialGeneration" BIGINT;

ALTER TABLE "HostedCodexUpstreamEffectAttempt"
  ADD CONSTRAINT "HostedCodexUpstreamEffectAttempt_credential_generation_fkey"
  FOREIGN KEY ("accountId", "credentialGeneration")
  REFERENCES "HostedCodexCredentialVersion"("accountId", "generation")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "hosted_codex_effect_attempt_monotonic"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE old_rank integer; new_rank integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."credentialGeneration" IS NULL THEN
      RAISE EXCEPTION 'hosted_codex_effect_attempt_generation_required';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."credentialGeneration" IS DISTINCT FROM OLD."credentialGeneration" THEN
    RAISE EXCEPTION 'hosted_codex_effect_attempt_generation_immutable';
  END IF;
  IF NEW."relayRequestId" <> OLD."relayRequestId" OR NEW."grantId" <> OLD."grantId"
    OR NEW."workspaceId" <> OLD."workspaceId" OR NEW."poolId" <> OLD."poolId"
    OR NEW."accountId" <> OLD."accountId" OR NEW."attemptOrdinal" <> OLD."attemptOrdinal"
    OR NEW."requestHash" <> OLD."requestHash" OR NEW."idempotencyKeyHash" <> OLD."idempotencyKeyHash"
    OR NEW."ownerIdHash" <> OLD."ownerIdHash" OR NEW."fenceEpoch" <> OLD."fenceEpoch"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_effect_attempt_binding_immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  old_rank := CASE OLD."state" WHEN 'prepared' THEN 0 WHEN 'dispatching' THEN 1 WHEN 'response_started' THEN 2 ELSE 3 END;
  new_rank := CASE NEW."state" WHEN 'prepared' THEN 0 WHEN 'dispatching' THEN 1 WHEN 'response_started' THEN 2 ELSE 3 END;
  IF new_rank < old_rank OR (old_rank = 3 AND NEW."state" <> OLD."state")
    OR NEW."heartbeatAt" < OLD."heartbeatAt" OR NEW."leaseExpiresAt" < OLD."leaseExpiresAt" THEN
    RAISE EXCEPTION 'hosted_codex_effect_attempt_transition_invalid' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER "HostedCodexUpstreamEffectAttempt_monotonic"
  ON "HostedCodexUpstreamEffectAttempt";
CREATE TRIGGER "HostedCodexUpstreamEffectAttempt_monotonic"
  BEFORE INSERT OR UPDATE ON "HostedCodexUpstreamEffectAttempt"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_effect_attempt_monotonic"();

COMMIT;
