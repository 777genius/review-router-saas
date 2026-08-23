-- Hosted Codex security certification is additive. Migration 000074 is an
-- immutable release artifact and must not be rewritten.
BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Recreate rather than ALTER TYPE ... ADD VALUE so the new value can safely be
-- used by the populated backfill in this same transaction on every supported
-- PostgreSQL release.
DROP TRIGGER "HostedCodexRelayRequest_delete_guard" ON "HostedCodexRelayRequest";
DROP TRIGGER "HostedCodexRelayRequest_admission_guard" ON "HostedCodexRelayRequest";
DROP TRIGGER "HostedCodexRelayRequest_transition_guard" ON "HostedCodexRelayRequest";
DROP TRIGGER "HostedCodexRelayRequest_completion_accounting" ON "HostedCodexRelayRequest";
DROP TRIGGER "HostedCodexRelayRequest_success_fence" ON "HostedCodexRelayRequest";
ALTER TABLE "HostedCodexRelayRequest"
  DROP CONSTRAINT "HostedCodexRelayRequest_status_evidence_check";
ALTER TABLE "HostedCodexRelayRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "HostedCodexRelayRequestStatus" RENAME TO "HostedCodexRelayRequestStatus_pre_000075";
CREATE TYPE "HostedCodexRelayRequestStatus" AS ENUM (
  'received', 'processing', 'response_started', 'succeeded', 'failed',
  'terminal_unknown'
);
ALTER TABLE "HostedCodexRelayRequest"
  ALTER COLUMN "status" TYPE "HostedCodexRelayRequestStatus"
  USING ("status"::text::"HostedCodexRelayRequestStatus"),
  ALTER COLUMN "status" SET DEFAULT 'received';
