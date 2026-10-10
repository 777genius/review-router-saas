-- Disabled H C2b. Safe receipts and immutable personal binding lifetime only.
-- No credentials, provider/runtime effects or historical migration changes.
BEGIN;

ALTER TABLE "ProviderAccountConnection"
  ADD COLUMN "authorizationEpochMirror" BIGINT,
  ADD COLUMN "pendingSourceOperationId" TEXT,
  ADD CONSTRAINT "ProviderAccountConnection_epoch_bounded" CHECK (
    "authorizationEpochMirror" IS NULL OR "authorizationEpochMirror" BETWEEN 1 AND 9007199254740991);
CREATE UNIQUE INDEX "ProviderAccountConnection_pendingSourceOperationId_key"
  ON "ProviderAccountConnection"("pendingSourceOperationId");

CREATE TABLE "PersonalAccountOperation" (
  "id" TEXT PRIMARY KEY,
  "actorUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "clientOperationId" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('connect', 'attach', 'revoke')),
  "personalWorkspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "proposedSourceId" TEXT, -- Scalar reservation, never an FK to an absent source.
  "sourceId" TEXT REFERENCES "ProviderAccountConnection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "targetWorkspaceId" TEXT REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "profileId" TEXT,
  "displayName" TEXT,
  "ingress" TEXT,
  "normalizedIntentHash" TEXT NOT NULL CHECK ("normalizedIntentHash" ~ '^[a-f0-9]{64}$'),
  "expectedSourceMetadataRevision" INTEGER,
  "expectedGatewayRevision" BIGINT CHECK ("expectedGatewayRevision" IS NULL OR "expectedGatewayRevision" BETWEEN 1 AND 9007199254740991),
  "predecessorBindingId" TEXT REFERENCES "WorkspaceAccountBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "expectedPredecessorRevision" INTEGER,
  "bindingId" TEXT REFERENCES "WorkspaceAccountBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "expectedBindingRevision" INTEGER,
  "resultSourceId" TEXT REFERENCES "ProviderAccountConnection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "resultBindingId" TEXT REFERENCES "WorkspaceAccountBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "phase" TEXT NOT NULL CHECK ("phase" IN ('reserved', 'submitted', 'unknown', 'rejected', 'applied')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PersonalAccountOperation_safe_refs" CHECK (
    "id" ~ '^rrpo_[a-f0-9]{64}$' AND "clientOperationId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  CONSTRAINT "PersonalAccountOperation_intent_shape" CHECK (
    ("action" = 'connect' AND "proposedSourceId" IS NOT NULL
      AND "proposedSourceId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "sourceId" IS NULL AND "targetWorkspaceId" IS NULL
      AND "profileId" IS NOT NULL AND "profileId" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND "displayName" IS NOT NULL AND length("displayName") BETWEEN 1 AND 120
      AND "displayName" = btrim("displayName") AND octet_length("displayName") <= 400
      AND "displayName" !~ '[[:cntrl:]]' AND "ingress" IS NOT NULL AND "ingress" IN ('api-key-create', 'oauth-begin')
      AND "expectedSourceMetadataRevision" IS NULL AND "expectedGatewayRevision" IS NULL
      AND "predecessorBindingId" IS NULL AND "expectedPredecessorRevision" IS NULL
      AND "bindingId" IS NULL AND "expectedBindingRevision" IS NULL)
    OR ("action" IN ('attach', 'revoke') AND "proposedSourceId" IS NULL
      AND "sourceId" IS NOT NULL AND "targetWorkspaceId" IS NOT NULL
      AND "profileId" IS NULL AND "displayName" IS NULL AND "ingress" IS NULL
      AND "expectedGatewayRevision" IS NOT NULL
      AND "expectedSourceMetadataRevision" IS NOT NULL AND "expectedSourceMetadataRevision" BETWEEN 1 AND 2147483646
      AND (("action" = 'attach' AND "bindingId" IS NULL AND "expectedBindingRevision" IS NULL
        AND (("predecessorBindingId" IS NULL AND "expectedPredecessorRevision" IS NULL)
          OR ("predecessorBindingId" IS NOT NULL AND "expectedPredecessorRevision" IS NOT NULL AND "expectedPredecessorRevision" BETWEEN 1 AND 2147483646)))
        OR ("action" = 'revoke' AND "predecessorBindingId" IS NULL AND "expectedPredecessorRevision" IS NULL
          AND "bindingId" IS NOT NULL AND "expectedBindingRevision" IS NOT NULL AND "expectedBindingRevision" BETWEEN 1 AND 2147483646)))
  ),
  CONSTRAINT "PersonalAccountOperation_result_shape" CHECK (
    ("phase" <> 'applied' AND "resultSourceId" IS NULL AND "resultBindingId" IS NULL AND "action" = 'connect')
    OR ("phase" = 'applied' AND "resultSourceId" IS NOT NULL AND "resultBindingId" IS NOT NULL
      AND (("action" = 'connect' AND "resultSourceId" = "proposedSourceId")
        OR ("action" = 'attach' AND "resultSourceId" = "sourceId")
        OR ("action" = 'revoke' AND "resultSourceId" = "sourceId" AND "resultBindingId" = "bindingId")))
  )
);
CREATE UNIQUE INDEX "PersonalAccountOperation_actorUserId_clientOperationId_key"
  ON "PersonalAccountOperation"("actorUserId", "clientOperationId");
