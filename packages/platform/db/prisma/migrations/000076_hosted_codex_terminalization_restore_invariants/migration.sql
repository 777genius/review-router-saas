-- Close post-dispatch ambiguity and restore-state gaps without modifying the
-- published 000074 or 000075 migration artifacts.
BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- A fresh witnessed permit (and therefore a fresh nonce) creates a fresh,
-- immutable retry operation even when the inventory and target are unchanged.
DROP INDEX "HostedCodexRestoreOperation_inventory_target_key";
CREATE INDEX "HostedCodexRestoreOperation_inventory_target_idx"
  ON "HostedCodexRestoreOperation"("inventoryHash", "databaseResourceIdentity", "targetIncarnation");

CREATE OR REPLACE FUNCTION "hosted_codex_restore_operation_monotonic"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'witnessed' AND NEW."state" IN ('reconciling', 'failed'))
    OR (OLD."state" = 'reconciling' AND NEW."state" IN ('reconciled', 'failed'))
    OR (OLD."state" = 'reconciled' AND NEW."state" IN ('promoted', 'failed'))
  ) THEN
    RAISE EXCEPTION 'hosted_codex_restore_operation_transition_invalid' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."state" = 'failed' AND OLD."state" <> 'failed' AND EXISTS (
    SELECT 1 FROM public."HostedCodexRestoreItem" i
    WHERE i."restoreOperationId" = OLD."id" AND i."state" IN ('rewrapped', 'promoted')
  ) THEN
    -- A partially committed operation remains resumable under its witnessed
    -- permit. It cannot be abandoned into a mixed-key inventory that a fresh
    -- single-source permit could not bind completely.
    RAISE EXCEPTION 'hosted_codex_restore_partial_operation_must_resume' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."state" = 'promoted' AND OLD."state" <> 'promoted' AND (
    (SELECT count(*) FROM public."HostedCodexRestoreItem" i
      WHERE i."restoreOperationId" = OLD."id") <> OLD."itemCount"
    OR EXISTS (
      SELECT 1 FROM public."HostedCodexRestoreItem" i
      WHERE i."restoreOperationId" = OLD."id" AND i."state" <> 'promoted'
    )
    OR EXISTS (
      SELECT 1 FROM public."HostedCodexRestoreItem" i
      JOIN public."HostedCodexAccount" a ON a."id" = i."accountId"
      WHERE i."restoreOperationId" = OLD."id"
        AND (
          a."activeGeneration" <> i."generation" OR a."state" <> 'healthy'
          OR i."targetRevision" IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM public."HostedCodexCredentialEnvelopeRevision" r
            WHERE r."credentialVersionId" = i."credentialVersionId"
              AND r."revision" = i."targetRevision"
              AND r."databaseResourceIdentity" = NEW."databaseResourceIdentity"
              AND r."databaseIncarnation" = NEW."targetIncarnation"
              AND r."kmsKeyArn" = NEW."targetKmsKeyArn"
              AND NOT EXISTS (
                SELECT 1 FROM public."HostedCodexCredentialEnvelopeRevision" newer
                WHERE newer."credentialVersionId" = i."credentialVersionId"
                  AND newer."revision" > r."revision"
              )
          )
        )
    )
  ) THEN
    RAISE EXCEPTION 'hosted_codex_restore_promotion_inventory_incomplete' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "hosted_codex_restore_item_monotonic"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE operation_state public."HostedCodexRestoreOperationState";
