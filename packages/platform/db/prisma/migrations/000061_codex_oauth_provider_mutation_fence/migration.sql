BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- Stop provider writers first, then serialize repository identity writers
-- without blocking ordinary repository reads. The row locks below cover the
-- exact parents whose natural identity is copied into OAuth rows.
LOCK TABLE "CodexOAuthProviderInstance" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "RepositoryConnection" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CodexOAuthLease" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CodexOAuthWritebackIntent" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  PERFORM r."id"
  FROM "RepositoryConnection" r
  JOIN "CodexOAuthProviderInstance" p ON p."repositoryId" = r."id"
  ORDER BY r."id"
  FOR UPDATE OF r;
END $$;

-- 000060 and 000061 are separate Prisma transactions. An issued manifest may
-- cross its TTL while 000061 is waiting for locks or being retried.
UPDATE "CodexOAuthSetupManifest"
SET "status" = 'expired'
WHERE "status" = 'issued'
  AND "expiresAt" <= CURRENT_TIMESTAMP;

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
  "evidenceJson" JSONB NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3)
);

CREATE TABLE "CodexOAuthChildIdentityQuarantine" (
  "childKind" TEXT NOT NULL,
  "childId" TEXT NOT NULL,
  "providerInstanceRowId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  PRIMARY KEY ("childKind", "childId")
);

-- BEGIN durable setup recovery request ledger (kept separable for rollout review)
CREATE TABLE "CodexOAuthSetupRecoveryRequest" (
  "id" TEXT PRIMARY KEY,
  "providerInstanceRowId" TEXT NOT NULL,
  "recoveryRequestId" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "acknowledgement" TEXT NOT NULL,
  "mutationEpoch" BIGINT NOT NULL,
  "mode" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "latestManifestId" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey"
    FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CodexOAuthSetupRecoveryRequest_latestManifestId_fkey"
    FOREIGN KEY ("latestManifestId") REFERENCES "CodexOAuthSetupManifest"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CodexOAuthSetupRecoveryRequest_epoch_check"
    CHECK ("mutationEpoch" > 0),
  CONSTRAINT "CodexOAuthSetupRecoveryRequest_contract_check" CHECK (
    "acknowledgement" = 'all_prior_installers_and_writers_are_stopped'
    AND "mode" = 'forced_reseed'
    AND "state" IN ('active', 'manifest_issued', 'completed', 'superseded')
  )
);
CREATE UNIQUE INDEX "CodexOAuthSetupRecoveryRequest_provider_request_key"
  ON "CodexOAuthSetupRecoveryRequest"("providerInstanceRowId", "recoveryRequestId");
CREATE UNIQUE INDEX "CodexOAuthSetupRecoveryRequest_latestManifestId_key"
  ON "CodexOAuthSetupRecoveryRequest"("latestManifestId");
CREATE INDEX "CodexOAuthSetupRecoveryRequest_provider_state_idx"
  ON "CodexOAuthSetupRecoveryRequest"("providerInstanceRowId", "state");
CREATE UNIQUE INDEX "CodexOAuthSetupRecoveryRequest_one_active_provider_key"
  ON "CodexOAuthSetupRecoveryRequest"("providerInstanceRowId")
  WHERE "state" IN ('active', 'manifest_issued');
-- END durable setup recovery request ledger

INSERT INTO "CodexOAuthProviderIdentityQuarantine" (
  "providerInstanceRowId", "observedWorkspaceId", "observedRepositoryId",
  "observedProviderInstanceId", "expectedProviderInstanceId", "reason", "evidenceJson"
)
SELECT p."id", p."workspaceId", p."repositoryId", p."providerInstanceId",
  CASE WHEN r."githubRepositoryId" IS NULL THEN NULL
       ELSE 'codex-rotating:' || r."githubRepositoryId"::text END,
  CASE
    WHEN r."id" IS NULL THEN 'repository_missing'
    WHEN r."provider"::text <> 'github' OR r."githubRepositoryId" IS NULL THEN 'repository_not_github'
    WHEN r."externalRepositoryId" IS DISTINCT FROM r."githubRepositoryId"::text THEN 'repository_external_identity_mismatch'
    WHEN p."workspaceId" <> r."workspaceId" THEN 'workspace_mismatch'
    WHEN p."providerInstanceId" <> 'codex-rotating:' || r."githubRepositoryId"::text THEN 'canonical_id_mismatch'
    WHEN p."authMode" <> 'codex_subscription_oauth_rotating' THEN 'auth_mode_mismatch'
    ELSE 'secret_name_mismatch'
  END,
  jsonb_build_object(
    'provider', to_jsonb(p),
    'repository', CASE WHEN r."id" IS NULL THEN NULL ELSE to_jsonb(r) END
  )
