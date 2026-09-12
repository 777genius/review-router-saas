import { renderManagedEvidenceDigest } from "./render-schema-handoff-policy.mjs";
import { renderManagedOperationCustodyContract } from "./render-managed-operation-custody.mjs";

// ---------------------------------------------------------------------------
// The irreversible boundary that must exist BEFORE any DDL runs.
// ---------------------------------------------------------------------------
//
// The published 000089 body already refuses to run while any nonsuperuser
// backend other than its own exists, and while any nonsuperuser login role that
// can write the two migrated tables still holds CONNECT. Because PUBLIC holds
// CONNECT on a PostgreSQL database by default, EVERY login role holds it until
// it is explicitly withdrawn: stopping services is not sufficient and this
// module does not pretend otherwise.
//
// So the boundary here is exactly: capture the original CONNECT ACL including
// grantors, withdraw admission narrowly, drain the remaining sessions, prove
// quiescence, and restore the captured ACL afterwards. Nothing here mutates
// application schema, and nothing here is authorization.
//
// Privileged concurrent mutation is handled honestly rather than claimed away:
// a superuser backend cannot be excluded by withdrawing CONNECT, so the guard
// DETECTS one and fails closed. A superuser that connects after the check is
// outside any guarantee a nonsuperuser owner can make, and that limit is stated
// in the returned record instead of being hidden by a check that cannot hold.

const fail = (reason) => {
  throw new Error(`render_historical89_boundary_rejected:${reason}`);
};
const digest = (value) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const roleName = (value) =>
  typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/u.test(value);
const instant = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};
const shapeOf = (keys) => [...keys].sort().join();
const keysOf = (value) =>
  value &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype
    ? Object.keys(value).sort().join()
    : null;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const quoted = (value) => `"${String(value).replaceAll('"', '""')}"`;

const coordinator = renderManagedOperationCustodyContract.coordinatorRole;
const custodyReader = renderManagedOperationCustodyContract.readerRole;

// The only principals allowed to hold CONNECT while the boundary is closed.
// The coordinator is the database owner and performs the operation; the custody
// reader can execute exactly one read routine and owns nothing.
export const renderHistorical89AdmittedRoles = Object.freeze([
  coordinator,
  custodyReader,
]);

// ---------------------------------------------------------------------------
// Original CONNECT ACL
// ---------------------------------------------------------------------------

/** Complete database-level ACL with grantors, plus live backend facts. */
export const renderHistorical89ConnectAclSql = `SET search_path = pg_catalog, public;
SELECT jsonb_build_object(
  'version',1,
  'database',current_database(),
  'allowConnections',d.datallowconn,
  'connectionLimit',d.datconnlimit,
  'owner',owner.rolname,
  'raw',CASE WHEN d.datacl IS NULL THEN NULL ELSE d.datacl::text END,
  -- EFFECTIVE entries. A database whose datacl is still NULL carries
  -- PostgreSQL's built-in default, in which PUBLIC holds CONNECT; reading only
  -- the raw column would report "no grants" for exactly the state that admits
  -- every login role. The raw column is kept beside it so the null-versus-
  -- explicit distinction stays visible.
  'entries',(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,
      'granteeOid',a.grantee::text,
      'grantor',grantor.rolname,'grantorOid',a.grantor::text,
      'privilege',a.privilege_type,'grantable',a.is_grantable
    ) ORDER BY a.privilege_type COLLATE "C",a.grantee,a.grantor),'[]'::jsonb)
    FROM pg_catalog.aclexplode(
      COALESCE(d.datacl,pg_catalog.acldefault('d'::"char",d.datdba))) a
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee
    LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=a.grantor),
  'connectCapableRoles',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'role',r.rolname,'canLogin',r.rolcanlogin,'superuser',r.rolsuper,
      'writesMigratedTables',
        pg_catalog.has_any_column_privilege(r.oid,'public."WorkflowProvisioning"','INSERT,UPDATE')
        OR pg_catalog.has_table_privilege(r.oid,'public."WorkflowProvisioning"','DELETE,TRUNCATE')
        OR pg_catalog.has_any_column_privilege(r.oid,'public."RepositoryConnection"','INSERT,UPDATE')
        OR pg_catalog.has_table_privilege(r.oid,'public."RepositoryConnection"','DELETE,TRUNCATE')
    ) ORDER BY r.rolname COLLATE "C")
    FROM pg_catalog.pg_roles r
    WHERE r.rolcanlogin AND NOT r.rolsuper
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')),'[]'::jsonb),
  'backends',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'role',r.rolname,'superuser',r.rolsuper,'backendType',COALESCE(a.backend_type,'client backend')
    ) ORDER BY r.rolname COLLATE "C",a.pid)
    FROM pg_catalog.pg_stat_activity a
    JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
    WHERE a.datname=current_database() AND a.pid<>pg_catalog.pg_backend_pid()
      AND (a.backend_type IS NULL OR a.backend_type = 'client backend')),'[]'::jsonb)
)
FROM pg_catalog.pg_database d
LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
WHERE d.datname=current_database();`;

