BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "HostedCodexRuntimeGateStatus" AS ENUM ('closed', 'active');

CREATE TABLE "HostedCodexRuntimeGate" (
  "id" TEXT NOT NULL,
  "status" "HostedCodexRuntimeGateStatus" NOT NULL DEFAULT 'closed',
  "authzEpoch" BIGINT NOT NULL DEFAULT 1,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "reasonCode" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL,
  "changedByHash" TEXT NOT NULL,
  CONSTRAINT "HostedCodexRuntimeGate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexRuntimeGate_singleton_check" CHECK ("id" = 'global'),
  CONSTRAINT "HostedCodexRuntimeGate_authority_check" CHECK (
    "authzEpoch" > 0 AND "revision" > 0
    AND length("reasonCode") BETWEEN 1 AND 160
    AND "changedByHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX "HostedCodexRuntimeGate_authority_idx"
  ON "HostedCodexRuntimeGate"("status", "authzEpoch", "revision");

INSERT INTO "HostedCodexRuntimeGate" (
  "id", "status", "authzEpoch", "revision", "reasonCode", "changedAt", "changedByHash"
) VALUES (
  'global', 'closed', 1, 1, 'migration_closed', CURRENT_TIMESTAMP,
  '550647576b36ed5a602a9e6dca0f2a486838834d99e6316367f68e926ffb8d6f'
);

CREATE FUNCTION hosted_codex_runtime_gate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hosted_codex_runtime_gate_delete_forbidden';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."revision" <> OLD."revision" + 1
     OR NEW."authzEpoch" <> OLD."authzEpoch" + 1
     OR NEW."changedAt" <= OLD."changedAt"
     OR (
       NEW."reasonCode" IS NOT DISTINCT FROM OLD."reasonCode"
       AND NEW."status" = OLD."status"
     ) THEN
    RAISE EXCEPTION 'hosted_codex_runtime_gate_transition_invalid';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "HostedCodexRuntimeGate_transition_guard"
  BEFORE UPDATE OR DELETE ON "HostedCodexRuntimeGate"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_runtime_gate_guard();

ALTER TABLE "HostedCodexInvocationGrant"
  ADD COLUMN "runtimeAuthzEpoch" BIGINT;

UPDATE "HostedCodexInvocationGrant"
SET "status" = 'revoked',
    "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP),
    "revision" = "revision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('issued', 'exhausted');

UPDATE "HostedCodexCommentRefreshCapability" AS capability
SET "revokedAt" = COALESCE(capability."revokedAt", CURRENT_TIMESTAMP),
    "revision" = capability."revision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "HostedCodexInvocationGrant" AS invocation_grant
WHERE capability."grantId" = invocation_grant."id"
  AND invocation_grant."runtimeAuthzEpoch" IS NULL
  AND capability."revokedAt" IS NULL;

CREATE OR REPLACE FUNCTION hosted_codex_invocation_grant_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."runtimeAuthzEpoch" IS NULL OR NEW."runtimeAuthzEpoch" < 1 THEN
      RAISE EXCEPTION 'hosted_codex_runtime_gate_epoch_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public."HostedCodexRuntimeGate" gate
      WHERE gate."id" = 'global'
        AND gate."status" = 'active'
        AND gate."authzEpoch" = NEW."runtimeAuthzEpoch"
    ) THEN
      RAISE EXCEPTION 'hosted_codex_runtime_gate_authority_mismatch';
    END IF;
    IF NEW."failoverCount" <> 0
       OR NEW."activeAccountId" IS DISTINCT FROM NEW."primaryAccountId"
       OR NEW."backupAccountId" IS NOT NULL AND NEW."backupAccountId" = NEW."primaryAccountId"
       OR NEW."firstSuccessfulResponseAt" IS NOT NULL THEN
      RAISE EXCEPTION 'hosted_codex_grant_invalid_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."invocationId" IS DISTINCT FROM OLD."invocationId"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."repositoryConnectionId" IS DISTINCT FROM OLD."repositoryConnectionId"
     OR NEW."repositoryBindingId" IS DISTINCT FROM OLD."repositoryBindingId"
     OR NEW."primaryAccountId" IS DISTINCT FROM OLD."primaryAccountId"
     OR NEW."backupAccountId" IS DISTINCT FROM OLD."backupAccountId"
     OR NEW."reviewRequestId" IS DISTINCT FROM OLD."reviewRequestId"
     OR NEW."providerInvocationKey" IS DISTINCT FROM OLD."providerInvocationKey"
     OR NEW."runId" IS DISTINCT FROM OLD."runId" OR NEW."runAttempt" IS DISTINCT FROM OLD."runAttempt"
     OR NEW."model" IS DISTINCT FROM OLD."model" OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
     OR NEW."policyFingerprint" IS DISTINCT FROM OLD."policyFingerprint"
     OR NEW."runtimeConfigVersion" IS DISTINCT FROM OLD."runtimeConfigVersion"
     OR NEW."bindingRevision" IS DISTINCT FROM OLD."bindingRevision" OR NEW."authzEpoch" IS DISTINCT FROM OLD."authzEpoch"
     OR NEW."runtimeAuthzEpoch" IS DISTINCT FROM OLD."runtimeAuthzEpoch"
     OR NEW."capabilityTokenHash" IS DISTINCT FROM OLD."capabilityTokenHash"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."maxRequests" IS DISTINCT FROM OLD."maxRequests"
     OR NEW."maxConcurrentRequests" IS DISTINCT FROM OLD."maxConcurrentRequests"
     OR NEW."maxRequestBytes" IS DISTINCT FROM OLD."maxRequestBytes"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_grant_identity_immutable';
  END IF;
  IF OLD."firstSuccessfulResponseAt" IS NOT NULL
     AND NEW."firstSuccessfulResponseAt" IS DISTINCT FROM OLD."firstSuccessfulResponseAt" THEN
    RAISE EXCEPTION 'hosted_codex_first_success_immutable';
  END IF;
  IF NEW."activeAccountId" IS DISTINCT FROM OLD."activeAccountId" THEN
    IF OLD."firstSuccessfulResponseAt" IS NOT NULL OR NEW."firstSuccessfulResponseAt" IS NOT NULL
       OR OLD."failoverCount" <> 0 OR NEW."failoverCount" <> 1
       OR OLD."activeAccountId" IS DISTINCT FROM OLD."primaryAccountId"
       OR OLD."backupAccountId" IS NULL OR NEW."activeAccountId" IS DISTINCT FROM OLD."backupAccountId" THEN
      RAISE EXCEPTION 'hosted_codex_grant_failover_forbidden';
    END IF;
  ELSIF NEW."failoverCount" IS DISTINCT FROM OLD."failoverCount"
        OR NEW."primaryAccountId" IS DISTINCT FROM OLD."primaryAccountId"
        OR NEW."backupAccountId" IS DISTINCT FROM OLD."backupAccountId" THEN
    RAISE EXCEPTION 'hosted_codex_grant_failover_evidence_invalid';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    OLD."status" = 'issued'
    OR (OLD."status" = 'exhausted' AND NEW."status" = 'revoked')
  ) THEN
    RAISE EXCEPTION 'hosted_codex_grant_terminal_status';
  END IF;
  RETURN NEW;
END
$guard$;

COMMIT;