DECLARE operation_count integer;
DECLARE operation_resource text;
DECLARE operation_incarnation text;
DECLARE operation_target_key text;
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
  IF NEW."targetRevision" IS DISTINCT FROM OLD."targetRevision" AND NOT (
    OLD."state" IN ('pending', 'busy') AND NEW."state" = 'rewrapped'
    AND OLD."targetRevision" IS NULL AND NEW."targetRevision" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'hosted_codex_restore_item_target_revision_immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'pending' AND NEW."state" IN ('busy', 'rewrapped', 'failed'))
    OR (OLD."state" = 'busy' AND NEW."state" IN ('rewrapped', 'failed'))
    OR (OLD."state" = 'rewrapped' AND NEW."state" = 'promoted')
  ) THEN
    RAISE EXCEPTION 'hosted_codex_restore_item_transition_invalid' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."state" = 'rewrapped' AND NEW."targetRevision" IS NULL THEN
    RAISE EXCEPTION 'hosted_codex_restore_item_target_revision_missing' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."state" = 'promoted' AND OLD."state" <> 'promoted' THEN
    SELECT o."state", o."itemCount", o."databaseResourceIdentity", o."targetIncarnation", o."targetKmsKeyArn"
      INTO operation_state, operation_count, operation_resource, operation_incarnation, operation_target_key
    FROM public."HostedCodexRestoreOperation" o
    WHERE o."id" = OLD."restoreOperationId";
    IF operation_state <> 'reconciled'
      OR (SELECT count(*) FROM public."HostedCodexRestoreItem" i
          WHERE i."restoreOperationId" = OLD."restoreOperationId") <> operation_count
      OR EXISTS (
        SELECT 1 FROM public."HostedCodexRestoreItem" i
        WHERE i."restoreOperationId" = OLD."restoreOperationId"
          AND i."id" <> OLD."id" AND i."state" NOT IN ('rewrapped', 'promoted')
      ) THEN
      RAISE EXCEPTION 'hosted_codex_restore_promotion_inventory_incomplete' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."targetRevision" IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."HostedCodexCredentialEnvelopeRevision" r
      JOIN public."HostedCodexAccount" a ON a."id" = NEW."accountId"
      WHERE r."credentialVersionId" = NEW."credentialVersionId"
        AND r."revision" = NEW."targetRevision"
        AND r."databaseResourceIdentity" = operation_resource
        AND r."databaseIncarnation" = operation_incarnation
        AND r."kmsKeyArn" = operation_target_key
        AND a."activeGeneration" = NEW."generation"
        AND NOT EXISTS (
          SELECT 1 FROM public."HostedCodexCredentialEnvelopeRevision" newer
          WHERE newer."credentialVersionId" = NEW."credentialVersionId"
            AND newer."revision" > r."revision"
        )
    ) THEN
      RAISE EXCEPTION 'hosted_codex_restore_promotion_inventory_incomplete' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Raw SQL, process crashes, and application code all share the same poison
-- boundary: a terminal-unknown relay row revokes every capability on its grant.
CREATE FUNCTION "hosted_codex_terminal_unknown_poison_grant"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."status" = 'terminal_unknown'
    AND (TG_OP = 'INSERT' OR OLD."status" <> 'terminal_unknown') THEN
    UPDATE public."HostedCodexInvocationGrant"
    SET "status" = 'revoked', "revokedAt" = COALESCE("revokedAt", NEW."completedAt", clock_timestamp()),
        "inFlight" = 0, "revision" = "revision" + 1, "updatedAt" = clock_timestamp()
    WHERE "id" = NEW."grantId" AND "status" = 'issued';
    UPDATE public."HostedCodexCommentRefreshCapability"
    SET "revokedAt" = COALESCE("revokedAt", NEW."completedAt", clock_timestamp()),
        "revision" = "revision" + 1, "updatedAt" = clock_timestamp()
    WHERE "grantId" = NEW."grantId" AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "HostedCodexRelayRequest_terminal_unknown_poison_grant"
  AFTER INSERT OR UPDATE OF "status" ON "HostedCodexRelayRequest"
  FOR EACH ROW EXECUTE FUNCTION "hosted_codex_terminal_unknown_poison_grant"();

-- Backfill the capability half of terminal rows created by 000075 before this
-- trigger existed. Grant revocation itself was already performed by 000075.
UPDATE "HostedCodexCommentRefreshCapability" c
SET "revokedAt" = COALESCE(c."revokedAt", g."revokedAt", clock_timestamp()),
    "revision" = c."revision" + 1,
    "updatedAt" = clock_timestamp()
FROM "HostedCodexInvocationGrant" g
WHERE c."grantId" = g."id" AND c."revokedAt" IS NULL
  AND (
    g."status" = 'revoked'
    OR EXISTS (
      SELECT 1 FROM "HostedCodexRelayRequest" r
      WHERE r."grantId" = g."id" AND r."status" = 'terminal_unknown'
    )
  );

COMMIT;
