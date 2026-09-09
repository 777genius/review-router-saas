import { readRenderHistorical96CheckoutInventory } from "./render-historical96-checkout.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
} from "./render-historical89-admission.mjs";
import {
  inspectRenderManagedLedgerRows,
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./render-managed-catalog.mjs";
import {
  assertRenderManagedClosedGate,
  renderManagedRuntimeGateSql,
} from "./render-managed-workflow-cutover.mjs";
import { projectionOf } from "./render-managed-transaction-bodies.mjs";

const limits = Object.freeze({
  bytes: 2_000_000,
  catalogBytes: 8 * 1024 * 1024,
  rows: 20_000,
  queryMs: 5_000,
});
const identitySql = `SELECT jsonb_build_object(
  'databaseName',current_database(),'sessionUser',session_user,'currentRole',current_user,
  'databaseOid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()),
  'readOnly',current_setting('transaction_read_only'),
  'isolation',current_setting('transaction_isolation'),
  'backendPid',pg_backend_pid(),
  'backendStart',(SELECT to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid())
)`;
const clusterSql = `SELECT jsonb_build_object('systemIdentifier',system_identifier::text)
FROM pg_catalog.pg_control_system()`;
// No password columns, backend query text, settings values, or function bodies.
// Definitions/settings required for comparison are hashed by the accepted catalog.
const capabilitiesSql = `SELECT jsonb_build_object(
  'superuser',r.rolsuper,'createRole',r.rolcreaterole,
  'ledgerExists',to_regclass('public._prisma_migrations') IS NOT NULL,
  'ledgerSelect',has_table_privilege(current_user,to_regclass('public._prisma_migrations'),'SELECT'),
  'ledgerInsert',has_table_privilege(current_user,to_regclass('public._prisma_migrations'),'INSERT'),
  'ledgerUpdate',has_table_privilege(current_user,to_regclass('public._prisma_migrations'),'UPDATE'),
  'ledgerDelete',has_table_privilege(current_user,to_regclass('public._prisma_migrations'),'DELETE'),
  'ledgerOwner',(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('public._prisma_migrations')),
  'publicSchemaOwner',(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'),
  'publicSchemaCreate',has_schema_privilege(current_user,to_regnamespace('public'),'CREATE'),
  'namespaceObjectOwner',(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('public."CodexOAuthSecretNamespace"')),
  'schemaOwnerRoleExists',EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reviewrouter_release_schema_owner'),
  'signalBackend',pg_has_role(current_user,'pg_signal_backend','USAGE'),
  'retainedGuardRoutine',to_regprocedure('public.reviewrouter_managed_retained_ledger_guard()') IS NOT NULL,
  'retainedGuardTrigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='reviewrouter_managed_retained_ledger_guard'),
  'signalTargets',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'pid',a.pid,'role',u.rolname,'superuser',u.rolsuper,'backendType',a.backend_type,
    'roleUsage',pg_has_role(current_user,u.oid,'USAGE')) ORDER BY a.pid)
    FROM pg_stat_activity a LEFT JOIN pg_roles u ON u.oid=a.usesysid
    WHERE a.datid=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND a.pid<>pg_backend_pid()),'[]'::jsonb)
) FROM pg_roles r WHERE r.rolname=current_user`;
const projections = {
  capabilities: capabilitiesSql,
  gate: renderManagedRuntimeGateSql,
  ledger: projectionOf(renderManagedLedgerSql),
  catalog: projectionOf(renderManagedCatalogSql),
  memberships: projectionOf(renderManagedMembershipSql),
  defaultAcl: projectionOf(renderHistorical89DefaultAclSql),
  objectAcl: projectionOf(renderHistorical89ObjectAclSql),
};

// MATERIALIZED avoids evaluating a projection twice. The server limits response
// bytes before sending JSON. Work inside aggregates is bounded by statement_timeout,
// not LIMIT 1; row caps additionally reject oversized collected projections.
function bounded(sql, byteLimit) {
  return `WITH capture(value) AS MATERIALIZED (${sql})
SELECT CASE WHEN octet_length(value::text)<=${byteLimit} THEN value ELSE NULL END AS value,
  octet_length(value::text)>${byteLimit} AS exceeded FROM capture LIMIT 2`;
}
const error = (code) => new Error(`historical89_capture:${code}`);
function checkSize(value) {
  if (Array.isArray(value)) {
    if (value.length > limits.rows) throw error("read-cap");
    value.forEach(checkSize);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(checkSize);
  }
}
function validProjection(name, value) {
  if (name === "ledger" || name === "memberships") return Array.isArray(value);
  if (name === "catalog")
    return (
      value?.version === 1 &&
      Array.isArray(value.facts) &&
      value.facts.filter((row) => row.family === "authority").length === 1
    );
  if (name === "defaultAcl" || name === "objectAcl")
    return value?.version === 1 && Array.isArray(value.rows);
  if (name === "gate")
    return ["gateStatus", "authzEpoch", "revision"].every(
      (key) => typeof value?.[key] === "string",
    );
  return (
    ["superuser", "createRole", "signalBackend", "schemaOwnerRoleExists"].every(
      (key) => typeof value?.[key] === "boolean",
    ) && Array.isArray(value?.signalTargets)
  );
}

/**
 * Caller supplies an exclusively leased, IDLE pg client (no existing transaction)
 * and keeps it leased until resolution. query(config) is the only client method used.
 * idleClient is an explicit caller precondition: SQL cannot reliably discover an
 * existing read-only transaction without affecting it. Never pass a pooled query()
 * facade. No connection is opened/closed and no transaction is committed here.
 * Source is an explicit non-secret provenance label plus the caller's checkout SHA;
 * it is recorded, not authenticated. Collection completeness is projection-only.
 * @param {{client: {query: (config: {text: string, query_timeout: number}) => Promise<{rows: Record<string, unknown>[], command?: string}>}, expected: {databaseName: string, databaseOid: string, systemIdentifier: string, sessionUser: string, currentRole: string}, source: {commit: string, label: string}, idleClient: boolean}} input
 */
export async function captureHistorical89Prerequisites({
  client,
  expected,
  source,
  idleClient,
}) {
  const keys = [
    "databaseName",
    "sessionUser",
    "currentRole",
    "databaseOid",
    "systemIdentifier",
  ];
  if (
    !client ||
    typeof client.query !== "function" ||
    idleClient !== true ||
    !expected ||
    keys.some((key) => typeof expected[key] !== "string" || !expected[key]) ||
    !/^[1-9][0-9]*$/u.test(expected.databaseOid) ||
    !/^[1-9][0-9]*$/u.test(expected.systemIdentifier) ||
    !/^[a-f0-9]{40}$/u.test(source?.commit) ||
    typeof source?.label !== "string" ||
    !/^[a-zA-Z0-9._/-]{1,120}$/u.test(source.label)
  )
    throw error("input");
  const result = {
    version: 1,
    source: { commit: source.commit, label: source.label },
    expected: Object.fromEntries(keys.map((key) => [key, expected[key]])),
    limits,
    observations: /** @type {Record<string, any>} */ ({}),
    digests: /** @type {Record<string, string>} */ ({}),
    collection: /** @type {Record<string, string>} */ ({}),
    migrationIdentities:
      /** @type {ReturnType<typeof readHistorical89PendingIdentities> | undefined} */ (
        undefined
      ),
    ledgerObservation:
      /** @type {ReturnType<typeof inspectRenderManagedLedgerRows> | undefined} */ (
        undefined
      ),
    collectionComplete: false,
    unresolvedCapabilities: [
      "independent-admission-review",
      "historical-creators",
      "complete-effective-authority-qualification",
      "durable-external-exclusion",
      "operation-custody-and-recovery",
      "signal-targets-may-change",
    ],
    authorizesProductionMutation: false,
    rollbackConfirmed: false,
  };
  const names = ["identity", "cluster", ...Object.keys(projections)];
  for (const name of names) result.collection[name] = "not-collected";
  let stage = "begin";
  const query = async (text) => {
    try {
      return await client.query({ text, query_timeout: limits.queryMs });
    } catch (cause) {
      // Never propagate pg message/detail/hint/query/cause (even on ROLLBACK).
      throw error(
        cause?.code === "42501"
          ? "permission-denied"
          : cause?.code === "57014"
            ? "query-timeout"
            : "query-failed",
      );
    }
  };
  const read = async (name, sql) => {
    stage = name;
    const byteLimit = name === "catalog" ? limits.catalogBytes : limits.bytes;
    const response = await query(bounded(sql, byteLimit));
    if (response.rows?.length !== 1) throw error("missing-facts");
    const row = response.rows[0];
    if (row.exceeded !== false) throw error("read-cap");
    if (row.value == null) throw error("missing-facts");
    if (Buffer.byteLength(JSON.stringify(row.value)) > byteLimit)
      throw error("read-cap");
    checkSize(row.value);
    return row.value;
  };
  const record = (name, value) => {
    result.digests[name] = renderManagedEvidenceDigest(value);
    result.observations[name] = value;
    result.collection[name] = "collected";
  };
  try {
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    stage = "timeouts";
    await query("SET LOCAL statement_timeout = '4s'");
    await query("SET LOCAL lock_timeout = '1s'");
    await query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
    // Avoid JIT compilation spending the bounded capture budget; rollback restores it.
    await query("SET LOCAL jit = off");
    await query("SET LOCAL search_path = pg_catalog, public");
    const identity = await read("identity", identitySql);
    record("identity", identity);
    if (identity.readOnly !== "on" || identity.isolation !== "repeatable read")
      throw error("transaction-mode");
    if (
      !Number.isSafeInteger(identity.backendPid) ||
      identity.backendPid <= 0 ||
      typeof identity.backendStart !== "string" ||
      !identity.backendStart
    )
      throw error("missing-facts");
    if (keys.slice(0, 4).some((key) => identity[key] !== expected[key]))
      throw error("identity-mismatch");
    const cluster = await read("cluster", clusterSql);
    record("cluster", cluster);
    if (!cluster.systemIdentifier) throw error("missing-facts");
    if (cluster.systemIdentifier !== expected.systemIdentifier)
      throw error("identity-mismatch");
    // Immutable source identities are checked before broad DB projections.
    stage = "source";
    result.migrationIdentities = readHistorical89PendingIdentities();
    const inventory = readRenderHistorical96CheckoutInventory();
    for (const [name, sql] of Object.entries(projections)) {
      const value = await read(name, sql);
      if (!validProjection(name, value)) throw error("missing-facts");
      record(name, value);
      if (name === "capabilities" && !value.schemaOwnerRoleExists)
        result.unresolvedCapabilities.push("schema-owner-role-not-observed");
    }
    stage = "qualification";
    try {
      result.ledgerObservation = inspectRenderManagedLedgerRows(
        inventory,
        result.observations.ledger,
        renderHistorical89AdmissionPhase,
      );
    } catch {
      result.unresolvedCapabilities.push("ledger-history-not-qualified");
    }
    try {
      assertRenderManagedClosedGate(result.observations.gate);
    } catch {
      result.unresolvedCapabilities.push("closed-gate-not-observed");
    }
    const caps = result.observations.capabilities;
    for (const key of [
      "ledgerSelect",
      "ledgerInsert",
      "ledgerUpdate",
      "ledgerDelete",
      "publicSchemaCreate",
    ])
      if (caps[key] !== true)
        result.unresolvedCapabilities.push(`${key}-not-observed`);
    for (const key of [
      "ledgerOwner",
      "publicSchemaOwner",
      "namespaceObjectOwner",
    ])
      if (caps[key] !== expected.currentRole)
        result.unresolvedCapabilities.push(`${key}-not-current-role`);
    if (caps.createRole !== true)
      result.unresolvedCapabilities.push("createrole-not-observed");
    if (caps.superuser !== false)
      result.unresolvedCapabilities.push("non-superuser-not-observed");
    if (
      caps.retainedGuardRoutine !== false ||
      caps.retainedGuardTrigger !== false
    )
      result.unresolvedCapabilities.push("guardless-baseline-not-observed");
    if (
      !Array.isArray(caps.signalTargets) ||
      caps.signalTargets.some(
        (target) =>
          target.superuser !== false ||
          (target.roleUsage !== true && caps.signalBackend !== true),
      )
    )
      result.unresolvedCapabilities.push(
        "existing-guard-signal-rights-unresolved",
      );
  } catch (caught) {
    const reason =
      caught instanceof Error &&
      /^historical89_capture:[a-z-]+$/u.test(caught.message)
        ? caught.message.slice("historical89_capture:".length)
        : "collection-failed";
    result.collection[stage] = reason;
    result.unresolvedCapabilities.push(`${stage}:${reason}`);
  } finally {
    try {
      const response = await query("ROLLBACK");
      result.rollbackConfirmed = response.command === "ROLLBACK";
    } catch {
      /* The caller must discard a client whose cleanup is unconfirmed. */
    }
    if (!result.rollbackConfirmed)
      result.unresolvedCapabilities.push("rollback-unconfirmed-discard-client");
  }
  result.collectionComplete =
    names.every((name) => result.collection[name] === "collected") &&
    result.rollbackConfirmed;
  return result;
}
