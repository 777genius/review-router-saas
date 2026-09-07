import { activationMigrationExclusionSql } from "../run-codex-rotating-release-migration.mjs";
import { readRenderSchemaHandoffCatalog } from "./render-schema-handoff-policy.mjs";

// The coordinator must never block on Prisma's lock while holding the canonical
// lock: Prisma takes its lock first. A failed try makes the coordinator roll back.
// These statements belong inside the caller's explicit transaction.
export const renderManagedCoordinatorExclusionSql = `${activationMigrationExclusionSql}
DO $engine$ BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(72707369::bigint) THEN
    RAISE EXCEPTION 'render_managed_prisma_engine_active';
  END IF;
END $engine$;`;

const guardName = "reviewrouter_managed_retained_ledger_guard";
const canonicalLock = `locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
  AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
  AND classid=1381126735 AND objid=1129271120 AND objsubid=2
  AND mode='ExclusiveLock' AND granted`;
const prismaLock = `locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
  AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
  AND classid=0 AND objid=72707369 AND objsubid=1 AND mode='ExclusiveLock' AND granted`;
const coordinatorGuard = `DO $coordinator$ BEGIN
  IF session_user <> 'reviewrouter' OR current_user <> 'reviewrouter'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE ${canonicalLock})
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE ${prismaLock}) THEN
    RAISE EXCEPTION 'render_managed_coordinator_exclusion_missing';
  END IF;
END $coordinator$;`;

