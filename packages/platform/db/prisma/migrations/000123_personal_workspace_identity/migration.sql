-- Fail on duplicate nonnull owners. Never merge or adopt legacy NULL scopes.
BEGIN;

CREATE UNIQUE INDEX "Workspace_personalOwnerUserId_key"
  ON "Workspace" ("personalOwnerUserId");
DROP INDEX "Workspace_personalOwnerUserId_idx";

CREATE FUNCTION personal_workspace_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."personalOwnerUserId" IS DISTINCT FROM OLD."personalOwnerUserId"
     OR (OLD."personalOwnerUserId" IS NOT NULL AND
         (NEW."slug" IS DISTINCT FROM OLD."slug" OR
          NEW."id" IS DISTINCT FROM OLD."id")) THEN
    RAISE EXCEPTION 'personal_workspace_identity_immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Workspace_personal_identity_immutable"
  BEFORE UPDATE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION personal_workspace_identity_immutable();

COMMIT;
