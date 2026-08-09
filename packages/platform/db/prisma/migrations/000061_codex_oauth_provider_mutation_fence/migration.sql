BEGIN;

LOCK TABLE "CodexOAuthProviderInstance" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CodexOAuthLease" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CodexOAuthWritebackIntent" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "CodexOAuthProviderInstance"
  ADD COLUMN "mutationEpoch" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "mutationOwner" TEXT,
  ADD COLUMN "mutationOwnerId" TEXT;
ALTER TABLE "CodexOAuthSetupManifest" ADD COLUMN "mutationEpoch" BIGINT;
ALTER TABLE "CodexOAuthLease" ADD COLUMN "mutationEpoch" BIGINT;
ALTER TABLE "CodexOAuthWritebackIntent" ADD COLUMN "mutationEpoch" BIGINT;

CREATE TABLE "CodexOAuthProviderIdentityQuarantine" (
  "providerInstanceRowId" TEXT PRIMARY KEY,
  "observedWorkspaceId" TEXT NOT NULL,
  "observedRepositoryId" TEXT NOT NULL,
  "observedProviderInstanceId" TEXT NOT NULL,
  "expectedProviderInstanceId" TEXT,
  "reason" TEXT NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "CodexOAuthProviderIdentityQuarantine" (
  "providerInstanceRowId", "observedWorkspaceId", "observedRepositoryId",
  "observedProviderInstanceId", "expectedProviderInstanceId", "reason"
)
SELECT p."id", p."workspaceId", p."repositoryId", p."providerInstanceId",
  CASE WHEN r."githubRepositoryId" IS NULL THEN NULL
       ELSE 'codex-rotating:' || r."githubRepositoryId"::text END,
  CASE
    WHEN r."id" IS NULL THEN 'repository_missing'
    WHEN r."provider"::text <> 'github' OR r."githubRepositoryId" IS NULL THEN 'repository_not_github'
    WHEN p."workspaceId" <> r."workspaceId" THEN 'workspace_mismatch'
    WHEN p."providerInstanceId" <> 'codex-rotating:' || r."githubRepositoryId"::text THEN 'canonical_id_mismatch'
    WHEN p."authMode" <> 'codex_subscription_oauth_rotating' THEN 'auth_mode_mismatch'
    ELSE 'secret_name_mismatch'
  END
FROM "CodexOAuthProviderInstance" p
LEFT JOIN "RepositoryConnection" r ON r."id" = p."repositoryId"
WHERE r."id" IS NULL
   OR r."provider"::text <> 'github'
   OR r."githubRepositoryId" IS NULL
   OR p."workspaceId" <> r."workspaceId"
   OR p."providerInstanceId" <> 'codex-rotating:' || r."githubRepositoryId"::text
   OR p."authMode" <> 'codex_subscription_oauth_rotating'
   OR p."secretName" <> 'REVIEWROUTER_CODEX_AUTH_JSON';

-- Never guess whether a legacy secret PUT won. Pending/finalized work and
-- quarantined identity are recovery-owned until an operator reseeds safely.
UPDATE "CodexOAuthProviderInstance" p
SET "mutationEpoch" = 1,
    "mutationOwner" = 'recovery',
    "mutationOwnerId" = COALESCE(
      (SELECT i."id" FROM "CodexOAuthWritebackIntent" i
       WHERE i."providerInstanceRowId" = p."id" AND i."status" = 'pending'
       ORDER BY i."createdAt" DESC, i."id" DESC LIMIT 1),
      p."activeLeaseId",
      'identity-quarantine:' || p."id"
    ),
    "state" = 'unknown_auth_state'
WHERE EXISTS (
        SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = p."id"
      )
   OR p."activeLeaseId" IS NOT NULL
   OR EXISTS (
        SELECT 1 FROM "CodexOAuthWritebackIntent" i
        WHERE i."providerInstanceRowId" = p."id" AND i."status" = 'pending'
      );

-- A fetched setup is known to be on the far side of the secret PUT and pins
-- setup ownership even when the original manifest TTL has elapsed.
WITH fetched AS (
  SELECT DISTINCT ON (m."providerInstanceRowId")
    m."providerInstanceRowId", m."id"
  FROM "CodexOAuthSetupManifest" m
  JOIN "CodexOAuthProviderInstance" p ON p."id" = m."providerInstanceRowId"
  WHERE m."status" = 'fetched' AND p."mutationOwner" IS NULL
  ORDER BY m."providerInstanceRowId", m."createdAt" DESC, m."id" DESC
)
UPDATE "CodexOAuthProviderInstance" p
SET "mutationEpoch" = 1, "mutationOwner" = 'setup', "mutationOwnerId" = fetched."id"
FROM fetched WHERE p."id" = fetched."providerInstanceRowId";

WITH issued AS (
  SELECT DISTINCT ON (m."providerInstanceRowId")
    m."providerInstanceRowId", m."id"
  FROM "CodexOAuthSetupManifest" m
  JOIN "CodexOAuthProviderInstance" p ON p."id" = m."providerInstanceRowId"
  WHERE m."status" = 'issued' AND m."expiresAt" > CURRENT_TIMESTAMP
    AND p."mutationOwner" IS NULL
  ORDER BY m."providerInstanceRowId", m."createdAt" DESC, m."id" DESC
)
UPDATE "CodexOAuthProviderInstance" p
SET "mutationEpoch" = 1, "mutationOwner" = 'setup', "mutationOwnerId" = issued."id"
FROM issued WHERE p."id" = issued."providerInstanceRowId";

UPDATE "CodexOAuthSetupManifest" m SET "mutationEpoch" = p."mutationEpoch"
FROM "CodexOAuthProviderInstance" p
WHERE p."id" = m."providerInstanceRowId" AND p."mutationOwnerId" = m."id";
UPDATE "CodexOAuthLease" l SET "mutationEpoch" = p."mutationEpoch"
FROM "CodexOAuthProviderInstance" p
WHERE p."id" = l."providerInstanceRowId" AND p."mutationOwnerId" = l."id";
UPDATE "CodexOAuthWritebackIntent" i SET "mutationEpoch" = p."mutationEpoch"
FROM "CodexOAuthProviderInstance" p
WHERE p."id" = i."providerInstanceRowId"
  AND (p."mutationOwnerId" = i."id" OR i."status" = 'pending');

UPDATE "CodexOAuthWritebackIntent"
SET "status" = 'failed', "safeErrorCode" = 'legacy_ambiguous_recovery'
WHERE "status" = 'pending';

ALTER TABLE "CodexOAuthProviderInstance"
  ADD CONSTRAINT "CodexOAuthProviderInstance_mutation_fence_check" CHECK (
    "mutationEpoch" >= 0
    AND ("mutationOwner" IS NULL) = ("mutationOwnerId" IS NULL)
    AND ("mutationOwner" IS NULL OR "mutationOwner" IN ('runtime', 'setup', 'recovery'))
    AND ("mutationOwner" IS NULL OR "mutationEpoch" > 0)
  );
ALTER TABLE "CodexOAuthSetupManifest"
  ADD CONSTRAINT "CodexOAuthSetupManifest_epoch_check" CHECK (
    ("status" NOT IN ('issued', 'fetched') OR "mutationEpoch" IS NOT NULL)
    AND ("mutationEpoch" IS NULL OR "mutationEpoch" > 0)
  ) NOT VALID;
ALTER TABLE "CodexOAuthLease"
  ADD CONSTRAINT "CodexOAuthLease_epoch_check" CHECK (
    ("status" NOT IN ('preleased', 'finalized') OR "mutationEpoch" IS NOT NULL)
    AND ("mutationEpoch" IS NULL OR "mutationEpoch" > 0)
  ) NOT VALID;
ALTER TABLE "CodexOAuthWritebackIntent"
  ADD CONSTRAINT "CodexOAuthWritebackIntent_epoch_check" CHECK (
    ("status" <> 'pending' OR "mutationEpoch" IS NOT NULL)
    AND ("mutationEpoch" IS NULL OR "mutationEpoch" > 0)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE repository_record RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR
    NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId" OR
    NEW."providerInstanceId" IS DISTINCT FROM OLD."providerInstanceId" OR
    NEW."authMode" IS DISTINCT FROM OLD."authMode" OR
    NEW."secretName" IS DISTINCT FROM OLD."secretName"
  ) THEN RAISE EXCEPTION 'codex_oauth_provider_identity_immutable' USING ERRCODE = '23514';
  END IF;
  SELECT "workspaceId", "provider", "githubRepositoryId" INTO repository_record
  FROM "RepositoryConnection" WHERE "id" = NEW."repositoryId";
  IF NOT FOUND OR repository_record."provider"::text <> 'github'
     OR repository_record."githubRepositoryId" IS NULL
     OR NEW."workspaceId" <> repository_record."workspaceId"
     OR NEW."providerInstanceId" <> 'codex-rotating:' || repository_record."githubRepositoryId"::text
     OR NEW."authMode" <> 'codex_subscription_oauth_rotating'
     OR NEW."secretName" <> 'REVIEWROUTER_CODEX_AUTH_JSON'
  THEN RAISE EXCEPTION 'codex_oauth_provider_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthProviderInstance_identity_guard"
BEFORE INSERT OR UPDATE ON "CodexOAuthProviderInstance"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_provider_identity_guard"();

CREATE OR REPLACE FUNCTION "codex_oauth_provider_mutation_transition_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."latestGeneration" IS DISTINCT FROM OLD."latestGeneration"
     OR NEW."latestGenerationHash" IS DISTINCT FROM OLD."latestGenerationHash"
     OR NEW."activeLeaseId" IS DISTINCT FROM OLD."activeLeaseId"
     OR NEW."activeLeaseExpiresAt" IS DISTINCT FROM OLD."activeLeaseExpiresAt"
  THEN
    IF NOT (
      -- Acquisition or recovery advances the durable epoch and names its owner.
      (NEW."mutationEpoch" > OLD."mutationEpoch"
       AND NEW."mutationOwner" IN ('runtime', 'setup', 'recovery')
       AND NEW."mutationOwnerId" IS NOT NULL)
      OR
      -- Confirmation consumes exactly the current setup/runtime owner.
      (NEW."mutationEpoch" = OLD."mutationEpoch"
       AND OLD."mutationOwner" IN ('runtime', 'setup')
       AND OLD."mutationOwnerId" IS NOT NULL
       AND NEW."mutationOwner" IS NULL
       AND NEW."mutationOwnerId" IS NULL)
      OR
      -- Runtime creates the lease under a transaction-local owner key, then
      -- replaces that key with the durable lease id in the same transaction.
      (NEW."mutationEpoch" = OLD."mutationEpoch"
       AND OLD."mutationOwner" = 'runtime'
       AND NEW."mutationOwner" = 'runtime'
       AND OLD."mutationOwnerId" IS NOT NULL
       AND NEW."mutationOwnerId" = NEW."activeLeaseId"
       AND NEW."latestGeneration" = OLD."latestGeneration"
       AND NEW."latestGenerationHash" IS NOT DISTINCT FROM OLD."latestGenerationHash")
    ) THEN
      RAISE EXCEPTION 'codex_oauth_provider_mutation_fence_required' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthProviderInstance_mutation_transition_guard"
BEFORE UPDATE ON "CodexOAuthProviderInstance"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_provider_mutation_transition_guard"();

CREATE OR REPLACE FUNCTION "codex_oauth_child_identity_fence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p RECORD;
BEGIN
  SELECT * INTO p FROM "CodexOAuthProviderInstance" WHERE "id" = NEW."providerInstanceRowId";
  IF NOT FOUND OR NEW."providerInstanceId" <> p."providerInstanceId" THEN
    RAISE EXCEPTION 'codex_oauth_child_provider_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  -- This trigger function is shared with CodexOAuthWritebackIntent, which does
  -- not carry workspaceId/repositoryId. Read optional row fields through JSON
  -- so PostgreSQL does not resolve absent record attributes at runtime.
  IF TG_TABLE_NAME IN ('CodexOAuthLease', 'CodexOAuthSetupManifest') AND (
    to_jsonb(NEW)->>'workspaceId' <> p."workspaceId" OR
    to_jsonb(NEW)->>'repositoryId' <> p."repositoryId"
  ) THEN RAISE EXCEPTION 'codex_oauth_child_natural_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."mutationEpoch" IS NOT NULL AND NEW."mutationEpoch" <> p."mutationEpoch" THEN
    IF NOT (
      TG_OP = 'UPDATE'
      AND NEW."mutationEpoch" < p."mutationEpoch"
      AND (
        (TG_TABLE_NAME = 'CodexOAuthSetupManifest' AND NEW."status" NOT IN ('issued', 'fetched'))
        OR (TG_TABLE_NAME = 'CodexOAuthLease' AND NEW."status" NOT IN ('preleased', 'finalized'))
        OR (TG_TABLE_NAME = 'CodexOAuthWritebackIntent' AND NEW."status" <> 'pending')
      )
    ) THEN
      RAISE EXCEPTION 'codex_oauth_child_mutation_epoch_mismatch' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "CodexOAuthSetupManifest_identity_fence_guard"
BEFORE INSERT OR UPDATE ON "CodexOAuthSetupManifest"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_child_identity_fence_guard"();
CREATE TRIGGER "CodexOAuthLease_identity_fence_guard"
BEFORE INSERT OR UPDATE ON "CodexOAuthLease"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_child_identity_fence_guard"();
CREATE TRIGGER "CodexOAuthWritebackIntent_identity_fence_guard"
BEFORE INSERT OR UPDATE ON "CodexOAuthWritebackIntent"
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_child_identity_fence_guard"();

CREATE INDEX "CodexOAuthProviderInstance_mutation_owner_idx"
  ON "CodexOAuthProviderInstance"("mutationOwner", "mutationEpoch");
CREATE INDEX "CodexOAuthSetupManifest_provider_epoch_idx"
  ON "CodexOAuthSetupManifest"("providerInstanceRowId", "mutationEpoch");
CREATE INDEX "CodexOAuthLease_provider_epoch_idx"
  ON "CodexOAuthLease"("providerInstanceRowId", "mutationEpoch");
CREATE INDEX "CodexOAuthWritebackIntent_provider_epoch_idx"
  ON "CodexOAuthWritebackIntent"("providerInstanceRowId", "mutationEpoch");

COMMIT;

-- Deliberately no down migration: application rollback is safe while these
-- additive guards remain installed.
