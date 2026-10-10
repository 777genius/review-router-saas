-- C1 product ownership/bindings. No credential custody or native account effects.
BEGIN;

ALTER TABLE "Workspace" ADD COLUMN "personalOwnerUserId" TEXT;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_personalOwnerUserId_nonempty"
  CHECK ("personalOwnerUserId" IS NULL OR length("personalOwnerUserId") > 0);
CREATE INDEX "Workspace_personalOwnerUserId_idx" ON "Workspace"("personalOwnerUserId");
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_personalOwnerUserId_fkey"
  FOREIGN KEY ("personalOwnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TYPE "ProviderAccountConnectionState" AS ENUM ('active', 'disabled', 'quarantined', 'pending', 'unknown');
CREATE TYPE "WorkspaceAccountBindingState" AS ENUM ('active', 'revoked');

CREATE TABLE "ProviderAccountConnection" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT,
  "ownerWorkspaceId" TEXT,
  "gatewayAccountRef" TEXT NOT NULL,
  "gatewayOperationRef" TEXT,
  "profileRef" TEXT,
  "displayName" TEXT NOT NULL,
  "state" "ProviderAccountConnectionState" NOT NULL DEFAULT 'unknown',
  "metadataRevision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderAccountConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderAccountConnection_owner_xor" CHECK (
    ("ownerUserId" IS NOT NULL) <> ("ownerWorkspaceId" IS NOT NULL)
  ),
  CONSTRAINT "ProviderAccountConnection_revision_positive" CHECK ("metadataRevision" > 0),
  CONSTRAINT "ProviderAccountConnection_safe_refs" CHECK (
    "gatewayAccountRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    AND ("gatewayOperationRef" IS NULL OR "gatewayOperationRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
    AND ("profileRef" IS NULL OR "profileRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
  ),
  CONSTRAINT "ProviderAccountConnection_display_bounded" CHECK (
    length(btrim("displayName")) BETWEEN 1 AND 120
    AND length("displayName") <= 120 AND "displayName" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "ProviderAccountConnection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderAccountConnection_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId")
    REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ProviderAccountConnection_gatewayAccountRef_key" ON "ProviderAccountConnection"("gatewayAccountRef");
CREATE INDEX "ProviderAccountConnection_ownerUserId_idx" ON "ProviderAccountConnection"("ownerUserId");
CREATE INDEX "ProviderAccountConnection_ownerWorkspaceId_state_idx" ON "ProviderAccountConnection"("ownerWorkspaceId", "state");

CREATE TABLE "WorkspaceAccountBinding" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "state" "WorkspaceAccountBindingState" NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceAccountBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceAccountBinding_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "WorkspaceAccountBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceAccountBinding_connectionId_fkey" FOREIGN KEY ("connectionId")
    REFERENCES "ProviderAccountConnection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "WorkspaceAccountBinding_workspaceId_connectionId_key" ON "WorkspaceAccountBinding"("workspaceId", "connectionId");
CREATE UNIQUE INDEX "WorkspaceAccountBinding_id_workspaceId_key" ON "WorkspaceAccountBinding"("id", "workspaceId");

-- Actual SQL enforcement; Prisma-only validation cannot make ownership immutable.
CREATE FUNCTION provider_account_connection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."metadataRevision" <> 1 THEN
      RAISE EXCEPTION 'provider_account_initial_revision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
      OR NEW."ownerWorkspaceId" IS DISTINCT FROM OLD."ownerWorkspaceId"
      OR NEW."gatewayAccountRef" IS DISTINCT FROM OLD."gatewayAccountRef" THEN
      RAISE EXCEPTION 'provider_account_owner_immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."metadataRevision"::bigint <> OLD."metadataRevision"::bigint + 1 THEN
      RAISE EXCEPTION 'provider_account_revision_conflict' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProviderAccountConnection_guard" BEFORE INSERT OR UPDATE ON "ProviderAccountConnection"
  FOR EACH ROW EXECUTE FUNCTION provider_account_connection_guard();

CREATE FUNCTION workspace_account_binding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 THEN
      RAISE EXCEPTION 'workspace_account_binding_initial_revision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
      OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId" THEN
      RAISE EXCEPTION 'workspace_account_binding_identity_immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."revision"::bigint <> OLD."revision"::bigint + 1 THEN
      RAISE EXCEPTION 'workspace_account_binding_revision_conflict' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceAccountBinding_guard" BEFORE INSERT OR UPDATE ON "WorkspaceAccountBinding"
  FOR EACH ROW EXECUTE FUNCTION workspace_account_binding_guard();

COMMIT;
