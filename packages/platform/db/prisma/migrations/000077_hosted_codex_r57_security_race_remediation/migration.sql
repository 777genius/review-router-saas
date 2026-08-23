-- Remediate the post-certification dispatch, accounting, restore, and retry
-- races without rewriting the immutable 000074 through 000076 artifacts.
BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- At most one resumable operation may own an inventory/target scope. A
-- promoted or cleanly failed operation releases the scope for a fresh permit.
CREATE UNIQUE INDEX "HostedCodexRestoreOperation_active_inventory_target_key"
  ON "HostedCodexRestoreOperation"(
    "inventoryHash", "databaseResourceIdentity", "targetIncarnation"
  )
  WHERE "state" IN ('witnessed', 'reconciling', 'reconciled');

-- Exhaustion closes new admission, but it must not make revocation impossible.
CREATE OR REPLACE FUNCTION hosted_codex_invocation_grant_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."failoverCount" <> 0
       OR NEW."activeAccountId" IS DISTINCT FROM NEW."primaryAccountId"
       OR NEW."backupAccountId" IS NOT NULL AND NEW."backupAccountId" = NEW."primaryAccountId"
       OR NEW."firstSuccessfulResponseAt" IS NOT NULL THEN
      RAISE EXCEPTION 'hosted_codex_grant_invalid_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."invocationId" IS DISTINCT FROM OLD."invocationId"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."repositoryConnectionId" IS DISTINCT FROM OLD."repositoryConnectionId"
     OR NEW."repositoryBindingId" IS DISTINCT FROM OLD."repositoryBindingId"
     OR NEW."primaryAccountId" IS DISTINCT FROM OLD."primaryAccountId"
     OR NEW."backupAccountId" IS DISTINCT FROM OLD."backupAccountId"
     OR NEW."reviewRequestId" IS DISTINCT FROM OLD."reviewRequestId"
     OR NEW."providerInvocationKey" IS DISTINCT FROM OLD."providerInvocationKey"
     OR NEW."runId" IS DISTINCT FROM OLD."runId" OR NEW."runAttempt" IS DISTINCT FROM OLD."runAttempt"
     OR NEW."model" IS DISTINCT FROM OLD."model" OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
     OR NEW."policyFingerprint" IS DISTINCT FROM OLD."policyFingerprint"
     OR NEW."runtimeConfigVersion" IS DISTINCT FROM OLD."runtimeConfigVersion"
     OR NEW."bindingRevision" IS DISTINCT FROM OLD."bindingRevision" OR NEW."authzEpoch" IS DISTINCT FROM OLD."authzEpoch"
     OR NEW."capabilityTokenHash" IS DISTINCT FROM OLD."capabilityTokenHash"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."maxRequests" IS DISTINCT FROM OLD."maxRequests"
     OR NEW."maxConcurrentRequests" IS DISTINCT FROM OLD."maxConcurrentRequests"
     OR NEW."maxRequestBytes" IS DISTINCT FROM OLD."maxRequestBytes"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hosted_codex_grant_identity_immutable';
  END IF;
  IF OLD."firstSuccessfulResponseAt" IS NOT NULL
     AND NEW."firstSuccessfulResponseAt" IS DISTINCT FROM OLD."firstSuccessfulResponseAt" THEN
    RAISE EXCEPTION 'hosted_codex_first_success_immutable';
  END IF;
  IF NEW."activeAccountId" IS DISTINCT FROM OLD."activeAccountId" THEN
    IF OLD."firstSuccessfulResponseAt" IS NOT NULL OR NEW."firstSuccessfulResponseAt" IS NOT NULL
       OR OLD."failoverCount" <> 0 OR NEW."failoverCount" <> 1
       OR OLD."activeAccountId" IS DISTINCT FROM OLD."primaryAccountId"
       OR OLD."backupAccountId" IS NULL OR NEW."activeAccountId" IS DISTINCT FROM OLD."backupAccountId" THEN
      RAISE EXCEPTION 'hosted_codex_grant_failover_forbidden';
    END IF;
  ELSIF NEW."failoverCount" IS DISTINCT FROM OLD."failoverCount"
        OR NEW."primaryAccountId" IS DISTINCT FROM OLD."primaryAccountId"
        OR NEW."backupAccountId" IS DISTINCT FROM OLD."backupAccountId" THEN
    RAISE EXCEPTION 'hosted_codex_grant_failover_evidence_invalid';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    OLD."status" = 'issued'
    OR (OLD."status" = 'exhausted' AND NEW."status" = 'revoked')
  ) THEN
    RAISE EXCEPTION 'hosted_codex_grant_terminal_status';
  END IF;
  RETURN NEW;
END
$guard$;

