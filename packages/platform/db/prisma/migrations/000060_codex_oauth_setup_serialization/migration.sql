BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "CodexOAuthSetupManifest"
  ADD COLUMN "confirmationJson" JSONB;

UPDATE "CodexOAuthSetupManifest"
SET "status" = 'expired'
WHERE "status" IN ('issued', 'fetched')
  AND "expiresAt" <= CURRENT_TIMESTAMP;

WITH ranked_active AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "providerInstanceRowId"
      ORDER BY
        CASE "status" WHEN 'fetched' THEN 0 ELSE 1 END,
        "createdAt" DESC,
        "id" DESC
    ) AS active_rank
  FROM "CodexOAuthSetupManifest"
  WHERE "status" IN ('issued', 'fetched')
)
UPDATE "CodexOAuthSetupManifest" AS manifest
SET "status" = 'superseded'
FROM ranked_active
WHERE manifest."id" = ranked_active."id"
  AND ranked_active.active_rank > 1;

CREATE UNIQUE INDEX "CodexOAuthSetupManifest_one_active_provider_key"
  ON "CodexOAuthSetupManifest"("providerInstanceRowId")
  WHERE "status" IN ('issued', 'fetched');

COMMIT;