FROM "CodexOAuthProviderInstance" p
LEFT JOIN "RepositoryConnection" r ON r."id" = p."repositoryId"
WHERE r."id" IS NULL
   OR r."provider"::text <> 'github'
   OR r."githubRepositoryId" IS NULL
   OR r."externalRepositoryId" IS DISTINCT FROM r."githubRepositoryId"::text
   OR p."workspaceId" <> r."workspaceId"
   OR p."providerInstanceId" <> 'codex-rotating:' || r."githubRepositoryId"::text
   OR p."authMode" <> 'codex_subscription_oauth_rotating'
   OR p."secretName" <> 'REVIEWROUTER_CODEX_AUTH_JSON';

INSERT INTO "CodexOAuthChildIdentityQuarantine" (
  "childKind", "childId", "providerInstanceRowId", "reason", "evidenceJson"
)
SELECT 'setup_manifest', m."id", m."providerInstanceRowId",
  CASE
    WHEN p."id" IS NULL THEN 'provider_missing'
    WHEN pq."providerInstanceRowId" IS NOT NULL THEN 'provider_identity_quarantined'
    WHEN m."workspaceId" <> p."workspaceId" THEN 'workspace_mismatch'
    WHEN m."repositoryId" <> p."repositoryId" THEN 'repository_mismatch'
    ELSE 'provider_instance_id_mismatch'
  END,
  jsonb_build_object('child', to_jsonb(m), 'provider', to_jsonb(p))
FROM "CodexOAuthSetupManifest" m
LEFT JOIN "CodexOAuthProviderInstance" p ON p."id" = m."providerInstanceRowId"
LEFT JOIN "CodexOAuthProviderIdentityQuarantine" pq
  ON pq."providerInstanceRowId" = m."providerInstanceRowId"
WHERE p."id" IS NULL
   OR pq."providerInstanceRowId" IS NOT NULL
   OR m."workspaceId" <> p."workspaceId"
   OR m."repositoryId" <> p."repositoryId"
   OR m."providerInstanceId" <> p."providerInstanceId";

INSERT INTO "CodexOAuthChildIdentityQuarantine" (
  "childKind", "childId", "providerInstanceRowId", "reason", "evidenceJson"
)
SELECT 'lease', l."id", l."providerInstanceRowId",
  CASE
    WHEN p."id" IS NULL THEN 'provider_missing'
    WHEN pq."providerInstanceRowId" IS NOT NULL THEN 'provider_identity_quarantined'
    WHEN l."workspaceId" <> p."workspaceId" THEN 'workspace_mismatch'
    WHEN l."repositoryId" <> p."repositoryId" THEN 'repository_mismatch'
    ELSE 'provider_instance_id_mismatch'
  END,
  jsonb_build_object('child', to_jsonb(l), 'provider', to_jsonb(p))
FROM "CodexOAuthLease" l
LEFT JOIN "CodexOAuthProviderInstance" p ON p."id" = l."providerInstanceRowId"
LEFT JOIN "CodexOAuthProviderIdentityQuarantine" pq
  ON pq."providerInstanceRowId" = l."providerInstanceRowId"
WHERE p."id" IS NULL
   OR pq."providerInstanceRowId" IS NOT NULL
   OR l."workspaceId" <> p."workspaceId"
   OR l."repositoryId" <> p."repositoryId"
   OR l."providerInstanceId" <> p."providerInstanceId";

INSERT INTO "CodexOAuthChildIdentityQuarantine" (
  "childKind", "childId", "providerInstanceRowId", "reason", "evidenceJson"
)
SELECT 'writeback_intent', i."id", i."providerInstanceRowId",
  CASE
    WHEN p."id" IS NULL THEN 'provider_missing'
    WHEN pq."providerInstanceRowId" IS NOT NULL THEN 'provider_identity_quarantined'
    WHEN i."providerInstanceId" <> p."providerInstanceId" THEN 'provider_instance_id_mismatch'
    WHEN l."id" IS NULL THEN 'lease_missing'
    ELSE 'lease_provider_mismatch'
  END,
  jsonb_build_object('child', to_jsonb(i), 'provider', to_jsonb(p), 'lease', to_jsonb(l))