-- A no-effect crash is the one terminal request state that may be resumed in
-- place. The immutable body hash and idempotency identity remain unchanged,
-- and application admission restores only the already-counted in-flight slot.
CREATE OR REPLACE FUNCTION hosted_codex_relay_request_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
     OR NEW."idempotencyKeyHash" IS DISTINCT FROM OLD."idempotencyKeyHash"
     OR NEW."requestBytes" IS DISTINCT FROM OLD."requestBytes"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'hosted_codex_relay_request_identity_immutable';
  END IF;
  IF OLD."requestHash" IS NOT NULL
     AND NEW."requestHash" IS DISTINCT FROM OLD."requestHash" THEN
    RAISE EXCEPTION 'hosted_codex_relay_request_hash_immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'received'
       AND NEW."status" NOT IN ('processing', 'response_started', 'succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'processing'
       AND NEW."status" NOT IN ('response_started', 'succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'response_started'
       AND NEW."status" NOT IN ('succeeded', 'failed', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_transition_invalid';
    ELSIF OLD."status" = 'failed' AND NOT (
      OLD."errorCode" = 'upstream_dispatch_not_started'
      AND NEW."status" = 'processing'
      AND NEW."requestHash" IS NOT NULL
      AND NEW."responseBytes" IS NULL AND NEW."responseHash" IS NULL
      AND NEW."errorCode" IS NULL AND NEW."completedAt" IS NULL
      AND NEW."successfulResponseStartedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM public."HostedCodexUpstreamEffectAttempt" e
        WHERE e."relayRequestId" = OLD."id" AND e."grantId" = OLD."grantId"
          AND e."state" = 'failed_no_effect'
          AND NOT EXISTS (
            SELECT 1 FROM public."HostedCodexUpstreamEffectAttempt" newer
            WHERE newer."relayRequestId" = e."relayRequestId"
              AND newer."attemptOrdinal" > e."attemptOrdinal"
          )
      )
    ) THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_terminal_status';
    ELSIF OLD."status" IN ('succeeded', 'terminal_unknown') THEN
      RAISE EXCEPTION 'hosted_codex_relay_request_terminal_status';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;

-- Repair counters that 000076 may have zeroed while sibling requests were
-- still live. The request ledger remains the accounting authority.
UPDATE "HostedCodexInvocationGrant" g
SET "inFlight" = live.count,
    "revision" = g."revision" + 1,
    "updatedAt" = clock_timestamp()
FROM (
  SELECT g2."id", count(r."id")::integer AS count
  FROM "HostedCodexInvocationGrant" g2
  LEFT JOIN "HostedCodexRelayRequest" r ON r."grantId" = g2."id"
    AND r."status" IN ('received', 'processing', 'response_started')
  GROUP BY g2."id"
) live
WHERE g."id" = live."id" AND g."inFlight" IS DISTINCT FROM live.count;

CREATE OR REPLACE FUNCTION "hosted_codex_terminal_unknown_poison_grant"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."status" = 'terminal_unknown'
    AND (TG_OP = 'INSERT' OR OLD."status" <> 'terminal_unknown') THEN
    UPDATE public."HostedCodexInvocationGrant"
    SET "status" = 'revoked',
        "revokedAt" = COALESCE("revokedAt", NEW."completedAt", clock_timestamp()),
        "revision" = "revision" + 1,
        "updatedAt" = clock_timestamp()
    WHERE "id" = NEW."grantId"
      AND "status" IN ('issued', 'exhausted') AND "revokedAt" IS NULL;
    UPDATE public."HostedCodexCommentRefreshCapability"
    SET "revokedAt" = COALESCE("revokedAt", NEW."completedAt", clock_timestamp()),
        "revision" = "revision" + 1, "updatedAt" = clock_timestamp()
    WHERE "grantId" = NEW."grantId" AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Cover terminal-unknown rows created while an exhausted grant escaped the
-- narrower 000076 trigger.
UPDATE "HostedCodexInvocationGrant" g
SET "status" = 'revoked',
    "revokedAt" = COALESCE(
      g."revokedAt",
      (SELECT min(r."completedAt") FROM "HostedCodexRelayRequest" r
       WHERE r."grantId" = g."id" AND r."status" = 'terminal_unknown'),
      clock_timestamp()
    ),
    "revision" = g."revision" + 1,
    "updatedAt" = clock_timestamp()
WHERE g."status" IN ('issued', 'exhausted') AND g."revokedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "HostedCodexRelayRequest" r
    WHERE r."grantId" = g."id" AND r."status" = 'terminal_unknown'
  );

UPDATE "HostedCodexCommentRefreshCapability" c
SET "revokedAt" = COALESCE(c."revokedAt", g."revokedAt", clock_timestamp()),
    "revision" = c."revision" + 1,
    "updatedAt" = clock_timestamp()
FROM "HostedCodexInvocationGrant" g
WHERE c."grantId" = g."id" AND g."status" = 'revoked'
  AND c."revokedAt" IS NULL;

COMMIT;
