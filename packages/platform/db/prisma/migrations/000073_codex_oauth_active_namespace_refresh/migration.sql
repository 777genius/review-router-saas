BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- A successful OAuth refresh invalidates the previously restored token set,
-- so runtime refreshes update the already-active namespace in place.
-- Namespace promotion remains versioned for setup and explicit recovery, but
-- ordinary refreshes no longer allocate a new secret name or rewrite the
-- protected default-branch workflow.
DROP INDEX "CodexOAuthWritebackIntent_secretNamespaceId_key";

CREATE INDEX "CodexOAuthWritebackIntent_secretNamespaceId_idx"
  ON "CodexOAuthWritebackIntent"("secretNamespaceId");

COMMIT;
