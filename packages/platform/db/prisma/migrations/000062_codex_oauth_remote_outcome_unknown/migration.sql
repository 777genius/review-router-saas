BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- These failures were recorded only after a GitHub secret PUT was claimed.
-- GitHub offers no CAS or request-outcome lookup for secret PUT, so neither a
-- transport failure nor elapsed time can prove that a late write will not land.
UPDATE "CodexOAuthWritebackIntent"
SET "status" = 'remote_outcome_unknown',
    "safeErrorCode" = CASE "safeErrorCode"
      WHEN 'github_put_failed' THEN 'github_put_remote_outcome_unknown'
      WHEN 'writeback_confirmation_ambiguous' THEN 'writeback_confirmation_remote_outcome_unknown'
      WHEN 'stale_mutation_epoch' THEN 'post_put_stale_mutation_epoch'
      WHEN 'legacy_ambiguous_recovery' THEN 'legacy_remote_outcome_unknown'
      ELSE "safeErrorCode"
    END
WHERE "status" = 'failed'
  AND "safeErrorCode" IN (
    'github_put_failed',
    'writeback_confirmation_ambiguous',
    'stale_mutation_epoch',
    'legacy_ambiguous_recovery'
  );

-- Preserve recovery ownership for every migrated unknown outcome. The owner
-- names provenance only; it never authorizes an in-place reseed.
UPDATE "CodexOAuthProviderInstance" provider
SET "state" = 'unknown_auth_state',
    "mutationEpoch" = provider."mutationEpoch" + 1,
    "mutationOwner" = 'recovery',
    "mutationOwnerId" = intent."id"
FROM "CodexOAuthWritebackIntent" intent
WHERE intent."providerInstanceRowId" = provider."id"
  AND intent."status" = 'remote_outcome_unknown';

COMMIT;

-- No down migration: relabeling an unknowable remote outcome as recoverable
-- would reintroduce the overwrite race this migration closes.