FROM "CodexOAuthWritebackIntent" i
LEFT JOIN "CodexOAuthProviderInstance" p ON p."id" = i."providerInstanceRowId"
LEFT JOIN "CodexOAuthProviderIdentityQuarantine" pq
  ON pq."providerInstanceRowId" = i."providerInstanceRowId"
LEFT JOIN "CodexOAuthLease" l ON l."id" = i."leaseId"
WHERE p."id" IS NULL
   OR pq."providerInstanceRowId" IS NOT NULL
   OR i."providerInstanceId" <> p."providerInstanceId"
   OR l."id" IS NULL
   OR l."providerInstanceRowId" <> i."providerInstanceRowId"
   OR l."providerInstanceId" <> i."providerInstanceId";

-- Preserve the complete original rows above, then make every dirty active row
-- terminal before guards are installed. Recovery is never blocked behind an
-- active row that the identity trigger would make impossible to update.
UPDATE "CodexOAuthSetupManifest" m
SET "status" = 'identity_quarantined'
FROM "CodexOAuthChildIdentityQuarantine" q
WHERE q."childKind" = 'setup_manifest' AND q."childId" = m."id"
  AND m."status" IN ('issued', 'fetched');

UPDATE "CodexOAuthLease" l
SET "status" = 'identity_quarantined'
FROM "CodexOAuthChildIdentityQuarantine" q
WHERE q."childKind" = 'lease' AND q."childId" = l."id"
  AND l."status" IN ('preleased', 'finalized');

UPDATE "CodexOAuthWritebackIntent" i
SET "status" = 'failed', "safeErrorCode" = 'identity_quarantined'
FROM "CodexOAuthChildIdentityQuarantine" q
WHERE q."childKind" = 'writeback_intent' AND q."childId" = i."id"
  AND i."status" = 'pending';

-- Never guess whether a legacy secret PUT won. Pending/finalized work and all
-- identity quarantine are recovery-owned until an operator repairs or reseeds.
UPDATE "CodexOAuthProviderInstance" p
SET "mutationEpoch" = 1,
    "mutationOwner" = 'recovery',
    "mutationOwnerId" = COALESCE(
      (SELECT 'child-quarantine:' || q."childKind" || ':' || q."childId"
       FROM "CodexOAuthChildIdentityQuarantine" q
       WHERE q."providerInstanceRowId" = p."id"
       ORDER BY q."childKind", q."childId" LIMIT 1),
      (SELECT i."id" FROM "CodexOAuthWritebackIntent" i
       WHERE i."providerInstanceRowId" = p."id" AND i."status" = 'pending'
       ORDER BY i."createdAt" DESC, i."id" DESC LIMIT 1),
      p."activeLeaseId",
      (SELECT l."id" FROM "CodexOAuthLease" l
       WHERE l."providerInstanceRowId" = p."id"
         AND l."status" IN ('preleased', 'finalized')
       ORDER BY l."createdAt" DESC, l."id" DESC LIMIT 1),
      'identity-quarantine:' || p."id"
    ),
    "state" = 'unknown_auth_state',
    "activeLeaseId" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "CodexOAuthChildIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = p."id"
      ) THEN NULL ELSE p."activeLeaseId" END,
    "activeLeaseExpiresAt" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "CodexOAuthChildIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = p."id"
      ) THEN NULL ELSE p."activeLeaseExpiresAt" END
WHERE EXISTS (
        SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = p."id"
      )
   OR EXISTS (
        SELECT 1 FROM "CodexOAuthChildIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = p."id"
      )
   OR p."activeLeaseId" IS NOT NULL
   OR EXISTS (
        SELECT 1 FROM "CodexOAuthLease" l
        WHERE l."providerInstanceRowId" = p."id"
          AND l."status" IN ('preleased', 'finalized')
      )
   OR EXISTS (
        SELECT 1 FROM "CodexOAuthWritebackIntent" i
        WHERE i."providerInstanceRowId" = p."id" AND i."status" = 'pending'
      );

-- A fetched setup is on the far side of the secret PUT and pins setup
-- ownership even when its TTL elapsed. Issued ownership is live-TTL only.
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

