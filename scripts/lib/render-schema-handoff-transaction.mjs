import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripAtomicMigrationEnvelope } from "../run-codex-rotating-release-migration.mjs";
import {
  classifyRenderManagedMembership,
  inspectRenderManagedLedger,
  readRenderSchemaHandoffCatalog,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
  renderManagedMembershipCleanupSql,
  renderManagedTemporaryMembershipSql,
} from "./render-schema-handoff-policy.mjs";
import {
  renderManagedCoordinatorExclusionSql,
  renderRetainedLedgerGuard,
} from "./render-retained-exclusion.mjs";

// Candidate dependency closure derived from the exact87/88/89 routine bodies.
// These columns support their reads, row locks and transaction-local receipt.
// This declaration is NOT an approved managed baseline. Fixed independent
// catalog review, original custody, phase-A receipt and an external fence must
// precede execution. No CLI, database connection or approval override exists.
const reads = {
  CodexOAuthProviderInstance: [
    "id",
    "repositoryId",
    "mutationOwner",
    "mutationOwnerId",
    "mutationEpoch",
    "activeLeaseId",
    "activeSecretNamespaceId",
    "activeSecretNamespaceEpoch",
    "activeSecretNamespaceName",
    "latestGenerationHash",
    "state",
  ],
  RepositoryConnection: ["id", "githubRepositoryId"],
  CodexOAuthSetupDispatchAttempt: ["id", "namespaceId", "status", "claimId"],
  CodexOAuthSetupPayloadClaim: [
    "id",
    "providerInstanceRowId",
    "status",
    "databaseRecoveryWitness",
    "confirmedAttemptId",
    "manifestId",
    "githubRepositoryId",
    "generationHash",
  ],
  CodexOAuthWritebackIntent: [
    "secretNamespaceId",
    "status",
    "providerResponseCode",
    "providerConfirmedAt",
    "databaseRecoveryWitness",
    "providerInstanceRowId",
    "leaseId",
    "mutationEpoch",
  ],
  CodexOAuthDatabaseAuthorityReceipt: [
    "databaseRole",
    "backendPid",
    "transactionId",
    "effect",
    "ownerId",
    "effectCode",
    "consumedAt",
  ],
};
const schemaOwner = "reviewrouter_release_schema_owner";
const quote = (name) => `"${name}"`;
const grant = (privilege, table, columns) =>
  `GRANT ${privilege} (${columns.map(quote).join(",")}) ON TABLE public.${quote(table)} TO ${schemaOwner} GRANTED BY reviewrouter;`;
export const renderSchemaHandoffDependencySql = [
  ...Object.entries(reads).map(([table, columns]) =>
    grant("SELECT", table, columns),
  ),
  // PostgreSQL FOR UPDATE needs UPDATE on at least one column; immutable ids
  // provide that privilege without granting changes to mutable authority data.
  ...[
    "CodexOAuthProviderInstance",
    "CodexOAuthSetupDispatchAttempt",
    "CodexOAuthSetupPayloadClaim",
  ].map((table) => grant("UPDATE", table, ["id"])),
  grant(
    "INSERT",
    "CodexOAuthDatabaseAuthorityReceipt",
    reads.CodexOAuthDatabaseAuthorityReceipt.slice(0, -1),
  ),
  `GRANT EXECUTE ON FUNCTION public.codex_oauth_consume_database_authority(text,text,integer) TO ${schemaOwner} GRANTED BY reviewrouter;`,
].join("\n");

function projection(sql) {
  const prefix = "SET search_path = pg_catalog, public;\n";
  if (!sql.startsWith(prefix + "SELECT ") || !sql.endsWith(";"))
    throw new Error("render_handoff_projection_contract");
  return sql.slice(prefix.length, -1);
}
const ledgerQuery = projection(renderManagedLedgerSql);
const membershipQuery = projection(renderManagedMembershipSql);

