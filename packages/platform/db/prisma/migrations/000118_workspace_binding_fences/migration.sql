-- C2a: independent policy versions and one retained fence intent per binding.
-- No gateway epoch, occupancy, allowance, transport or credential writes.
BEGIN;

ALTER TABLE "WorkspaceAccountBinding"
  ADD COLUMN "policyRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pendingFenceOperationId" TEXT,
  ADD COLUMN "pendingFencePolicySubject" TEXT,
  ADD COLUMN "pendingFencePolicyRevision" INTEGER,
  ADD COLUMN "fenceAckOperationId" TEXT,
  ADD COLUMN "fenceAckPolicyRevision" INTEGER;

-- DDL holds the table lock through COMMIT. Replace 117's trigger in this
-- transaction only; no writer can observe an unguarded binding. Existing CAS
-- versions are retained, while the NEW authorization version starts at 1.
DROP TRIGGER "WorkspaceAccountBinding_guard" ON "WorkspaceAccountBinding";
UPDATE "WorkspaceAccountBinding" SET
  "pendingFenceOperationId" = gen_random_uuid()::text,
  "pendingFencePolicySubject" = "id",
  "pendingFencePolicyRevision" = 1
WHERE "state" = 'revoked';

ALTER TABLE "WorkspaceAccountBinding"
  ADD CONSTRAINT "WorkspaceAccountBinding_policy_positive" CHECK ("policyRevision" > 0),
  ADD CONSTRAINT "WorkspaceAccountBinding_pending_fence_shape" CHECK (
    ("pendingFenceOperationId" IS NULL AND "pendingFencePolicySubject" IS NULL AND "pendingFencePolicyRevision" IS NULL)
    OR ("pendingFenceOperationId" IS NOT NULL AND "pendingFencePolicySubject" IS NOT NULL AND "pendingFencePolicyRevision" IS NOT NULL
      AND "pendingFenceOperationId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "pendingFencePolicySubject" = "id"
      AND "pendingFencePolicySubject" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "pendingFencePolicyRevision" BETWEEN 1 AND "policyRevision")
  ),
  ADD CONSTRAINT "WorkspaceAccountBinding_ack_shape" CHECK (
    ("fenceAckOperationId" IS NULL AND "fenceAckPolicyRevision" IS NULL)
    OR ("fenceAckOperationId" IS NOT NULL AND "fenceAckPolicyRevision" IS NOT NULL
      AND "fenceAckOperationId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "fenceAckPolicyRevision" BETWEEN 1 AND "policyRevision")
  ),
  ADD CONSTRAINT "WorkspaceAccountBinding_fence_monotonic" CHECK (
    "pendingFenceOperationId" IS NULL OR "fenceAckOperationId" IS NULL
    OR ("pendingFencePolicyRevision" > "fenceAckPolicyRevision"
      AND "pendingFenceOperationId" <> "fenceAckOperationId")
  ),
  ADD CONSTRAINT "WorkspaceAccountBinding_revoked_fenced" CHECK (
    "state" <> 'revoked' OR "pendingFenceOperationId" IS NOT NULL
    OR ("fenceAckOperationId" IS NOT NULL AND "fenceAckPolicyRevision" = "policyRevision")
  );

CREATE OR REPLACE FUNCTION workspace_account_binding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NEW."policyRevision" <> 1
      OR NEW."state" <> 'active'
      OR NEW."pendingFenceOperationId" IS NOT NULL
      OR NEW."pendingFencePolicySubject" IS NOT NULL
      OR NEW."pendingFencePolicyRevision" IS NOT NULL
      OR NEW."fenceAckOperationId" IS NOT NULL
      OR NEW."fenceAckPolicyRevision" IS NOT NULL THEN
      RAISE EXCEPTION 'workspace_account_binding_initial_revision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
      OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'workspace_account_binding_identity_immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."revision" = OLD."revision" AND NEW."policyRevision" = OLD."policyRevision" THEN
      -- Only exact ACK bookkeeping (or a no-op) may retain both versions.
      IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        RAISE EXCEPTION 'workspace_account_binding_ack_authority' USING ERRCODE = '23514';
      END IF;
      IF ROW(NEW."pendingFenceOperationId", NEW."pendingFencePolicySubject", NEW."pendingFencePolicyRevision", NEW."fenceAckOperationId", NEW."fenceAckPolicyRevision")
        IS DISTINCT FROM ROW(OLD."pendingFenceOperationId", OLD."pendingFencePolicySubject", OLD."pendingFencePolicyRevision", OLD."fenceAckOperationId", OLD."fenceAckPolicyRevision") THEN
        IF OLD."pendingFenceOperationId" IS NULL
          OR NEW."pendingFenceOperationId" IS NOT NULL
          OR NEW."pendingFencePolicySubject" IS NOT NULL
          OR NEW."pendingFencePolicyRevision" IS NOT NULL
          OR NEW."fenceAckOperationId" IS DISTINCT FROM OLD."pendingFenceOperationId"
          OR NEW."fenceAckPolicyRevision" IS DISTINCT FROM OLD."pendingFencePolicyRevision" THEN
          RAISE EXCEPTION 'workspace_account_binding_ack_conflict' USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSE
      IF NEW."revision"::bigint <> OLD."revision"::bigint + 1
        OR NEW."policyRevision"::bigint <> OLD."policyRevision"::bigint + 1 THEN
        RAISE EXCEPTION 'workspace_account_binding_revision_conflict' USING ERRCODE = '23514';
      END IF;
      -- A grant/revoke cannot also invent an ACK.
      IF ROW(NEW."fenceAckOperationId", NEW."fenceAckPolicyRevision")
        IS DISTINCT FROM ROW(OLD."fenceAckOperationId", OLD."fenceAckPolicyRevision") THEN
        RAISE EXCEPTION 'workspace_account_binding_ack_authority' USING ERRCODE = '23514';
      END IF;
      IF NEW."state" = 'revoked' THEN
        IF NEW."pendingFencePolicySubject" IS DISTINCT FROM NEW."id"
          OR NEW."pendingFencePolicyRevision" IS DISTINCT FROM NEW."policyRevision"
          OR NEW."pendingFenceOperationId" IS NULL
          OR NEW."pendingFenceOperationId" IS NOT DISTINCT FROM OLD."pendingFenceOperationId"
          OR NEW."pendingFenceOperationId" IS NOT DISTINCT FROM OLD."fenceAckOperationId" THEN
          RAISE EXCEPTION 'workspace_account_binding_revoke_intent' USING ERRCODE = '23514';
        END IF;
      ELSIF ROW(NEW."pendingFenceOperationId", NEW."pendingFencePolicySubject", NEW."pendingFencePolicyRevision")
        IS DISTINCT FROM ROW(OLD."pendingFenceOperationId", OLD."pendingFencePolicySubject", OLD."pendingFencePolicyRevision") THEN
        RAISE EXCEPTION 'workspace_account_binding_grant_drops_fence' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceAccountBinding_guard" BEFORE INSERT OR UPDATE ON "WorkspaceAccountBinding"
  FOR EACH ROW EXECUTE FUNCTION workspace_account_binding_guard();

COMMIT;
