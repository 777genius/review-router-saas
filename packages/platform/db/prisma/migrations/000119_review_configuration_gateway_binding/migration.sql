-- C2b: safe configuration selection. No grant, gateway credential or execution state.
BEGIN;

ALTER TABLE "ReviewConfigurationVersion"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "gatewayBindingId" TEXT,
  ADD COLUMN "gatewayProfileRef" TEXT;
ALTER TABLE "ReviewConfigurationVersionProvider"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "gatewayBindingId" TEXT,
  ADD COLUMN "gatewayProfileRef" TEXT;

-- Derive scope from the real parents; legacy rows keep every existing setting.
UPDATE "ReviewConfigurationVersion" AS v SET "workspaceId" = c."workspaceId"
FROM "ReviewConfiguration" AS c WHERE v."configurationId" = c."id";
UPDATE "ReviewConfigurationVersionProvider" AS p SET "workspaceId" = v."workspaceId"
FROM "ReviewConfigurationVersion" AS v WHERE p."configurationVersionId" = v."id";
ALTER TABLE "ReviewConfigurationVersion" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "ReviewConfigurationVersionProvider" ALTER COLUMN "workspaceId" SET NOT NULL;

CREATE UNIQUE INDEX "ReviewConfiguration_id_workspaceId_key"
  ON "ReviewConfiguration"("id", "workspaceId");
CREATE UNIQUE INDEX "ReviewConfigurationVersion_id_workspaceId_key"
  ON "ReviewConfigurationVersion"("id", "workspaceId");

-- A repository target cannot manufacture a configuration parent in another
-- workspace and then satisfy every downstream composite FK against that lie.
-- Workspace defaults have a null repositoryId and retain their existing scope.
ALTER TABLE "ReviewConfiguration"
  DROP CONSTRAINT "ReviewConfiguration_repositoryId_fkey",
  ADD CONSTRAINT "ReviewConfiguration_repositoryId_workspaceId_fkey"
    FOREIGN KEY ("repositoryId", "workspaceId")
    REFERENCES "RepositoryConnection"("id", "workspaceId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "ReviewConfigurationVersion"
  DROP CONSTRAINT "ReviewConfigurationVersion_configurationId_fkey",
  ADD CONSTRAINT "ReviewConfigurationVersion_configurationId_workspaceId_fkey"
    FOREIGN KEY ("configurationId", "workspaceId")
    REFERENCES "ReviewConfiguration"("id", "workspaceId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ReviewConfigurationVersion_gatewayBindingId_workspaceId_fkey"
    FOREIGN KEY ("gatewayBindingId", "workspaceId")
    REFERENCES "WorkspaceAccountBinding"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ReviewConfigurationVersionProvider"
  DROP CONSTRAINT "ReviewConfigurationVersionProvider_configurationVersionId_fkey",
  ADD CONSTRAINT "ReviewConfigurationVersionProvider_version_workspace_fkey"
    FOREIGN KEY ("configurationVersionId", "workspaceId")
    REFERENCES "ReviewConfigurationVersion"("id", "workspaceId") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "ReviewConfigurationVersionProvider_binding_workspace_fkey"
    FOREIGN KEY ("gatewayBindingId", "workspaceId")
    REFERENCES "WorkspaceAccountBinding"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ReviewConfigurationVersion"
  ADD CONSTRAINT "ReviewConfigurationVersion_auth_kind" CHECK (
    ("providerKind" = 'codex' AND "providerAuthMode" IN (
      'codex_subscription_oauth', 'codex_subscription_oauth_rotating',
      'codex_subscription_oauth_hosted_pool', 'codex_openai_api_key', 'codex_account_gateway'))
    OR ("providerKind" = 'claude' AND "providerAuthMode" = 'claude_code_oauth')
    OR ("providerKind" = 'openrouter' AND "providerAuthMode" = 'openrouter_api_key')
  ),
  ADD CONSTRAINT "ReviewConfigurationVersion_gateway_selection" CHECK (
    ("providerAuthMode" = 'codex_account_gateway'
      AND "gatewayBindingId" IS NOT NULL AND "gatewayProfileRef" IS NOT NULL
      AND "gatewayBindingId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "gatewayProfileRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "gatewayBindingId" !~ '^(sk-|ghp_|github_pat_|xox[baprs]-)'
      AND "gatewayProfileRef" !~ '^(sk-|ghp_|github_pat_|xox[baprs]-)')
    OR ("providerAuthMode" <> 'codex_account_gateway'
      AND "gatewayBindingId" IS NULL AND "gatewayProfileRef" IS NULL)
  );
CREATE INDEX "ReviewConfigurationVersion_gatewayBindingId_workspaceId_idx"
  ON "ReviewConfigurationVersion"("gatewayBindingId", "workspaceId");

ALTER TABLE "ReviewConfigurationVersionProvider"
  ADD CONSTRAINT "ReviewConfigurationVersionProvider_auth_kind" CHECK (
    ("providerKind" = 'codex' AND "providerAuthMode" IN (
      'codex_subscription_oauth', 'codex_subscription_oauth_rotating',
      'codex_subscription_oauth_hosted_pool', 'codex_openai_api_key', 'codex_account_gateway'))
    OR ("providerKind" = 'claude' AND "providerAuthMode" = 'claude_code_oauth')
    OR ("providerKind" = 'openrouter' AND "providerAuthMode" = 'openrouter_api_key')
  ),
  ADD CONSTRAINT "ReviewConfigurationVersionProvider_gateway_selection" CHECK (
    ("providerAuthMode" = 'codex_account_gateway'
      AND "gatewayBindingId" IS NOT NULL AND "gatewayProfileRef" IS NOT NULL
      AND "gatewayBindingId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "gatewayProfileRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      AND "gatewayBindingId" !~ '^(sk-|ghp_|github_pat_|xox[baprs]-)'
      AND "gatewayProfileRef" !~ '^(sk-|ghp_|github_pat_|xox[baprs]-)')
    OR ("providerAuthMode" <> 'codex_account_gateway'
      AND "gatewayBindingId" IS NULL AND "gatewayProfileRef" IS NULL)
  );
CREATE INDEX "ReviewConfigurationVersionProvider_gateway_binding_idx"
  ON "ReviewConfigurationVersionProvider"("gatewayBindingId", "workspaceId");

COMMIT;