const aclEntryShape = shapeOf([
  "grantee",
  "granteeOid",
  "grantor",
  "grantorOid",
  "privilege",
  "grantable",
]);
const observationShape = shapeOf([
  "version",
  "database",
  "allowConnections",
  "connectionLimit",
  "owner",
  "raw",
  "entries",
  "connectCapableRoles",
  "backends",
]);

/**
 * Validate an observed database ACL and split it into the CONNECT grants this
 * boundary must withdraw and the ones it must keep.
 *
 * A grant this coordinator cannot revoke - one whose grantor is a role it
 * cannot act as - is a hard rejection, not something to work around: silently
 * leaving such a grant in place would leave admission open while reporting it
 * closed.
 */
export function assertHistorical89OriginalConnectAcl(observation) {
  if (keysOf(observation) !== observationShape) fail("connect_acl_shape");
  if (
    observation.version !== 1 ||
    typeof observation.database !== "string" ||
    !observation.database ||
    observation.allowConnections !== true ||
    !Number.isSafeInteger(observation.connectionLimit) ||
    !roleName(observation.owner) ||
    observation.owner !== coordinator
  )
    fail("connect_acl_database");
  if (
    observation.raw !== null &&
    (typeof observation.raw !== "string" || !observation.raw)
  )
    fail("connect_acl_raw");
  if (!Array.isArray(observation.entries) || observation.entries.length === 0)
    fail("connect_acl_entries");
  const seen = new Set();
  for (const entry of observation.entries) {
    if (
      keysOf(entry) !== aclEntryShape ||
      typeof entry.grantee !== "string" ||
      !entry.grantee ||
      (entry.grantee !== "PUBLIC" && !roleName(entry.grantee)) ||
      !roleName(entry.grantor) ||
      typeof entry.privilege !== "string" ||
      !/^[A-Z]+$/u.test(entry.privilege) ||
      typeof entry.grantable !== "boolean" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(String(entry.granteeOid)) ||
      !/^[1-9][0-9]*$/u.test(String(entry.grantorOid))
    )
      fail("connect_acl_entry");
    const key = `${entry.grantee} ${entry.grantor} ${entry.privilege}`;
    if (seen.has(key)) fail("connect_acl_duplicate");
    seen.add(key);
  }
  const connect = observation.entries.filter(
    (entry) => entry.privilege === "CONNECT",
  );
  const withdraw = connect.filter(
    (entry) => !renderHistorical89AdmittedRoles.includes(entry.grantee),
  );
  for (const entry of withdraw)
    if (entry.grantor !== coordinator) fail("connect_grantor_unavailable");
  if (!Array.isArray(observation.connectCapableRoles))
    fail("connect_capable_roles");
  return Object.freeze({
    digest: renderManagedEvidenceDigest(observation),
    // A database ACL that is still the built-in NULL default is materialized to
    // its explicit equivalent by the first REVOKE and cannot be set back to
    // NULL. The effective privileges after restore are identical, and the
    // restore check compares those effective entries rather than the raw text.
    materializesDefaultAcl: observation.raw === null,
    entries: Object.freeze(
      observation.entries.map((entry) => Object.freeze(entry)),
    ),
    withdraw: Object.freeze(withdraw.map((entry) => Object.freeze(entry))),
    retain: Object.freeze(
      connect
        .filter((entry) =>
          renderHistorical89AdmittedRoles.includes(entry.grantee),
        )
        .map((entry) => Object.freeze(entry)),
    ),
  });
}