CREATE UNIQUE INDEX "PersonalAccountOperation_proposedSourceId_key"
  ON "PersonalAccountOperation"("proposedSourceId");
CREATE UNIQUE INDEX "PersonalAccountOperation_issued_result"
  ON "PersonalAccountOperation"("resultBindingId") WHERE "action" IN ('connect', 'attach') AND "phase" = 'applied';
-- Issuance stays occupied even after the referenced binding retires.
CREATE UNIQUE INDEX "PersonalAccountOperation_attach_root"
  ON "PersonalAccountOperation"("sourceId", "targetWorkspaceId")
  WHERE "action" = 'attach' AND "phase" = 'applied' AND "predecessorBindingId" IS NULL;
CREATE UNIQUE INDEX "PersonalAccountOperation_attach_successor"
  ON "PersonalAccountOperation"("predecessorBindingId")
  WHERE "action" = 'attach' AND "phase" = 'applied' AND "predecessorBindingId" IS NOT NULL;
ALTER TABLE "ProviderAccountConnection" ADD CONSTRAINT "ProviderAccountConnection_pendingSourceOperationId_fkey"
  FOREIGN KEY ("pendingSourceOperationId") REFERENCES "PersonalAccountOperation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

DROP INDEX "WorkspaceAccountBinding_workspaceId_connectionId_key";
CREATE UNIQUE INDEX "WorkspaceAccountBinding_active_pair"
  ON "WorkspaceAccountBinding"("workspaceId", "connectionId") WHERE "state" = 'active';
CREATE INDEX "WorkspaceAccountBinding_workspaceId_connectionId_state_idx"
  ON "WorkspaceAccountBinding"("workspaceId", "connectionId", "state");

-- Add a personal-only guard. SQL118 identity/counter/exact ACK logic stays intact.
CREATE FUNCTION personal_binding_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD."state" = 'revoked' AND NEW."state" = 'active' AND EXISTS (
    SELECT 1 FROM "ProviderAccountConnection" WHERE "id" = OLD."connectionId" AND "ownerUserId" IS NOT NULL
  ) THEN RAISE EXCEPTION 'personal_binding_terminal' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceAccountBinding_personal_terminal" BEFORE UPDATE ON "WorkspaceAccountBinding"
  FOR EACH ROW EXECUTE FUNCTION personal_binding_terminal();

