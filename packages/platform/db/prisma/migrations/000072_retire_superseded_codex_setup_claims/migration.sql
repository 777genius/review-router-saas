-- Setup reactivation already retired the previous versioned secret namespace,
-- but left its claim and confirmed dispatch attempt active. Readiness requires
-- one active claim per provider, so keep the newest activated claim and retire
-- only older duplicates produced by that lifecycle bug.
WITH ranked_active_claims AS (
  SELECT
    claim."id",
    row_number() OVER (
      PARTITION BY claim."providerInstanceRowId"
      ORDER BY claim."recoveryEpoch" DESC, claim."createdAt" DESC, claim."id" DESC
    ) AS rank
  FROM "CodexOAuthSetupPayloadClaim" claim
  WHERE claim."status" = 'active'
), superseded_claims AS (
  SELECT "id" FROM ranked_active_claims WHERE rank > 1
)
UPDATE "CodexOAuthSetupDispatchAttempt" attempt
SET "status" = 'retired_confirmed',
    "retiredAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE attempt."claimId" IN (SELECT "id" FROM superseded_claims)
  AND attempt."status" = 'confirmed';

WITH ranked_active_claims AS (
  SELECT
    claim."id",
    row_number() OVER (
      PARTITION BY claim."providerInstanceRowId"
      ORDER BY claim."recoveryEpoch" DESC, claim."createdAt" DESC, claim."id" DESC
    ) AS rank
  FROM "CodexOAuthSetupPayloadClaim" claim
  WHERE claim."status" = 'active'
)
UPDATE "CodexOAuthSetupPayloadClaim" claim
SET "status" = 'retired_active',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE claim."id" IN (
  SELECT "id" FROM ranked_active_claims WHERE rank > 1
);

CREATE UNIQUE INDEX "CodexOAuthSetupPayloadClaim_one_active_per_provider_key"
  ON "CodexOAuthSetupPayloadClaim"("providerInstanceRowId")
  WHERE "status" = 'active';