-- Only positive parent epochs may be copied. In particular, terminal history
-- attached to an idle epoch-zero provider remains NULL rather than becoming a
-- false fence token.
UPDATE "CodexOAuthSetupManifest" m SET "mutationEpoch" = p."mutationEpoch"
FROM "CodexOAuthProviderInstance" p
WHERE p."id" = m."providerInstanceRowId" AND p."mutationEpoch" > 0
  AND (p."mutationOwnerId" = m."id" OR m."status" IN ('issued', 'fetched'));
UPDATE "CodexOAuthLease" l SET "mutationEpoch" = p."mutationEpoch"
FROM "CodexOAuthProviderInstance" p
WHERE p."id" = l."providerInstanceRowId" AND p."mutationEpoch" > 0
  AND (p."mutationOwnerId" = l."id" OR l."status" IN ('preleased', 'finalized'));
UPDATE "CodexOAuthWritebackIntent" i SET "mutationEpoch" = p."mutationEpoch"
FROM "CodexOAuthProviderInstance" p
WHERE p."id" = i."providerInstanceRowId" AND p."mutationEpoch" > 0
  AND (p."mutationOwnerId" = i."id" OR i."status" = 'pending');

UPDATE "CodexOAuthWritebackIntent"
SET "status" = 'failed', "safeErrorCode" = 'legacy_ambiguous_recovery'
WHERE "status" = 'pending';

-- Fail the migration before any constraint is installed if a live fence token
-- is absent or non-positive. These assertions deliberately include expired-by-
-- time leases whose legacy status still says preleased/finalized.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthSetupManifest"
    WHERE "status" IN ('issued', 'fetched')
      AND COALESCE("mutationEpoch", 0) <= 0
  ) THEN RAISE EXCEPTION 'active setup manifest lacks a positive mutation epoch'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthLease"
    WHERE "status" IN ('preleased', 'finalized')
      AND COALESCE("mutationEpoch", 0) <= 0
  ) THEN RAISE EXCEPTION 'active lease lacks a positive mutation epoch'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthWritebackIntent"
    WHERE "status" = 'pending' AND COALESCE("mutationEpoch", 0) <= 0
  ) THEN RAISE EXCEPTION 'pending intent lacks a positive mutation epoch'; END IF;
END $$;

ALTER TABLE "CodexOAuthProviderInstance"
  ADD CONSTRAINT "CodexOAuthProviderInstance_mutation_fence_check" CHECK (
    "mutationEpoch" >= 0
    AND ("mutationOwner" IS NULL) = ("mutationOwnerId" IS NULL)
    AND ("mutationOwner" IS NULL OR "mutationOwner" IN ('runtime', 'setup', 'recovery'))
    AND ("mutationOwner" IS NULL OR "mutationEpoch" > 0)
  );
ALTER TABLE "CodexOAuthSetupManifest"
  ADD CONSTRAINT "CodexOAuthSetupManifest_epoch_check" CHECK (
    ("status" NOT IN ('issued', 'fetched') OR COALESCE("mutationEpoch", 0) > 0)
    AND ("mutationEpoch" IS NULL OR "mutationEpoch" > 0)
  ) NOT VALID;
ALTER TABLE "CodexOAuthLease"
  ADD CONSTRAINT "CodexOAuthLease_epoch_check" CHECK (
    ("status" NOT IN ('preleased', 'finalized') OR COALESCE("mutationEpoch", 0) > 0)
    AND ("mutationEpoch" IS NULL OR "mutationEpoch" > 0)
  ) NOT VALID;