const grantTarget = (grantee) =>
  grantee === "PUBLIC" ? "PUBLIC" : quoted(grantee);

function projection(sql) {
  const index = sql.indexOf("SELECT ");
  if (index < 0) fail("projection_source");
  return sql.slice(index).replace(/;\s*$/u, "");
}

const connectAclProjection = projection(renderHistorical89ConnectAclSql);

// GRANT/REVOKE can rebuild datacl with the same grants in a different array
// order or jsonb key order. Compare the CONNECT/CREATE/TEMPORARY set, not the
// raw jsonb bytes, so restriction/restore fail only on a real baseline change.
function distinctCanonicalEntries(observedEntries) {
  const sorted = (expr) =>
    `(SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'privilege' COLLATE "C", elem->>'granteeOid', elem->>'grantorOid'), '[]'::jsonb) FROM jsonb_array_elements(${expr}) AS elem)`;
  return `${sorted(`(${connectAclProjection})->'entries'`)}
     IS DISTINCT FROM ${sorted(`${literal(JSON.stringify(observedEntries))}::jsonb`)}`;
}

/**
 * Terminate every remaining nonsuperuser backend on this database.
 *
 * `pg_terminate_backend` itself requires the caller to hold the privileges of
 * the target backend's role, or of `pg_signal_backend`, or be a superuser -
 * the same `has_privs_of_role` test PostgreSQL runs internally, restated here
 * with `pg_has_role(..., 'USAGE')`. Checking it against every candidate BEFORE
 * calling `pg_terminate_backend` on any of them turns a mid-drain permission
 * error - which would leave some backends already terminated and others not -
 * into a single clear precondition failure with nothing yet touched.
 */
export const renderHistorical89SessionDrainSql = `DO $drain$
DECLARE remaining integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity a
    JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
    WHERE a.datname=pg_catalog.current_database()
      AND a.pid<>pg_catalog.pg_backend_pid() AND NOT r.rolsuper
      AND NOT pg_catalog.pg_has_role(current_user, r.oid, 'USAGE')
      AND NOT pg_catalog.pg_has_role(current_user, 'pg_signal_backend', 'USAGE')
  ) THEN
    RAISE EXCEPTION 'historical89_terminate_privilege_missing';
  END IF;
  PERFORM pg_catalog.pg_terminate_backend(a.pid)
  FROM pg_catalog.pg_stat_activity a
  JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
  WHERE a.datname=pg_catalog.current_database()
    AND a.pid<>pg_catalog.pg_backend_pid() AND NOT r.rolsuper;
  FOR i IN 1..150 LOOP
    -- pg_stat_activity is cached for the lifetime of a transaction; without
    -- clearing that snapshot this loop would keep re-reading the state from
    -- before PERFORM above ran and never observe a terminated backend leave.
    PERFORM pg_catalog.pg_stat_clear_snapshot();
    SELECT count(*) INTO remaining FROM pg_catalog.pg_stat_activity a
    JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
    WHERE a.datname=pg_catalog.current_database()
      AND a.pid<>pg_catalog.pg_backend_pid() AND NOT r.rolsuper;
    EXIT WHEN remaining=0;
    PERFORM pg_catalog.pg_sleep(0.2);
  END LOOP;
  IF remaining<>0 THEN
    RAISE EXCEPTION 'historical89_session_drain_incomplete';
  END IF;
END $drain$;`;

/**
 * Withdraw admission narrowly and drain the remaining sessions.
 *
 * Only CONNECT is touched; TEMPORARY and CREATE entries are left exactly as
 * observed. Each withdrawal names the original grantor, so a grant made by a
 * different role can never be silently replaced by one made by this operation.
 */
