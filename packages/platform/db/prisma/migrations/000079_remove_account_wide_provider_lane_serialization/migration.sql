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
    REVOKE ALL
      ON TABLE "ReviewProviderScopeConcurrencyControl"
      FROM reviewrouter_release_migration;
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
-- The explicit post-drain activation routine removes it atomically while it
-- holds the fleet cutover fence, then marks scoped concurrency active.

-- Operator transitions are deliberately narrower than schema ownership.  The
-- release login has no membership in the schema-owner role and receives no
-- table DML or DDL capability.  These routines are the complete bounded
-- management surface; each transition and its catalog validation is one
-- transaction under the same fleet fence used by the bridge trigger.
CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  control_activated boolean;
  control_updated_at timestamp(3);
  duplicate_count integer;
  index_oid oid;
  index_valid boolean;
  index_ready boolean;
  index_unique boolean;
  index_definition text;
  expected_definition constant text :=
    'CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_provider_vote_lane" ON public."ReviewInvocationLeaseV2" USING btree ("providerVoteIdentityHash") WHERE ((state = ''active''::"ReviewInvocationLeaseStateV2") AND (purpose = ''provider_execution''::"ReviewInvocationLeasePurposeV2"))';
BEGIN
  SELECT control."activated", control."updatedAt"
    INTO STRICT control_activated, control_updated_at
    FROM public."ReviewProviderScopeConcurrencyControl" control
    WHERE control."singleton" = true;

  SELECT count(*)::integer
    INTO duplicate_count
    FROM (
      SELECT lease."providerVoteIdentityHash"
      FROM public."ReviewInvocationLeaseV2" lease
      WHERE lease."purpose" = 'provider_execution'
        AND lease."state" = 'active'
      GROUP BY lease."providerVoteIdentityHash"
      HAVING count(*) > 1
    ) duplicate_lanes;

  SELECT index_catalog.indexrelid, index_catalog.indisvalid,
         index_catalog.indisready, index_catalog.indisunique,
         pg_get_indexdef(index_catalog.indexrelid)
    INTO index_oid, index_valid, index_ready, index_unique, index_definition
    FROM pg_catalog.pg_index index_catalog
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = index_catalog.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_class table_relation
      ON table_relation.oid = index_catalog.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname =
        'ReviewInvocationLeaseV2_one_active_provider_vote_lane'
      AND table_namespace.nspname = 'public'
      AND table_relation.relname = 'ReviewInvocationLeaseV2';

  RETURN jsonb_build_object(
    'activated', control_activated,
    'updatedAt', control_updated_at,
    'duplicateActiveVoteLanes', duplicate_count,
    'legacyProviderVoteIndex', CASE WHEN index_oid IS NULL THEN NULL ELSE
      jsonb_build_object(
        'valid', index_valid,
        'ready', index_ready,
        'unique', index_unique,
        'definition', index_definition,
        'exact', index_valid AND index_ready AND index_unique
          AND index_definition = expected_definition
      ) END
  );
END
$$;

CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'provider_scope_concurrency_caller_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(1381126735, 1381192279);
  RETURN public.reviewrouter_provider_scope_concurrency_snapshot();
END
$$;

CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_activate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  control_activated boolean;
  snapshot jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'provider_scope_concurrency_caller_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1381192279);
  SELECT control."activated"
    INTO STRICT control_activated
    FROM public."ReviewProviderScopeConcurrencyControl" control
    WHERE control."singleton" = true
    FOR UPDATE;
  snapshot := public.reviewrouter_provider_scope_concurrency_snapshot();

  IF control_activated THEN
    IF snapshot->>'legacyProviderVoteIndex' IS NOT NULL THEN
      RAISE EXCEPTION 'provider_scope_concurrency_activated_index_present';
    END IF;
    RETURN snapshot;
  END IF;
  IF coalesce((snapshot->'legacyProviderVoteIndex'->>'exact')::boolean, false)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'provider_scope_concurrency_legacy_index_invalid';
  END IF;

  DROP INDEX public."ReviewInvocationLeaseV2_one_active_provider_vote_lane";
  UPDATE public."ReviewProviderScopeConcurrencyControl"
  SET "activated" = true, "updatedAt" = statement_timestamp()
  WHERE "singleton" = true;
  RETURN public.reviewrouter_provider_scope_concurrency_snapshot();
END
$$;

CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_close_for_rollback()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  control_activated boolean;
  snapshot jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'provider_scope_concurrency_caller_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1381192279);
  SELECT control."activated"
    INTO STRICT control_activated
    FROM public."ReviewProviderScopeConcurrencyControl" control
    WHERE control."singleton" = true
    FOR UPDATE;
  snapshot := public.reviewrouter_provider_scope_concurrency_snapshot();

  IF NOT control_activated THEN
    RETURN snapshot;
  END IF;
  IF snapshot->>'legacyProviderVoteIndex' IS NOT NULL THEN
    RAISE EXCEPTION 'provider_scope_concurrency_activated_index_present';
  END IF;
  UPDATE public."ReviewProviderScopeConcurrencyControl"
  SET "activated" = false, "updatedAt" = statement_timestamp()
  WHERE "singleton" = true;
  RETURN public.reviewrouter_provider_scope_concurrency_snapshot();
END
$$;

CREATE OR REPLACE FUNCTION reviewrouter_provider_scope_concurrency_verify_rollback()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  control_activated boolean;
  snapshot jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'provider_scope_concurrency_caller_invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1381192279);
  SELECT control."activated"
    INTO STRICT control_activated
    FROM public."ReviewProviderScopeConcurrencyControl" control
    WHERE control."singleton" = true
    FOR UPDATE;
  IF control_activated THEN
    RAISE EXCEPTION 'provider_scope_concurrency_must_be_closed';
  END IF;
  snapshot := public.reviewrouter_provider_scope_concurrency_snapshot();
  IF (snapshot->>'duplicateActiveVoteLanes')::integer <> 0 THEN
    RAISE EXCEPTION 'provider_scope_concurrency_rollback_requires_drain:%',
      snapshot->>'duplicateActiveVoteLanes';
  END IF;
  IF coalesce((snapshot->'legacyProviderVoteIndex'->>'exact')::boolean, false)
     IS DISTINCT FROM true THEN
    IF to_regclass(
      'public."ReviewInvocationLeaseV2_one_active_provider_vote_lane"'
    ) IS NOT NULL THEN
      DROP INDEX public."ReviewInvocationLeaseV2_one_active_provider_vote_lane";
    END IF;
    CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
      ON public."ReviewInvocationLeaseV2" ("providerVoteIdentityHash")
      WHERE "state" = 'active' AND "purpose" = 'provider_execution';
  END IF;
  snapshot := public.reviewrouter_provider_scope_concurrency_snapshot();
  IF coalesce((snapshot->'legacyProviderVoteIndex'->>'exact')::boolean, false)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'provider_scope_concurrency_legacy_index_repair_failed';
  END IF;
  RETURN snapshot;
END
$$;

REVOKE ALL ON FUNCTION reviewrouter_provider_scope_concurrency_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_provider_scope_concurrency_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_provider_scope_concurrency_activate() FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_provider_scope_concurrency_close_for_rollback() FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_provider_scope_concurrency_verify_rollback() FROM PUBLIC;

DO $operator_routine_acl$
BEGIN
  IF to_regrole('reviewrouter_release_schema_owner') IS NULL
     OR to_regrole('reviewrouter_release_migration') IS NULL THEN
    RAISE EXCEPTION 'provider_scope_concurrency_authority_roles_missing';
  END IF;
  ALTER FUNCTION reviewrouter_provider_scope_concurrency_snapshot()
    OWNER TO reviewrouter_release_schema_owner;
  ALTER FUNCTION reviewrouter_provider_scope_concurrency_status()
    OWNER TO reviewrouter_release_schema_owner;
  ALTER FUNCTION reviewrouter_provider_scope_concurrency_activate()
    OWNER TO reviewrouter_release_schema_owner;
  ALTER FUNCTION reviewrouter_provider_scope_concurrency_close_for_rollback()
    OWNER TO reviewrouter_release_schema_owner;
  ALTER FUNCTION reviewrouter_provider_scope_concurrency_verify_rollback()
    OWNER TO reviewrouter_release_schema_owner;
  GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_status()
    TO reviewrouter_release_migration;
  GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_activate()
    TO reviewrouter_release_migration;
  GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_close_for_rollback()
    TO reviewrouter_release_migration;
  GRANT EXECUTE ON FUNCTION reviewrouter_provider_scope_concurrency_verify_rollback()
    TO reviewrouter_release_migration;
END
$operator_routine_acl$;