// SQL construction is not authorization. The adapter must authenticate the
// original start custody, fixed review contracts and durable external fence
// before installing this guard. No connection or CLI is exposed here.
export function renderRetainedLedgerGuard(binding) {
  const keys = ["operationId", "implementationSha", "custodyDigest"];
  const patterns = [
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
    /^[a-f0-9]{40}$/u,
    /^sha256:[a-f0-9]{64}$/u,
  ];
  if (
    !binding ||
    Object.keys(binding).sort().join() !== [...keys].sort().join() ||
    keys.some(
      (key, i) =>
        typeof binding[key] !== "string" || !patterns[i].test(binding[key]),
    )
  )
    throw new Error("render_retained_guard_binding_invalid");
  const applicationName = `rr-retained-${binding.operationId}`;
  const catalog = readRenderSchemaHandoffCatalog().slice(0, 89);
  const values = catalog
    .map((r, i) => `(${i},'${r.migrationName}','${r.checksum}')`)
    .join(",\n");
  const body = `
DECLARE expected_index integer; expected_checksum text; prefix_count integer; excluded_id text;
BEGIN
  IF session_user <> 'reviewrouter' OR current_user <> 'reviewrouter'
     OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> '_prisma_migrations'
     OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_NARGS <> 3
     OR TG_ARGV[0] <> '${binding.operationId}'
     OR TG_ARGV[1] <> '${binding.implementationSha}'
     OR TG_ARGV[2] <> '${binding.custodyDigest}'
     OR pg_catalog.current_setting('application_name') <> '${applicationName}'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE ${prismaLock}) THEN
    RAISE EXCEPTION 'render_retained_writer_identity';
  END IF;
  -- This is acquired by the writer backend itself, before Prisma commits its
  -- start row. It survives every migration/ledger commit and coordinator death.
  -- Backend termination releases it only after that backend stops executing SQL.
  PERFORM pg_catalog.set_config('lock_timeout','5000ms',true);
  PERFORM pg_catalog.pg_advisory_lock(1381126735,1129271120);
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'render_retained_ledger_delete_forbidden';
  END IF;
  WITH expected(index,name,checksum) AS (VALUES ${values})
  SELECT index,checksum INTO expected_index,expected_checksum FROM expected
    WHERE name=NEW.migration_name AND index BETWEEN 76 AND 88;
  IF expected_index IS NULL OR NEW.checksum IS DISTINCT FROM expected_checksum
     OR NEW.started_at IS NULL OR NEW.rolled_back_at IS NOT NULL
     OR NEW.id IS NULL OR NEW.id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'render_retained_ledger_identity';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.finished_at IS NOT NULL OR NEW.applied_steps_count IS DISTINCT FROM 0 OR COALESCE(NEW.logs,'') <> '' THEN
      RAISE EXCEPTION 'render_retained_start_row';
    END IF;
  ELSE
    excluded_id := OLD.id;
    -- Prisma records a successful step and finished_at in separate statements.
    -- The intermediate row stays unfinished evidence until the second commits.
    IF ROW(NEW.id,NEW.checksum,NEW.migration_name,NEW.started_at)
         IS DISTINCT FROM ROW(OLD.id,OLD.checksum,OLD.migration_name,OLD.started_at)
       OR OLD.finished_at IS NOT NULL OR OLD.rolled_back_at IS NOT NULL
       OR OLD.applied_steps_count NOT IN (0,1) OR COALESCE(OLD.logs,'') <> ''
       OR ((NEW.finished_at >= NEW.started_at AND NEW.applied_steps_count=1 AND COALESCE(NEW.logs,'')='')
         OR (OLD.applied_steps_count=0 AND NEW.finished_at IS NULL AND NEW.applied_steps_count=1 AND COALESCE(NEW.logs,'')='')
         OR (OLD.applied_steps_count=0 AND NEW.finished_at IS NULL AND NEW.applied_steps_count=0 AND COALESCE(NEW.logs,'')<>'')) IS NOT TRUE THEN
      RAISE EXCEPTION 'render_retained_result_row';
    END IF;
  END IF;
  SELECT count(*) INTO prefix_count FROM public._prisma_migrations
    WHERE excluded_id IS NULL OR id<>excluded_id;
  IF prefix_count <> expected_index OR EXISTS (
    WITH expected(index,name,checksum) AS (VALUES ${values})
    SELECT 1 FROM public._prisma_migrations m
    LEFT JOIN expected e ON e.name=m.migration_name AND e.checksum=m.checksum AND e.index<expected_index
    WHERE (excluded_id IS NULL OR m.id<>excluded_id) AND (e.index IS NULL OR m.finished_at IS NULL
      OR m.started_at IS NULL OR m.finished_at<m.started_at OR m.rolled_back_at IS NOT NULL
      OR m.applied_steps_count<>1 OR COALESCE(m.logs,'')<>''))
    OR EXISTS (SELECT 1 FROM public._prisma_migrations
      WHERE excluded_id IS NULL OR id<>excluded_id GROUP BY migration_name HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'render_retained_ledger_prefix';
  END IF;
  RETURN NEW;
END
`;
  const argumentsHex = Buffer.from(
    keys.map((k) => binding[k]).join("\0") + "\0",
  ).toString("hex");
  const verifySql = `${coordinatorGuard}
DO $identity$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='${guardName}') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid=p.prolang
       WHERE n.nspname='public' AND p.proname='${guardName}' AND p.pronargs=0 AND l.lanname='plpgsql'
         AND p.proowner='reviewrouter'::regrole AND NOT p.prosecdef AND p.prokind='f'
         AND p.prorettype='pg_catalog.trigger'::regtype AND p.provolatile='v' AND NOT p.proleakproof
         AND NOT p.proisstrict AND p.proparallel='u' AND p.provariadic=0 AND p.prosupport=0
         AND p.pronargdefaults=0 AND p.proargnames IS NULL AND p.proallargtypes IS NULL
         AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
         AND p.prosrc=$body$${body}$body$
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
           WHERE a.grantee<>p.proowner OR a.grantor<>p.proowner OR a.is_grantable))
     OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname='${guardName}') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname='${guardName}'
       AND tgrelid='public._prisma_migrations'::regclass AND tgfoid='public.${guardName}()'::regprocedure
       AND tgtype=31 AND tgenabled='A' AND NOT tgisinternal AND tgconstraint=0
       AND NOT tgdeferrable AND NOT tginitdeferred AND tgqual IS NULL AND tgattr=''::int2vector
       AND tgnargs=3 AND tgargs=pg_catalog.decode('${argumentsHex}','hex')) THEN
    RAISE EXCEPTION 'render_retained_guard_drift';
  END IF;
END $identity$;`;
  const installSql = `${coordinatorGuard}
CREATE FUNCTION public.${guardName}() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $body$${body}$body$;
REVOKE ALL ON FUNCTION public.${guardName}() FROM PUBLIC;
CREATE TRIGGER ${guardName} BEFORE INSERT OR UPDATE OR DELETE ON public._prisma_migrations
FOR EACH ROW EXECUTE FUNCTION public.${guardName}('${binding.operationId}','${binding.implementationSha}','${binding.custodyDigest}');
ALTER TABLE public._prisma_migrations ENABLE ALWAYS TRIGGER ${guardName};
${verifySql}`;
  // Keep the guard at 89. It rejects stale engines after cleanup and cannot be
  // removed/adopted by phase B outside that phase's authenticated atomic boundary.
  return Object.freeze({ applicationName, installSql, verifySql });
}