export function renderHistorical89AdmissionRestrictionSql(observation) {
  const acl = assertHistorical89OriginalConnectAcl(observation);
  const database = quoted(observation.database);
  const revokes = acl.withdraw
    .map(
      (entry) =>
        `REVOKE CONNECT ON DATABASE ${database} FROM ${grantTarget(entry.grantee)} GRANTED BY ${quoted(entry.grantor)};`,
    )
    .join("\n");
  return `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5000ms';
DO $admission_identity$ BEGIN
  IF session_user <> ${literal(coordinator)} OR current_user <> ${literal(coordinator)}
     OR current_database() <> ${literal(observation.database)}
     OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'historical89_admission_identity';
  END IF;
  IF ${distinctCanonicalEntries(observation.entries)} THEN
    RAISE EXCEPTION 'historical89_admission_baseline_changed';
  END IF;
END $admission_identity$;
${revokes}
-- The custody reader owns nothing and can execute exactly one read routine. It
-- is admitted explicitly so post-commit reconciliation reads the
-- operation-bound receipt through a restricted connection under this fence.
GRANT CONNECT ON DATABASE ${database} TO ${quoted(custodyReader)};
COMMIT;
${renderHistorical89SessionDrainSql}`;
}

/**
 * Restore exactly the observed CONNECT grants, each with its original grantor,
 * and remove the temporary custody-reader admission.
 */
export function renderHistorical89AdmissionRestoreSql(observation) {
  const acl = assertHistorical89OriginalConnectAcl(observation);
  const database = quoted(observation.database);
  const grants = acl.withdraw
    .map(
      (entry) =>
        `GRANT CONNECT ON DATABASE ${database} TO ${grantTarget(entry.grantee)}${
          entry.grantable ? " WITH GRANT OPTION" : ""
        } GRANTED BY ${quoted(entry.grantor)};`,
    )
    .join("\n");
  return `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
DO $restore_identity$ BEGIN
  IF session_user <> ${literal(coordinator)} OR current_user <> ${literal(coordinator)}
     OR current_database() <> ${literal(observation.database)} THEN
    RAISE EXCEPTION 'historical89_restore_identity';
  END IF;
END $restore_identity$;
${grants}
REVOKE CONNECT ON DATABASE ${database} FROM ${quoted(custodyReader)};
DO $restore_exactness$ BEGIN
  IF ${distinctCanonicalEntries(observation.entries)} THEN
    RAISE EXCEPTION 'historical89_restore_not_exact';
  END IF;
END $restore_exactness$;
COMMIT;`;
}

/**
 * In-transaction guard. It repeats the fleet requirement rather than trusting
 * the earlier drain: a reconnect between the drain and the transaction must
 * abort the operation, not be discovered afterwards.
 */
export const renderHistorical89FleetQuiescenceGuardSql = `DO $fleet$ BEGIN
  -- Every other nonsuperuser backend, not only writers: an observer holding an
  -- open snapshot is enough to make this operation unsafe.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a
             JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
             WHERE a.datname=pg_catalog.current_database()
               AND a.pid<>pg_catalog.pg_backend_pid() AND NOT r.rolsuper) THEN
    RAISE EXCEPTION 'historical89_fleet_not_quiesced';
  END IF;
  -- Admission must still be withdrawn at execution time.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
             WHERE r.rolcanlogin AND NOT r.rolsuper
               AND r.rolname NOT IN (${renderHistorical89AdmittedRoles.map((role) => literal(role)).join(",")})
               AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT')) THEN
    RAISE EXCEPTION 'historical89_admission_open';
  END IF;
  -- Withdrawing CONNECT cannot exclude a superuser. Detect and refuse instead
  -- of claiming an exclusion a nonsuperuser owner cannot enforce.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a
             JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
             WHERE a.datname=pg_catalog.current_database()
               AND a.pid<>pg_catalog.pg_backend_pid() AND r.rolsuper
               AND a.backend_type='client backend') THEN
    RAISE EXCEPTION 'historical89_privileged_backend_present';
  END IF;
  -- No other backend, privileged or not, may hold a lock on the ledger.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
             WHERE l.relation='public._prisma_migrations'::regclass
               AND l.pid<>pg_catalog.pg_backend_pid() AND l.granted) THEN
    RAISE EXCEPTION 'historical89_ledger_locked_elsewhere';
  END IF;
END $fleet$;`;

