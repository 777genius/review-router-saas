-- This migration is the mixed-version bridge, not the activation event.
-- Old replicas globally inspect providerVoteIdentityHash and cannot tolerate
-- two active rows.  The trigger preserves that invariant after the index is
-- removed until an operator explicitly activates scoped concurrency.
CREATE TABLE "ReviewProviderScopeConcurrencyControl" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "activated" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "ReviewProviderScopeConcurrencyControl" ("singleton", "activated")
VALUES (true, false)
ON CONFLICT ("singleton") DO NOTHING;

-- The rollout bit is operator authority, not an application mutation surface.
-- Runtime processes need to observe it through the bridge/status paths, but
-- only the migration operator (or the schema owner it is permitted to assume)
-- may change it.
REVOKE ALL ON TABLE "ReviewProviderScopeConcurrencyControl" FROM PUBLIC;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker'
  ] LOOP
    IF to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public."ReviewProviderScopeConcurrencyControl" FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE public."ReviewProviderScopeConcurrencyControl" TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
  IF to_regrole('reviewrouter_release_migration') IS NOT NULL THEN
    GRANT SELECT, UPDATE
      ON TABLE "ReviewProviderScopeConcurrencyControl"
      TO reviewrouter_release_migration;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_bridge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scoped_concurrency_activated boolean;
BEGIN
  -- Shared only: this is a cutover fence, not an account-wide capacity lock.
  -- The activation command takes the exclusive session form of the same lock.
  PERFORM pg_advisory_xact_lock_shared(1381126735, 1381192279);

  SELECT "activated"
    INTO scoped_concurrency_activated
    FROM "ReviewProviderScopeConcurrencyControl"
    WHERE "singleton" = true;

  IF scoped_concurrency_activated IS DISTINCT FROM true THEN
    -- Serialize only equal vote identities while the old fleet contract is
    -- live.  Inference leases and unrelated vote identities never take it.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('review-provider-vote:' || NEW."providerVoteIdentityHash", 0)
    );
    IF EXISTS (
      SELECT 1
      FROM "ReviewInvocationLeaseV2" incumbent
      WHERE incumbent."providerVoteIdentityHash" = NEW."providerVoteIdentityHash"
        AND incumbent."purpose" = 'provider_execution'
        AND incumbent."state" = 'active'
        AND incumbent."leaseId" <> NEW."leaseId"
    ) THEN
      RAISE unique_violation
        USING CONSTRAINT = 'ReviewInvocationLeaseV2_one_active_provider_vote_lane',
              MESSAGE = 'mixed-version provider vote lane is busy';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReviewInvocationLeaseV2_provider_scope_concurrency_bridge"
BEFORE INSERT OR UPDATE OF "providerVoteIdentityHash", "purpose", "state"
ON "ReviewInvocationLeaseV2"
FOR EACH ROW
WHEN (NEW."purpose" = 'provider_execution' AND NEW."state" = 'active')
EXECUTE FUNCTION reviewrouter_provider_scope_concurrency_bridge();

-- Keep the physical index throughout migration-first and rolling app deploys.
-- The explicit post-drain activation command removes it concurrently while it
-- holds the fleet cutover fence, then marks scoped concurrency active.