CREATE FUNCTION personal_account_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE owner_id TEXT; binding_row "WorkspaceAccountBinding"; predecessor_row "WorkspaceAccountBinding";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'personal_operation_retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."id", NEW."actorUserId", NEW."clientOperationId", NEW."action", NEW."personalWorkspaceId", NEW."proposedSourceId", NEW."sourceId", NEW."targetWorkspaceId", NEW."profileId", NEW."displayName", NEW."ingress", NEW."normalizedIntentHash", NEW."expectedSourceMetadataRevision", NEW."expectedGatewayRevision", NEW."predecessorBindingId", NEW."expectedPredecessorRevision", NEW."bindingId", NEW."expectedBindingRevision", NEW."createdAt")
      IS DISTINCT FROM ROW(OLD."id", OLD."actorUserId", OLD."clientOperationId", OLD."action", OLD."personalWorkspaceId", OLD."proposedSourceId", OLD."sourceId", OLD."targetWorkspaceId", OLD."profileId", OLD."displayName", OLD."ingress", OLD."normalizedIntentHash", OLD."expectedSourceMetadataRevision", OLD."expectedGatewayRevision", OLD."predecessorBindingId", OLD."expectedPredecessorRevision", OLD."bindingId", OLD."expectedBindingRevision", OLD."createdAt")
      OR (OLD."phase" IN ('applied', 'rejected') AND ROW(NEW."phase", NEW."resultSourceId", NEW."resultBindingId") IS DISTINCT FROM ROW(OLD."phase", OLD."resultSourceId", OLD."resultBindingId"))
      OR (OLD."phase" = 'reserved' AND NEW."phase" NOT IN ('reserved', 'submitted'))
      OR (OLD."phase" IN ('submitted', 'unknown') AND NEW."phase" NOT IN ('submitted', 'unknown', 'applied', 'rejected'))
      OR (OLD."phase" = 'unknown' AND NEW."phase" = 'submitted') THEN
      RAISE EXCEPTION 'personal_operation_immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."phase" <> 'reserved' AND NEW."action" = 'connect' THEN
    RAISE EXCEPTION 'personal_operation_initial_phase' USING ERRCODE = '23514';
  END IF;
  owner_id := NEW."actorUserId";
  IF NEW."action" <> 'connect' THEN
    SELECT "ownerUserId" INTO owner_id FROM "ProviderAccountConnection" WHERE "id" = NEW."sourceId";
    IF owner_id IS NULL OR (NEW."action" = 'attach' AND owner_id <> NEW."actorUserId") THEN
      RAISE EXCEPTION 'personal_operation_owner' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = NEW."targetWorkspaceId" AND "personalOwnerUserId" IS NULL) THEN
      RAISE EXCEPTION 'personal_operation_target' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = NEW."personalWorkspaceId" AND "personalOwnerUserId" = owner_id) THEN
    RAISE EXCEPTION 'personal_operation_scope' USING ERRCODE = '23514';
  END IF;
  IF NEW."phase" = 'applied' THEN
    SELECT * INTO binding_row FROM "WorkspaceAccountBinding" WHERE "id" = NEW."resultBindingId";
    IF binding_row."id" IS NULL OR binding_row."connectionId" IS DISTINCT FROM NEW."resultSourceId"
      OR binding_row."workspaceId" IS DISTINCT FROM COALESCE(NEW."targetWorkspaceId", NEW."personalWorkspaceId")
      OR NOT EXISTS (SELECT 1 FROM "ProviderAccountConnection" WHERE "id" = NEW."resultSourceId" AND "ownerUserId" = owner_id) THEN
      RAISE EXCEPTION 'personal_operation_result_join' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' OR OLD."phase" <> 'applied' THEN
      IF NEW."action" IN ('connect', 'attach') AND (binding_row."state" <> 'active' OR binding_row."revision" <> 1) THEN
        RAISE EXCEPTION 'personal_operation_fresh_result' USING ERRCODE = '23514';
      END IF;
      IF NEW."action" = 'connect' AND NOT EXISTS (SELECT 1 FROM "ProviderAccountConnection"
        WHERE "id" = NEW."proposedSourceId" AND "profileRef" = NEW."profileId" AND "displayName" = NEW."displayName"
          AND "gatewayOperationRef" = NEW."id" AND "authorizationEpochMirror" IS NOT NULL) THEN
        RAISE EXCEPTION 'personal_operation_connect_join' USING ERRCODE = '23514';
      END IF;
      IF NEW."action" = 'revoke' AND (binding_row."state" <> 'revoked' OR binding_row."revision" <> NEW."expectedBindingRevision" + 1
        OR binding_row."pendingFenceOperationId" IS DISTINCT FROM NEW."id") THEN
        RAISE EXCEPTION 'personal_operation_revoke_join' USING ERRCODE = '23514';
      END IF;
      IF NEW."action" = 'attach' THEN
        IF NEW."predecessorBindingId" IS NULL THEN
          IF EXISTS (SELECT 1 FROM "WorkspaceAccountBinding" WHERE "connectionId" = NEW."sourceId" AND "workspaceId" = NEW."targetWorkspaceId" AND "id" <> NEW."resultBindingId") THEN
            RAISE EXCEPTION 'personal_operation_unissued_root' USING ERRCODE = '23514';
          END IF;
        ELSE
          SELECT * INTO predecessor_row FROM "WorkspaceAccountBinding" WHERE "id" = NEW."predecessorBindingId";
          IF predecessor_row."connectionId" IS DISTINCT FROM NEW."sourceId" OR predecessor_row."workspaceId" IS DISTINCT FROM NEW."targetWorkspaceId"
            OR predecessor_row."state" IS DISTINCT FROM 'revoked' OR predecessor_row."revision" IS DISTINCT FROM NEW."expectedPredecessorRevision"
            OR predecessor_row."pendingFenceOperationId" IS NOT NULL OR predecessor_row."fenceAckPolicyRevision" IS DISTINCT FROM predecessor_row."policyRevision"
            OR NOT EXISTS (SELECT 1 FROM "PersonalAccountOperation" WHERE "action" = 'attach' AND "phase" = 'applied'
              AND "sourceId" = NEW."sourceId" AND "targetWorkspaceId" = NEW."targetWorkspaceId" AND "resultBindingId" = NEW."predecessorBindingId") THEN
            RAISE EXCEPTION 'personal_operation_predecessor' USING ERRCODE = '23514';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PersonalAccountOperation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PersonalAccountOperation"
  FOR EACH ROW EXECUTE FUNCTION personal_account_operation_guard();

COMMIT;