// Returns an explicit transaction WITHOUT COMMIT. The production coordinator
// must compare the final catalog to its fixed approved contract in this same
// transaction, then commit and verify again on fresh restricted connections.
// The builder does not authenticate observations or confer mutation authority.
export function renderSchemaHandoffTransaction({
  ledger,
  retainedBinding,
  originalMembership,
}) {
  const catalog = readRenderSchemaHandoffCatalog();
  if (
    inspectRenderManagedLedger(catalog, ledger, "managed-schema-handoff")
      .count !== 89
  )
    throw new Error("render_handoff_committed_requires_reconciliation");
  classifyRenderManagedMembership([originalMembership], originalMembership);
  const original = JSON.stringify([originalMembership]);
  const expectedLedger = JSON.stringify(
    [...ledger].sort((a, b) => (a.migrationName < b.migrationName ? -1 : 1)),
  );
  const guard = renderRetainedLedgerGuard(retainedBinding);
  const statements = catalog.slice(89).map((row) => {
    const source = readFileSync(
      new URL(
        `../../packages/platform/db/prisma/migrations/${row.migrationName}/migration.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    if (createHash("sha256").update(source).digest("hex") !== row.checksum)
      throw new Error("render_handoff_source_changed");
    return `INSERT INTO public._prisma_migrations(id,checksum,migration_name,started_at,applied_steps_count)
VALUES (pg_catalog.gen_random_uuid()::text,'${row.checksum}','${row.migrationName}',pg_catalog.clock_timestamp(),0);
-- Unqualified CREATE in the immutable87/88 bodies must target public. With
-- pg_catalog omitted it is still searched implicitly FIRST for builtins;
-- pg_temp is explicit and last. Restore the observation path after each body.
SET LOCAL search_path = public, pg_temp;
${stripAtomicMigrationEnvelope(source, row.migrationName)}
SET LOCAL search_path = pg_catalog, public;
UPDATE public._prisma_migrations SET finished_at=pg_catalog.clock_timestamp(),applied_steps_count=1
WHERE migration_name='${row.migrationName}' AND checksum='${row.checksum}' AND finished_at IS NULL;`;
  });
  const identities = catalog
    .map((row) => `('${row.migrationName}','${row.checksum}')`)
    .join(",\n");
  return `BEGIN;
${renderManagedCoordinatorExclusionSql}
SET LOCAL search_path = pg_catalog, public;
${guard.verifySql}
DO $baseline$ BEGIN
  IF (${ledgerQuery}) IS DISTINCT FROM $ledger$${expectedLedger}$ledger$::jsonb
     OR (${membershipQuery}) IS DISTINCT FROM $membership$${original}$membership$::jsonb THEN
    RAISE EXCEPTION 'render_handoff_baseline_changed';
  END IF;
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') <> 'reviewrouter'
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) <> 'reviewrouter'
     OR EXISTS (SELECT 1 FROM (VALUES ('${schemaOwner}',false),('reviewrouter_release_migration',true)) expected(name,login)
       LEFT JOIN pg_roles r ON r.rolname=expected.name WHERE r.oid IS NULL OR r.rolcanlogin<>expected.login
       OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
     OR has_database_privilege('${schemaOwner}',current_database(),'CREATE')
     OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN (
       'public."CodexOAuthSecretNamespace"'::regclass,${Object.keys(reads)
         .map((name) => `'public.${quote(name)}'::regclass`)
         .join(",")}) AND c.relowner<>'reviewrouter'::regrole)
     OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public."ReviewProviderScopeConcurrencyControl"'::regclass,
       'public."ReviewInvocationLeaseV2"'::regclass) AND c.relowner<>'${schemaOwner}'::regrole) THEN
    RAISE EXCEPTION 'render_handoff_owner_precondition';
  END IF;
END $baseline$;
${renderManagedTemporaryMembershipSql}
${renderSchemaHandoffDependencySql}
DO $schema$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO ${schemaOwner} GRANTED BY reviewrouter',current_database());
END $schema$;
ALTER SCHEMA public OWNER TO ${schemaOwner};
ALTER TABLE public."CodexOAuthSecretNamespace" OWNER TO ${schemaOwner};
DO $schema$ BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM ${schemaOwner} GRANTED BY reviewrouter RESTRICT',current_database());
END $schema$;
-- Both coordinator locks exclude a stale Prisma writer while its retained
-- guard is removed. Any error restores the guard, owners, grants and ledger.
DROP TRIGGER reviewrouter_managed_retained_ledger_guard ON public._prisma_migrations;
DROP FUNCTION public.reviewrouter_managed_retained_ledger_guard();
${statements.join("\n")}
${renderManagedMembershipCleanupSql}
DO $terminal$ BEGIN
  -- The immutable migrations deliberately override the coordinator timeouts.
  IF current_setting('lock_timeout') <> '15s' OR current_setting('statement_timeout') <> '5min' THEN
    RAISE EXCEPTION 'render_handoff_effective_timeouts';
  END IF;
  IF (${membershipQuery}) IS DISTINCT FROM $membership$${original}$membership$::jsonb
     OR pg_has_role('reviewrouter','${schemaOwner}','SET')
     OR pg_has_role('reviewrouter','${schemaOwner}','USAGE')
     OR has_database_privilege('${schemaOwner}',current_database(),'CREATE')
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='codex_oauth_reattest_active_namespace_v4_to_v5' AND p.pronargs=20)
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='codex_oauth_reattest_active_namespace_v4_to_v5'
       AND p.pronargs=21 AND p.proowner='${schemaOwner}'::regrole AND p.prosecdef
       AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND granted
       AND relation='public."CodexOAuthSecretNamespace"'::regclass AND mode IN ('ShareRowExclusiveLock','AccessExclusiveLock')) THEN
    RAISE EXCEPTION 'render_handoff_terminal_authority';
  END IF;
  IF (SELECT count(*) FROM public._prisma_migrations) <> 92
    OR jsonb_path_query_array((${ledgerQuery}),'$[0 to 88]') IS DISTINCT FROM $ledger$${expectedLedger}$ledger$::jsonb OR EXISTS (
    WITH expected(name,checksum) AS (VALUES ${identities})
    SELECT 1 FROM public._prisma_migrations m LEFT JOIN expected e ON e.name=m.migration_name AND e.checksum=m.checksum
    WHERE e.name IS NULL OR m.id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      OR m.started_at IS NULL OR m.finished_at IS NULL OR m.finished_at<m.started_at
      OR m.rolled_back_at IS NOT NULL OR m.applied_steps_count<>1 OR COALESCE(m.logs,'')<>'')
    OR EXISTS (SELECT 1 FROM public._prisma_migrations GROUP BY migration_name HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'render_handoff_terminal_ledger';
  END IF;
END $terminal$;
-- Remain inside the transaction for approved catalog/status checks. No COMMIT,
-- artifact publication, activation, traffic admission or service resume here.
`;
}