ALTER TABLE "CodexOAuthWritebackIntent"
  ADD CONSTRAINT "CodexOAuthWritebackIntent_epoch_check" CHECK (
    ("status" <> 'pending' OR COALESCE("mutationEpoch", 0) > 0)
    AND ("mutationEpoch" IS NULL OR "mutationEpoch" > 0)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION "codex_oauth_repository_identity_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."githubRepositoryId" IS DISTINCT FROM OLD."githubRepositoryId"
     OR NEW."externalRepositoryId" IS DISTINCT FROM OLD."externalRepositoryId"
  THEN
    IF EXISTS (
      SELECT 1 FROM "CodexOAuthProviderInstance" p
      WHERE p."repositoryId" IN (OLD."id", NEW."id")
        AND (
          NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."provider"::text <> 'github'
          OR NEW."githubRepositoryId" IS NULL
          OR NEW."externalRepositoryId" IS DISTINCT FROM NEW."githubRepositoryId"::text
          OR p."repositoryId" <> NEW."id"
          OR p."workspaceId" <> NEW."workspaceId"
          OR p."providerInstanceId" <> 'codex-rotating:' || NEW."githubRepositoryId"::text
          OR p."authMode" <> 'codex_subscription_oauth_rotating'
          OR p."secretName" <> 'REVIEWROUTER_CODEX_AUTH_JSON'
        )
    ) THEN
      RAISE EXCEPTION 'codex_oauth_repository_identity_bound' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "RepositoryConnection_codex_oauth_identity_guard"
AFTER UPDATE ON "RepositoryConnection"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION "codex_oauth_repository_identity_guard"();

CREATE OR REPLACE FUNCTION "codex_oauth_provider_identity_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE repository_record RECORD;
DECLARE identity_changed BOOLEAN := FALSE;
DECLARE repair_allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    identity_changed :=
      NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR
      NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId" OR
      NEW."providerInstanceId" IS DISTINCT FROM OLD."providerInstanceId" OR
      NEW."authMode" IS DISTINCT FROM OLD."authMode" OR
      NEW."secretName" IS DISTINCT FROM OLD."secretName";
    repair_allowed := identity_changed
      AND OLD."mutationOwner" = 'recovery'
      AND EXISTS (
        SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" q
        WHERE q."providerInstanceRowId" = OLD."id" AND q."resolvedAt" IS NULL
      );
    IF identity_changed AND NOT repair_allowed THEN
      RAISE EXCEPTION 'codex_oauth_provider_identity_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "workspaceId", "provider", "githubRepositoryId" INTO repository_record
  FROM "RepositoryConnection" WHERE "id" = NEW."repositoryId" FOR SHARE;
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
     OR NEW."mutationEpoch" IS DISTINCT FROM OLD."mutationEpoch"
     OR NEW."mutationOwner" IS DISTINCT FROM OLD."mutationOwner"
     OR NEW."mutationOwnerId" IS DISTINCT FROM OLD."mutationOwnerId"
  THEN
    IF NOT (
      (NEW."mutationEpoch" > OLD."mutationEpoch"
       AND NEW."mutationOwner" IN ('runtime', 'setup', 'recovery')
       AND NEW."mutationOwnerId" IS NOT NULL)
      OR
      (NEW."mutationEpoch" = OLD."mutationEpoch"
       AND OLD."mutationOwner" IN ('runtime', 'setup')
       AND OLD."mutationOwnerId" IS NOT NULL
       AND NEW."mutationOwner" IS NULL
       AND NEW."mutationOwnerId" IS NULL)
      OR
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
DECLARE lease_record RECORD;
DECLARE was_active BOOLEAN := FALSE;
DECLARE is_active BOOLEAN := FALSE;
DECLARE row_changed BOOLEAN := TRUE;
DECLARE owner_matches BOOLEAN := FALSE;
BEGIN
  SELECT * INTO p FROM "CodexOAuthProviderInstance"
  WHERE "id" = NEW."providerInstanceRowId" FOR SHARE;
  IF NOT FOUND OR NEW."providerInstanceId" <> p."providerInstanceId" THEN
    RAISE EXCEPTION 'codex_oauth_child_provider_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('CodexOAuthLease', 'CodexOAuthSetupManifest') AND (
    to_jsonb(NEW)->>'workspaceId' <> p."workspaceId" OR
    to_jsonb(NEW)->>'repositoryId' <> p."repositoryId"
  ) THEN RAISE EXCEPTION 'codex_oauth_child_natural_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'CodexOAuthWritebackIntent' THEN
    SELECT "providerInstanceRowId", "providerInstanceId", "mutationEpoch" INTO lease_record
    FROM "CodexOAuthLease" WHERE "id" = NEW."leaseId";
    IF NOT FOUND OR lease_record."providerInstanceRowId" <> NEW."providerInstanceRowId"
       OR lease_record."providerInstanceId" <> NEW."providerInstanceId"
    THEN RAISE EXCEPTION 'codex_oauth_child_lease_ownership_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'CodexOAuthSetupManifest' THEN
    is_active := NEW."status" IN ('issued', 'fetched');
    owner_matches := p."mutationOwner" = 'setup' AND p."mutationOwnerId" = NEW."id";
    IF TG_OP = 'UPDATE' THEN was_active := OLD."status" IN ('issued', 'fetched'); END IF;
  ELSIF TG_TABLE_NAME = 'CodexOAuthLease' THEN
    is_active := NEW."status" IN ('preleased', 'finalized');
    owner_matches := p."mutationOwner" = 'runtime'
      AND p."mutationOwnerId" IN (NEW."id", NEW."leaseKey");
    IF TG_OP = 'UPDATE' THEN was_active := OLD."status" IN ('preleased', 'finalized'); END IF;
  ELSE
    is_active := NEW."status" = 'pending';
    owner_matches := p."mutationOwner" = 'runtime' AND p."mutationOwnerId" = NEW."leaseId"
      AND lease_record."mutationEpoch" = p."mutationEpoch";
    IF TG_OP = 'UPDATE' THEN was_active := OLD."status" = 'pending'; END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    row_changed := (to_jsonb(NEW) - 'mutationEpoch') IS DISTINCT FROM
      (to_jsonb(OLD) - 'mutationEpoch');
  END IF;

  IF NEW."mutationEpoch" IS NOT NULL AND NEW."mutationEpoch" <> p."mutationEpoch" THEN
    IF NOT (
      TG_OP = 'UPDATE'
      AND NEW."mutationEpoch" < p."mutationEpoch"
      AND was_active AND NOT is_active
    ) THEN
      RAISE EXCEPTION 'codex_oauth_child_mutation_epoch_mismatch' USING ERRCODE = '40001';
    END IF;
  ELSIF (is_active OR (TG_OP = 'UPDATE' AND was_active AND row_changed))
        AND (COALESCE(NEW."mutationEpoch", 0) <= 0 OR NOT owner_matches)
  THEN
    RAISE EXCEPTION 'codex_oauth_child_mutation_owner_mismatch' USING ERRCODE = '40001';
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

-- Executable, evidence-preserving cleanup for an operator who has first
-- established recovery ownership. Terminal quarantined rows can be repaired
-- without disabling the guards; ambiguous intent lease ownership requires an
-- explicit replacement lease belonging to the same provider.
CREATE OR REPLACE FUNCTION "codex_oauth_repair_quarantined_child"(
  target_kind TEXT, target_id TEXT, replacement_lease_id TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE q RECORD;
DECLARE p RECORD;
DECLARE replacement RECORD;
BEGIN
  SELECT * INTO q FROM "CodexOAuthChildIdentityQuarantine"
  WHERE "childKind" = target_kind AND "childId" = target_id AND "resolvedAt" IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'codex_oauth_child_quarantine_not_found'; END IF;
  SELECT * INTO p FROM "CodexOAuthProviderInstance"
  WHERE "id" = q."providerInstanceRowId" FOR UPDATE;
  IF NOT FOUND OR p."mutationOwner" <> 'recovery' THEN
    RAISE EXCEPTION 'codex_oauth_child_quarantine_recovery_required' USING ERRCODE = '40001';
  END IF;
  IF target_kind = 'setup_manifest' THEN
    UPDATE "CodexOAuthSetupManifest" SET
      "workspaceId" = p."workspaceId", "repositoryId" = p."repositoryId",
      "providerInstanceId" = p."providerInstanceId"
    WHERE "id" = target_id AND "providerInstanceRowId" = p."id";
  ELSIF target_kind = 'lease' THEN
    UPDATE "CodexOAuthLease" SET
      "workspaceId" = p."workspaceId", "repositoryId" = p."repositoryId",
      "providerInstanceId" = p."providerInstanceId"
    WHERE "id" = target_id AND "providerInstanceRowId" = p."id";
  ELSIF target_kind = 'writeback_intent' THEN
    SELECT "id", "providerInstanceRowId", "providerInstanceId" INTO replacement
    FROM "CodexOAuthLease"
    WHERE "id" = COALESCE(replacement_lease_id,
      (SELECT "leaseId" FROM "CodexOAuthWritebackIntent" WHERE "id" = target_id));
    IF NOT FOUND OR replacement."providerInstanceRowId" <> p."id"
       OR replacement."providerInstanceId" <> p."providerInstanceId"
    THEN RAISE EXCEPTION 'codex_oauth_child_quarantine_valid_lease_required'; END IF;
    UPDATE "CodexOAuthWritebackIntent" SET
      "providerInstanceId" = p."providerInstanceId", "leaseId" = replacement."id"
    WHERE "id" = target_id AND "providerInstanceRowId" = p."id";
  ELSE
    RAISE EXCEPTION 'codex_oauth_child_quarantine_kind_invalid';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'codex_oauth_child_quarantine_row_missing'; END IF;
  UPDATE "CodexOAuthChildIdentityQuarantine" SET "resolvedAt" = CURRENT_TIMESTAMP
  WHERE "childKind" = target_kind AND "childId" = target_id;
END $$;

CREATE OR REPLACE FUNCTION "codex_oauth_repair_quarantined_provider"(
  target_provider_instance_row_id TEXT,
  target_github_repository_id BIGINT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE p RECORD;
DECLARE r RECORD;
BEGIN
  SELECT * INTO p FROM "CodexOAuthProviderInstance"
  WHERE "id" = target_provider_instance_row_id FOR UPDATE;
  IF NOT FOUND OR p."mutationOwner" <> 'recovery' OR NOT EXISTS (
    SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" q
    WHERE q."providerInstanceRowId" = p."id" AND q."resolvedAt" IS NULL
  ) THEN RAISE EXCEPTION 'codex_oauth_provider_quarantine_recovery_required' USING ERRCODE = '40001'; END IF;
  SELECT * INTO r FROM "RepositoryConnection" WHERE "id" = p."repositoryId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_oauth_provider_quarantine_repository_invalid';
  END IF;
  IF r."provider"::text <> 'github' OR r."githubRepositoryId" IS NULL THEN
    IF COALESCE(target_github_repository_id, 0) <= 0 THEN
      RAISE EXCEPTION 'codex_oauth_provider_quarantine_repository_identity_required';
    END IF;
    SET CONSTRAINTS "RepositoryConnection_codex_oauth_identity_guard" DEFERRED;
    UPDATE "RepositoryConnection" SET
      "provider" = 'github',
      "githubRepositoryId" = target_github_repository_id,
      "externalRepositoryId" = target_github_repository_id::text
    WHERE "id" = r."id";
    SELECT * INTO r FROM "RepositoryConnection" WHERE "id" = p."repositoryId";
  ELSIF r."externalRepositoryId" IS DISTINCT FROM r."githubRepositoryId"::text THEN
    SET CONSTRAINTS "RepositoryConnection_codex_oauth_identity_guard" DEFERRED;
    UPDATE "RepositoryConnection" SET
      "externalRepositoryId" = r."githubRepositoryId"::text
    WHERE "id" = r."id";
    SELECT * INTO r FROM "RepositoryConnection" WHERE "id" = p."repositoryId";
  END IF;
  UPDATE "CodexOAuthProviderInstance" SET
    "workspaceId" = r."workspaceId",
    "providerInstanceId" = 'codex-rotating:' || r."githubRepositoryId"::text,
    "authMode" = 'codex_subscription_oauth_rotating',
    "secretName" = 'REVIEWROUTER_CODEX_AUTH_JSON'
  WHERE "id" = p."id";
  UPDATE "CodexOAuthProviderIdentityQuarantine" SET "resolvedAt" = CURRENT_TIMESTAMP
  WHERE "providerInstanceRowId" = p."id";
END $$;

CREATE INDEX "CodexOAuthProviderInstance_mutation_owner_idx"
  ON "CodexOAuthProviderInstance"("mutationOwner", "mutationEpoch");
CREATE INDEX "CodexOAuthSetupManifest_provider_epoch_idx"
  ON "CodexOAuthSetupManifest"("providerInstanceRowId", "mutationEpoch");
CREATE INDEX "CodexOAuthLease_provider_epoch_idx"
  ON "CodexOAuthLease"("providerInstanceRowId", "mutationEpoch");
CREATE INDEX "CodexOAuthWritebackIntent_provider_epoch_idx"
  ON "CodexOAuthWritebackIntent"("providerInstanceRowId", "mutationEpoch");
CREATE INDEX "CodexOAuthChildIdentityQuarantine_provider_idx"
  ON "CodexOAuthChildIdentityQuarantine"("providerInstanceRowId", "resolvedAt");

COMMIT;

-- Deliberately no down migration. After this fence is installed, application
-- rollback below the mutation-fence-aware image is unsafe; recover by rolling
-- forward with a compatible image.