// ---------------------------------------------------------------------------
// Pre-DDL evidence
// ---------------------------------------------------------------------------

const recoveryShape = shapeOf([
  "recoveryIdentitySha256",
  "artifactDigest",
  "capturedAt",
  "dumpReadable",
  "retained",
]);
const admissionShape = shapeOf(["status", "connectAclDigest", "restrictedAt"]);
const automationShape = shapeOf([
  "automaticMigrationsDisabled",
  "declaredServices",
]);
const serviceShape = shapeOf(["serviceId", "autoDeploy", "suspended"]);
const fenceShape = shapeOf([
  "externalFenceSha256",
  "holder",
  "scope",
  "durable",
  "survivesCoordinatorDeath",
  "establishedAt",
]);
const preconditionShape = shapeOf([
  "recovery",
  "admission",
  "automation",
  "fence",
]);

/**
 * The four facts that must hold before any DDL runs, as evidence rather than as
 * a claim. Every one of them fails closed: missing, false or malformed evidence
 * rejects. None of them is produced here - this validates what an operator or
 * adapter observed, and returns a digest of exactly that.
 */
export function assertHistorical89ExecutionPreconditions(input) {
  if (keysOf(input) !== preconditionShape) fail("preconditions_shape");
  const { recovery, admission, automation, fence } = input;
  if (keysOf(recovery) !== recoveryShape) fail("recovery_shape");
  if (
    !digest(recovery.recoveryIdentitySha256) ||
    !digest(recovery.artifactDigest) ||
    !instant(recovery.capturedAt) ||
    recovery.dumpReadable !== true ||
    recovery.retained !== true
  )
    fail("recovery_unqualified");
  if (keysOf(admission) !== admissionShape) fail("admission_shape");
  if (
    admission.status !== "closed" ||
    !digest(admission.connectAclDigest) ||
    !instant(admission.restrictedAt)
  )
    fail("admission_open");
  if (keysOf(automation) !== automationShape) fail("automation_shape");
  if (
    automation.automaticMigrationsDisabled !== true ||
    !Array.isArray(automation.declaredServices) ||
    automation.declaredServices.length === 0
  )
    fail("automation_enabled");
  const serviceIds = new Set();
  for (const service of automation.declaredServices) {
    if (
      keysOf(service) !== serviceShape ||
      typeof service.serviceId !== "string" ||
      !/^srv-[a-z0-9]+$/u.test(service.serviceId) ||
      service.autoDeploy !== "no" ||
      service.suspended !== "suspended" ||
      serviceIds.has(service.serviceId)
    )
      fail("automation_service");
    serviceIds.add(service.serviceId);
  }
  if (keysOf(fence) !== fenceShape) fail("fence_shape");
  if (
    !digest(fence.externalFenceSha256) ||
    typeof fence.holder !== "string" ||
    !fence.holder ||
    !Array.isArray(fence.scope) ||
    fence.scope.length === 0 ||
    Array.from(fence.scope).some(
      (entry) => typeof entry !== "string" || !entry,
    ) ||
    Object.keys(fence.scope).some((key, index) => key !== String(index)) ||
    fence.durable !== true ||
    // A transaction lock disappears with its backend. This operation needs an
    // exclusion that outlives coordinator death, so a fence that does not claim
    // that property is rejected rather than downgraded.
    fence.survivesCoordinatorDeath !== true ||
    !instant(fence.establishedAt)
  )
    fail("fence_not_durable");
  if (
    fence.scope.length !== serviceIds.size ||
    new Set(fence.scope).size !== serviceIds.size ||
    fence.scope.some((serviceId) => !serviceIds.has(serviceId))
  )
    fail("fence_scope_mismatch");
  return Object.freeze({
    digest: renderManagedEvidenceDigest(input),
    externalFenceSha256: fence.externalFenceSha256,
    connectAclDigest: admission.connectAclDigest,
    recoveryIdentitySha256: recovery.recoveryIdentitySha256,
    // Stated, not hidden: a superuser is outside what a nonsuperuser owner can
    // exclude. The guard detects a privileged backend and fails closed; it
    // cannot prevent one that connects afterwards.
    privilegedConcurrentMutation: "detected-and-refused",
  });
}