DROP TYPE "HostedCodexRelayRequestStatus_pre_000075";
ALTER TABLE "HostedCodexRelayRequest"
  ADD CONSTRAINT "HostedCodexRelayRequest_status_evidence_check" CHECK (
    ("status" = 'received' AND "startedAt" IS NULL AND "completedAt" IS NULL
      AND "successfulResponseStartedAt" IS NULL
      AND "requestHash" IS NULL AND "responseBytes" IS NULL
      AND "responseHash" IS NULL AND "errorCode" IS NULL)
    OR
    ("status" = 'processing' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL
      AND "successfulResponseStartedAt" IS NULL
      AND "responseBytes" IS NULL AND "responseHash" IS NULL
      AND "errorCode" IS NULL)
    OR
    ("status" = 'response_started' AND "startedAt" IS NOT NULL
      AND "successfulResponseStartedAt" IS NOT NULL AND "completedAt" IS NULL
      AND "requestHash" IS NOT NULL
      AND "responseBytes" IS NOT NULL AND "responseBytes" >= 0
      AND "responseHash" IS NULL AND "errorCode" IS NULL)
    OR
    ("status" = 'succeeded' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
      AND "successfulResponseStartedAt" IS NOT NULL
      AND "requestHash" IS NOT NULL AND "responseBytes" >= 0
      AND "responseHash" IS NOT NULL AND "errorCode" IS NULL)
    OR
    ("status" = 'failed' AND "requestHash" IS NOT NULL
      AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
    OR
    ("status" = 'terminal_unknown' AND "completedAt" IS NOT NULL
      AND "errorCode" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION hosted_codex_relay_request_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
     OR NEW."idempotencyKeyHash" IS DISTINCT FROM OLD."idempotencyKeyHash"
     OR NEW."requestBytes" IS DISTINCT FROM OLD."requestBytes"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'hosted_codex_relay_request_identity_immutable';
  END IF;
  IF OLD."requestHash" IS NOT NULL
     AND NEW."requestHash" IS DISTINCT FROM OLD."requestHash" THEN
    RAISE EXCEPTION 'hosted_codex_relay_request_hash_immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'received'
       AND NEW."status" NOT IN ('processing', 'response_started', 'succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'processing'
       AND NEW."status" NOT IN ('response_started', 'succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'response_started'
       AND NEW."status" NOT IN ('succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" IN ('succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_terminal_status';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION hosted_codex_relay_completion_accounting()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $complete$
DECLARE completed_grant_id TEXT;
BEGIN
  IF NEW."status" NOT IN ('succeeded', 'failed', 'terminal_unknown')
     OR (TG_OP = 'UPDATE' AND OLD."status" IN ('succeeded', 'failed', 'terminal_unknown')) THEN
    RETURN NEW;
  END IF;
  UPDATE public."HostedCodexInvocationGrant" AS target_grant
  SET "inFlight" = target_grant."inFlight" - 1,
      "revision" = target_grant."revision" + 1,
      "updatedAt" = clock_timestamp()
  WHERE target_grant."id" = NEW."grantId" AND target_grant."inFlight" > 0
  RETURNING target_grant."id" INTO completed_grant_id;
  IF completed_grant_id IS NULL THEN
    RAISE EXCEPTION 'hosted_codex_relay_completion_accounting_conflict';
  END IF;
  RETURN NEW;
END
$complete$;

CREATE TRIGGER "HostedCodexRelayRequest_delete_guard"
  BEFORE DELETE ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_forbid_delete();
CREATE TRIGGER "HostedCodexRelayRequest_admission_guard"
  BEFORE INSERT ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_admission_guard();
CREATE TRIGGER "HostedCodexRelayRequest_transition_guard"
  BEFORE UPDATE ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_request_guard();
CREATE TRIGGER "HostedCodexRelayRequest_completion_accounting"
  AFTER INSERT OR UPDATE OF "status" ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_completion_accounting();
CREATE TRIGGER "HostedCodexRelayRequest_success_fence"
  AFTER INSERT OR UPDATE OF "successfulResponseStartedAt" ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION hosted_codex_relay_success_fence();

CREATE TYPE "HostedCodexUpstreamEffectState" AS ENUM (
  'prepared', 'dispatching', 'response_started', 'succeeded',
  'failed_no_effect', 'failed_classified', 'terminal_unknown'
);
CREATE TYPE "HostedCodexRestoreOperationState" AS ENUM (
  'witnessed', 'reconciling', 'reconciled', 'promoted', 'failed'
);
CREATE TYPE "HostedCodexRestoreItemState" AS ENUM (
  'pending', 'busy', 'rewrapped', 'promoted', 'failed'
);

-- Preserve every pre-certification envelope as immutable evidence. Legacy
-- rows intentionally have no KMS ARN/resource identity and cannot be served.
CREATE TABLE "HostedCodexCredentialEnvelopeRevision" (
  "id" TEXT NOT NULL,
  "credentialVersionId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "generation" BIGINT NOT NULL,
  "revision" BIGINT NOT NULL,
  "sourceRevision" BIGINT,
  "custodyMode" TEXT NOT NULL,
  "kmsKeyArn" TEXT,
  "kmsContextVersion" INTEGER NOT NULL,
  "databaseResourceIdentity" TEXT,
  "databaseIncarnation" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "envelopeVersion" INTEGER NOT NULL,
  "encryptionAlgorithm" TEXT NOT NULL,
  "aadHash" TEXT NOT NULL,
  "ciphertextHash" TEXT NOT NULL,
  "encryptedCiphertext" TEXT NOT NULL,
  "envelopeMetadata" JSONB NOT NULL,
  "fenceOwnerIdHash" TEXT,
  "fenceEpoch" BIGINT,
  "actorIdHash" TEXT NOT NULL,
  "idempotencyKeyHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexCredentialEnvelopeRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexCredentialEnvelopeRevision_values_check" CHECK (
    "generation" > 0 AND "revision" > 0 AND "kmsContextVersion" > 0
    AND "envelopeVersion" > 0
    AND length("databaseIncarnation") BETWEEN 16 AND 255
    AND "custodyMode" IN ('legacy_env', 'local_test', 'aws_kms')
    AND "reason" IN ('legacy_upgrade', 'credential_created', 'refresh', 'kms_rewrap', 'restore_reconciliation')
    AND "aadHash" ~ '^[a-f0-9]{64}$'
    AND "ciphertextHash" ~ '^[a-f0-9]{64}$'
    AND "actorIdHash" ~ '^[a-f0-9]{64}$'
    AND "idempotencyKeyHash" ~ '^[a-f0-9]{64}$'
    AND ("sourceRevision" IS NULL OR "sourceRevision" > 0)
    AND (("fenceOwnerIdHash" IS NULL AND "fenceEpoch" IS NULL)
      OR ("fenceOwnerIdHash" ~ '^[a-f0-9]{64}$' AND "fenceEpoch" > 0))
    AND (("custodyMode" IN ('legacy_env', 'local_test') AND "kmsKeyArn" IS NULL)
      OR ("custodyMode" = 'aws_kms'
        AND "kmsKeyArn" ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/(mrk-[0-9a-f]{32}|[0-9a-f-]{36})$'
        AND length("databaseResourceIdentity") BETWEEN 16 AND 255))
    AND jsonb_typeof("envelopeMetadata") = 'object'
    AND NOT ("envelopeMetadata" ?| ARRAY['plaintext', 'accessToken', 'refreshToken', 'secret'])
  )
);
CREATE UNIQUE INDEX "HostedCodexCredentialEnvelopeRevision_credential_revision_key"
  ON "HostedCodexCredentialEnvelopeRevision"("credentialVersionId", "revision");
CREATE UNIQUE INDEX "HostedCodexCredentialEnvelopeRevision_idempotency_key"
  ON "HostedCodexCredentialEnvelopeRevision"("idempotencyKeyHash");
CREATE INDEX "HostedCodexCredentialEnvelopeRevision_account_generation_idx"
  ON "HostedCodexCredentialEnvelopeRevision"("workspaceId", "poolId", "accountId", "generation", "revision");
ALTER TABLE "HostedCodexCredentialEnvelopeRevision"
  ADD CONSTRAINT "HostedCodexCredentialEnvelopeRevision_credential_tenant_fkey"
  FOREIGN KEY ("credentialVersionId", "accountId", "workspaceId", "poolId", "generation")
  REFERENCES "HostedCodexCredentialVersion"("id", "accountId", "workspaceId", "poolId", "generation")
  ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "HostedCodexCredentialEnvelopeRevision" (
  "id", "credentialVersionId", "accountId", "workspaceId", "poolId",
  "generation", "revision", "custodyMode", "kmsContextVersion",
  "databaseIncarnation", "reason", "envelopeVersion",
  "encryptionAlgorithm", "aadHash", "ciphertextHash",
  "encryptedCiphertext", "envelopeMetadata", "actorIdHash",
  "idempotencyKeyHash", "createdAt"
)
SELECT
  'legacy-' || md5(v."id"), v."id", v."accountId", v."workspaceId", v."poolId",
  v."generation", 1, 'legacy_env', 1, v."databaseIncarnation",
  'legacy_upgrade', v."envelopeVersion", v."encryptionAlgorithm", v."aadHash",
  v."ciphertextHash", v."encryptedCiphertext", v."envelopeMetadata",
  md5('legacy-actor:' || v."id") || md5('legacy-actor:' || v."id"),
  md5('legacy-idempotency:' || v."id") || md5('legacy-idempotency:' || v."id"),
  v."createdAt"
FROM "HostedCodexCredentialVersion" v;

CREATE TABLE "HostedCodexRestoreOperation" (
  "id" TEXT NOT NULL,
  "inventoryHash" TEXT NOT NULL,
  "databaseResourceIdentity" TEXT NOT NULL,
  "sourceIncarnation" TEXT NOT NULL,
  "targetIncarnation" TEXT NOT NULL,
  "sourceKmsKeyArn" TEXT NOT NULL,
  "targetKmsKeyArn" TEXT NOT NULL,
  "authorityKeyId" TEXT NOT NULL,
  "actorIdHash" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "permitExpiresAt" TIMESTAMP(3) NOT NULL,
  "state" "HostedCodexRestoreOperationState" NOT NULL DEFAULT 'witnessed',
  "itemCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconciliationStartedAt" TIMESTAMP(3),
  "reconciledAt" TIMESTAMP(3),
  "promotedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  CONSTRAINT "HostedCodexRestoreOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexRestoreOperation_scope_check" CHECK (
    "inventoryHash" ~ '^[a-f0-9]{64}$' AND "actorIdHash" ~ '^[a-f0-9]{64}$'
    AND "nonceHash" ~ '^[a-f0-9]{64}$' AND "itemCount" >= 0
    AND length("databaseResourceIdentity") BETWEEN 16 AND 255
    AND length("sourceIncarnation") BETWEEN 16 AND 255
    AND length("targetIncarnation") BETWEEN 16 AND 255
    AND "sourceIncarnation" <> "targetIncarnation"
    AND "sourceKmsKeyArn" ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/(mrk-[0-9a-f]{32}|[0-9a-f-]{36})$'
    AND "targetKmsKeyArn" ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/(mrk-[0-9a-f]{32}|[0-9a-f-]{36})$'
    AND length("authorityKeyId") BETWEEN 3 AND 255
  )
);
CREATE UNIQUE INDEX "HostedCodexRestoreOperation_nonce_key" ON "HostedCodexRestoreOperation"("nonceHash");
CREATE UNIQUE INDEX "HostedCodexRestoreOperation_inventory_target_key"
  ON "HostedCodexRestoreOperation"("inventoryHash", "databaseResourceIdentity", "targetIncarnation");

CREATE TABLE "HostedCodexRestoreItem" (
  "id" TEXT NOT NULL,
  "restoreOperationId" TEXT NOT NULL,
  "credentialVersionId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "generation" BIGINT NOT NULL,
  "sourceRevision" BIGINT NOT NULL,
  "sourceAadHash" TEXT NOT NULL,
  "sourceCiphertextHash" TEXT NOT NULL,
  "state" "HostedCodexRestoreItemState" NOT NULL DEFAULT 'pending',
  "targetRevision" BIGINT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "rewrappedAt" TIMESTAMP(3),
  "promotedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostedCodexRestoreItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexRestoreItem_values_check" CHECK (
    "generation" > 0 AND "sourceRevision" > 0 AND "attemptCount" >= 0
    AND "sourceAadHash" ~ '^[a-f0-9]{64}$'
    AND "sourceCiphertextHash" ~ '^[a-f0-9]{64}$'
    AND ("targetRevision" IS NULL OR "targetRevision" > "sourceRevision")
  )
);
CREATE UNIQUE INDEX "HostedCodexRestoreItem_operation_credential_key"
  ON "HostedCodexRestoreItem"("restoreOperationId", "credentialVersionId");
CREATE INDEX "HostedCodexRestoreItem_account_state_idx"
  ON "HostedCodexRestoreItem"("workspaceId", "poolId", "accountId", "state");
ALTER TABLE "HostedCodexRestoreItem"
  ADD CONSTRAINT "HostedCodexRestoreItem_operation_fkey"
  FOREIGN KEY ("restoreOperationId") REFERENCES "HostedCodexRestoreOperation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexRestoreItem_credential_tenant_fkey"
  FOREIGN KEY ("credentialVersionId", "accountId", "workspaceId", "poolId", "generation")
  REFERENCES "HostedCodexCredentialVersion"("id", "accountId", "workspaceId", "poolId", "generation")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexRestoreItem_account_tenant_fkey"
  FOREIGN KEY ("accountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every request/account dispatch has its own durable attempt. Binding columns
-- are immutable; state and heartbeat move only forward. Unknown dispatches are
-- terminal and cannot be reclaimed or resent.
CREATE UNIQUE INDEX "HostedCodexRelayRequest_id_grantId_key"
  ON "HostedCodexRelayRequest"("id", "grantId");
CREATE TABLE "HostedCodexUpstreamEffectAttempt" (
  "id" TEXT NOT NULL,
  "relayRequestId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "attemptOrdinal" INTEGER NOT NULL,
  "requestHash" TEXT NOT NULL,
  "idempotencyKeyHash" TEXT NOT NULL,
  "state" "HostedCodexUpstreamEffectState" NOT NULL DEFAULT 'prepared',
  "ownerIdHash" TEXT NOT NULL,
  "fenceEpoch" BIGINT NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "dispatchStartedAt" TIMESTAMP(3),
  "responseStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "providerResponseIdHash" TEXT,
  "terminalEvidenceHash" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostedCodexUpstreamEffectAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostedCodexUpstreamEffectAttempt_values_check" CHECK (
    "attemptOrdinal" > 0 AND "fenceEpoch" > 0
    AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "idempotencyKeyHash" ~ '^[a-f0-9]{64}$'
    AND "ownerIdHash" ~ '^[a-f0-9]{64}$'
    AND ("providerResponseIdHash" IS NULL OR "providerResponseIdHash" ~ '^[a-f0-9]{64}$')
    AND ("terminalEvidenceHash" IS NULL OR "terminalEvidenceHash" ~ '^[a-f0-9]{64}$')
    AND "leaseExpiresAt" > "createdAt"
  )
);
CREATE UNIQUE INDEX "HostedCodexUpstreamEffectAttempt_request_attempt_key"
  ON "HostedCodexUpstreamEffectAttempt"("relayRequestId", "attemptOrdinal");
CREATE UNIQUE INDEX "HostedCodexUpstreamEffectAttempt_idempotency_key"
  ON "HostedCodexUpstreamEffectAttempt"("idempotencyKeyHash");
CREATE INDEX "HostedCodexUpstreamEffectAttempt_sweep_idx"
  ON "HostedCodexUpstreamEffectAttempt"("state", "leaseExpiresAt", "id");
CREATE INDEX "HostedCodexUpstreamEffectAttempt_account_idx"
  ON "HostedCodexUpstreamEffectAttempt"("workspaceId", "poolId", "accountId", "state");
ALTER TABLE "HostedCodexUpstreamEffectAttempt"
  ADD CONSTRAINT "HostedCodexUpstreamEffectAttempt_request_fkey"
  FOREIGN KEY ("relayRequestId", "grantId") REFERENCES "HostedCodexRelayRequest"("id", "grantId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexUpstreamEffectAttempt_grant_tenant_fkey"
  FOREIGN KEY ("grantId", "workspaceId", "poolId")
  REFERENCES "HostedCodexInvocationGrant"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HostedCodexUpstreamEffectAttempt_account_tenant_fkey"
  FOREIGN KEY ("accountId", "workspaceId", "poolId")
  REFERENCES "HostedCodexAccount"("id", "workspaceId", "poolId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The fence row is a durable per-account sequence. Releasing it clears the
-- owner but never deletes the row or resets fenceEpoch.
ALTER TABLE "HostedCodexMutationFence"
  ALTER COLUMN "ownerIdHash" DROP NOT NULL,
  ALTER COLUMN "expectedGeneration" DROP NOT NULL,
  ALTER COLUMN "expiresAt" DROP NOT NULL,
  ADD COLUMN "releasedAt" TIMESTAMP(3),
  ADD COLUMN "releaseReason" TEXT,
  ADD CONSTRAINT "HostedCodexMutationFence_ownership_check" CHECK (
    ("ownerIdHash" IS NULL AND "expectedGeneration" IS NULL AND "expiresAt" IS NULL AND "releasedAt" IS NOT NULL)
    OR ("ownerIdHash" ~ '^[a-f0-9]{64}$' AND "expectedGeneration" > 0 AND "expiresAt" IS NOT NULL AND "releasedAt" IS NULL)
  );

-- Populated upgrade: deny every legacy credential, revoke outstanding grants,
-- and convert ambiguous relay rows without decrypting any envelope.
UPDATE "HostedCodexAccount"
SET "state" = 'restore_quarantined',
    "healthVersion" = "healthVersion" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "activeGeneration" IS NOT NULL
  AND "state" NOT IN ('restore_quarantined', 'tombstoned');

UPDATE "HostedCodexRelayRequest"
SET "status" = 'terminal_unknown',
    "errorCode" = 'security_certification_upgrade_unknown',
    "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('received', 'processing', 'response_started');

UPDATE "HostedCodexInvocationGrant"
SET "status" = 'revoked',
    "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP),
    "inFlight" = 0,
    "revision" = "revision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'issued';

CREATE FUNCTION "hosted_codex_evidence_no_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'hosted_codex_evidence_delete_forbidden' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION "hosted_codex_envelope_revision_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'hosted_codex_envelope_revision_immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION "hosted_codex_effect_attempt_monotonic"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_rank integer; new_rank integer;
BEGIN
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
END;
$$;

CREATE FUNCTION "hosted_codex_fence_monotonic"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."accountId" <> OLD."accountId" OR NEW."workspaceId" <> OLD."workspaceId"
    OR NEW."poolId" <> OLD."poolId" OR NEW."fenceEpoch" < OLD."fenceEpoch" THEN
    RAISE EXCEPTION 'hosted_codex_mutation_fence_regression' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."ownerIdHash" IS NOT NULL AND NEW."fenceEpoch" = OLD."fenceEpoch"
    AND NEW."ownerIdHash" IS NOT NULL
    AND NEW."ownerIdHash" IS DISTINCT FROM OLD."ownerIdHash" THEN
    RAISE EXCEPTION 'hosted_codex_mutation_fence_owner_change_without_epoch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "hosted_codex_restore_operation_monotonic"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_rank integer; new_rank integer;
BEGIN
  IF NEW."inventoryHash" <> OLD."inventoryHash"
    OR NEW."databaseResourceIdentity" <> OLD."databaseResourceIdentity"
    OR NEW."sourceIncarnation" <> OLD."sourceIncarnation"
    OR NEW."targetIncarnation" <> OLD."targetIncarnation"
    OR NEW."sourceKmsKeyArn" <> OLD."sourceKmsKeyArn"
    OR NEW."targetKmsKeyArn" <> OLD."targetKmsKeyArn"
    OR NEW."authorityKeyId" <> OLD."authorityKeyId"
    OR NEW."actorIdHash" <> OLD."actorIdHash" OR NEW."nonceHash" <> OLD."nonceHash"
    OR NEW."permitExpiresAt" <> OLD."permitExpiresAt" OR NEW."itemCount" <> OLD."itemCount"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_restore_operation_scope_immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  old_rank := CASE OLD."state" WHEN 'witnessed' THEN 0 WHEN 'reconciling' THEN 1 WHEN 'reconciled' THEN 2 ELSE 3 END;
  new_rank := CASE NEW."state" WHEN 'witnessed' THEN 0 WHEN 'reconciling' THEN 1 WHEN 'reconciled' THEN 2 ELSE 3 END;
  IF new_rank < old_rank OR (old_rank = 3 AND NEW."state" <> OLD."state") THEN
    RAISE EXCEPTION 'hosted_codex_restore_operation_transition_invalid' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "hosted_codex_restore_item_monotonic"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."restoreOperationId" <> OLD."restoreOperationId"
    OR NEW."credentialVersionId" <> OLD."credentialVersionId"
    OR NEW."accountId" <> OLD."accountId" OR NEW."workspaceId" <> OLD."workspaceId"
    OR NEW."poolId" <> OLD."poolId" OR NEW."generation" <> OLD."generation"
    OR NEW."sourceRevision" <> OLD."sourceRevision" OR NEW."sourceAadHash" <> OLD."sourceAadHash"
    OR NEW."sourceCiphertextHash" <> OLD."sourceCiphertextHash" OR NEW."createdAt" <> OLD."createdAt"
    OR NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'hosted_codex_restore_item_regression' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."state" = 'promoted' AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'hosted_codex_restore_item_terminal' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "HostedCodexCredentialEnvelopeRevision_no_update"
  BEFORE UPDATE ON "HostedCodexCredentialEnvelopeRevision"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_envelope_revision_immutable"();
CREATE TRIGGER "HostedCodexCredentialEnvelopeRevision_no_delete"
  BEFORE DELETE ON "HostedCodexCredentialEnvelopeRevision"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_evidence_no_delete"();
CREATE TRIGGER "HostedCodexUpstreamEffectAttempt_monotonic"
  BEFORE UPDATE ON "HostedCodexUpstreamEffectAttempt"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_effect_attempt_monotonic"();
CREATE TRIGGER "HostedCodexUpstreamEffectAttempt_no_delete"
  BEFORE DELETE ON "HostedCodexUpstreamEffectAttempt"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_evidence_no_delete"();
CREATE TRIGGER "HostedCodexMutationFence_monotonic"
  BEFORE UPDATE ON "HostedCodexMutationFence"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_fence_monotonic"();
CREATE TRIGGER "HostedCodexMutationFence_no_delete"
  BEFORE DELETE ON "HostedCodexMutationFence"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_evidence_no_delete"();
CREATE TRIGGER "HostedCodexRestoreOperation_monotonic"
  BEFORE UPDATE ON "HostedCodexRestoreOperation"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_restore_operation_monotonic"();
CREATE TRIGGER "HostedCodexRestoreOperation_no_delete"
  BEFORE DELETE ON "HostedCodexRestoreOperation"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_evidence_no_delete"();
CREATE TRIGGER "HostedCodexRestoreItem_monotonic"
  BEFORE UPDATE ON "HostedCodexRestoreItem"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_restore_item_monotonic"();
CREATE TRIGGER "HostedCodexRestoreItem_no_delete"
  BEFORE DELETE ON "HostedCodexRestoreItem"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_evidence_no_delete"();

COMMIT;
