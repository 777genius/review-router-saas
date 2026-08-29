#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isSanitizedDiagnosticError,
  sanitizedDiagnosticError,
} from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import { assertLegacyAmbiguityEvidence } from "../packages/features/release-rollout/src/domain/trusted-rollout-evidence.js";
import {
  canonicalReleaseMigrationArtifact,
  canonicalReleaseMigrationEntries,
} from "../packages/features/release-rollout/src/domain/release-migration-transition.ts";
import { normalizeSecretSafePostgresArguments } from "./lib/secret-safe-command-boundary.mjs";
import { effectivePrincipalInventorySql } from "../packages/features/release-rollout/src/adapters/effective-principal-postgres.mjs";
import { fencedLiveV70V73CatalogDigestSql } from "../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
import {
  prepareLegacyAmbiguityReconciliation,
  verifyLegacyAmbiguityReconciliation,
  guardedLegacyAmbiguityReconciliationProcedureSql,
} from "./reconcile-codex-rotating-legacy-ambiguity.mjs";

const runtimeRoles = [
  ["api", "reviewrouter_api", "REVIEW_ROUTER_API_DATABASE_URL"],
  ["web", "reviewrouter_web", "REVIEW_ROUTER_WEB_DATABASE_URL"],
  ["worker", "reviewrouter_worker", "REVIEW_ROUTER_WORKER_DATABASE_URL"],
  [
    "effect-authority",
    "reviewrouter_codex_effect_authority",
    "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
  ],
];

const atomicReleaseMigrationEntries = Object.freeze(
  canonicalReleaseMigrationEntries.map(
    ({ migrationName, migrationSqlSha256 }) => [
      migrationName,
      migrationSqlSha256,
    ],
  ),
);

export function stripAtomicMigrationEnvelope(source, migrationName) {
  const lines = source.split("\n");
  const beginLines = [];
  const commitLines = [];

  for (const [index, line] of lines.entries()) {
    const statement = line.trim();
    if (statement === "BEGIN;") beginLines.push(index);
    if (statement === "COMMIT;") commitLines.push(index);
  }

  if (beginLines.length === 0 && commitLines.length === 0) return source;

  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  const beginLine = beginLines[0];
  const commitLine = commitLines[0];
  const hasValidTrailingContent = lines
    .slice((commitLine ?? -1) + 1)
    .every((line) => line.trim() === "" || line.trimStart().startsWith("--"));

  if (
    beginLines.length !== 1 ||
    commitLines.length !== 1 ||
    firstContentLine !== beginLine ||
    beginLine >= commitLine ||
    !hasValidTrailingContent
  ) {
    throw new Error(
      `release_migration_transaction_envelope_invalid:${migrationName}`,
    );
  }

  return lines
    .filter((_, index) => index !== beginLine && index !== commitLine)
    .join("\n");
}

const schemaOwnerGuardedCompatibilityMigrations = new Set([
  "000064_codex_oauth_versioned_secret_namespaces",
  "000066_codex_oauth_rotating_cascade_authority",
]);
const legacyReleaseMigrationOwnerTransfer =
  "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_release_migration') THEN";

export function adaptGuardedMigrationForSchemaOwner(source, migrationName) {
  if (!schemaOwnerGuardedCompatibilityMigrations.has(migrationName))
    return source;

  const occurrenceCount =
    source.split(legacyReleaseMigrationOwnerTransfer).length - 1;
  if (occurrenceCount !== 1)
    throw new Error(
      `release_migration_schema_owner_compatibility_invalid:${migrationName}`,
    );

  return source.replace(
    legacyReleaseMigrationOwnerTransfer,
    `${legacyReleaseMigrationOwnerTransfer.slice(0, -5)}
     AND pg_has_role(current_user, 'reviewrouter_release_migration', 'SET') THEN`,
  );
}

export function atomicReleaseMigrationBundleSql() {
  return atomicReleaseMigrationEntries
    .map(([migrationName, checksum], index) => {
      const path = new URL(
        `../packages/platform/db/prisma/migrations/${migrationName}/migration.sql`,
        import.meta.url,
      );
      const source = readFileSync(path, "utf8");
      const actual = createHash("sha256").update(source).digest("hex");
      if (actual !== checksum)
        throw new Error(
          `release_migration_bundle_source_mismatch:${migrationName}`,
        );
      const body = stripAtomicMigrationEnvelope(source, migrationName);
      const variable = `apply_release_migration_${index}`;
      return `SELECT NOT EXISTS (
  SELECT 1 FROM public._prisma_migrations
  WHERE migration_name='${migrationName}' AND checksum='${checksum}'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) AS ${variable} \\gset
\\if :${variable}
INSERT INTO public._prisma_migrations(
  id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
) VALUES (
  pg_catalog.gen_random_uuid()::text,'${checksum}',NULL,'${migrationName}',NULL,NULL,
  clock_timestamp(),0
);
${body}
UPDATE public._prisma_migrations
SET finished_at=clock_timestamp(),applied_steps_count=1
WHERE migration_name='${migrationName}' AND checksum='${checksum}'
  AND finished_at IS NULL AND rolled_back_at IS NULL;
\\endif`;
    })
    .join("\n");
}

/** Fixed bundle body embedded in the guard-owned SECURITY DEFINER executor. */
function guardedAtomicReleaseMigrationBundleSql(entries) {
  return entries
    .map(([migrationName, checksum]) => {
      const path = new URL(
        `../packages/platform/db/prisma/migrations/${migrationName}/migration.sql`,
        import.meta.url,
      );
      const source = readFileSync(path, "utf8");
      const actual = createHash("sha256").update(source).digest("hex");
      if (actual !== checksum)
        throw new Error(
          `release_migration_bundle_source_mismatch:${migrationName}`,
        );
      const body = adaptGuardedMigrationForSchemaOwner(
        stripAtomicMigrationEnvelope(source, migrationName),
        migrationName,
      );
      return `IF NOT EXISTS (
  SELECT 1 FROM public._prisma_migrations
  WHERE migration_name='${migrationName}' AND checksum='${checksum}'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) THEN
  INSERT INTO public._prisma_migrations(
    id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,
    applied_steps_count
  ) VALUES (
    pg_catalog.gen_random_uuid()::text,'${checksum}',NULL,
    '${migrationName}',NULL,NULL,pg_catalog.clock_timestamp(),0
  );
${body}
  UPDATE public._prisma_migrations
  SET finished_at=pg_catalog.clock_timestamp(),applied_steps_count=1
  WHERE migration_name='${migrationName}' AND checksum='${checksum}'
    AND finished_at IS NULL AND rolled_back_at IS NULL;
END IF;`;
    })
    .join("\n");
}

const runtimeDatabaseAclRoleNames = runtimeRoles.map(
  ([, username]) => username,
);

function assertCanonicalRuntimeRoleConfiguration(configuration) {
  if (
    !configuration ||
    !Array.isArray(configuration.roles) ||
    configuration.roles.length !== runtimeRoles.length ||
    runtimeRoles.some(([role, username]) => {
      const matches = configuration.roles.filter(
        (candidate) =>
          candidate?.role === role && candidate?.username === username,
      );
      return matches.length !== 1;
    })
  )
    throw new Error("release_migration_runtime_role_set_invalid");
}

const runtimeDatabaseAclRoutineBody = `
DECLARE runtime_role text;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'runtime database ACL caller invalid';
  END IF;
  IF requested_phase NOT IN ('preactivation','activated') THEN
    RAISE EXCEPTION 'runtime database ACL phase invalid';
  END IF;
  EXECUTE format(
    'REVOKE CREATE, CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC',
    pg_catalog.current_database()
  );
  FOREACH runtime_role IN ARRAY ARRAY[${runtimeDatabaseAclRoleNames.map(quoted).join(",")}] LOOP
    EXECUTE format(
      'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I',
      pg_catalog.current_database(),runtime_role
    );
    IF requested_phase='activated' THEN
      EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO %I',
        pg_catalog.current_database(),runtime_role
      );
    ELSE
      EXECUTE format(
        'REVOKE CONNECT ON DATABASE %I FROM %I',
        pg_catalog.current_database(),runtime_role
      );
    END IF;
  END LOOP;
END;`;
const runtimeDatabaseAclRoutineBodySha256 = createHash("sha256")
  .update(`${runtimeDatabaseAclRoutineBody}\n`)
  .digest("hex");

function databaseOwnerRuntimeAclRoutineSql() {
  return `CREATE OR REPLACE FUNCTION reviewrouter_activation.apply_runtime_database_acl(
  requested_phase text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $apply_runtime_database_acl$${runtimeDatabaseAclRoutineBody}
$apply_runtime_database_acl$;
ALTER FUNCTION reviewrouter_activation.apply_runtime_database_acl(text)
  OWNER TO ${canonicalBootstrapRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.apply_runtime_database_acl(text)
  FROM PUBLIC, ${activationReceiptGuardRoleName}, reviewrouter_release_migration,
    ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName},
    ${runtimeDatabaseAclRoleNames.join(", ")};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.apply_runtime_database_acl(text)
  TO ${releaseSchemaOwnerRoleName};
DO $runtime_database_acl_routine_boundary$
DECLARE routine_fact record;
DECLARE unexpected_grantee text;
BEGIN
  SELECT routine.prosrc,routine.prosecdef,routine.proconfig,
    owner.rolname AS owner_name INTO STRICT routine_fact
  FROM pg_catalog.pg_proc routine
  JOIN pg_catalog.pg_roles owner ON owner.oid=routine.proowner
  WHERE routine.oid=
    'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure;
  IF routine_fact.owner_name <> '${canonicalBootstrapRoleName}'
     OR NOT routine_fact.prosecdef
     OR routine_fact.proconfig IS DISTINCT FROM
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
     OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          routine_fact.prosrc,'UTF8')),'hex') <>
        '${runtimeDatabaseAclRoutineBodySha256}' THEN
    RAISE EXCEPTION 'runtime database ACL routine integrity boundary invalid';
  END IF;
  SELECT coalesce(grantee.rolname,'PUBLIC') INTO unexpected_grantee
  FROM pg_catalog.pg_proc routine
  CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
    routine.proacl,pg_catalog.acldefault('f',routine.proowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE routine.oid=
      'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure
    AND acl.privilege_type='EXECUTE'
    AND acl.grantee NOT IN (
      '${canonicalBootstrapRoleName}'::regrole,
      '${releaseSchemaOwnerRoleName}'::regrole)
  LIMIT 1;
  IF unexpected_grantee IS NOT NULL
     OR NOT pg_catalog.has_function_privilege(
       '${releaseSchemaOwnerRoleName}',
       'reviewrouter_activation.apply_runtime_database_acl(text)','EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
         routine.proacl,pg_catalog.acldefault('f',routine.proowner))) acl
       WHERE routine.oid=
         'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure
         AND acl.grantee='${releaseSchemaOwnerRoleName}'::regrole
         AND acl.is_grantable
     ) THEN
    RAISE EXCEPTION 'runtime database ACL routine execute boundary invalid: %',
      unexpected_grantee;
  END IF;
END
$runtime_database_acl_routine_boundary$;`;
}

function guardOwnedRuntimeGrantSql() {
  const configuration = {
    roles: runtimeRoles.map(([role, username]) => ({ role, username })),
  };
  return `PERFORM reviewrouter_activation.apply_runtime_database_acl('activated');
${runtimeGrantStatements(configuration, undefined, {
  skipDatabaseAcl: true,
})}`;
}

function guardOwnedRuntimeAclGateSql(configuration) {
  return `PERFORM reviewrouter_activation.apply_runtime_database_acl('preactivation');
${runtimeAclGateStatements(configuration, undefined, {
  skipDatabaseAcl: true,
})}`;
}

function schemaOwnerRuntimeAclRoutinesSql() {
  const runtimeGrants = guardOwnedRuntimeGrantSql();
  const applyBody = `
BEGIN
${runtimeGrants}
END;`;
  const pairBody = `
DECLARE preactivation_policy jsonb;
DECLARE activated_policy jsonb;
BEGIN
  preactivation_policy :=
    reviewrouter_activation.capture_catalog_policy_candidate('preactivation');
  BEGIN
    PERFORM reviewrouter_activation.apply_runtime_acl();
    activated_policy :=
      reviewrouter_activation.capture_catalog_policy_candidate('activated');
    RAISE EXCEPTION 'runtime ACL policy capture rollback'
      USING ERRCODE = 'RRACL';
  EXCEPTION WHEN SQLSTATE 'RRACL' THEN
    IF activated_policy IS NULL THEN
      RAISE;
    END IF;
  END;
  RETURN pg_catalog.jsonb_build_object(
    'preactivation',preactivation_policy,
    'activated',activated_policy
  );
END;`;
  const applySha256 = createHash("sha256")
    .update(`${applyBody}\n`)
    .digest("hex");
  const pairSha256 = createHash("sha256").update(`${pairBody}\n`).digest("hex");
  return `CREATE OR REPLACE FUNCTION reviewrouter_activation.apply_runtime_acl()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $apply_runtime_acl$${applyBody}
$apply_runtime_acl$;
ALTER FUNCTION reviewrouter_activation.apply_runtime_acl()
  OWNER TO ${releaseSchemaOwnerRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.apply_runtime_acl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.apply_runtime_acl()
  TO ${activationReceiptGuardRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.capture_runtime_acl_policy_pair()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $capture_runtime_acl_policy_pair$${pairBody}
$capture_runtime_acl_policy_pair$;
ALTER FUNCTION reviewrouter_activation.capture_runtime_acl_policy_pair()
  OWNER TO ${releaseSchemaOwnerRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.capture_runtime_acl_policy_pair()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.capture_runtime_acl_policy_pair()
  TO ${activationReceiptGuardRoleName};
DO $runtime_acl_routine_boundary$
DECLARE routine_fact record;
DECLARE unexpected_grantee text;
BEGIN
  FOR routine_fact IN
    SELECT routine.oid, routine.prosrc, routine.prosecdef,
      routine.proconfig, owner.rolname AS owner_name
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_roles owner ON owner.oid=routine.proowner
    WHERE routine.oid IN (
      'reviewrouter_activation.apply_runtime_acl()'::regprocedure,
      'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure
    )
  LOOP
    IF routine_fact.owner_name <> '${releaseSchemaOwnerRoleName}'
       OR NOT routine_fact.prosecdef
       OR routine_fact.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[] THEN
      RAISE EXCEPTION 'runtime ACL routine authority boundary invalid';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc routine WHERE routine.oid IN (
        'reviewrouter_activation.apply_runtime_acl()'::regprocedure,
        'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure
      )) <> 2
     OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=
            'reviewrouter_activation.apply_runtime_acl()'::regprocedure),'UTF8')),'hex')
        <> '${applySha256}'
     OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=
            'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure),'UTF8')),'hex')
        <> '${pairSha256}' THEN
    RAISE EXCEPTION 'runtime ACL routine integrity binding invalid';
  END IF;
  SELECT coalesce(grantee.rolname,'PUBLIC') INTO unexpected_grantee
  FROM pg_catalog.pg_proc routine
  CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
    routine.proacl,pg_catalog.acldefault('f',routine.proowner))) acl
  LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
  WHERE routine.oid IN (
      'reviewrouter_activation.apply_runtime_acl()'::regprocedure,
      'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure)
    AND acl.privilege_type='EXECUTE'
    AND acl.grantee <> '${activationReceiptGuardRoleName}'::regrole
    AND acl.grantee <> '${releaseSchemaOwnerRoleName}'::regrole
  LIMIT 1;
  IF unexpected_grantee IS NOT NULL
     OR NOT pg_catalog.has_function_privilege(
       '${activationReceiptGuardRoleName}',
       'reviewrouter_activation.apply_runtime_acl()','EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       '${activationReceiptGuardRoleName}',
       'reviewrouter_activation.capture_runtime_acl_policy_pair()','EXECUTE') THEN
    RAISE EXCEPTION 'runtime ACL routine execute ACL invalid: %',unexpected_grantee;
  END IF;
END
$runtime_acl_routine_boundary$;`;
}

export const rotatingEvidenceTables = Object.freeze([
  "CodexOAuthChildIdentityQuarantine",
  "CodexOAuthLease",
  "CodexOAuthProviderIdentityQuarantine",
  "CodexOAuthProviderInstance",
  "CodexOAuthSecretNamespace",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupManifest",
  "CodexOAuthSetupPayloadClaim",
  "CodexOAuthSetupRecoveryRequest",
  "CodexOAuthWritebackIntent",
]);

const quarantineTables = Object.freeze([
  "CodexOAuthChildIdentityQuarantine",
  "CodexOAuthProviderIdentityQuarantine",
]);

const fullyProtectedRuntimeTables = Object.freeze([
  "CodexOAuthWorkflowCompatibility",
  "CodexOAuthDatabaseAuthorityKey",
  "CodexOAuthDatabaseAuthorityReceipt",
  "RuntimeGenerationWitnessProof",
]);

export const workerOwnedMaintenanceCheckpointTable =
  "ReviewInvestigationMaintenanceCheckpoint";

export const providerRuntimeUpdateColumns = Object.freeze([
  "state",
  "latestGeneration",
  "latestGenerationHash",
  "activeLeaseId",
  "activeLeaseExpiresAt",
  "mutationEpoch",
  "mutationOwner",
  "mutationOwnerId",
  "activeSecretNamespaceId",
  "activeSecretNamespaceEpoch",
  "activeSecretNamespaceName",
  "activeAccountIdentityHash",
  "updatedAt",
]);

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`release_migration_required_environment:${name}`);
  return value;
}

function quoted(value) {
  if (value.includes("\0"))
    throw new Error("release_migration_invalid_role_password");
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseIdentity(value) {
  const url = parseDatabaseUrl(value);
  if (
    !/\.internal$/u.test(url.hostname) &&
    !/^dpg-[a-z0-9-]+$/u.test(url.hostname)
  )
    throw new Error("release_migration_private_database_host_required");
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase()}:${port}${url.pathname}`;
}

function parseDatabaseUrl(value) {
  try {
    return value instanceof URL ? value : new URL(value);
  } catch {
    throw new Error("release_migration_database_url_invalid");
  }
}

const canonicalRoleNames = Object.freeze([
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_release_migration",
]);

const canonicalBootstrapRoleName = "reviewrouter_role_bootstrap";
const activationReceiptGuardRoleName = "reviewrouter_activation_receipt_guard";
const releaseSchemaOwnerRoleName = "reviewrouter_release_schema_owner";
const activationPermitInstallerRoleName =
  "reviewrouter_activation_permit_installer";
const activationReceiptReaderRoleName =
  "reviewrouter_activation_receipt_reader";
const activationPrincipalLoginNames = Object.freeze([
  ...canonicalRoleNames,
  canonicalBootstrapRoleName,
  activationPermitInstallerRoleName,
  activationReceiptReaderRoleName,
]);
const activationPrincipalRoleNames = Object.freeze([
  ...activationPrincipalLoginNames,
  activationReceiptGuardRoleName,
  releaseSchemaOwnerRoleName,
]);
export const activationPrincipalRoleCapabilityMatrix = Object.freeze(
  activationPrincipalLoginNames.flatMap((login) =>
    activationPrincipalRoleNames.map((role) =>
      Object.freeze({
        login,
        role,
        usage: login === role,
        set: login === role,
      }),
    ),
  ),
);

export function isActivationPrincipalRoleCapabilityPermitted(
  login,
  role,
  capability,
) {
  if (capability !== "usage" && capability !== "set") return false;
  const contract = activationPrincipalRoleCapabilityMatrix.find(
    (entry) => entry.login === login && entry.role === role,
  );
  return contract?.[capability] === true;
}
// Trust root for the one PostgreSQL catalog projection embedded in the
// guard-owned activation projector and reused by the read-only adapter.
export const effectivePrincipalInventorySqlSha256 = createHash("sha256")
  .update(effectivePrincipalInventorySql)
  .digest("hex");
const activationMigrationExclusionSql = `SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '120000ms';
SELECT pg_advisory_xact_lock(1381126735, 1129271120);`;

export function activationAuthorityProvisioningSql() {
  return `\\set ON_ERROR_STOP on
BEGIN;
${activationMigrationExclusionSql}
DO $authority_roles$
DECLARE guard pg_roles%ROWTYPE;
DECLARE installer pg_roles%ROWTYPE;
DECLARE reader pg_roles%ROWTYPE;
DECLARE schema_owner pg_roles%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
    WHERE rolname='${releaseSchemaOwnerRoleName}') THEN
    CREATE ROLE ${releaseSchemaOwnerRoleName} NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  SELECT * INTO guard FROM pg_roles WHERE rolname = '${activationReceiptGuardRoleName}';
  SELECT * INTO installer FROM pg_roles WHERE rolname = '${activationPermitInstallerRoleName}';
  SELECT * INTO reader FROM pg_roles WHERE rolname = '${activationReceiptReaderRoleName}';
  SELECT * INTO schema_owner FROM pg_roles
    WHERE rolname = '${releaseSchemaOwnerRoleName}';
  IF guard.rolname IS NULL OR guard.rolcanlogin OR guard.rolsuper OR guard.rolcreatedb
     OR guard.rolcreaterole OR guard.rolreplication OR guard.rolbypassrls THEN
    RAISE EXCEPTION 'external activation guard is not pre-provisioned canonically';
  END IF;
  IF installer.rolname IS NULL OR installer.rolcanlogin IS DISTINCT FROM true OR installer.rolsuper
     OR installer.rolcreatedb OR installer.rolcreaterole
     OR installer.rolreplication OR installer.rolbypassrls THEN
    RAISE EXCEPTION 'activation permit installer is not pre-provisioned canonically';
  END IF;
  IF reader.rolname IS NULL OR reader.rolcanlogin IS DISTINCT FROM true OR reader.rolsuper
     OR reader.rolcreatedb OR reader.rolcreaterole
     OR reader.rolreplication OR reader.rolbypassrls THEN
    RAISE EXCEPTION 'activation receipt reader is not pre-provisioned canonically';
  END IF;
  IF schema_owner.rolname IS NULL OR schema_owner.rolcanlogin
     OR schema_owner.rolsuper OR schema_owner.rolcreatedb
     OR schema_owner.rolcreaterole OR schema_owner.rolreplication
     OR schema_owner.rolbypassrls THEN
    RAISE EXCEPTION 'release schema owner is not canonical';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members edge
    WHERE edge.roleid IN (guard.oid, installer.oid, reader.oid)
       OR edge.member IN (guard.oid, installer.oid, reader.oid)
       OR edge.grantor IN (guard.oid, installer.oid, reader.oid)
  ) THEN
    RAISE EXCEPTION 'activation authority roles must have no membership edges';
  END IF;
END
$authority_roles$;
-- This provider-authorized handoff precedes the trusted bootstrap transaction,
-- whose final statement performs the atomic demotion. Remove all historical
-- schema-owner membership records using their recorded grantors; PG17 can
-- otherwise retain parallel grants after a current-role-only revoke.
DO $schema_owner_membership_convergence$
DECLARE edge record;
BEGIN
  FOR edge IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name,
      grantor.rolname AS grantor_name
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles grantor ON grantor.oid=membership.grantor
    WHERE membership.roleid='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.member='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.grantor='${releaseSchemaOwnerRoleName}'::regrole
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY %I CASCADE',
      edge.granted_name,edge.member_name,edge.grantor_name
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members membership
    WHERE membership.roleid='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.member='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.grantor='${releaseSchemaOwnerRoleName}'::regrole) THEN
    RAISE EXCEPTION 'release schema owner membership convergence failed';
  END IF;
END
$schema_owner_membership_convergence$;
-- Establish exactly one temporary handoff after the historical topology is
-- empty. PostgreSQL 17 records a non-bootstrap superuser's grant under the
-- bootstrap superuser that supplied the authority, so the catalog-recorded
-- grantor is intentionally discovered and checked rather than prescribed.
GRANT ${releaseSchemaOwnerRoleName} TO ${canonicalBootstrapRoleName}
  WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
DO $schema_owner_handoff$
DECLARE total_count integer;
DECLARE canonical_count integer;
DECLARE external_grantor_count integer;
DECLARE edge_summary text;
BEGIN
  SELECT count(*), count(*) FILTER (
    WHERE granted.rolname='${releaseSchemaOwnerRoleName}'
      AND member.rolname='${canonicalBootstrapRoleName}'
      AND grantor.rolname<>'${canonicalBootstrapRoleName}'
      AND grantor.rolname<>'${releaseSchemaOwnerRoleName}'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ), count(DISTINCT grantor.oid) INTO total_count, canonical_count,
     external_grantor_count
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_roles member ON member.oid=membership.member
  JOIN pg_roles grantor ON grantor.oid=membership.grantor
  WHERE membership.roleid='${releaseSchemaOwnerRoleName}'::regrole
     OR membership.member='${releaseSchemaOwnerRoleName}'::regrole
     OR membership.grantor='${releaseSchemaOwnerRoleName}'::regrole;
  IF total_count <> 1 OR canonical_count <> 1 OR external_grantor_count <> 1 THEN
    SELECT left(coalesce(string_agg(format(
      'granted=%I member=%I grantor=%I admin=%s inherit=%s set=%s',
      relevant.granted_name,relevant.member_name,relevant.grantor_name,
      relevant.admin_option,relevant.inherit_option,relevant.set_option
    ), '; ' ORDER BY relevant.granted_name,relevant.member_name,
       relevant.grantor_name), '<none>'), 2048)
    INTO edge_summary
    FROM (
      SELECT granted.rolname AS granted_name, member.rolname AS member_name,
        grantor.rolname AS grantor_name, membership.admin_option,
        membership.inherit_option, membership.set_option
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_roles member ON member.oid=membership.member
      JOIN pg_roles grantor ON grantor.oid=membership.grantor
      WHERE membership.roleid='${releaseSchemaOwnerRoleName}'::regrole
         OR membership.member='${releaseSchemaOwnerRoleName}'::regrole
         OR membership.grantor='${releaseSchemaOwnerRoleName}'::regrole
      ORDER BY granted.rolname,member.rolname,grantor.rolname
      LIMIT 16
    ) relevant;
    RAISE EXCEPTION
      'release schema owner temporary handoff is non-canonical: total %, canonical %',
      total_count, canonical_count
      USING DETAIL = 'bounded role/flag summary: ' || edge_summary;
  END IF;
END
$schema_owner_handoff$;
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC;', current_database())
\\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO ${activationPermitInstallerRoleName};',
  current_database()
)
\\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO ${activationReceiptReaderRoleName};',
  current_database()
)
\\gexec
SELECT format(
  'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM ${activationReceiptReaderRoleName};',
  current_database()
)
\\gexec
REVOKE ALL ON SCHEMA public FROM ${activationReceiptReaderRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${activationReceiptReaderRoleName};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${activationReceiptReaderRoleName};
DO $public_routine_acl$
DECLARE routine_row record;
BEGIN
  -- Canonicalize exact pg_proc identities. Each dynamic command advances the
  -- transaction's command counter, so the following DO gate observes these
  -- ACLs even though a later failure would roll the whole transaction back.
  -- ROUTINE covers functions, aggregates, procedures, and window functions.
  FOR routine_row IN
    SELECT catalog_routine.oid
    FROM pg_proc catalog_routine
    JOIN pg_namespace namespace ON namespace.oid = catalog_routine.pronamespace
    WHERE namespace.nspname = 'public'
    ORDER BY catalog_routine.oid
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ROUTINE %s FROM ${activationReceiptReaderRoleName}',
      routine_row.oid::regprocedure
    );
    EXECUTE format(
      'REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC',
      routine_row.oid::regprocedure
    );
  END LOOP;
END
$public_routine_acl$;
DO $source_receipt_acl$
DECLARE
  receipt_table regclass := pg_catalog.to_regclass(
    'release_authority.source_legacy_ambiguity_receipt'
  );
  canonical_routine regprocedure := pg_catalog.to_regprocedure(
    'release_authority.source_receipt_canonical_json(jsonb)'
  );
  immutable_routine regprocedure := pg_catalog.to_regprocedure(
    'release_authority.source_receipt_immutable()'
  );
BEGIN
  IF pg_catalog.to_regnamespace('release_authority') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON SCHEMA release_authority '
      ||'FROM ${activationReceiptGuardRoleName}';
  END IF;
  -- Fresh installs and legacy contract rehearsals do not own a source receipt.
  -- The migration-permit routine remains the fail-closed enforcement point.
  IF receipt_table IS NULL THEN RETURN; END IF;
  IF canonical_routine IS NULL OR immutable_routine IS NULL THEN
    RAISE EXCEPTION 'source legacy ambiguity receipt catalog is incomplete';
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA release_authority '
    ||'TO ${activationReceiptGuardRoleName}';
  EXECUTE 'REVOKE ALL ON TABLE '
    ||'release_authority.source_legacy_ambiguity_receipt '
    ||'FROM ${activationReceiptGuardRoleName}';
  EXECUTE 'GRANT SELECT ON TABLE '
    ||'release_authority.source_legacy_ambiguity_receipt '
    ||'TO ${activationReceiptGuardRoleName}';
  EXECUTE 'REVOKE ALL ON FUNCTION '
    ||'release_authority.source_receipt_canonical_json(jsonb) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION '
    ||'release_authority.source_receipt_immutable() FROM PUBLIC';
  IF NOT has_schema_privilege(
       '${activationReceiptGuardRoleName}', 'release_authority', 'USAGE'
     )
     OR has_schema_privilege(
       '${activationReceiptGuardRoleName}', 'release_authority', 'CREATE'
     )
     OR NOT has_table_privilege(
       '${activationReceiptGuardRoleName}',
       'release_authority.source_legacy_ambiguity_receipt', 'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
       ) acl
       WHERE routine.oid IN (canonical_routine, immutable_routine)
         AND acl.grantee=0
         AND acl.privilege_type='EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid=relation.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
       ) acl
       WHERE relation.oid=receipt_table
         AND acl.grantee='${activationReceiptGuardRoleName}'::regrole
         AND (acl.privilege_type<>'SELECT' OR acl.is_grantable)
     ) THEN
    RAISE EXCEPTION 'source legacy ambiguity receipt ACL is non-canonical';
  END IF;
END
$source_receipt_acl$;
DO $installer_database_acl$
BEGIN
  IF NOT has_database_privilege(
       '${activationPermitInstallerRoleName}', current_database(), 'CONNECT'
     )
     OR has_database_privilege(
       '${activationPermitInstallerRoleName}', current_database(), 'TEMP'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_database database,
            LATERAL aclexplode(coalesce(database.datacl, acldefault('d', database.datdba))) acl
       WHERE database.datname = current_database()
         AND acl.grantee = '${activationPermitInstallerRoleName}'::regrole
         AND acl.privilege_type = 'CONNECT'
         AND acl.is_grantable
     ) THEN
    RAISE EXCEPTION 'activation permit installer database ACL is non-canonical';
  END IF;
  IF NOT has_database_privilege(
       '${activationReceiptReaderRoleName}', current_database(), 'CONNECT'
     )
     OR has_database_privilege(
       '${activationReceiptReaderRoleName}', current_database(), 'CREATE'
     )
     OR has_database_privilege(
       '${activationReceiptReaderRoleName}', current_database(), 'TEMP'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_database database,
            LATERAL aclexplode(coalesce(database.datacl, acldefault('d', database.datdba))) acl
       WHERE database.datname = current_database()
         AND acl.grantee = '${activationReceiptReaderRoleName}'::regrole
         AND acl.is_grantable
     )
     OR has_schema_privilege(
       '${activationReceiptReaderRoleName}', 'public', 'CREATE'
     )
     OR EXISTS (
       SELECT 1 FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
       WHERE namespace.nspname='public'
         AND relation.relkind IN ('r','p','v','m','f')
         AND has_table_privilege(
           '${activationReceiptReaderRoleName}', relation.oid, privilege
         )
     )
     OR EXISTS (
       SELECT 1 FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) privilege
       WHERE namespace.nspname='public' AND relation.relkind='S'
         AND has_sequence_privilege(
           '${activationReceiptReaderRoleName}', relation.oid, privilege
         )
     )
     OR EXISTS (
       SELECT 1 FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
       WHERE namespace.nspname='public'
         AND has_function_privilege(
           '${activationReceiptReaderRoleName}', routine.oid, 'EXECUTE'
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
       CROSS JOIN LATERAL aclexplode(
         coalesce(routine.proacl, acldefault('f', routine.proowner))
       ) acl
       WHERE namespace.nspname='public'
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'activation receipt reader database ACL is non-canonical';
  END IF;
END
$installer_database_acl$;
DO $prisma_migrations_boundary$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'Prisma migration history table is absent';
  END IF;
END
$prisma_migrations_boundary$;
GRANT SELECT ON TABLE public."_prisma_migrations" TO ${activationReceiptGuardRoleName};
DO $activation_public_table_acl$
BEGIN
  IF NOT has_table_privilege(
       '${activationReceiptGuardRoleName}', 'public._prisma_migrations', 'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
       WHERE has_table_privilege(
         '${activationReceiptGuardRoleName}', 'public._prisma_migrations', privilege
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND relation.relname <> '_prisma_migrations'
         AND EXISTS (
           SELECT 1
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
           WHERE has_table_privilege(
             '${activationReceiptGuardRoleName}', relation.oid, privilege
           )
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND EXISTS (
           SELECT 1
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
           WHERE has_table_privilege(
             '${activationPermitInstallerRoleName}', relation.oid, privilege
           )
         )
     ) THEN
    RAISE EXCEPTION 'activation public table ACL is non-canonical';
  END IF;
END
$activation_public_table_acl$;
GRANT SELECT ("status") ON TABLE public."CodexOAuthLease",
  public."CodexOAuthSetupManifest",public."CodexOAuthWritebackIntent"
  TO ${activationReceiptGuardRoleName};
DO $migration_completion_column_acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE namespace.nspname='public'
      AND relation.relname IN ('CodexOAuthLease','CodexOAuthSetupManifest',
        'CodexOAuthWritebackIntent')
      AND has_column_privilege('${activationReceiptGuardRoleName}',relation.oid,
        attribute.attnum,'SELECT') IS DISTINCT FROM (attribute.attname='status')
  ) THEN
    RAISE EXCEPTION 'migration completion column ACL is non-canonical';
  END IF;
END
$migration_completion_column_acl$;
CREATE SCHEMA IF NOT EXISTS reviewrouter_activation AUTHORIZATION ${activationReceiptGuardRoleName};
ALTER SCHEMA reviewrouter_activation OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON SCHEMA reviewrouter_activation FROM PUBLIC;
CREATE TABLE IF NOT EXISTS reviewrouter_activation.activation_permit (
  rollout_id text PRIMARY KEY CHECK (rollout_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'),
  source_system_identifier text NOT NULL CHECK (source_system_identifier ~ '^[0-9]+$'),
  target_system_identifier text NOT NULL CHECK (target_system_identifier ~ '^[0-9]+$'),
  postgres_major integer NOT NULL CHECK (postgres_major = 17),
  expected_commit_sha text NOT NULL CHECK (expected_commit_sha ~ '^[a-f0-9]{40}$'),
  migration_checksum text NOT NULL CHECK (migration_checksum ~ '^sha256:[a-f0-9]{64}$'),
  target_deploy_ids jsonb NOT NULL CHECK (
    jsonb_typeof(target_deploy_ids) = 'array' AND jsonb_array_length(target_deploy_ids) > 0
  ),
  permit_epoch bigint NOT NULL CHECK (permit_epoch > 0),
  permit_nonce text NOT NULL CHECK (permit_nonce ~ '^[a-f0-9]{32}$'),
  preactivation_catalog_policy jsonb NOT NULL,
  preactivation_catalog_policy_sha256 text NOT NULL CHECK (preactivation_catalog_policy_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  activated_catalog_policy jsonb NOT NULL,
  activated_catalog_policy_sha256 text NOT NULL CHECK (activated_catalog_policy_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  installed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  consumed_at timestamptz,
  CHECK (source_system_identifier <> target_system_identifier),
  UNIQUE (permit_epoch, permit_nonce)
);
CREATE TABLE IF NOT EXISTS reviewrouter_activation.activation_receipt (
  rollout_id text PRIMARY KEY,
  source_system_identifier text NOT NULL,
  target_system_identifier text NOT NULL UNIQUE,
  postgres_major integer NOT NULL,
  expected_commit_sha text NOT NULL,
  migration_checksum text NOT NULL,
  target_deploy_ids jsonb NOT NULL,
  permit_epoch bigint NOT NULL,
  permit_nonce text NOT NULL,
  canonical_privileges_sha256 text NOT NULL,
  catalog_facts_sha256 text NOT NULL,
  preactivation_catalog_policy jsonb NOT NULL,
  preactivation_catalog_policy_sha256 text NOT NULL,
  activated_catalog_policy jsonb NOT NULL,
  activated_catalog_policy_sha256 text NOT NULL,
  before_principal_inventory_sha256 text NOT NULL,
  before_principal_policy_sha256 text NOT NULL,
  activated_principal_inventory_sha256 text NOT NULL,
  activated_principal_policy_sha256 text NOT NULL,
  first_write_receipt_sha256 text NOT NULL,
  transaction_id bigint NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE reviewrouter_activation.activation_receipt
  ADD COLUMN IF NOT EXISTS before_principal_inventory_sha256 text,
  ADD COLUMN IF NOT EXISTS before_principal_policy_sha256 text,
  ADD COLUMN IF NOT EXISTS activated_principal_inventory_sha256 text,
  ADD COLUMN IF NOT EXISTS activated_principal_policy_sha256 text;
DO $principal_evidence_upgrade$
BEGIN
  IF EXISTS (SELECT 1 FROM reviewrouter_activation.activation_receipt WHERE
    before_principal_inventory_sha256 IS NULL OR before_principal_policy_sha256 IS NULL OR
    activated_principal_inventory_sha256 IS NULL OR activated_principal_policy_sha256 IS NULL) THEN
    RAISE EXCEPTION 'legacy activation receipt lacks principal evidence';
  END IF;
END
$principal_evidence_upgrade$;
ALTER TABLE reviewrouter_activation.activation_receipt
  ALTER COLUMN before_principal_inventory_sha256 SET NOT NULL,
  ALTER COLUMN before_principal_policy_sha256 SET NOT NULL,
  ALTER COLUMN activated_principal_inventory_sha256 SET NOT NULL,
  ALTER COLUMN activated_principal_policy_sha256 SET NOT NULL;
DO $principal_evidence_constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conrelid='reviewrouter_activation.activation_receipt'::regclass
    AND conname='activation_receipt_principal_evidence_valid') THEN
    ALTER TABLE reviewrouter_activation.activation_receipt ADD CONSTRAINT
      activation_receipt_principal_evidence_valid CHECK (
        before_principal_inventory_sha256 ~ '^sha256:[a-f0-9]{64}$' AND
        before_principal_policy_sha256 ~ '^sha256:[a-f0-9]{64}$' AND
        activated_principal_inventory_sha256 ~ '^sha256:[a-f0-9]{64}$' AND
        activated_principal_policy_sha256 ~ '^sha256:[a-f0-9]{64}$');
  END IF;
END
$principal_evidence_constraint$;
CREATE TABLE IF NOT EXISTS reviewrouter_activation.activation_principal_evidence (
  rollout_id text PRIMARY KEY,
  source_system_identifier text NOT NULL,
  target_system_identifier text NOT NULL,
  postgres_major integer NOT NULL,
  expected_commit_sha text NOT NULL,
  migration_checksum text NOT NULL,
  target_deploy_ids jsonb NOT NULL,
  permit_epoch bigint NOT NULL,
  permit_nonce text NOT NULL,
  preactivation_catalog_policy jsonb NOT NULL,
  preactivation_catalog_policy_sha256 text NOT NULL,
  activated_catalog_policy jsonb NOT NULL,
  activated_catalog_policy_sha256 text NOT NULL,
  before_inventory jsonb NOT NULL,
  before_policy jsonb NOT NULL,
  activated_inventory jsonb NOT NULL,
  activated_policy jsonb NOT NULL,
  before_principal_inventory_sha256 text NOT NULL,
  before_principal_policy_sha256 text NOT NULL,
  activated_principal_inventory_sha256 text NOT NULL,
  activated_principal_policy_sha256 text NOT NULL,
  transaction_id bigint NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE IF NOT EXISTS reviewrouter_activation.migration_permit (
  rollout_id text PRIMARY KEY CHECK (rollout_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'),
  source_system_identifier text NOT NULL CHECK (source_system_identifier ~ '^[1-9][0-9]{0,19}$'),
  target_system_identifier text NOT NULL CHECK (target_system_identifier ~ '^[1-9][0-9]{0,19}$'),
  target_database_identity text NOT NULL CHECK (target_database_identity ~ '^[1-9][0-9]{0,19}$'),
  target_database_name text NOT NULL CHECK (length(target_database_name) BETWEEN 1 AND 63),
  target_recovery_witness_sha256 text NOT NULL CHECK (target_recovery_witness_sha256 ~ '^[a-f0-9]{64}$'),
  transition_sha256 text NOT NULL CHECK (transition_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  previous_receipt_sha256 text NOT NULL CHECK (previous_receipt_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  expected_post_manifest_identity text NOT NULL CHECK (expected_post_manifest_identity ~ '^sha256:[a-f0-9]{64}$'),
  expected_post_catalog_digest text NOT NULL CHECK (expected_post_catalog_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_legacy_ambiguity jsonb NOT NULL,
  eligibility_cutoff timestamptz NOT NULL,
  permit_epoch bigint NOT NULL CHECK (permit_epoch > 0),
  permit_nonce text NOT NULL CHECK (permit_nonce ~ '^[a-f0-9]{32}$'),
  state text NOT NULL DEFAULT 'installed' CHECK (state IN ('installed','consumed','completed','quarantined')),
  target_receipt jsonb,
  installed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  consumed_at timestamptz,
  terminalized_at timestamptz,
  CHECK (source_system_identifier <> target_system_identifier),
  CHECK ((state IN ('installed','quarantined') AND target_receipt IS NULL) OR
    (state IN ('consumed','completed') AND target_receipt IS NOT NULL)),
  UNIQUE (permit_epoch,permit_nonce)
);
ALTER TABLE reviewrouter_activation.migration_permit
  ADD COLUMN IF NOT EXISTS source_legacy_ambiguity jsonb,
  ADD COLUMN IF NOT EXISTS eligibility_cutoff timestamptz;
DO $migration_permit_evidence_upgrade$
BEGIN
  IF EXISTS (SELECT 1 FROM reviewrouter_activation.migration_permit
             WHERE source_legacy_ambiguity IS NULL OR eligibility_cutoff IS NULL)
  THEN RAISE EXCEPTION 'legacy migration permit cannot be upgraded without source evidence'; END IF;
END $migration_permit_evidence_upgrade$;
ALTER TABLE reviewrouter_activation.migration_permit
  ALTER COLUMN source_legacy_ambiguity SET NOT NULL,
  ALTER COLUMN eligibility_cutoff SET NOT NULL;
DO $migration_permit_evidence_catalog$
DECLARE evidence_attribute record;
BEGIN
  SELECT a.atttypid,a.atttypmod,a.attndims,a.attnotnull
  INTO evidence_attribute
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid='reviewrouter_activation.migration_permit'::pg_catalog.regclass
    AND a.attname='source_legacy_ambiguity' AND NOT a.attisdropped;
  IF NOT FOUND
     OR evidence_attribute.atttypid IS DISTINCT FROM 'jsonb'::pg_catalog.regtype
     OR evidence_attribute.atttypmod IS DISTINCT FROM -1
     OR evidence_attribute.attndims IS DISTINCT FROM 0
     OR evidence_attribute.attnotnull IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'release migration target source evidence catalog invalid';
  END IF;
END
$migration_permit_evidence_catalog$;
ALTER TABLE reviewrouter_activation.activation_permit
  ADD COLUMN IF NOT EXISTS preactivation_catalog_policy jsonb,
  ADD COLUMN IF NOT EXISTS preactivation_catalog_policy_sha256 text,
  ADD COLUMN IF NOT EXISTS activated_catalog_policy jsonb,
  ADD COLUMN IF NOT EXISTS activated_catalog_policy_sha256 text;
ALTER TABLE reviewrouter_activation.activation_receipt
  ADD COLUMN IF NOT EXISTS preactivation_catalog_policy jsonb,
  ADD COLUMN IF NOT EXISTS preactivation_catalog_policy_sha256 text,
  ADD COLUMN IF NOT EXISTS activated_catalog_policy jsonb,
  ADD COLUMN IF NOT EXISTS activated_catalog_policy_sha256 text;
ALTER TABLE reviewrouter_activation.activation_principal_evidence
  ADD COLUMN IF NOT EXISTS preactivation_catalog_policy jsonb,
  ADD COLUMN IF NOT EXISTS preactivation_catalog_policy_sha256 text,
  ADD COLUMN IF NOT EXISTS activated_catalog_policy jsonb,
  ADD COLUMN IF NOT EXISTS activated_catalog_policy_sha256 text;
DO $catalog_policy_upgrade$
BEGIN
  IF EXISTS (SELECT 1 FROM reviewrouter_activation.activation_permit WHERE
       preactivation_catalog_policy IS NULL OR preactivation_catalog_policy_sha256 IS NULL
       OR activated_catalog_policy IS NULL OR activated_catalog_policy_sha256 IS NULL)
     OR EXISTS (SELECT 1 FROM reviewrouter_activation.activation_receipt WHERE
       preactivation_catalog_policy IS NULL OR preactivation_catalog_policy_sha256 IS NULL
       OR activated_catalog_policy IS NULL OR activated_catalog_policy_sha256 IS NULL)
     OR EXISTS (SELECT 1 FROM reviewrouter_activation.activation_principal_evidence WHERE
       preactivation_catalog_policy IS NULL OR preactivation_catalog_policy_sha256 IS NULL
       OR activated_catalog_policy IS NULL OR activated_catalog_policy_sha256 IS NULL) THEN
    RAISE EXCEPTION 'legacy activation state lacks reviewed catalog policy';
  END IF;
END
$catalog_policy_upgrade$;
ALTER TABLE reviewrouter_activation.activation_permit
  ALTER COLUMN preactivation_catalog_policy SET NOT NULL,
  ALTER COLUMN preactivation_catalog_policy_sha256 SET NOT NULL,
  ALTER COLUMN activated_catalog_policy SET NOT NULL,
  ALTER COLUMN activated_catalog_policy_sha256 SET NOT NULL;
ALTER TABLE reviewrouter_activation.activation_receipt
  ALTER COLUMN preactivation_catalog_policy SET NOT NULL,
  ALTER COLUMN preactivation_catalog_policy_sha256 SET NOT NULL,
  ALTER COLUMN activated_catalog_policy SET NOT NULL,
  ALTER COLUMN activated_catalog_policy_sha256 SET NOT NULL;
ALTER TABLE reviewrouter_activation.activation_principal_evidence
  ALTER COLUMN preactivation_catalog_policy SET NOT NULL,
  ALTER COLUMN preactivation_catalog_policy_sha256 SET NOT NULL,
  ALTER COLUMN activated_catalog_policy SET NOT NULL,
  ALTER COLUMN activated_catalog_policy_sha256 SET NOT NULL;
ALTER TABLE reviewrouter_activation.activation_permit OWNER TO ${activationReceiptGuardRoleName};
ALTER TABLE reviewrouter_activation.activation_receipt OWNER TO ${activationReceiptGuardRoleName};
ALTER TABLE reviewrouter_activation.activation_principal_evidence OWNER TO ${activationReceiptGuardRoleName};
ALTER TABLE reviewrouter_activation.migration_permit OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${activationPermitInstallerRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${activationReceiptReaderRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${canonicalBootstrapRoleName};
DROP FUNCTION IF EXISTS reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text);
CREATE OR REPLACE FUNCTION reviewrouter_activation.install_activation_permit(
  requested_rollout_id text, requested_source_system_identifier text,
  requested_target_system_identifier text, requested_postgres_major integer,
  requested_expected_commit_sha text, requested_migration_checksum text,
  requested_target_deploy_ids jsonb, requested_permit_epoch bigint,
  requested_permit_nonce text, requested_preactivation_catalog_policy jsonb,
  requested_preactivation_catalog_policy_sha256 text,
  requested_activated_catalog_policy jsonb,
  requested_activated_catalog_policy_sha256 text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $install_permit$
DECLARE existing reviewrouter_activation.activation_permit%ROWTYPE;
BEGIN
  IF session_user <> '${activationPermitInstallerRoleName}'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
     OR requested_source_system_identifier !~ '^[0-9]+$'
     OR requested_target_system_identifier !~ '^[0-9]+$'
     OR requested_source_system_identifier = requested_target_system_identifier
     OR requested_postgres_major <> 17
     OR requested_expected_commit_sha !~ '^[a-f0-9]{40}$'
     OR requested_migration_checksum !~ '^sha256:[a-f0-9]{64}$'
     OR jsonb_typeof(requested_target_deploy_ids) <> 'array'
     OR jsonb_array_length(requested_target_deploy_ids) < 1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(requested_target_deploy_ids) value WHERE value !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$')
     OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(requested_target_deploy_ids) value)
        <> jsonb_array_length(requested_target_deploy_ids)
     OR requested_permit_epoch < 1
     OR requested_permit_nonce !~ '^[a-f0-9]{32}$'
     OR requested_preactivation_catalog_policy_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR requested_activated_catalog_policy_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR requested_preactivation_catalog_policy->>'kind' IS DISTINCT FROM 'reviewrouter-activation-catalog-policy'
     OR requested_activated_catalog_policy->>'kind' IS DISTINCT FROM 'reviewrouter-activation-catalog-policy'
     OR requested_preactivation_catalog_policy->>'version' IS DISTINCT FROM '1'
     OR requested_activated_catalog_policy->>'version' IS DISTINCT FROM '1'
     OR requested_preactivation_catalog_policy->>'phase' IS DISTINCT FROM 'preactivation'
     OR requested_activated_catalog_policy->>'phase' IS DISTINCT FROM 'activated'
     OR (SELECT count(*) FROM jsonb_object_keys(requested_preactivation_catalog_policy)) <> 11
     OR (SELECT count(*) FROM jsonb_object_keys(requested_activated_catalog_policy)) <> 11
     OR NOT requested_preactivation_catalog_policy ?& ARRAY['kind','version','phase','database','roles','memberships','roleReachability','rowSecurity','extensions','grants','effectivePermissions']
     OR NOT requested_activated_catalog_policy ?& ARRAY['kind','version','phase','database','roles','memberships','roleReachability','rowSecurity','extensions','grants','effectivePermissions']
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['roles','memberships','roleReachability','rowSecurity','extensions','grants','effectivePermissions']) field
       WHERE jsonb_typeof(requested_preactivation_catalog_policy->field) IS DISTINCT FROM 'array'
          OR jsonb_typeof(requested_activated_catalog_policy->field) IS DISTINCT FROM 'array')
     OR requested_preactivation_catalog_policy_sha256 <> 'sha256:' || encode(sha256(convert_to(
          reviewrouter_activation.canonical_json(requested_preactivation_catalog_policy),'UTF8')),'hex')
     OR requested_activated_catalog_policy_sha256 <> 'sha256:' || encode(sha256(convert_to(
          reviewrouter_activation.canonical_json(requested_activated_catalog_policy),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'activation permit invalid';
  END IF;
  INSERT INTO reviewrouter_activation.activation_permit (
    rollout_id, source_system_identifier, target_system_identifier,
    postgres_major, expected_commit_sha, migration_checksum,
    target_deploy_ids, permit_epoch, permit_nonce,
    preactivation_catalog_policy,preactivation_catalog_policy_sha256,
    activated_catalog_policy,activated_catalog_policy_sha256
  ) VALUES (
    requested_rollout_id, requested_source_system_identifier,
    requested_target_system_identifier, requested_postgres_major,
    requested_expected_commit_sha, requested_migration_checksum,
    requested_target_deploy_ids, requested_permit_epoch, requested_permit_nonce,
    requested_preactivation_catalog_policy,requested_preactivation_catalog_policy_sha256,
    requested_activated_catalog_policy,requested_activated_catalog_policy_sha256
  ) ON CONFLICT (rollout_id) DO NOTHING;
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO existing FROM reviewrouter_activation.activation_permit
  WHERE rollout_id = requested_rollout_id FOR UPDATE;
  IF existing.source_system_identifier = requested_source_system_identifier
     AND existing.target_system_identifier = requested_target_system_identifier
     AND existing.postgres_major = requested_postgres_major
     AND existing.expected_commit_sha = requested_expected_commit_sha
     AND existing.migration_checksum = requested_migration_checksum
     AND existing.target_deploy_ids = requested_target_deploy_ids
     AND existing.permit_epoch = requested_permit_epoch
     AND existing.permit_nonce = requested_permit_nonce
     AND existing.preactivation_catalog_policy = requested_preactivation_catalog_policy
     AND existing.preactivation_catalog_policy_sha256 = requested_preactivation_catalog_policy_sha256
     AND existing.activated_catalog_policy = requested_activated_catalog_policy
     AND existing.activated_catalog_policy_sha256 = requested_activated_catalog_policy_sha256 THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'activation permit conflicts with installed tuple';
END
$install_permit$;
ALTER FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_activation TO ${activationPermitInstallerRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text) TO ${activationPermitInstallerRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.assert_no_activation_receipt()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $assert_no_receipt$
BEGIN
  IF session_user <> '${canonicalBootstrapRoleName}' THEN
    RAISE EXCEPTION 'activation receipt assertion caller invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM reviewrouter_activation.activation_receipt) THEN
    RAISE EXCEPTION 'role bootstrap forbidden after generation activation';
  END IF;
END
$assert_no_receipt$;
ALTER FUNCTION reviewrouter_activation.assert_no_activation_receipt() OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.assert_no_activation_receipt() FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reviewrouter_activation FROM ${canonicalBootstrapRoleName};
GRANT USAGE ON SCHEMA reviewrouter_activation TO ${canonicalBootstrapRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.assert_no_activation_receipt() TO ${canonicalBootstrapRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.canonical_json(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $canonical_json$
SELECT CASE jsonb_typeof(value)
  WHEN 'object' THEN '{' || coalesce((SELECT string_agg(to_json(key)::text || ':' ||
    reviewrouter_activation.canonical_json(item), ',' ORDER BY key COLLATE "C")
    FROM jsonb_each(value) entry(key,item)), '') || '}'
  WHEN 'array' THEN '[' || coalesce((SELECT string_agg(
    reviewrouter_activation.canonical_json(item), ',' ORDER BY ordinal)
    FROM jsonb_array_elements(value) WITH ORDINALITY entry(item,ordinal)), '') || ']'
  ELSE value::text END
$canonical_json$;
ALTER FUNCTION reviewrouter_activation.canonical_json(jsonb) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.canonical_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.canonical_json(jsonb) FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName}, ${canonicalBootstrapRoleName}, reviewrouter_release_migration;
DROP FUNCTION IF EXISTS reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,bigint,text);
DROP FUNCTION IF EXISTS reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text);
CREATE OR REPLACE FUNCTION reviewrouter_activation.install_migration_permit(
  requested_rollout_id text, requested_source_system_identifier text,
  requested_target_system_identifier text,
  requested_target_recovery_witness_sha256 text,
  requested_transition_sha256 text, requested_previous_receipt_sha256 text,
  requested_expected_post_manifest_identity text,
  requested_expected_post_catalog_digest text,
  requested_source_legacy_ambiguity jsonb,
  requested_eligibility_cutoff timestamptz,
  requested_permit_epoch bigint, requested_permit_nonce text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $install_migration_permit$
DECLARE existing reviewrouter_activation.migration_permit%ROWTYPE;
DECLARE database_comment text;
DECLARE observed_witness text;
DECLARE observed_system_identifier text;
DECLARE observed_database_identity text;
DECLARE restored_source_evidence jsonb;
BEGIN
  SELECT system_identifier::text INTO STRICT observed_system_identifier
  FROM pg_catalog.pg_control_system();
  SELECT oid::text,pg_catalog.shobj_description(oid,'pg_database')
  INTO STRICT observed_database_identity,database_comment
  FROM pg_catalog.pg_database WHERE datname=current_database();
  observed_witness := CASE
    WHEN pg_catalog.pg_input_is_valid(database_comment,'jsonb')
    THEN database_comment::jsonb->>'recoveryWitnessSha256' ELSE NULL END;
  IF session_user <> '${activationPermitInstallerRoleName}'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
     OR requested_source_system_identifier !~ '^[1-9][0-9]{0,19}$'
     OR requested_target_system_identifier !~ '^[1-9][0-9]{0,19}$'
     OR requested_source_system_identifier=requested_target_system_identifier
     OR requested_target_system_identifier IS DISTINCT FROM observed_system_identifier
     OR requested_target_recovery_witness_sha256 !~ '^[a-f0-9]{64}$'
     OR requested_target_recovery_witness_sha256 IS DISTINCT FROM observed_witness
     OR requested_transition_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR requested_previous_receipt_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR requested_expected_post_manifest_identity !~ '^sha256:[a-f0-9]{64}$'
     OR requested_expected_post_catalog_digest !~ '^sha256:[a-f0-9]{64}$'
     OR jsonb_typeof(requested_source_legacy_ambiguity) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(requested_source_legacy_ambiguity)) <> 18
     OR NOT requested_source_legacy_ambiguity ?& ARRAY['schemaVersion','rolloutId',
       'sourceSystemIdentifier','sourceDatabaseName','sourceRecoveryWitnessSha256',
       'authorityPrincipal','fenceId','fenceEstablishedAt','fencedInventorySha256',
       'inventorySha256','activeLeaseIds','fetchedSetupIds','pendingIntentIds',
       'intentStatuses','observations','eligibilityCutoff','stable','receiptSha256']
     OR requested_source_legacy_ambiguity->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR requested_source_legacy_ambiguity->>'rolloutId' IS DISTINCT FROM requested_rollout_id
     OR requested_source_legacy_ambiguity->>'sourceSystemIdentifier' IS DISTINCT FROM
       requested_source_system_identifier
     OR coalesce(requested_source_legacy_ambiguity->>'sourceDatabaseName','')=''
     OR requested_source_legacy_ambiguity->>'sourceRecoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
     OR coalesce(requested_source_legacy_ambiguity->>'authorityPrincipal','')=''
     OR coalesce(requested_source_legacy_ambiguity->>'fenceId','')=''
     OR requested_source_legacy_ambiguity->>'fencedInventorySha256' !~ '^sha256:[a-f0-9]{64}$'
     OR requested_source_legacy_ambiguity->'stable' IS DISTINCT FROM 'true'::jsonb
     OR requested_source_legacy_ambiguity->>'inventorySha256' !~ '^sha256:[a-f0-9]{64}$'
     OR requested_source_legacy_ambiguity->>'receiptSha256' !~ '^sha256:[a-f0-9]{64}$'
     OR NOT pg_input_is_valid(
       requested_source_legacy_ambiguity->>'fenceEstablishedAt','timestamptz')
     OR NOT pg_input_is_valid(
       requested_source_legacy_ambiguity->>'eligibilityCutoff','timestamptz')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['activeLeaseIds','fetchedSetupIds',
       'pendingIntentIds','intentStatuses']) key
       WHERE jsonb_typeof(requested_source_legacy_ambiguity->key) IS DISTINCT FROM 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(requested_source_legacy_ambiguity->key) item
           WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'))
     OR jsonb_typeof(requested_source_legacy_ambiguity->'observations') IS DISTINCT FROM 'array'
     OR jsonb_array_length(requested_source_legacy_ambiguity->'observations') <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(
         requested_source_legacy_ambiguity->'observations') sample
       WHERE jsonb_typeof(sample) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(sample)) <> 2
         OR NOT sample ?& ARRAY['observedAt','inventorySha256']
         OR sample->>'inventorySha256' IS DISTINCT FROM
           requested_source_legacy_ambiguity->>'inventorySha256'
         OR NOT pg_input_is_valid(sample->>'observedAt','timestamptz')
         OR to_char((sample->>'observedAt')::timestamptz AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM sample->>'observedAt')
     OR requested_eligibility_cutoff IS NULL
     OR requested_permit_epoch < 1
     OR requested_permit_nonce !~ '^[a-f0-9]{32}$' THEN
    RAISE EXCEPTION 'release migration target permit invalid';
  END IF;
  IF (requested_source_legacy_ambiguity->'observations'->1->>'observedAt')::timestamptz
       <= (requested_source_legacy_ambiguity->'observations'->0->>'observedAt')::timestamptz
  THEN RAISE EXCEPTION 'release migration target source evidence ordering invalid'; END IF;
  IF to_char((requested_source_legacy_ambiguity->>'fenceEstablishedAt')::timestamptz
       AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM
       requested_source_legacy_ambiguity->>'fenceEstablishedAt'
     OR to_char((requested_source_legacy_ambiguity->>'eligibilityCutoff')::timestamptz
       AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM
       requested_source_legacy_ambiguity->>'eligibilityCutoff'
     OR requested_source_legacy_ambiguity->>'eligibilityCutoff' IS DISTINCT FROM
       requested_source_legacy_ambiguity->'observations'->1->>'observedAt'
     OR requested_eligibility_cutoff IS DISTINCT FROM
       (requested_source_legacy_ambiguity->>'eligibilityCutoff')::timestamptz
     OR requested_source_legacy_ambiguity->>'receiptSha256' IS DISTINCT FROM
       'sha256:'||encode(sha256(convert_to(
         reviewrouter_activation.canonical_json(
           requested_source_legacy_ambiguity-'receiptSha256'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'release migration target source receipt invalid'; END IF;
  -- This row was created by the fenced source transaction and must travel in
  -- the pg_dump. A caller-supplied self-hash is never accepted as provenance.
  IF pg_catalog.to_regclass(
      'release_authority.source_legacy_ambiguity_receipt') IS NULL
  THEN RAISE EXCEPTION 'release migration source-owned receipt missing from target'; END IF;
  EXECUTE 'SELECT evidence FROM release_authority.source_legacy_ambiguity_receipt '
    ||'WHERE rollout_id=$1' INTO STRICT restored_source_evidence
    USING requested_rollout_id;
  IF restored_source_evidence IS DISTINCT FROM requested_source_legacy_ambiguity
  THEN RAISE EXCEPTION 'release migration source-owned receipt binding conflict'; END IF;
  INSERT INTO reviewrouter_activation.migration_permit(
    rollout_id,source_system_identifier,target_system_identifier,
    target_database_identity,target_database_name,target_recovery_witness_sha256,
    transition_sha256,previous_receipt_sha256,expected_post_manifest_identity,
    expected_post_catalog_digest,source_legacy_ambiguity,eligibility_cutoff,
    permit_epoch,permit_nonce)
  VALUES(requested_rollout_id,requested_source_system_identifier,
    requested_target_system_identifier,observed_database_identity,current_database(),
    requested_target_recovery_witness_sha256,requested_transition_sha256,
    requested_previous_receipt_sha256,requested_expected_post_manifest_identity,
    requested_expected_post_catalog_digest,requested_source_legacy_ambiguity,
    requested_eligibility_cutoff,requested_permit_epoch,requested_permit_nonce)
  ON CONFLICT (rollout_id) DO NOTHING;
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO STRICT existing FROM reviewrouter_activation.migration_permit
  WHERE rollout_id=requested_rollout_id FOR UPDATE;
  IF existing.source_system_identifier=requested_source_system_identifier
     AND existing.target_system_identifier=requested_target_system_identifier
     AND existing.target_database_identity=observed_database_identity
     AND existing.target_database_name=current_database()
     AND existing.target_recovery_witness_sha256=requested_target_recovery_witness_sha256
     AND existing.transition_sha256=requested_transition_sha256
     AND existing.previous_receipt_sha256=requested_previous_receipt_sha256
     AND existing.expected_post_manifest_identity=requested_expected_post_manifest_identity
     AND existing.expected_post_catalog_digest=requested_expected_post_catalog_digest
     AND existing.source_legacy_ambiguity=requested_source_legacy_ambiguity
     AND existing.eligibility_cutoff=requested_eligibility_cutoff
     AND existing.permit_epoch=requested_permit_epoch
     AND existing.permit_nonce=requested_permit_nonce
     AND existing.state IN ('installed','consumed','completed') THEN RETURN false; END IF;
  RAISE EXCEPTION 'release migration target permit binding conflict';
END
$install_migration_permit$;
ALTER FUNCTION reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text) TO ${activationPermitInstallerRoleName};

DROP FUNCTION IF EXISTS reviewrouter_activation.consume_migration_permit(text,text,text,text,text,bigint,text);
DROP FUNCTION IF EXISTS reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text);
CREATE OR REPLACE FUNCTION reviewrouter_activation.consume_migration_permit(
  requested_rollout_id text, requested_target_system_identifier text,
  requested_target_recovery_witness_sha256 text,
  requested_transition_sha256 text, requested_previous_receipt_sha256 text,
  requested_source_legacy_ambiguity jsonb,
  requested_eligibility_cutoff timestamptz,
  requested_permit_epoch bigint, requested_permit_nonce text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $consume_migration_permit$
DECLARE current_permit reviewrouter_activation.migration_permit%ROWTYPE;
DECLARE database_comment text;
DECLARE observed_witness text;
DECLARE observed_system_identifier text;
DECLARE observed_database_identity text;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'release migration target permit caller invalid'; END IF;
  SELECT system_identifier::text INTO STRICT observed_system_identifier
  FROM pg_catalog.pg_control_system();
  SELECT oid::text,pg_catalog.shobj_description(oid,'pg_database')
  INTO STRICT observed_database_identity,database_comment
  FROM pg_catalog.pg_database WHERE datname=current_database();
  observed_witness := CASE
    WHEN pg_catalog.pg_input_is_valid(database_comment,'jsonb')
    THEN database_comment::jsonb->>'recoveryWitnessSha256' ELSE NULL END;
  SELECT * INTO STRICT current_permit FROM reviewrouter_activation.migration_permit
  WHERE rollout_id=requested_rollout_id FOR UPDATE;
  IF current_permit.target_system_identifier IS DISTINCT FROM requested_target_system_identifier
     OR current_permit.target_system_identifier IS DISTINCT FROM observed_system_identifier
     OR current_permit.target_database_identity IS DISTINCT FROM observed_database_identity
     OR current_permit.target_database_name IS DISTINCT FROM current_database()
     OR current_permit.target_recovery_witness_sha256 IS DISTINCT FROM requested_target_recovery_witness_sha256
     OR current_permit.target_recovery_witness_sha256 IS DISTINCT FROM observed_witness
     OR current_permit.transition_sha256 IS DISTINCT FROM requested_transition_sha256
     OR current_permit.previous_receipt_sha256 IS DISTINCT FROM requested_previous_receipt_sha256
     OR current_permit.source_legacy_ambiguity IS DISTINCT FROM requested_source_legacy_ambiguity
     OR current_permit.eligibility_cutoff IS DISTINCT FROM requested_eligibility_cutoff
     OR current_permit.permit_epoch IS DISTINCT FROM requested_permit_epoch
     OR current_permit.permit_nonce IS DISTINCT FROM requested_permit_nonce THEN
    RAISE EXCEPTION 'release migration target permit binding conflict'; END IF;
  IF current_permit.state='completed' THEN RETURN 'replay'; END IF;
  IF current_permit.state IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION 'release migration target permit unavailable'; END IF;
  UPDATE reviewrouter_activation.migration_permit SET state='consumed',
    consumed_at=transaction_timestamp(),target_receipt=jsonb_build_object(
      'schemaVersion',1,'rolloutId',rollout_id,
      'sourceSystemIdentifier',source_system_identifier,
      'targetSystemIdentifier',target_system_identifier,
      'targetDatabaseIdentity',target_database_identity,'targetDatabaseName',target_database_name,
      'targetRecoveryWitnessSha256',target_recovery_witness_sha256,
      'transitionSha256',transition_sha256,'previousReceiptSha256',previous_receipt_sha256,
      'sourceLegacyAmbiguity',source_legacy_ambiguity,
      'eligibilityCutoff',to_char(eligibility_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'permitEpoch',permit_epoch,'permitNonce',permit_nonce)
  WHERE rollout_id=requested_rollout_id;
  RETURN 'execute';
END
$consume_migration_permit$;
ALTER FUNCTION reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text) TO ${releaseSchemaOwnerRoleName};

CREATE OR REPLACE FUNCTION reviewrouter_activation.complete_migration_permit(
  requested_rollout_id text, requested_permit_epoch bigint,
  requested_permit_nonce text, requested_effect_receipt jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $complete_migration_permit$
-- The caller supplies no effect claims. The database owns the receipt.
DECLARE requested_effect_metadata CONSTANT jsonb := requested_effect_receipt;
DECLARE current_permit reviewrouter_activation.migration_permit%ROWTYPE;
DECLARE completed_receipt jsonb;
DECLARE observed_manifest_identity text;
DECLARE observed_catalog_digest text;
BEGIN
  IF session_user <> 'reviewrouter_release_migration'
     OR requested_effect_metadata IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'release migration target completion invalid'; END IF;
  SELECT * INTO STRICT current_permit FROM reviewrouter_activation.migration_permit
  WHERE rollout_id=requested_rollout_id FOR UPDATE;
  IF current_permit.permit_epoch IS DISTINCT FROM requested_permit_epoch
     OR current_permit.permit_nonce IS DISTINCT FROM requested_permit_nonce THEN
    RAISE EXCEPTION 'release migration target completion binding conflict'; END IF;
  SELECT 'sha256:'||encode(pg_catalog.sha256(convert_to(coalesce(string_agg(
    migration_name||':'||checksum,',' ORDER BY migration_name),''),'UTF8')),'hex')
  INTO STRICT observed_manifest_identity FROM public._prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  SELECT digest INTO STRICT observed_catalog_digest
  FROM (${fencedLiveV70V73CatalogDigestSql}) live(digest);
  IF observed_manifest_identity IS DISTINCT FROM
       current_permit.expected_post_manifest_identity THEN
    RAISE EXCEPTION
      'release migration target live completion mismatch:manifest_identity_observed';
  END IF;
  IF observed_catalog_digest IS DISTINCT FROM
       current_permit.expected_post_catalog_digest THEN
    RAISE EXCEPTION
      'release migration target live completion mismatch:catalog_digest_observed'
      USING DETAIL=pg_catalog.format(
        'expected=%s observed=%s',
        current_permit.expected_post_catalog_digest,observed_catalog_digest);
  END IF;
  IF EXISTS (SELECT 1 FROM public._prisma_migrations
       WHERE finished_at IS NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION
      'release migration target live completion mismatch:unfinished_migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public."CodexOAuthLease"
       WHERE "status" IN ('preleased','finalized')) THEN
    RAISE EXCEPTION
      'release migration target live completion mismatch:active_lease';
  END IF;
  IF EXISTS (SELECT 1 FROM public."CodexOAuthSetupManifest"
       WHERE "status"='fetched') THEN
    RAISE EXCEPTION
      'release migration target live completion mismatch:fetched_setup_manifest';
  END IF;
  IF EXISTS (SELECT 1 FROM public."CodexOAuthWritebackIntent"
       WHERE "status" IN ('pending','remote_outcome_unknown')) THEN
    RAISE EXCEPTION
      'release migration target live completion mismatch:unresolved_writeback_intent';
  END IF;
  completed_receipt := current_permit.target_receipt ||
    jsonb_build_object(
      'legacyReconciliation',jsonb_build_object(
        'version',1,
        'acknowledgement','all_prior_installers_and_writers_are_stopped',
        'inventory',jsonb_build_object(
          'activeLeaseIds',current_permit.source_legacy_ambiguity->'activeLeaseIds',
          'fetchedSetupIds',current_permit.source_legacy_ambiguity->'fetchedSetupIds',
          'pendingIntentIds',current_permit.source_legacy_ambiguity->'pendingIntentIds',
          'intentStatuses',current_permit.source_legacy_ambiguity->'intentStatuses'),
        'inventorySha256',current_permit.source_legacy_ambiguity->>'inventorySha256',
        'stableSamples',2,
        'after',jsonb_build_object(
          'activeLeaseIds','[]'::jsonb,'fetchedSetupIds','[]'::jsonb,
          'pendingIntentIds','[]'::jsonb,
          'intentStatuses',coalesce((SELECT jsonb_agg(DISTINCT "status" ORDER BY "status")
            FROM public."CodexOAuthWritebackIntent"),'[]'::jsonb)),
        'status','reconciled'),
      'effectFingerprint','sha256:'||encode(pg_catalog.sha256(convert_to(
        current_permit.rollout_id||':'||current_permit.transition_sha256||':'||
        current_permit.permit_epoch::text||':'||current_permit.permit_nonce||':'||
        (current_permit.source_legacy_ambiguity->>'inventorySha256')||':'||
        to_char(current_permit.eligibility_cutoff AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||':'||observed_manifest_identity||':'||
        observed_catalog_digest,'UTF8')),'hex'),
      'postManifestIdentity',observed_manifest_identity,
      'postCatalogDigest',observed_catalog_digest,
      'completedAt',to_char(transaction_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF current_permit.state='completed' THEN
    RETURN current_permit.target_receipt;
  END IF;
  IF current_permit.state IS DISTINCT FROM 'consumed' THEN
    RAISE EXCEPTION 'release migration target completion state conflict'; END IF;
  UPDATE reviewrouter_activation.migration_permit SET state='completed',
    target_receipt=completed_receipt,terminalized_at=transaction_timestamp()
  WHERE rollout_id=requested_rollout_id;
  RETURN completed_receipt;
END
$complete_migration_permit$;
ALTER FUNCTION reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb) TO ${releaseSchemaOwnerRoleName};

CREATE OR REPLACE FUNCTION reviewrouter_activation.terminalize_migration_permit(
  requested_rollout_id text, requested_permit_epoch bigint,
  requested_permit_nonce text, requested_outcome text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $terminalize_migration_permit$
DECLARE current_permit reviewrouter_activation.migration_permit%ROWTYPE;
BEGIN
  IF session_user <> '${activationPermitInstallerRoleName}'
     OR requested_outcome NOT IN ('completed','quarantined') THEN
    RAISE EXCEPTION 'release migration target terminalization invalid'; END IF;
  SELECT * INTO STRICT current_permit FROM reviewrouter_activation.migration_permit
  WHERE rollout_id=requested_rollout_id FOR UPDATE;
  IF current_permit.permit_epoch IS DISTINCT FROM requested_permit_epoch
     OR current_permit.permit_nonce IS DISTINCT FROM requested_permit_nonce THEN
    RAISE EXCEPTION 'release migration target terminalization binding conflict'; END IF;
  IF requested_outcome='completed' THEN
    IF current_permit.state IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'release migration target completion missing'; END IF;
    RETURN false;
  END IF;
  IF current_permit.state='quarantined' THEN RETURN false; END IF;
  IF current_permit.state IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION 'release migration target quarantine conflict'; END IF;
  UPDATE reviewrouter_activation.migration_permit SET state='quarantined',
    terminalized_at=transaction_timestamp() WHERE rollout_id=requested_rollout_id;
  RETURN true;
END
$terminalize_migration_permit$;
ALTER FUNCTION reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text) TO ${activationPermitInstallerRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.read_migration_receipt(
  requested_rollout_id text, requested_permit_epoch bigint,
  requested_permit_nonce text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $read_migration_receipt$
DECLARE current_permit reviewrouter_activation.migration_permit%ROWTYPE;
BEGIN
  IF session_user NOT IN ('reviewrouter_release_migration',
      '${activationReceiptReaderRoleName}') THEN
    RAISE EXCEPTION 'release migration target receipt caller invalid'; END IF;
  SELECT * INTO STRICT current_permit FROM reviewrouter_activation.migration_permit
  WHERE rollout_id=requested_rollout_id;
  IF current_permit.state IS DISTINCT FROM 'completed'
     OR current_permit.permit_epoch IS DISTINCT FROM requested_permit_epoch
     OR current_permit.permit_nonce IS DISTINCT FROM requested_permit_nonce THEN
    RAISE EXCEPTION 'release migration target receipt unavailable'; END IF;
  RETURN current_permit.target_receipt;
END
$read_migration_receipt$;
ALTER FUNCTION reviewrouter_activation.read_migration_receipt(text,bigint,text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.read_migration_receipt(text,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_migration_receipt(text,bigint,text)
  TO reviewrouter_release_migration, ${activationReceiptReaderRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.project_effective_principal_authority(
  requested_phase text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $project_effective_principal_authority$
DECLARE projected_inventory jsonb;
DECLARE projected_policy jsonb;
DECLARE projected_catalog_policy jsonb;
DECLARE policy_violations jsonb;
DECLARE allowed_principal_contract jsonb;
DECLARE role_capability_matrix_contract jsonb;
BEGIN
  IF requested_phase NOT IN ('preactivation','activated') THEN
    RAISE EXCEPTION 'activation principal projection phase invalid';
  END IF;
  SELECT inventory::jsonb INTO STRICT projected_inventory FROM (
${effectivePrincipalInventorySql}
  ) canonical_projection(inventory);
  SELECT jsonb_agg(name ORDER BY name COLLATE "C") INTO STRICT allowed_principal_contract FROM (
    SELECT DISTINCT unnest(ARRAY[
      'reviewrouter_api','reviewrouter_web','reviewrouter_worker',
      'reviewrouter_codex_effect_authority','reviewrouter_release_migration',
      '${canonicalBootstrapRoleName}','${activationReceiptGuardRoleName}',
      '${activationPermitInstallerRoleName}','${activationReceiptReaderRoleName}',
      '${releaseSchemaOwnerRoleName}'
    ]) AS name
  ) allowed;
  role_capability_matrix_contract :=
    ${quoted(JSON.stringify(activationPrincipalRoleCapabilityMatrix))}::jsonb;
  WITH
  role_facts AS (
    SELECT role->>'name' AS name,
      (role->>'canLogin')::boolean AS can_login
    FROM jsonb_array_elements(projected_inventory->'roles') role
  ), allowed_principals(name) AS (
    SELECT jsonb_array_elements_text(allowed_principal_contract)
  ), permitted_reachability(login_name, role_name, allow_usage, allow_set) AS (
    SELECT capability->>'login', capability->>'role',
      (capability->>'usage')::boolean, (capability->>'set')::boolean
    FROM jsonb_array_elements(role_capability_matrix_contract) capability
  ), reachable(login_name, role_name, via_usage, via_set) AS (
    SELECT reachability->>'principal', reachability->>'role',
      (reachability->>'usage')::boolean, (reachability->>'set')::boolean
    FROM jsonb_array_elements(projected_inventory->'roleReachability') reachability
    WHERE (reachability->>'usage')::boolean OR (reachability->>'set')::boolean
  ), violations(code, principal, capability, resource) AS (
    SELECT 'database_owner_contract_mismatch',
      pg_get_userbyid((SELECT datdba FROM pg_database
        WHERE datname=current_database())),
      'owner:database', 'database:'||current_database()
    WHERE pg_get_userbyid((SELECT datdba FROM pg_database
      WHERE datname=current_database())) <> '${canonicalBootstrapRoleName}'
    UNION ALL
    SELECT 'unexpected_login', role_facts.name, NULL::text, NULL::text
    FROM role_facts
    WHERE role_facts.can_login
      AND NOT EXISTS (SELECT 1 FROM allowed_principals WHERE name=role_facts.name)
    UNION ALL
    SELECT 'principal_login_contract_mismatch', role_facts.name,
      NULL::text, NULL::text
    FROM role_facts
    WHERE role_facts.can_login IS DISTINCT FROM (role_facts.name IN (
        'reviewrouter_api','reviewrouter_web','reviewrouter_worker',
        'reviewrouter_codex_effect_authority','reviewrouter_release_migration',
        '${canonicalBootstrapRoleName}',
        '${activationPermitInstallerRoleName}','${activationReceiptReaderRoleName}'))
      AND EXISTS (SELECT 1 FROM allowed_principals WHERE name=role_facts.name)
    UNION ALL
    SELECT CASE capability.kind
        WHEN 'usage' THEN 'unexpected_role_usage'
        ELSE 'unexpected_role_set' END,
      reachable.login_name, 'admin:role-membership',
      'role:'||reachable.role_name
    FROM reachable
    CROSS JOIN LATERAL (VALUES
      ('usage',reachable.via_usage),('set',reachable.via_set)
    ) capability(kind,enabled)
    LEFT JOIN permitted_reachability permitted
      ON permitted.login_name=reachable.login_name
     AND permitted.role_name=reachable.role_name
    -- Bootstrap reachability is administrative and can be universal for a
    -- provider superuser. Its complete facts are still exact in catalogPolicy.
    WHERE capability.enabled
      AND reachable.login_name <> '${canonicalBootstrapRoleName}'
      AND NOT coalesce(
      CASE capability.kind WHEN 'usage' THEN permitted.allow_usage
        ELSE permitted.allow_set END, false)
    UNION ALL
    SELECT CASE capability.kind
        WHEN 'usage' THEN 'missing_role_usage'
        ELSE 'missing_role_set' END,
      permitted.login_name, 'admin:role-membership',
      'role:'||permitted.role_name
    FROM permitted_reachability permitted
    CROSS JOIN LATERAL (VALUES
      ('usage',permitted.allow_usage),('set',permitted.allow_set)
    ) capability(kind,required)
    LEFT JOIN reachable
      ON reachable.login_name=permitted.login_name
     AND reachable.role_name=permitted.role_name
    WHERE capability.required AND NOT coalesce(
      CASE capability.kind WHEN 'usage' THEN reachable.via_usage
        ELSE reachable.via_set END, false)
    UNION ALL
    SELECT CASE capability.kind WHEN 'inherit'
        THEN 'unexpected_inherited_permission'
        ELSE 'unexpected_set_permission' END,
      membership_record->>'member', 'admin:role-membership',
      'role:'||(membership_record->>'role')
    FROM jsonb_array_elements(projected_inventory->'memberships') membership_record
    CROSS JOIN LATERAL (VALUES
      ('inherit',(membership_record->>'inheritOption')::boolean),
      ('set',(membership_record->>'setOption')::boolean)
    ) capability(kind,enabled)
    WHERE capability.enabled
      AND (EXISTS (SELECT 1 FROM allowed_principals
             WHERE name=membership_record->>'member')
        OR EXISTS (SELECT 1 FROM allowed_principals
             WHERE name=membership_record->>'role'))
    UNION ALL
    SELECT 'unexpected_effective_permission', reachable.login_name,
      grant_record->>'capability', grant_record->>'resource'
    FROM reachable
    JOIN jsonb_array_elements(projected_inventory->'grants') grant_record
      ON grant_record->>'principal'=reachable.role_name
    LEFT JOIN permitted_reachability permitted
      ON permitted.login_name=reachable.login_name
     AND permitted.role_name=reachable.role_name
    WHERE reachable.login_name <> '${canonicalBootstrapRoleName}'
      AND reachable.via_usage AND NOT coalesce(permitted.allow_usage,false)
    UNION ALL
    SELECT 'unexpected_public_permission', 'PUBLIC', grant_record->>'capability',
      grant_record->>'resource'
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'principal'='PUBLIC'
      AND grant_record->>'capability' NOT IN ('schema:usage','type:usage')
    UNION ALL
    -- This gate intentionally precedes relevance normalization. The inventory
    -- grant union contains direct/default ACLs plus ownership and role
    -- attributes, so no noncanonical grantee can disappear from catalogPolicy.
    SELECT 'unexpected_grant_principal', grant_record->>'principal',
      grant_record->>'capability', grant_record->>'resource'
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'principal' IS DISTINCT FROM 'PUBLIC'
      AND NOT EXISTS (SELECT 1 FROM allowed_principals
        WHERE name=grant_record->>'principal')
    UNION ALL
    SELECT 'unexpected_ownership', grant_record->>'principal',
      grant_record->>'capability', grant_record->>'resource'
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'source'='ownership'
      AND NOT EXISTS (SELECT 1 FROM allowed_principals
        WHERE name=grant_record->>'principal')
    UNION ALL
    SELECT 'unexpected_administrative_capability', grant_record->>'principal',
      grant_record->>'capability', grant_record->>'resource'
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'capability' LIKE 'admin:%'
      AND grant_record->>'principal' <> '${canonicalBootstrapRoleName}'
    UNION ALL
    SELECT 'unexpected_external_grantor', grant_record->>'grantor',
      grant_record->>'capability', grant_record->>'resource'
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'grantor' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM allowed_principals
        WHERE name=grant_record->>'grantor')
      AND NOT (
        grant_record->>'principal'='${canonicalBootstrapRoleName}'
        AND grant_record->>'capability'='admin:role-membership'
        AND grant_record->>'source'='attribute'
        AND (grant_record->>'grantable')::boolean
        AND substring(grant_record->>'resource' FROM 6)
          = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(projected_inventory->'memberships') edge
          WHERE edge->>'member'=grant_record->>'principal'
            AND edge->>'role'=substring(grant_record->>'resource' FROM 6)
            AND edge->>'grantor'=grant_record->>'grantor'
            AND (edge->>'adminOption')::boolean
            AND NOT (edge->>'inheritOption')::boolean
            AND NOT (edge->>'setOption')::boolean)
        AND (SELECT count(DISTINCT edge->>'grantor')
          FROM jsonb_array_elements(projected_inventory->'memberships') edge
          WHERE edge->>'member'='${canonicalBootstrapRoleName}'
            AND edge->>'role' = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}]))=1
      )
    UNION ALL
    SELECT 'unexpected_row_security_principal', policy_role,
      NULL::text, relation_record->>'relation'
    FROM jsonb_array_elements(projected_inventory->'rowSecurity') relation_record
    CROSS JOIN LATERAL jsonb_array_elements(relation_record->'policies') policy_record
    CROSS JOIN LATERAL jsonb_array_elements_text(policy_record->'roles') policy_role
    WHERE policy_role <> 'PUBLIC'
      AND NOT EXISTS (SELECT 1 FROM allowed_principals WHERE name=policy_role)
    UNION ALL
    SELECT 'unsupported_catalog_authority', 'catalog', NULL::text, family
    FROM jsonb_array_elements_text(
      projected_inventory->'unsupportedAuthorityFamilies') family
    UNION ALL
    SELECT 'unsupported_acl_privilege', grant_record->>'principal',
      grant_record->>'capability', grant_record->>'resource'
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'capability' LIKE 'unsupported:%'
    UNION ALL
    SELECT 'unexpected_extension_owner', extension_record->>'owner',
      'owner:extension', 'extension:'||(extension_record->>'name')
    FROM jsonb_array_elements(projected_inventory->'extensions') extension_record
    WHERE NOT EXISTS (SELECT 1 FROM allowed_principals
      WHERE name=extension_record->>'owner')
      AND extension_record->>'owner' IS DISTINCT FROM (
        SELECT min(edge->>'grantor' COLLATE "C")
        FROM jsonb_array_elements(projected_inventory->'memberships') edge
        WHERE edge->>'member'='${canonicalBootstrapRoleName}'
          AND edge->>'role' = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
        HAVING count(DISTINCT edge->>'grantor')=1)
    UNION ALL
    SELECT 'bootstrap_membership_topology_mismatch',
      '${canonicalBootstrapRoleName}', 'admin:role-membership', 'role:'||expected.role_name
    FROM unnest(ARRAY[${canonicalRoleNames.map(quoted).join(",")}]) expected(role_name)
    WHERE (SELECT count(*)
      FROM jsonb_array_elements(projected_inventory->'memberships') edge
      WHERE edge->>'member'='${canonicalBootstrapRoleName}'
        AND edge->>'role'=expected.role_name
        AND (edge->>'adminOption')::boolean
        AND NOT (edge->>'inheritOption')::boolean
        AND NOT (edge->>'setOption')::boolean) <> 1
    UNION ALL
    SELECT 'unexpected_relevant_membership', edge->>'member',
      'admin:role-membership', 'role:'||(edge->>'role')
    FROM jsonb_array_elements(projected_inventory->'memberships') edge
    WHERE (edge->>'member' = ANY (ARRAY[${activationPrincipalRoleNames.map(quoted).join(",")}])
        OR edge->>'role' = ANY (ARRAY[${activationPrincipalRoleNames.map(quoted).join(",")}]))
      AND NOT (
        edge->>'member'='${canonicalBootstrapRoleName}'
        AND edge->>'role' = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
        AND (edge->>'adminOption')::boolean
        AND NOT (edge->>'inheritOption')::boolean
        AND NOT (edge->>'setOption')::boolean)
    UNION ALL
    SELECT 'bootstrap_membership_grantor_mismatch',
      '${canonicalBootstrapRoleName}', 'admin:role-membership', 'external-bootstrap-authority'
    WHERE (SELECT count(DISTINCT edge->>'grantor')
      FROM jsonb_array_elements(projected_inventory->'memberships') edge
      WHERE edge->>'member'='${canonicalBootstrapRoleName}'
        AND edge->>'role' = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])) <> 1
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(projected_inventory->'memberships') edge
         WHERE edge->>'member'='${canonicalBootstrapRoleName}'
           AND edge->>'role' = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
           AND edge->>'grantor' = ANY (ARRAY[${activationPrincipalRoleNames.map(quoted).join(",")}]))
    UNION ALL
    SELECT 'bootstrap_membership_grantor_not_inert', grantor_name,
      'admin:role-membership', 'external-bootstrap-authority'
    FROM (SELECT min(edge->>'grantor' COLLATE "C") AS grantor_name
      FROM jsonb_array_elements(projected_inventory->'memberships') edge
      WHERE edge->>'member'='${canonicalBootstrapRoleName}'
        AND edge->>'role' = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])) external_grantor
    WHERE grantor_name IS NOT NULL AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(projected_inventory->'roles') role
        WHERE role->>'name'=grantor_name AND (
          (role->>'canLogin')::boolean OR (role->>'superuser')::boolean
          OR (role->>'bypassRls')::boolean OR (role->>'replication')::boolean
          OR (role->>'createDatabase')::boolean OR (role->>'createRole')::boolean))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(projected_inventory->'memberships') edge
        WHERE edge->>'member'=grantor_name OR edge->>'role'=grantor_name)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(projected_inventory->'grants') grant_record
        WHERE grant_record->>'principal'=grantor_name
          OR (grant_record->>'grantor'=grantor_name AND NOT (
            grant_record->>'principal'='${canonicalBootstrapRoleName}'
            AND grant_record->>'capability'='admin:role-membership'
            AND substring(grant_record->>'resource' FROM 6) = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}]))))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(projected_inventory->'rowSecurity') relation_record
        WHERE relation_record->>'owner'=grantor_name OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(relation_record->'policies') policy_record,
            LATERAL jsonb_array_elements_text(policy_record->'roles') policy_role
          WHERE policy_role=grantor_name)))
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'kind',code,'principal',principal,'capability',capability,'resource',resource
  )) ORDER BY code COLLATE "C",principal COLLATE "C",
    capability COLLATE "C",resource COLLATE "C"),'[]'::jsonb)
  INTO policy_violations FROM (SELECT DISTINCT * FROM violations) unique_violations;
  SELECT jsonb_build_object(
    'kind','reviewrouter-effective-principal-policy',
    'version',2,
    'phase',requested_phase,
    'allowedPrincipals',allowed_principal_contract,
    'roleCapabilityMatrix',role_capability_matrix_contract,
    'publicPermissionKinds',jsonb_build_array('schema:usage','type:usage'),
    'rowSecurity',projected_inventory->'rowSecurity',
    'violations',policy_violations
  ) INTO projected_policy;
  IF jsonb_array_length(policy_violations) <> 0 THEN
    RETURN jsonb_build_object(
      'kind','reviewrouter-effective-principal-projection',
      'version',2,
      'inventory',projected_inventory,
      'policy',projected_policy,
      'catalogPolicy',NULL
    );
  END IF;
  WITH RECURSIVE canonical_principals(name) AS (
    SELECT unnest(ARRAY[${activationPrincipalRoleNames.map(quoted).join(",")}])
  ), role_facts AS (
    SELECT role, role->>'name' AS name
    FROM jsonb_array_elements(projected_inventory->'roles') role
  ), membership_facts AS (
    SELECT edge, edge->>'member' AS member, edge->>'role' AS role,
      edge->>'grantor' AS grantor
    FROM jsonb_array_elements(projected_inventory->'memberships') edge
  ), grant_facts AS (
    SELECT grant_record, grant_record->>'principal' AS principal,
      grant_record->>'grantor' AS grantor
    FROM jsonb_array_elements(projected_inventory->'grants') grant_record
  ), bootstrap_authority(name) AS (
    SELECT min(grantor COLLATE "C")
    FROM membership_facts
    WHERE member='${canonicalBootstrapRoleName}'
      AND role = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
  ), relevance_seed(name) AS (
    SELECT name FROM canonical_principals
    UNION
    SELECT name FROM role_facts WHERE (role->>'canLogin')::boolean
      OR (role->>'superuser')::boolean OR (role->>'bypassRls')::boolean
      OR (role->>'replication')::boolean OR (role->>'createDatabase')::boolean
      OR (role->>'createRole')::boolean
    UNION
    SELECT relation_record->>'owner'
    FROM jsonb_array_elements(projected_inventory->'rowSecurity') relation_record
    UNION
    SELECT policy_role
    FROM jsonb_array_elements(projected_inventory->'rowSecurity') relation_record,
      LATERAL jsonb_array_elements(relation_record->'policies') policy_record,
      LATERAL jsonb_array_elements_text(policy_record->'roles') policy_role
    WHERE policy_role <> 'PUBLIC'
    UNION
    SELECT extension_record->>'owner'
    FROM jsonb_array_elements(projected_inventory->'extensions') extension_record
    WHERE extension_record->>'owner' IS DISTINCT FROM
      (SELECT name FROM bootstrap_authority)
  ), relevant(name) AS (
    SELECT name FROM relevance_seed WHERE name IS NOT NULL
    UNION
    SELECT CASE WHEN membership.member=relevant.name
      THEN membership.role ELSE membership.member END
    FROM relevant JOIN membership_facts membership
      ON membership.member=relevant.name OR membership.role=relevant.name
  ), normalized_roles AS (
    SELECT role FROM role_facts WHERE name IN (SELECT name FROM relevant)
  ), normalized_memberships AS (
    SELECT jsonb_build_object(
      'member',member,'role',role,
      'setOption',(edge->>'setOption')::boolean,
      'inheritOption',(edge->>'inheritOption')::boolean,
      'adminOption',(edge->>'adminOption')::boolean,
      'grantor',CASE WHEN member='${canonicalBootstrapRoleName}'
          AND role = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
          AND (edge->>'adminOption')::boolean
          AND NOT (edge->>'inheritOption')::boolean
          AND NOT (edge->>'setOption')::boolean
        THEN jsonb_build_object('kind','external-bootstrap-authority')
        ELSE jsonb_build_object('kind','principal','name',grantor) END) AS edge
    FROM membership_facts
    WHERE member IN (SELECT name FROM relevant)
       OR role IN (SELECT name FROM relevant)
  ), normalized_grants AS (
    -- Memberships are the authoritative exact edge inventory. The matching
    -- admin-capability row is a derived duplicate. Other admin facts remain.
    SELECT CASE
      WHEN grantor=(SELECT name FROM bootstrap_authority)
        THEN jsonb_set(
          grant_record,'{grantor}',to_jsonb('external-bootstrap-authority'::text)
        )
      ELSE grant_record END AS grant_record
    FROM grant_facts
    WHERE NOT (principal='${canonicalBootstrapRoleName}'
        AND grant_record->>'capability'='admin:role-membership'
        AND EXISTS (
          SELECT 1 FROM membership_facts membership
          WHERE membership.member=principal
            AND membership.role=substring(grant_record->>'resource' FROM 6)
            AND membership.grantor=grantor
            AND (membership.edge->>'adminOption')::boolean
            AND NOT (membership.edge->>'inheritOption')::boolean
            AND NOT (membership.edge->>'setOption')::boolean
        )
        AND substring(grant_record->>'resource' FROM 6) = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}]))
      AND (principal='PUBLIC' OR principal IN (SELECT name FROM relevant))
  ), normalized_reachability AS (
    SELECT reachability
    FROM jsonb_array_elements(projected_inventory->'roleReachability') reachability
    WHERE reachability->>'principal' IN (SELECT name FROM relevant)
      AND reachability->>'role' IN (SELECT name FROM relevant)
  ), normalized_extensions AS (
    SELECT jsonb_build_object(
      'name',extension_record->>'name',
      'owner',CASE WHEN extension_record->>'owner'=(SELECT name FROM bootstrap_authority)
        THEN jsonb_build_object('kind','external-provider-authority')
        ELSE jsonb_build_object('kind','principal','name',extension_record->>'owner') END
    ) AS extension_record
    FROM jsonb_array_elements(projected_inventory->'extensions') extension_record
  ), role_names AS (
    SELECT name AS principal FROM relevant
    WHERE name IN (SELECT name FROM role_facts)
  ), effective AS (
    SELECT role_names.principal, grant_record->>'capability' AS capability,
      grant_record->>'resource' AS resource
    FROM role_names
    CROSS JOIN LATERAL jsonb_array_elements(projected_inventory->'grants') grant_record
    WHERE grant_record->>'principal' IN ('PUBLIC',role_names.principal)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(projected_inventory->'roleReachability') reachability
         WHERE reachability->>'principal'=role_names.principal
           AND reachability->>'role'=grant_record->>'principal'
           AND ((reachability->>'usage')::boolean OR (reachability->>'set')::boolean)
       )
  ), effective_unique AS (
    SELECT DISTINCT principal,capability,resource FROM effective
  ), effective_contract AS (
    SELECT role_names.principal, coalesce(jsonb_agg(jsonb_build_object(
      'capability',effective_unique.capability,'resource',effective_unique.resource)
      ORDER BY effective_unique.capability COLLATE "C",effective_unique.resource COLLATE "C")
      FILTER (WHERE effective_unique.capability IS NOT NULL),
      '[]'::jsonb) AS permissions
    FROM role_names LEFT JOIN effective_unique USING (principal)
    GROUP BY role_names.principal
  )
  SELECT jsonb_build_object(
    'kind','reviewrouter-activation-catalog-policy','version',1,
    'phase',requested_phase,'database',projected_inventory->'database',
    'roles',(SELECT coalesce(jsonb_agg(role ORDER BY role->>'name' COLLATE "C"),'[]'::jsonb)
      FROM normalized_roles),
    'memberships',(SELECT coalesce(jsonb_agg(edge ORDER BY edge->>'member' COLLATE "C",
      edge->>'role' COLLATE "C",(edge->>'setOption')::boolean,
      (edge->>'inheritOption')::boolean,(edge->>'adminOption')::boolean,
      reviewrouter_activation.canonical_json(edge->'grantor') COLLATE "C"),
      '[]'::jsonb) FROM normalized_memberships),
    'roleReachability',(SELECT coalesce(jsonb_agg(reachability
      ORDER BY reachability->>'principal' COLLATE "C",reachability->>'role' COLLATE "C"),
      '[]'::jsonb) FROM normalized_reachability),
    'rowSecurity',projected_inventory->'rowSecurity',
    'extensions',(SELECT coalesce(jsonb_agg(extension_record ORDER BY
      extension_record->>'name' COLLATE "C",
      reviewrouter_activation.canonical_json(extension_record->'owner') COLLATE "C"),
      '[]'::jsonb) FROM normalized_extensions),
    'grants',(SELECT coalesce(jsonb_agg(grant_record ORDER BY
      grant_record->>'principal' COLLATE "C",grant_record->>'capability' COLLATE "C",
      grant_record->>'resource' COLLATE "C",grant_record->>'source' COLLATE "C",
      (grant_record->>'grantable')::boolean,grant_record->>'grantor' COLLATE "C"),
      '[]'::jsonb) FROM normalized_grants),
    'effectivePermissions',(SELECT jsonb_agg(jsonb_build_object(
      'principal',principal,'permissions',permissions) ORDER BY principal COLLATE "C")
      FROM effective_contract)
  ) INTO projected_catalog_policy;
  RETURN jsonb_build_object(
    'kind','reviewrouter-effective-principal-projection',
    'version',2,
    'inventory',projected_inventory,
    'policy',projected_policy,
    'catalogPolicy',projected_catalog_policy
  );
END
$project_effective_principal_authority$;
ALTER FUNCTION reviewrouter_activation.project_effective_principal_authority(text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.project_effective_principal_authority(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.project_effective_principal_authority(text) FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName}, ${canonicalBootstrapRoleName}, reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_activation.capture_catalog_policy_candidate(
  requested_phase text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $capture_catalog_policy_candidate$
DECLARE projection jsonb;
DECLARE database_binding jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'activation catalog policy candidate caller invalid';
  END IF;
  SELECT pg_catalog.shobj_description(database.oid,'pg_database')::jsonb
  INTO database_binding
  FROM pg_catalog.pg_database database WHERE database.datname=current_database();
  IF current_setting('reviewrouter.activation_catalog_candidate_capture',true)
       IS DISTINCT FROM 'disposable-only'
     OR current_setting('reviewrouter.activation_catalog_disposable_database_identity',true)
       !~ '^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$'
     OR jsonb_typeof(database_binding) IS DISTINCT FROM 'object'
     OR database_binding->>'systemIdentifier' IS DISTINCT FROM
          (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
     OR database_binding->>'recoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
     OR database_binding->'disposableCaptureAttestation'->>'kind'
          IS DISTINCT FROM 'reviewrouter-disposable-database-attestation-v1'
     OR database_binding->'disposableCaptureAttestation'->>'identity'
          IS DISTINCT FROM current_setting(
            'reviewrouter.activation_catalog_disposable_database_identity',true)
     OR database_binding->'disposableCaptureAttestation'->>'systemIdentifier'
          IS DISTINCT FROM database_binding->>'systemIdentifier'
     OR database_binding->'disposableCaptureAttestation'->>'databaseOid'
          IS DISTINCT FROM (SELECT oid::text FROM pg_catalog.pg_database
            WHERE datname=current_database())
     OR database_binding->'disposableCaptureAttestation'->>'recoveryWitnessSha256'
          IS DISTINCT FROM database_binding->>'recoveryWitnessSha256'
     OR database_binding->'disposableCaptureAttestation'->>'nonce'
          !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'activation catalog policy candidate disposable marker invalid';
  END IF;
  IF current_setting('server_version_num')::integer / 10000 <> 17
     OR current_database() <> 'review_router' THEN
    RAISE EXCEPTION 'activation catalog policy candidate target invalid';
  END IF;
  projection := reviewrouter_activation.project_effective_principal_authority(requested_phase);
  IF projection->'catalogPolicy' IS NULL
     OR projection->'policy'->'violations' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'activation catalog policy candidate safety rejected'
      USING DETAIL = reviewrouter_activation.canonical_json(
        projection->'policy'->'violations'
      );
  END IF;
  RETURN projection->'catalogPolicy';
END
$capture_catalog_policy_candidate$;
ALTER FUNCTION reviewrouter_activation.capture_catalog_policy_candidate(text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.capture_catalog_policy_candidate(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.capture_catalog_policy_candidate(text) FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName}, ${canonicalBootstrapRoleName}, reviewrouter_release_migration;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.capture_catalog_policy_candidate(text)
  TO ${releaseSchemaOwnerRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.capture_catalog_policy_candidate_pair()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $capture_catalog_policy_candidate_pair$
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'activation catalog policy candidate pair caller invalid';
  END IF;
  RETURN reviewrouter_activation.capture_runtime_acl_policy_pair();
END
$capture_catalog_policy_candidate_pair$;
ALTER FUNCTION reviewrouter_activation.capture_catalog_policy_candidate_pair()
  OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.capture_catalog_policy_candidate_pair()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.capture_catalog_policy_candidate_pair()
  FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName},
    ${canonicalBootstrapRoleName}, ${releaseSchemaOwnerRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.capture_catalog_policy_candidate_pair()
  TO reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_activation.validate_principal_evidence(
  requested_rollout_id text, expected_transaction_id bigint
) RETURNS reviewrouter_activation.activation_principal_evidence
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $validate_principal_evidence$
DECLARE evidence reviewrouter_activation.activation_principal_evidence%ROWTYPE;
BEGIN
  IF requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
     OR expected_transaction_id < 1 THEN
    RAISE EXCEPTION 'activation principal evidence validation request invalid';
  END IF;
  SELECT * INTO STRICT evidence
  FROM reviewrouter_activation.activation_principal_evidence
  WHERE rollout_id=requested_rollout_id;
  IF evidence.transaction_id <> expected_transaction_id
     OR jsonb_typeof(evidence.before_inventory) IS DISTINCT FROM 'object'
     OR jsonb_typeof(evidence.activated_inventory) IS DISTINCT FROM 'object'
     OR evidence.before_inventory->>'version' IS DISTINCT FROM '1'
     OR evidence.activated_inventory->>'version' IS DISTINCT FROM '1'
     OR evidence.before_inventory->>'database' IS DISTINCT FROM current_database()
     OR evidence.activated_inventory->>'database' IS DISTINCT FROM current_database()
     OR evidence.before_inventory->>'sessionPrincipal' IS DISTINCT FROM
        'reviewrouter_release_migration'
     OR evidence.activated_inventory->>'sessionPrincipal' IS DISTINCT FROM
        'reviewrouter_release_migration'
     OR jsonb_typeof(evidence.before_inventory->'roles') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.before_inventory->'memberships') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.before_inventory->'roleReachability') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.before_inventory->'rowSecurity') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.before_inventory->'extensions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.before_inventory->'unsupportedAuthorityFamilies') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.before_inventory->'grants') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'roles') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'memberships') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'roleReachability') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'rowSecurity') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'extensions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'unsupportedAuthorityFamilies') IS DISTINCT FROM 'array'
     OR jsonb_typeof(evidence.activated_inventory->'grants') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(evidence.before_inventory->'grants') grant_record
       WHERE jsonb_typeof(grant_record->'grantable') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(grant_record->'grantor') IS DISTINCT FROM 'string')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(evidence.activated_inventory->'grants') grant_record
       WHERE jsonb_typeof(grant_record->'grantable') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(grant_record->'grantor') IS DISTINCT FROM 'string')
     OR jsonb_typeof(evidence.before_policy) IS DISTINCT FROM 'object'
     OR jsonb_typeof(evidence.activated_policy) IS DISTINCT FROM 'object'
     OR evidence.before_policy->>'kind' IS DISTINCT FROM
        'reviewrouter-effective-principal-policy'
     OR evidence.activated_policy->>'kind' IS DISTINCT FROM
        'reviewrouter-effective-principal-policy'
     OR evidence.before_policy->>'version' IS DISTINCT FROM '2'
     OR evidence.activated_policy->>'version' IS DISTINCT FROM '2'
     OR evidence.before_policy->>'phase' IS DISTINCT FROM 'preactivation'
     OR evidence.activated_policy->>'phase' IS DISTINCT FROM 'activated'
     OR jsonb_typeof(evidence.before_policy->'allowedPrincipals') IS DISTINCT FROM 'array'
     OR evidence.before_policy->'allowedPrincipals' IS DISTINCT FROM
        evidence.activated_policy->'allowedPrincipals'
     OR jsonb_typeof(evidence.before_policy->'roleCapabilityMatrix') IS DISTINCT FROM 'array'
     OR evidence.before_policy->'roleCapabilityMatrix' IS DISTINCT FROM
        ${quoted(JSON.stringify(activationPrincipalRoleCapabilityMatrix))}::jsonb
     OR evidence.before_policy->'roleCapabilityMatrix' IS DISTINCT FROM
        evidence.activated_policy->'roleCapabilityMatrix'
     OR jsonb_typeof(evidence.before_policy->'publicPermissionKinds') IS DISTINCT FROM 'array'
     OR evidence.before_policy->'publicPermissionKinds' IS DISTINCT FROM
        evidence.activated_policy->'publicPermissionKinds'
     OR evidence.before_policy->'rowSecurity' IS DISTINCT FROM
        evidence.before_inventory->'rowSecurity'
     OR evidence.activated_policy->'rowSecurity' IS DISTINCT FROM
        evidence.activated_inventory->'rowSecurity'
     OR evidence.before_policy->'violations' IS DISTINCT FROM '[]'::jsonb
     OR evidence.activated_policy->'violations' IS DISTINCT FROM '[]'::jsonb
     OR evidence.preactivation_catalog_policy->>'kind' IS DISTINCT FROM 'reviewrouter-activation-catalog-policy'
     OR evidence.activated_catalog_policy->>'kind' IS DISTINCT FROM 'reviewrouter-activation-catalog-policy'
     OR evidence.preactivation_catalog_policy->>'phase' IS DISTINCT FROM 'preactivation'
     OR evidence.activated_catalog_policy->>'phase' IS DISTINCT FROM 'activated'
     OR evidence.preactivation_catalog_policy_sha256 <> 'sha256:' || encode(sha256(convert_to(
          reviewrouter_activation.canonical_json(evidence.preactivation_catalog_policy),'UTF8')),'hex')
     OR evidence.activated_catalog_policy_sha256 <> 'sha256:' || encode(sha256(convert_to(
          reviewrouter_activation.canonical_json(evidence.activated_catalog_policy),'UTF8')),'hex')
     OR evidence.before_principal_inventory_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR evidence.before_principal_policy_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR evidence.activated_principal_inventory_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR evidence.activated_principal_policy_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR evidence.before_principal_inventory_sha256 <> 'sha256:' ||
        encode(sha256(convert_to(reviewrouter_activation.canonical_json(
          evidence.before_inventory),'UTF8')),'hex')
     OR evidence.before_principal_policy_sha256 <> 'sha256:' ||
        encode(sha256(convert_to(reviewrouter_activation.canonical_json(
          evidence.before_policy),'UTF8')),'hex')
     OR evidence.activated_principal_inventory_sha256 <> 'sha256:' ||
        encode(sha256(convert_to(reviewrouter_activation.canonical_json(
          evidence.activated_inventory),'UTF8')),'hex')
     OR evidence.activated_principal_policy_sha256 <> 'sha256:' ||
        encode(sha256(convert_to(reviewrouter_activation.canonical_json(
          evidence.activated_policy),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'activation principal evidence contract invalid';
  END IF;
  RETURN evidence;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'activation principal evidence absent';
END
$validate_principal_evidence$;
ALTER FUNCTION reviewrouter_activation.validate_principal_evidence(text,bigint) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.validate_principal_evidence(text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.validate_principal_evidence(text,bigint) FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName}, ${canonicalBootstrapRoleName}, reviewrouter_release_migration;
DROP FUNCTION IF EXISTS reviewrouter_activation.stage_principal_evidence(text,jsonb,jsonb,jsonb,jsonb,jsonb,text,text,text,text);
CREATE OR REPLACE FUNCTION reviewrouter_activation.stage_principal_evidence(
  requested_rollout_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $stage_principal_evidence$
DECLARE permit reviewrouter_activation.activation_permit%ROWTYPE;
DECLARE live_system_identifier text;
DECLARE live_migration_checksum text;
DECLARE projection jsonb;
DECLARE inventory jsonb;
DECLARE policy jsonb;
DECLARE catalog_policy jsonb;
DECLARE inventory_sha256 text;
DECLARE policy_sha256 text;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'principal evidence caller invalid';
  END IF;
  SELECT * INTO permit FROM reviewrouter_activation.activation_permit
  WHERE rollout_id=requested_rollout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation permit absent'; END IF;
  IF EXISTS (SELECT 1 FROM reviewrouter_activation.activation_permit newer
    WHERE newer.permit_epoch > permit.permit_epoch) THEN
    RAISE EXCEPTION 'activation permit superseded';
  END IF;
  IF EXISTS (SELECT 1 FROM reviewrouter_activation.activation_receipt
    WHERE rollout_id=requested_rollout_id) THEN RETURN false; END IF;
  SELECT system_identifier::text INTO live_system_identifier FROM pg_catalog.pg_control_system();
  SELECT 'sha256:' || encode(pg_catalog.sha256(convert_to(
    coalesce(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''),
    'UTF8')), 'hex') INTO live_migration_checksum
  FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  projection := reviewrouter_activation.project_effective_principal_authority('preactivation');
  inventory := projection->'inventory';
  policy := projection->'policy';
  catalog_policy := projection->'catalogPolicy';
  inventory_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
    reviewrouter_activation.canonical_json(inventory),'UTF8')),'hex');
  policy_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
    reviewrouter_activation.canonical_json(policy),'UTF8')),'hex');
  IF live_system_identifier <> permit.target_system_identifier
     OR live_migration_checksum <> permit.migration_checksum
     OR projection->>'kind' IS DISTINCT FROM 'reviewrouter-effective-principal-projection'
     OR projection->>'version' IS DISTINCT FROM '2'
     OR inventory->>'version' IS DISTINCT FROM '1'
     OR inventory->>'database' IS DISTINCT FROM current_database()
     OR inventory->>'sessionPrincipal' IS DISTINCT FROM session_user
     OR jsonb_typeof(inventory->'roles') IS DISTINCT FROM 'array'
     OR jsonb_typeof(inventory->'memberships') IS DISTINCT FROM 'array'
     OR jsonb_typeof(inventory->'roleReachability') IS DISTINCT FROM 'array'
     OR jsonb_typeof(inventory->'rowSecurity') IS DISTINCT FROM 'array'
     OR jsonb_typeof(inventory->'extensions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(inventory->'unsupportedAuthorityFamilies') IS DISTINCT FROM 'array'
     OR jsonb_typeof(inventory->'grants') IS DISTINCT FROM 'array'
     OR policy->>'kind' IS DISTINCT FROM 'reviewrouter-effective-principal-policy'
     OR policy->>'version' IS DISTINCT FROM '2'
     OR policy->>'phase' IS DISTINCT FROM 'preactivation'
     OR jsonb_typeof(policy->'roleCapabilityMatrix') IS DISTINCT FROM 'array'
     OR policy->'rowSecurity' IS DISTINCT FROM inventory->'rowSecurity'
     OR jsonb_typeof(policy->'violations') IS DISTINCT FROM 'array'
     OR jsonb_array_length(policy->'violations') <> 0 THEN
    RAISE EXCEPTION 'principal evidence invalid or stale';
  END IF;
  IF catalog_policy IS DISTINCT FROM permit.preactivation_catalog_policy
     OR permit.preactivation_catalog_policy_sha256 <> 'sha256:' || encode(pg_catalog.sha256(convert_to(
       reviewrouter_activation.canonical_json(catalog_policy),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'activation catalog policy mismatch'
      USING DETAIL = format('sections=%s expected=%s observed=%s',
        (SELECT string_agg(observed.key,',' ORDER BY observed.key COLLATE "C")
         FROM jsonb_each(catalog_policy) observed
         JOIN jsonb_each(permit.preactivation_catalog_policy) expected USING (key)
         WHERE observed.value IS DISTINCT FROM expected.value),
        permit.preactivation_catalog_policy_sha256,
        'sha256:' || encode(pg_catalog.sha256(convert_to(
          reviewrouter_activation.canonical_json(catalog_policy),'UTF8')),'hex'));
  END IF;
  INSERT INTO reviewrouter_activation.activation_principal_evidence (
    rollout_id,source_system_identifier,target_system_identifier,postgres_major,
    expected_commit_sha,migration_checksum,target_deploy_ids,permit_epoch,permit_nonce,
    preactivation_catalog_policy,preactivation_catalog_policy_sha256,
    activated_catalog_policy,activated_catalog_policy_sha256,
    before_inventory,before_policy,activated_inventory,activated_policy,
    before_principal_inventory_sha256,before_principal_policy_sha256,
    activated_principal_inventory_sha256,activated_principal_policy_sha256,transaction_id
  ) VALUES (
    permit.rollout_id,permit.source_system_identifier,permit.target_system_identifier,
    permit.postgres_major,permit.expected_commit_sha,permit.migration_checksum,
    permit.target_deploy_ids,permit.permit_epoch,permit.permit_nonce,
    permit.preactivation_catalog_policy,permit.preactivation_catalog_policy_sha256,
    permit.activated_catalog_policy,permit.activated_catalog_policy_sha256,
    inventory,policy,inventory,policy,inventory_sha256,policy_sha256,
    inventory_sha256,policy_sha256,txid_current()
  ) ON CONFLICT (rollout_id) DO UPDATE SET
    source_system_identifier=EXCLUDED.source_system_identifier,
    target_system_identifier=EXCLUDED.target_system_identifier,
    postgres_major=EXCLUDED.postgres_major,
    expected_commit_sha=EXCLUDED.expected_commit_sha,
    migration_checksum=EXCLUDED.migration_checksum,
    target_deploy_ids=EXCLUDED.target_deploy_ids,
    permit_epoch=EXCLUDED.permit_epoch,
    permit_nonce=EXCLUDED.permit_nonce,
    preactivation_catalog_policy=EXCLUDED.preactivation_catalog_policy,
    preactivation_catalog_policy_sha256=EXCLUDED.preactivation_catalog_policy_sha256,
    activated_catalog_policy=EXCLUDED.activated_catalog_policy,
    activated_catalog_policy_sha256=EXCLUDED.activated_catalog_policy_sha256,
    before_inventory=EXCLUDED.before_inventory,
    before_policy=EXCLUDED.before_policy,
    activated_inventory=EXCLUDED.activated_inventory,
    activated_policy=EXCLUDED.activated_policy,
    before_principal_inventory_sha256=EXCLUDED.before_principal_inventory_sha256,
    before_principal_policy_sha256=EXCLUDED.before_principal_policy_sha256,
    activated_principal_inventory_sha256=EXCLUDED.activated_principal_inventory_sha256,
    activated_principal_policy_sha256=EXCLUDED.activated_principal_policy_sha256,
    transaction_id=EXCLUDED.transaction_id,
    staged_at=transaction_timestamp();
  RETURN true;
END
$stage_principal_evidence$;
ALTER FUNCTION reviewrouter_activation.stage_principal_evidence(text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.stage_principal_evidence(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.stage_principal_evidence(text) FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName}, ${canonicalBootstrapRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.stage_principal_evidence(text) TO reviewrouter_release_migration;
DROP FUNCTION IF EXISTS reviewrouter_activation.activate_generation(text);
DROP FUNCTION IF EXISTS reviewrouter_activation.activate_generation(text,jsonb);
CREATE OR REPLACE FUNCTION reviewrouter_activation.activate_generation(
  requested_rollout_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $activate$
DECLARE permit reviewrouter_activation.activation_permit%ROWTYPE;
DECLARE receipt reviewrouter_activation.activation_receipt%ROWTYPE;
DECLARE principal_evidence reviewrouter_activation.activation_principal_evidence%ROWTYPE;
DECLARE live_system_identifier text;
DECLARE live_postgres_major integer;
DECLARE live_migration_checksum text;
DECLARE database_binding jsonb;
DECLARE expected_acl_facts jsonb;
DECLARE catalog_acl_facts jsonb;
DECLARE activation_body_facts jsonb;
DECLARE activated_projection jsonb;
DECLARE live_activated_inventory jsonb;
DECLARE live_activated_policy jsonb;
DECLARE live_activated_catalog_policy jsonb;
DECLARE acl_is_canonical boolean;
DECLARE canonical_privileges_sha256 text;
DECLARE catalog_facts_sha256 text;
DECLARE first_write_receipt_sha256 text;
BEGIN
  IF session_user <> 'reviewrouter_release_migration'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$' THEN
    RAISE EXCEPTION 'generation activation request invalid';
  END IF;
  SELECT * INTO permit FROM reviewrouter_activation.activation_permit
  WHERE rollout_id = requested_rollout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation permit absent'; END IF;
  SELECT * INTO receipt FROM reviewrouter_activation.activation_receipt
  WHERE rollout_id = requested_rollout_id;
  IF FOUND THEN
    IF receipt.source_system_identifier <> permit.source_system_identifier
       OR receipt.target_system_identifier <> permit.target_system_identifier
       OR receipt.postgres_major <> permit.postgres_major
       OR receipt.expected_commit_sha <> permit.expected_commit_sha
       OR receipt.migration_checksum <> permit.migration_checksum
       OR receipt.target_deploy_ids <> permit.target_deploy_ids
       OR receipt.permit_epoch <> permit.permit_epoch
       OR receipt.permit_nonce <> permit.permit_nonce
       OR receipt.preactivation_catalog_policy <> permit.preactivation_catalog_policy
       OR receipt.preactivation_catalog_policy_sha256 <> permit.preactivation_catalog_policy_sha256
       OR receipt.activated_catalog_policy <> permit.activated_catalog_policy
       OR receipt.activated_catalog_policy_sha256 <> permit.activated_catalog_policy_sha256 THEN
      RAISE EXCEPTION 'activation receipt conflicts with permit replay';
    END IF;
  ELSIF permit.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'consumed activation permit has no receipt';
  END IF;
  IF receipt.rollout_id IS NOT NULL THEN
    SELECT * INTO STRICT principal_evidence FROM
      reviewrouter_activation.validate_principal_evidence(
        requested_rollout_id,receipt.transaction_id);
    IF principal_evidence.source_system_identifier <> permit.source_system_identifier
       OR principal_evidence.target_system_identifier <> permit.target_system_identifier
       OR principal_evidence.postgres_major <> permit.postgres_major
       OR principal_evidence.expected_commit_sha <> permit.expected_commit_sha
       OR principal_evidence.migration_checksum <> permit.migration_checksum
       OR principal_evidence.target_deploy_ids <> permit.target_deploy_ids
       OR principal_evidence.permit_epoch <> permit.permit_epoch
       OR principal_evidence.permit_nonce <> permit.permit_nonce
       OR principal_evidence.preactivation_catalog_policy <> permit.preactivation_catalog_policy
       OR principal_evidence.preactivation_catalog_policy_sha256 <> permit.preactivation_catalog_policy_sha256
       OR principal_evidence.activated_catalog_policy <> permit.activated_catalog_policy
       OR principal_evidence.activated_catalog_policy_sha256 <> permit.activated_catalog_policy_sha256
       OR receipt.before_principal_inventory_sha256 <>
          principal_evidence.before_principal_inventory_sha256
       OR receipt.before_principal_policy_sha256 <>
          principal_evidence.before_principal_policy_sha256
       OR receipt.activated_principal_inventory_sha256 <>
          principal_evidence.activated_principal_inventory_sha256
       OR receipt.activated_principal_policy_sha256 <>
          principal_evidence.activated_principal_policy_sha256 THEN
      RAISE EXCEPTION 'activation receipt principal evidence invalid or legacy';
    END IF;
  END IF;
  IF receipt.rollout_id IS NULL THEN
    SELECT * INTO principal_evidence
    FROM reviewrouter_activation.activation_principal_evidence
    WHERE rollout_id=requested_rollout_id FOR UPDATE;
    IF NOT FOUND
       OR principal_evidence.transaction_id <> txid_current()
       OR principal_evidence.source_system_identifier <> permit.source_system_identifier
       OR principal_evidence.target_system_identifier <> permit.target_system_identifier
       OR principal_evidence.postgres_major <> permit.postgres_major
       OR principal_evidence.expected_commit_sha <> permit.expected_commit_sha
       OR principal_evidence.migration_checksum <> permit.migration_checksum
       OR principal_evidence.target_deploy_ids <> permit.target_deploy_ids
       OR principal_evidence.permit_epoch <> permit.permit_epoch
       OR principal_evidence.permit_nonce <> permit.permit_nonce
       OR principal_evidence.before_policy->>'kind' IS DISTINCT FROM
          'reviewrouter-effective-principal-policy'
       OR principal_evidence.before_policy->>'version' IS DISTINCT FROM '2'
       OR principal_evidence.before_policy->>'phase' IS DISTINCT FROM 'preactivation'
       OR jsonb_typeof(principal_evidence.before_policy->'roleCapabilityMatrix')
          IS DISTINCT FROM 'array'
       OR principal_evidence.before_policy->'violations' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'principal evidence is not transaction-bound to activation';
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc routine
        JOIN pg_catalog.pg_roles owner ON owner.oid=routine.proowner
        WHERE routine.oid IN (
          'reviewrouter_activation.apply_runtime_acl()'::regprocedure,
          'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure)
          AND owner.rolname='${releaseSchemaOwnerRoleName}'
          AND routine.prosecdef
          AND routine.proconfig IS NOT DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]) <> 2
       OR (SELECT count(*) FROM pg_catalog.pg_proc routine
           JOIN pg_catalog.pg_roles owner ON owner.oid=routine.proowner
           WHERE routine.oid=
             'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure
             AND owner.rolname='${canonicalBootstrapRoleName}'
             AND routine.prosecdef
             AND routine.proconfig IS NOT DISTINCT FROM
               ARRAY['search_path=pg_catalog, pg_temp']::text[]
             AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               routine.prosrc,'UTF8')),'hex')=
               '${runtimeDatabaseAclRoutineBodySha256}') <> 1
       OR NOT pg_catalog.has_function_privilege(
         '${activationReceiptGuardRoleName}',
         'reviewrouter_activation.apply_runtime_acl()','EXECUTE')
       OR NOT pg_catalog.has_function_privilege(
         '${activationReceiptGuardRoleName}',
         'reviewrouter_activation.capture_runtime_acl_policy_pair()','EXECUTE')
       OR NOT pg_catalog.has_function_privilege(
         '${releaseSchemaOwnerRoleName}',
         'reviewrouter_activation.apply_runtime_database_acl(text)','EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc routine
         CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
           routine.proacl,pg_catalog.acldefault('f',routine.proowner))) acl
         WHERE routine.oid IN (
           'reviewrouter_activation.apply_runtime_acl()'::regprocedure,
           'reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure)
           AND acl.privilege_type='EXECUTE'
           AND acl.grantee NOT IN (
             '${releaseSchemaOwnerRoleName}'::regrole,
             '${activationReceiptGuardRoleName}'::regrole))
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc routine
         CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
           routine.proacl,pg_catalog.acldefault('f',routine.proowner))) acl
         WHERE routine.oid=
           'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure
           AND acl.privilege_type='EXECUTE'
           AND (
             acl.grantee NOT IN (
               '${canonicalBootstrapRoleName}'::regrole,
               '${releaseSchemaOwnerRoleName}'::regrole)
             OR (acl.grantee='${releaseSchemaOwnerRoleName}'::regrole
                 AND acl.is_grantable)
           )) THEN
      RAISE EXCEPTION 'runtime ACL activation authority boundary invalid';
    END IF;
    PERFORM reviewrouter_activation.apply_runtime_acl();
    activated_projection := reviewrouter_activation.project_effective_principal_authority('activated');
    live_activated_inventory := activated_projection->'inventory';
    live_activated_policy := activated_projection->'policy';
    live_activated_catalog_policy := activated_projection->'catalogPolicy';
    IF activated_projection->>'kind' IS DISTINCT FROM 'reviewrouter-effective-principal-projection'
       OR activated_projection->>'version' IS DISTINCT FROM '2'
       OR live_activated_inventory->>'version' IS DISTINCT FROM '1'
       OR live_activated_inventory->>'database' IS DISTINCT FROM current_database()
       OR live_activated_inventory->>'sessionPrincipal' IS DISTINCT FROM session_user
       OR jsonb_typeof(live_activated_inventory->'roles') IS DISTINCT FROM 'array'
       OR jsonb_typeof(live_activated_inventory->'memberships') IS DISTINCT FROM 'array'
       OR jsonb_typeof(live_activated_inventory->'roleReachability') IS DISTINCT FROM 'array'
       OR jsonb_typeof(live_activated_inventory->'rowSecurity') IS DISTINCT FROM 'array'
       OR jsonb_typeof(live_activated_inventory->'extensions') IS DISTINCT FROM 'array'
       OR jsonb_typeof(live_activated_inventory->'unsupportedAuthorityFamilies') IS DISTINCT FROM 'array'
       OR jsonb_typeof(live_activated_inventory->'grants') IS DISTINCT FROM 'array'
       OR live_activated_policy->>'kind' IS DISTINCT FROM 'reviewrouter-effective-principal-policy'
       OR live_activated_policy->>'version' IS DISTINCT FROM '2'
       OR live_activated_policy->>'phase' IS DISTINCT FROM 'activated'
       OR jsonb_typeof(live_activated_policy->'roleCapabilityMatrix')
          IS DISTINCT FROM 'array'
       OR live_activated_policy->'rowSecurity' IS DISTINCT FROM
          live_activated_inventory->'rowSecurity'
       OR live_activated_policy->'violations' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'activated principal authority policy rejected';
    END IF;
    IF live_activated_catalog_policy IS DISTINCT FROM permit.activated_catalog_policy
       OR permit.activated_catalog_policy_sha256 <> 'sha256:' || encode(pg_catalog.sha256(convert_to(
         reviewrouter_activation.canonical_json(live_activated_catalog_policy),'UTF8')),'hex') THEN
      RAISE EXCEPTION 'activated catalog policy mismatch';
    END IF;
    UPDATE reviewrouter_activation.activation_principal_evidence SET
      activated_inventory=live_activated_inventory,
      activated_policy=live_activated_policy,
      activated_principal_inventory_sha256='sha256:' || encode(pg_catalog.sha256(convert_to(
        reviewrouter_activation.canonical_json(live_activated_inventory),'UTF8')),'hex'),
      activated_principal_policy_sha256='sha256:' || encode(pg_catalog.sha256(convert_to(
        reviewrouter_activation.canonical_json(live_activated_policy),'UTF8')),'hex')
    WHERE rollout_id=requested_rollout_id AND transaction_id=txid_current()
    RETURNING * INTO principal_evidence;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'principal evidence activation update raced';
    END IF;
    SELECT * INTO STRICT principal_evidence FROM
      reviewrouter_activation.validate_principal_evidence(
        requested_rollout_id,txid_current());
  END IF;
  SELECT system_identifier::text INTO live_system_identifier
    FROM pg_catalog.pg_control_system();
    live_postgres_major := current_setting('server_version_num')::integer / 10000;
    SELECT 'sha256:' || encode(pg_catalog.sha256(convert_to(
      coalesce(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''),
      'UTF8')), 'hex') INTO live_migration_checksum
    FROM public._prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
    SELECT shobj_description(oid, 'pg_database')::jsonb INTO database_binding
    FROM pg_database WHERE datname = current_database();
  IF live_system_identifier <> permit.target_system_identifier
       OR live_postgres_major <> permit.postgres_major
       OR live_migration_checksum <> permit.migration_checksum
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           coalesce(database_binding->'consumedMigrationEvidence', '[]'::jsonb)
         ) evidence
         WHERE evidence->>'commit' = permit.expected_commit_sha
           AND evidence->>'systemIdentifier' = permit.target_system_identifier
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(permit.target_deploy_ids) value
         WHERE value !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'
       )
       OR (SELECT count(DISTINCT value)
           FROM jsonb_array_elements_text(permit.target_deploy_ids) value)
          <> jsonb_array_length(permit.target_deploy_ids) THEN
    RAISE EXCEPTION 'activation permit does not match live target';
  END IF;
  WITH runtime_roles(role_name, role_kind) AS (VALUES
      ('reviewrouter_api','api'), ('reviewrouter_web','web'),
      ('reviewrouter_worker','worker'),
      ('reviewrouter_codex_effect_authority','effect-authority')
    ), tables AS (
      SELECT relation.oid, relation.relname
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','f')
    ), sequences AS (
      SELECT relation.oid, relation.relname
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relkind='S'
    ), routines AS (
      SELECT routine.oid, routine.proname,
        oidvectortypes(routine.proargtypes) AS argument_types,
        routine.oid::regprocedure::text AS signature
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      WHERE namespace.nspname='public'
    ), table_facts AS (
      SELECT role_name, role_kind, tables.oid, relname,
        has_table_privilege(role_name,tables.oid,'SELECT') AS can_select,
        has_table_privilege(role_name,tables.oid,'INSERT') AS can_insert,
        has_table_privilege(role_name,tables.oid,'UPDATE') AS can_update,
        has_table_privilege(role_name,tables.oid,'DELETE') AS can_delete,
        has_table_privilege(role_name,tables.oid,'TRUNCATE') AS can_truncate,
        has_table_privilege(role_name,tables.oid,'REFERENCES') AS can_reference,
        has_table_privilege(role_name,tables.oid,'TRIGGER') AS can_trigger
      FROM runtime_roles CROSS JOIN tables
    ), column_facts AS (
      SELECT role_name, role_kind, relation.relname, attribute.attname,
        has_column_privilege(role_name,relation.oid,attribute.attnum,'SELECT') AS can_select,
        has_column_privilege(role_name,relation.oid,attribute.attnum,'INSERT') AS can_insert,
        has_column_privilege(role_name,relation.oid,attribute.attnum,'UPDATE') AS can_update,
        has_column_privilege(role_name,relation.oid,attribute.attnum,'REFERENCES') AS can_reference
      FROM runtime_roles
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE namespace.nspname='public' AND relation.relname IN (
        'RepositoryConnection','CodexOAuthChildIdentityQuarantine','CodexOAuthLease',
        'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance','CodexOAuthSecretNamespace',
        'CodexOAuthSetupDispatchAttempt','CodexOAuthSetupManifest','CodexOAuthSetupPayloadClaim',
        'CodexOAuthSetupRecoveryRequest','CodexOAuthWritebackIntent','CodexOAuthWorkflowCompatibility',
        'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt',
        '${workerOwnedMaintenanceCheckpointTable}'
      ) AND attribute.attnum>0 AND NOT attribute.attisdropped
    ), sequence_facts AS (
      SELECT role_name, role_kind, relname,
        has_sequence_privilege(role_name,sequences.oid,'USAGE') AS can_usage,
        has_sequence_privilege(role_name,sequences.oid,'SELECT') AS can_select,
        has_sequence_privilege(role_name,sequences.oid,'UPDATE') AS can_update
      FROM runtime_roles CROSS JOIN sequences
    ), function_facts AS (
      SELECT role_name, role_kind, proname, argument_types, signature,
        has_function_privilege(role_name,routines.oid,'EXECUTE') AS can_execute
      FROM runtime_roles CROSS JOIN routines
    )
    SELECT jsonb_build_object(
      'database',(SELECT jsonb_agg(jsonb_build_object(
        'role',role_name,'connect',has_database_privilege(role_name,current_database(),'CONNECT'),
        'create',has_database_privilege(role_name,current_database(),'CREATE'),
        'temporary',has_database_privilege(role_name,current_database(),'TEMP')
      ) ORDER BY role_name) FROM runtime_roles),
      'schema',(SELECT jsonb_agg(jsonb_build_object(
        'role',role_name,'usage',has_schema_privilege(role_name,'public','USAGE'),
        'create',has_schema_privilege(role_name,'public','CREATE')
      ) ORDER BY role_name) FROM runtime_roles),
      'tables',(SELECT coalesce(jsonb_agg(to_jsonb(table_facts)-'oid'-'role_kind'
        ORDER BY role_name,relname),'[]'::jsonb) FROM table_facts),
      'columns',(SELECT coalesce(jsonb_agg(to_jsonb(column_facts)-'role_kind'
        ORDER BY role_name,relname,attname),'[]'::jsonb) FROM column_facts),
      'sequences',(SELECT coalesce(jsonb_agg(to_jsonb(sequence_facts)-'role_kind'
        ORDER BY role_name,relname),'[]'::jsonb) FROM sequence_facts),
      'functions',(SELECT coalesce(jsonb_agg(to_jsonb(function_facts)-'role_kind'-'proname'-'argument_types'
        ORDER BY role_name,signature),'[]'::jsonb) FROM function_facts)
    ), NOT (
       EXISTS (SELECT 1 FROM runtime_roles WHERE
         NOT has_database_privilege(role_name,current_database(),'CONNECT')
         OR has_database_privilege(role_name,current_database(),'CREATE')
         OR has_database_privilege(role_name,current_database(),'TEMP')
         OR NOT has_schema_privilege(role_name,'public','USAGE')
         OR has_schema_privilege(role_name,'public','CREATE'))
       OR EXISTS (SELECT 1 FROM table_facts WHERE
         can_select IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname <> '_prisma_migrations'
           AND relname NOT IN ('CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt',
             'RuntimeGenerationWitnessProof','RuntimeCanaryChallenge','RuntimeCanaryChallengeProof')
           AND (relname <> 'CodexOAuthWorkflowCompatibility' OR role_kind IN ('api','web'))
           AND (relname <> '${workerOwnedMaintenanceCheckpointTable}' OR role_kind = 'worker'))
         OR can_insert IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname NOT IN (
           '_prisma_migrations','RepositoryConnection','CodexOAuthChildIdentityQuarantine',
           'CodexOAuthProviderIdentityQuarantine','CodexOAuthDatabaseAuthorityKey',
           'CodexOAuthDatabaseAuthorityReceipt','CodexOAuthWorkflowCompatibility','RuntimeGenerationWitnessProof',
           'RuntimeCanaryChallenge','RuntimeCanaryChallengeProof')
           AND (relname <> '${workerOwnedMaintenanceCheckpointTable}' OR role_kind = 'worker'))
         OR can_update IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname NOT IN (
           '_prisma_migrations','RepositoryConnection','CodexOAuthChildIdentityQuarantine',
           'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance',
           'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt','CodexOAuthWorkflowCompatibility',
           'RuntimeGenerationWitnessProof','RuntimeCanaryChallenge','RuntimeCanaryChallengeProof')
           AND (relname <> '${workerOwnedMaintenanceCheckpointTable}' OR role_kind = 'worker'))
         OR can_delete IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname NOT IN (
           '_prisma_migrations','RepositoryConnection','CodexOAuthChildIdentityQuarantine','CodexOAuthLease',
           'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance','CodexOAuthSecretNamespace',
           'CodexOAuthSetupDispatchAttempt','CodexOAuthSetupManifest','CodexOAuthSetupPayloadClaim',
           'CodexOAuthSetupRecoveryRequest','CodexOAuthWritebackIntent',
           'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt','CodexOAuthWorkflowCompatibility',
           'RuntimeGenerationWitnessProof','RuntimeCanaryChallenge','RuntimeCanaryChallengeProof',
           '${workerOwnedMaintenanceCheckpointTable}'))
         OR can_truncate OR can_reference OR can_trigger)
       OR EXISTS (
         SELECT 1 FROM column_facts
         JOIN table_facts USING (role_name,role_kind,relname)
         WHERE column_facts.can_select IS DISTINCT FROM table_facts.can_select
           OR column_facts.can_insert IS DISTINCT FROM table_facts.can_insert
           OR column_facts.can_reference IS DISTINCT FROM table_facts.can_reference
           OR column_facts.can_update IS DISTINCT FROM CASE
             WHEN column_facts.role_kind <> 'effect-authority'
               AND column_facts.relname='CodexOAuthProviderInstance'
               AND column_facts.attname=ANY(ARRAY[${providerRuntimeUpdateColumns.map((column) => `'${column}'`).join(",")}])
             THEN true
             ELSE table_facts.can_update
           END
       )
       OR EXISTS (SELECT 1 FROM sequence_facts WHERE
         can_usage IS DISTINCT FROM (role_kind <> 'effect-authority')
         OR can_select OR can_update)
       OR EXISTS (SELECT 1 FROM function_facts WHERE can_execute IS DISTINCT FROM CASE
         WHEN role_kind='effect-authority' THEN proname='codex_oauth_sign_database_authority'
           AND argument_types='text'
         WHEN proname='reviewrouter_record_runtime_generation_witness_proof' THEN
           role_kind IN ('api','web','worker')
           AND argument_types='text, text, text, text'
         WHEN role_kind='api' AND proname='reviewrouter_read_runtime_generation_witness_proofs' THEN
           argument_types='text, text'
         WHEN role_kind='api' AND proname='reviewrouter_runtime_generation_write_read_canary' THEN
           argument_types='text, text'
         WHEN role_kind='api' AND proname='reviewrouter_request_runtime_canary_challenge' THEN
           argument_types='text, text, timestamp with time zone, text, text, text, jsonb'
         WHEN role_kind='api' AND proname='reviewrouter_read_runtime_canary_challenge_proofs' THEN
           argument_types='text'
         WHEN proname='reviewrouter_answer_runtime_canary_challenge' THEN
           role_kind IN ('api','web','worker')
           AND argument_types='text, text, text, text, text, text'
         WHEN proname='codex_oauth_database_authority_challenge' THEN argument_types='text, text, integer'
         WHEN proname='codex_oauth_consume_database_authority' THEN argument_types='text, text, integer'
         WHEN role_kind='api' AND proname='codex_oauth_authorize_runtime_confirmation' THEN argument_types='text, text, integer, text'
         WHEN role_kind='api' AND proname='codex_oauth_authorize_runtime_completion' THEN argument_types='text, text'
         WHEN role_kind='web' AND proname='codex_oauth_authorize_setup_confirmation' THEN argument_types='text, integer, text'
         WHEN role_kind='web' AND proname='codex_oauth_provider_identity_repair_challenge' THEN argument_types='text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, bigint'
         WHEN role_kind='web' AND proname='codex_oauth_repair_quarantined_provider' THEN argument_types='text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, bigint, text'
         WHEN role_kind='web' AND proname='codex_oauth_reattest_active_namespace_v4_to_v5' THEN argument_types='text, text, text, text, bigint, text, text, text, text, text, integer, integer, text, text, text, text, text, text, text, text, integer'
         ELSE false END)
       OR has_database_privilege('public',current_database(),'CONNECT')
       OR has_database_privilege('public',current_database(),'CREATE')
       OR has_database_privilege('public',current_database(),'TEMP')
       OR has_schema_privilege('public','public','CREATE')
       OR EXISTS (SELECT 1 FROM tables
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
         WHERE has_table_privilege('public',oid,privilege))
       OR EXISTS (SELECT 1 FROM sequences
         CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) privilege
         WHERE has_sequence_privilege('public',oid,privilege))
       OR EXISTS (SELECT 1 FROM routines WHERE has_function_privilege('public',oid,'EXECUTE'))
       OR EXISTS (SELECT 1 FROM pg_database database,
         LATERAL aclexplode(coalesce(database.datacl,acldefault('d',database.datdba))) acl
         WHERE database.datname=current_database() AND acl.is_grantable
           AND acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname=ANY(ARRAY[
             'reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])))
       OR EXISTS (SELECT 1 FROM pg_namespace namespace,
         LATERAL aclexplode(coalesce(namespace.nspacl,acldefault('n',namespace.nspowner))) acl
         WHERE namespace.nspname='public' AND acl.is_grantable
           AND acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname=ANY(ARRAY[
             'reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])))
       OR EXISTS (SELECT 1 FROM tables,
         LATERAL aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid=tables.oid),
           acldefault('r',(SELECT relowner FROM pg_class WHERE oid=tables.oid)))) acl
         WHERE acl.is_grantable
           AND acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname=ANY(ARRAY[
             'reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])))
       OR EXISTS (SELECT 1 FROM routines,
         LATERAL aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=routines.oid),
           acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=routines.oid)))) acl
         WHERE acl.is_grantable
           AND acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname=ANY(ARRAY[
             'reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'])))
    ) INTO catalog_acl_facts, acl_is_canonical
    FROM runtime_roles LIMIT 1;
    expected_acl_facts := catalog_acl_facts;
  IF NOT acl_is_canonical THEN
    RAISE EXCEPTION 'runtime ACL is not canonical';
  END IF;
  canonical_privileges_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
    jsonb_build_object('policyVersion',1,'facts',expected_acl_facts)::text,'UTF8')),'hex');
  SELECT jsonb_build_object(
    'principalInventorySqlSha256','${effectivePrincipalInventorySqlSha256}',
    'installPermitBodySha256',encode(pg_catalog.sha256(convert_to(installer.prosrc,'UTF8')),'hex'),
    'canonicalJsonBodySha256',encode(pg_catalog.sha256(convert_to(canonical.prosrc,'UTF8')),'hex'),
    'principalProjectorBodySha256',encode(pg_catalog.sha256(convert_to(projector.prosrc,'UTF8')),'hex'),
    'principalEvidenceValidatorBodySha256',encode(pg_catalog.sha256(convert_to(validator.prosrc,'UTF8')),'hex'),
      'stagePrincipalEvidenceBodySha256',encode(pg_catalog.sha256(convert_to(stage.prosrc,'UTF8')),'hex'),
      'runtimeDatabaseAclBodySha256',encode(pg_catalog.sha256(convert_to(database_acl.prosrc,'UTF8')),'hex'),
      'runtimeAclBodySha256',encode(pg_catalog.sha256(convert_to(runtime_acl.prosrc,'UTF8')),'hex'),
    'runtimeAclPolicyPairBodySha256',encode(pg_catalog.sha256(convert_to(runtime_acl_pair.prosrc,'UTF8')),'hex'),
    'activateGenerationBodySha256',encode(pg_catalog.sha256(convert_to(activate.prosrc,'UTF8')),'hex'),
    'readActivationReceiptBodySha256',encode(pg_catalog.sha256(convert_to(reader.prosrc,'UTF8')),'hex')
  ) INTO activation_body_facts
  FROM pg_proc installer, pg_proc canonical, pg_proc projector, pg_proc validator,
    pg_proc stage, pg_proc database_acl, pg_proc runtime_acl, pg_proc runtime_acl_pair,
    pg_proc activate, pg_proc reader
  WHERE installer.oid='reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)'::regprocedure
    AND canonical.oid='reviewrouter_activation.canonical_json(jsonb)'::regprocedure
    AND projector.oid='reviewrouter_activation.project_effective_principal_authority(text)'::regprocedure
    AND validator.oid='reviewrouter_activation.validate_principal_evidence(text,bigint)'::regprocedure
    AND stage.oid='reviewrouter_activation.stage_principal_evidence(text)'::regprocedure
    AND database_acl.oid=
      'reviewrouter_activation.apply_runtime_database_acl(text)'::regprocedure
    AND runtime_acl.oid='reviewrouter_activation.apply_runtime_acl()'::regprocedure
    AND runtime_acl_pair.oid='reviewrouter_activation.capture_runtime_acl_policy_pair()'::regprocedure
    AND activate.oid='reviewrouter_activation.activate_generation(text)'::regprocedure
    AND reader.oid='reviewrouter_activation.read_activation_receipt(text)'::regprocedure;
  IF activation_body_facts IS NULL THEN
    RAISE EXCEPTION 'activation principal evidence body attestation unavailable';
  END IF;
  catalog_facts_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
    jsonb_build_object('policyVersion',1,'facts',catalog_acl_facts,
      'activationPrincipalEvidenceContract',activation_body_facts)::text,'UTF8')),'hex');
  IF receipt.rollout_id IS NOT NULL THEN
    IF receipt.canonical_privileges_sha256 <> canonical_privileges_sha256
       OR receipt.catalog_facts_sha256 <> catalog_facts_sha256
       OR receipt.preactivation_catalog_policy_sha256 <>
          principal_evidence.preactivation_catalog_policy_sha256
       OR receipt.activated_catalog_policy_sha256 <>
          principal_evidence.activated_catalog_policy_sha256
       OR receipt.before_principal_inventory_sha256 <>
          principal_evidence.before_principal_inventory_sha256
       OR receipt.before_principal_policy_sha256 <>
          principal_evidence.before_principal_policy_sha256
       OR receipt.activated_principal_inventory_sha256 <>
          principal_evidence.activated_principal_inventory_sha256
       OR receipt.activated_principal_policy_sha256 <>
          principal_evidence.activated_principal_policy_sha256 THEN
      RAISE EXCEPTION 'activation receipt conflicts with catalog replay';
    END IF;
  ELSE
    first_write_receipt_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
      permit.rollout_id || ':' || permit.source_system_identifier || ':' ||
      permit.target_system_identifier || ':' || permit.postgres_major::text || ':' ||
      permit.expected_commit_sha || ':' || permit.migration_checksum || ':' ||
      permit.target_deploy_ids::text || ':' || permit.permit_epoch::text || ':' ||
      permit.permit_nonce || ':' || canonical_privileges_sha256 || ':' ||
      catalog_facts_sha256 || ':' ||
      permit.preactivation_catalog_policy_sha256 || ':' ||
      permit.activated_catalog_policy_sha256 || ':' ||
      principal_evidence.before_principal_inventory_sha256 || ':' ||
      principal_evidence.before_principal_policy_sha256 || ':' ||
      principal_evidence.activated_principal_inventory_sha256 || ':' ||
      principal_evidence.activated_principal_policy_sha256, 'UTF8')), 'hex');
    INSERT INTO reviewrouter_activation.activation_receipt (
      rollout_id, source_system_identifier, target_system_identifier,
      postgres_major, expected_commit_sha, migration_checksum, target_deploy_ids,
      permit_epoch, permit_nonce, canonical_privileges_sha256,
      catalog_facts_sha256, preactivation_catalog_policy,
      preactivation_catalog_policy_sha256, activated_catalog_policy,
      activated_catalog_policy_sha256, before_principal_inventory_sha256,
      before_principal_policy_sha256, activated_principal_inventory_sha256,
      activated_principal_policy_sha256, first_write_receipt_sha256, transaction_id
    ) VALUES (
      permit.rollout_id, permit.source_system_identifier,
      permit.target_system_identifier, permit.postgres_major,
      permit.expected_commit_sha, permit.migration_checksum,
      permit.target_deploy_ids, permit.permit_epoch, permit.permit_nonce,
      canonical_privileges_sha256, catalog_facts_sha256,
      permit.preactivation_catalog_policy,
      permit.preactivation_catalog_policy_sha256,
      permit.activated_catalog_policy,
      permit.activated_catalog_policy_sha256,
      principal_evidence.before_principal_inventory_sha256,
      principal_evidence.before_principal_policy_sha256,
      principal_evidence.activated_principal_inventory_sha256,
      principal_evidence.activated_principal_policy_sha256,
      first_write_receipt_sha256, txid_current()
    ) RETURNING * INTO receipt;
    UPDATE reviewrouter_activation.activation_permit
    SET consumed_at = transaction_timestamp()
    WHERE rollout_id = permit.rollout_id AND consumed_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'activation permit consumption raced'; END IF;
  END IF;
  RETURN jsonb_build_object(
    'rolloutId',receipt.rollout_id,
    'sourceSystemIdentifier',receipt.source_system_identifier,
    'targetSystemIdentifier',receipt.target_system_identifier,
    'postgresMajor',receipt.postgres_major,
    'expectedCommitSha',receipt.expected_commit_sha,
    'migrationChecksum',receipt.migration_checksum,
    'targetDeployIds',receipt.target_deploy_ids,
    'permitEpoch',receipt.permit_epoch,
    'permitNonce',receipt.permit_nonce,
    'canonicalPrivilegesSha256',receipt.canonical_privileges_sha256,
    'catalogFactsSha256',receipt.catalog_facts_sha256,
    'preactivationCatalogPolicySha256',receipt.preactivation_catalog_policy_sha256,
    'activatedCatalogPolicySha256',receipt.activated_catalog_policy_sha256,
    'beforePrincipalInventorySha256',receipt.before_principal_inventory_sha256,
    'beforePrincipalPolicySha256',receipt.before_principal_policy_sha256,
    'activatedPrincipalInventorySha256',receipt.activated_principal_inventory_sha256,
    'activatedPrincipalPolicySha256',receipt.activated_principal_policy_sha256,
    'firstWriteReceiptSha256',receipt.first_write_receipt_sha256,
    'transactionId',receipt.transaction_id::text,
    'activatedAt',to_char(receipt.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'firstWriteBoundary',true
  );
END
$activate$;
ALTER FUNCTION reviewrouter_activation.activate_generation(text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.activate_generation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reviewrouter_activation.activate_generation(text) FROM ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName}, ${canonicalBootstrapRoleName};
GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_release_migration,
  ${releaseSchemaOwnerRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.activate_generation(text) TO reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_activation.read_activation_receipt(
  requested_rollout_id text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $read_receipt$
DECLARE receipt reviewrouter_activation.activation_receipt%ROWTYPE;
DECLARE principal_evidence reviewrouter_activation.activation_principal_evidence%ROWTYPE;
DECLARE expected_first_write_receipt_sha256 text;
BEGIN
  IF session_user NOT IN ('${activationReceiptReaderRoleName}','reviewrouter_release_migration')
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$' THEN
    RAISE EXCEPTION 'activation receipt read request invalid';
  END IF;
  SELECT * INTO receipt FROM reviewrouter_activation.activation_receipt
  WHERE rollout_id=requested_rollout_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO STRICT principal_evidence FROM
    reviewrouter_activation.validate_principal_evidence(
      requested_rollout_id,receipt.transaction_id);
  expected_first_write_receipt_sha256 := 'sha256:' || encode(sha256(convert_to(
    receipt.rollout_id || ':' || receipt.source_system_identifier || ':' ||
    receipt.target_system_identifier || ':' || receipt.postgres_major::text || ':' ||
    receipt.expected_commit_sha || ':' || receipt.migration_checksum || ':' ||
    receipt.target_deploy_ids::text || ':' || receipt.permit_epoch::text || ':' ||
    receipt.permit_nonce || ':' || receipt.canonical_privileges_sha256 || ':' ||
    receipt.catalog_facts_sha256 || ':' ||
    receipt.preactivation_catalog_policy_sha256 || ':' ||
    receipt.activated_catalog_policy_sha256 || ':' ||
    principal_evidence.before_principal_inventory_sha256 || ':' ||
    principal_evidence.before_principal_policy_sha256 || ':' ||
    principal_evidence.activated_principal_inventory_sha256 || ':' ||
    principal_evidence.activated_principal_policy_sha256,'UTF8')),'hex');
  IF receipt.before_principal_inventory_sha256 <>
       principal_evidence.before_principal_inventory_sha256
     OR receipt.preactivation_catalog_policy <>
       principal_evidence.preactivation_catalog_policy
     OR receipt.preactivation_catalog_policy_sha256 <>
       principal_evidence.preactivation_catalog_policy_sha256
     OR receipt.activated_catalog_policy <>
       principal_evidence.activated_catalog_policy
     OR receipt.activated_catalog_policy_sha256 <>
       principal_evidence.activated_catalog_policy_sha256
     OR receipt.before_principal_policy_sha256 <>
       principal_evidence.before_principal_policy_sha256
     OR receipt.activated_principal_inventory_sha256 <>
       principal_evidence.activated_principal_inventory_sha256
     OR receipt.activated_principal_policy_sha256 <>
       principal_evidence.activated_principal_policy_sha256
     OR receipt.first_write_receipt_sha256 <> expected_first_write_receipt_sha256 THEN
    RAISE EXCEPTION 'activation receipt principal evidence invalid or legacy';
  END IF;
  RETURN jsonb_build_object(
    'rolloutId',receipt.rollout_id,
    'sourceSystemIdentifier',receipt.source_system_identifier,
    'targetSystemIdentifier',receipt.target_system_identifier,
    'postgresMajor',receipt.postgres_major,
    'expectedCommitSha',receipt.expected_commit_sha,
    'migrationChecksum',receipt.migration_checksum,
    'targetDeployIds',receipt.target_deploy_ids,
    'permitEpoch',receipt.permit_epoch,
    'permitNonce',receipt.permit_nonce,
    'canonicalPrivilegesSha256',receipt.canonical_privileges_sha256,
    'catalogFactsSha256',receipt.catalog_facts_sha256,
    'preactivationCatalogPolicySha256',receipt.preactivation_catalog_policy_sha256,
    'activatedCatalogPolicySha256',receipt.activated_catalog_policy_sha256,
    'beforePrincipalInventorySha256',receipt.before_principal_inventory_sha256,
    'beforePrincipalPolicySha256',receipt.before_principal_policy_sha256,
    'activatedPrincipalInventorySha256',receipt.activated_principal_inventory_sha256,
    'activatedPrincipalPolicySha256',receipt.activated_principal_policy_sha256,
    'firstWriteReceiptSha256',receipt.first_write_receipt_sha256,
    'transactionId',receipt.transaction_id::text,
    'activatedAt',to_char(receipt.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'firstWriteBoundary',true
  );
END
$read_receipt$;
ALTER FUNCTION reviewrouter_activation.read_activation_receipt(text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.read_activation_receipt(text) FROM PUBLIC;
REVOKE ALL ON SCHEMA reviewrouter_activation FROM ${activationReceiptReaderRoleName};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reviewrouter_activation FROM ${activationReceiptReaderRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${activationReceiptReaderRoleName};
GRANT USAGE ON SCHEMA reviewrouter_activation TO ${activationReceiptReaderRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_activation_receipt(text) TO ${activationReceiptReaderRoleName};
-- The reader-wide reset above deliberately removes every earlier routine ACL.
-- Restore the independently guarded migration receipt reader after that reset;
-- doing this earlier is order-dependent and silently removes the capability.
GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_migration_receipt(text,bigint,text)
  TO ${activationReceiptReaderRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_activation_receipt(text) TO reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_activation.read_activation_migration_manifest_identity()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $read_manifest$
BEGIN
  IF session_user NOT IN (
    '${activationPermitInstallerRoleName}',
    '${activationReceiptReaderRoleName}',
    'reviewrouter_release_migration'
  ) THEN
    RAISE EXCEPTION 'activation migration manifest read request invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public._prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'activation migration manifest unresolved';
  END IF;
  RETURN (
    SELECT 'sha256:' || encode(sha256(convert_to(
      coalesce(string_agg(migration_name || ':' || checksum, ','
        ORDER BY migration_name), ''), 'UTF8')), 'hex')
    FROM public._prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  );
END
$read_manifest$;
ALTER FUNCTION reviewrouter_activation.read_activation_migration_manifest_identity()
  OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.read_activation_migration_manifest_identity()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_activation_migration_manifest_identity()
  TO ${activationPermitInstallerRoleName}, ${activationReceiptReaderRoleName},
     reviewrouter_release_migration;
-- Install the schema-owner ACL projectors before the activation namespace is
-- fingerprinted. Role bootstrap may validate them, but must not mutate this
-- trusted namespace after release-control readiness has been attested.
GRANT CREATE ON SCHEMA reviewrouter_activation
  TO ${releaseSchemaOwnerRoleName};
${databaseOwnerRuntimeAclRoutineSql()}
${schemaOwnerRuntimeAclRoutinesSql()}
REVOKE CREATE ON SCHEMA reviewrouter_activation
  FROM ${releaseSchemaOwnerRoleName};
COMMIT;
`;
}

export function activationRoutineBodyTrustRoots() {
  const sql = activationAuthorityProvisioningSql();
  const digestBody = (delimiter) => {
    const marker = `AS $${delimiter}$`;
    const start = sql.indexOf(marker);
    const end = sql.indexOf(`\n$${delimiter}$;`, start + marker.length);
    if (start < 0 || end < 0)
      throw new Error(`activation_routine_body_missing:${delimiter}`);
    const body = sql.slice(start + marker.length, end + 1);
    return createHash("sha256").update(body).digest("hex");
  };
  return Object.freeze({
    // The installer trust root also commits to the canonicalizer, staged
    // catalog projector, evidence validator, activation routine, and the
    // target-local one-shot migration permit protocol.
    installerRoutineBodySha256: createHash("sha256")
      .update(
        [
          digestBody("install_permit"),
          digestBody("canonical_json"),
          digestBody("project_effective_principal_authority"),
          digestBody("capture_catalog_policy_candidate"),
          digestBody("capture_catalog_policy_candidate_pair"),
          digestBody("validate_principal_evidence"),
          digestBody("stage_principal_evidence"),
          digestBody("apply_runtime_database_acl"),
          digestBody("activate"),
          digestBody("install_migration_permit"),
          digestBody("consume_migration_permit"),
          digestBody("complete_migration_permit"),
          digestBody("terminalize_migration_permit"),
          digestBody("read_migration_receipt"),
        ].join(":"),
      )
      .digest("hex"),
    readerRoutineBodySha256: createHash("sha256")
      .update(
        [
          digestBody("canonical_json"),
          digestBody("validate_principal_evidence"),
          digestBody("read_receipt"),
        ].join(":"),
      )
      .digest("hex"),
  });
}

export function canonicalRoleTopologyObservationSql() {
  return `SELECT json_build_object(
    'callerCount', 1,
    'roles', (SELECT json_agg(json_build_object(
      'username', rolname,
      'login', rolcanlogin,
      'superuser', rolsuper,
      'createDatabase', rolcreatedb,
      'createRole', rolcreaterole,
      'replication', rolreplication,
      'bypassRls', rolbypassrls,
      'canSetReleaseRole', pg_has_role(rolname, 'reviewrouter_release_migration', 'SET')
    ) ORDER BY rolname) FROM pg_roles WHERE rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])) ,
    'setRoleMatrix', (SELECT json_agg(json_build_object(
      'member', member.rolname,
      'target', target.rolname,
      'canSet', pg_has_role(member.oid, target.oid, 'SET')
    ) ORDER BY member.rolname, target.rolname)
    FROM pg_roles member CROSS JOIN pg_roles target
    WHERE member.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
      AND target.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])) ,
    'bootstrapMemberships', (SELECT json_agg(json_build_object(
      'granted', granted.rolname,
      'member', member.rolname,
      'grantor', grantor.rolname,
      'adminOption', membership.admin_option,
      'inheritOption', membership.inherit_option,
      'setOption', membership.set_option
    ) ORDER BY granted.rolname, member.rolname)
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles grantor ON grantor.oid = membership.grantor
    WHERE (
        granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
        OR member.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
        OR granted.rolname = '${canonicalBootstrapRoleName}'
        OR member.rolname = '${canonicalBootstrapRoleName}'
      )
      AND granted.rolname <> '${activationReceiptGuardRoleName}'
      AND member.rolname <> '${activationReceiptGuardRoleName}'),
    'guard', (SELECT json_build_object(
      'username', role.rolname,
      'login', role.rolcanlogin,
      'superuser', role.rolsuper,
      'createDatabase', role.rolcreatedb,
      'createRole', role.rolcreaterole,
      'replication', role.rolreplication,
      'bypassRls', role.rolbypassrls,
      'membershipCount', (SELECT count(*)
        FROM pg_auth_members membership
        WHERE membership.roleid = role.oid OR membership.member = role.oid)
    ) FROM pg_roles role WHERE role.rolname = '${activationReceiptGuardRoleName}'),
    'schemaOwner', (SELECT json_build_object(
      'username', role.rolname,
      'login', role.rolcanlogin,
      'superuser', role.rolsuper,
      'createDatabase', role.rolcreatedb,
      'createRole', role.rolcreaterole,
      'replication', role.rolreplication,
      'bypassRls', role.rolbypassrls,
      'migrationCanSet', pg_has_role('reviewrouter_release_migration',role.oid,'SET'),
      'bootstrapCanSet', pg_has_role('${canonicalBootstrapRoleName}',role.oid,'SET')
    ) FROM pg_roles role WHERE role.rolname = '${releaseSchemaOwnerRoleName}'),
    'ownership', json_build_object(
      'databaseOwner', (SELECT owner.rolname
        FROM pg_database database
        JOIN pg_roles owner ON owner.oid = database.datdba
        WHERE database.datname = current_database()),
      'publicSchemaOwner', (SELECT owner.rolname
        FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = 'public'),
      'bootstrapSchemaOwner', (SELECT owner.rolname
        FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = 'reviewrouter_bootstrap'),
      'bootstrapFunctionOwner', (SELECT max(owner.rolname)
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        JOIN pg_roles owner ON owner.oid = routine.proowner
        WHERE namespace.nspname = 'reviewrouter_bootstrap'
          AND routine.proname = 'consume_migration_evidence'),
      'bootstrapFunctionCount', (SELECT count(*)
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'reviewrouter_bootstrap'
          AND routine.proname = 'consume_migration_evidence'),
      'unexpectedPublicObjectOwnerCount', (SELECT count(*) FROM (
        SELECT owner.rolname
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND owner.rolname <> '${releaseSchemaOwnerRoleName}'
        UNION ALL
        SELECT owner.rolname
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        JOIN pg_roles owner ON owner.oid = routine.proowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname <> '${releaseSchemaOwnerRoleName}'
        UNION ALL
        SELECT owner.rolname
        FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        JOIN pg_roles owner ON owner.oid = type.typowner
        WHERE namespace.nspname = 'public'
          AND type.typtype IN ('d', 'e', 'm', 'r')
          AND owner.rolname <> '${releaseSchemaOwnerRoleName}'
      ) unexpected_public_object_owners)
    )
  )`;
}

export function assertCanonicalRoleTopology(verifiedRoles) {
  const observedMatrixKeys = Array.isArray(verifiedRoles?.setRoleMatrix)
    ? new Set(
        verifiedRoles.setRoleMatrix.map(
          (entry) => `${entry.member}\u0000${entry.target}`,
        ),
      )
    : new Set();
  if (
    verifiedRoles?.callerCount !== 1 ||
    !Array.isArray(verifiedRoles.roles) ||
    verifiedRoles.roles.length !== canonicalRoleNames.length ||
    !Array.isArray(verifiedRoles.setRoleMatrix) ||
    verifiedRoles.setRoleMatrix.length !==
      canonicalRoleNames.length * canonicalRoleNames.length ||
    !Array.isArray(verifiedRoles.bootstrapMemberships) ||
    verifiedRoles.bootstrapMemberships.length !== canonicalRoleNames.length ||
    verifiedRoles.roles.some(
      (role) =>
        !canonicalRoleNames.includes(role.username) ||
        role.login !== true ||
        role.superuser !== false ||
        role.createDatabase !== false ||
        role.createRole !== false ||
        role.replication !== false ||
        role.bypassRls !== false ||
        role.canSetReleaseRole !==
          (role.username === "reviewrouter_release_migration"),
    ) ||
    new Set(verifiedRoles.roles.map((role) => role.username)).size !==
      canonicalRoleNames.length ||
    verifiedRoles.setRoleMatrix.some(
      (entry) =>
        !canonicalRoleNames.includes(entry.member) ||
        !canonicalRoleNames.includes(entry.target) ||
        entry.canSet !== (entry.member === entry.target),
    ) ||
    observedMatrixKeys.size !==
      canonicalRoleNames.length * canonicalRoleNames.length ||
    verifiedRoles.bootstrapMemberships.some(
      (entry) =>
        !canonicalRoleNames.includes(entry.granted) ||
        entry.member !== canonicalBootstrapRoleName ||
        entry.grantor === canonicalBootstrapRoleName ||
        entry.grantor === releaseSchemaOwnerRoleName ||
        canonicalRoleNames.includes(entry.grantor) ||
        entry.adminOption !== true ||
        entry.inheritOption !== false ||
        entry.setOption !== false,
    ) ||
    new Set(verifiedRoles.bootstrapMemberships.map((entry) => entry.granted))
      .size !== canonicalRoleNames.length ||
    new Set(verifiedRoles.bootstrapMemberships.map((entry) => entry.grantor))
      .size !== 1 ||
    verifiedRoles.guard?.username !== activationReceiptGuardRoleName ||
    verifiedRoles.guard?.login !== false ||
    verifiedRoles.guard?.superuser !== false ||
    verifiedRoles.guard?.createDatabase !== false ||
    verifiedRoles.guard?.createRole !== false ||
    verifiedRoles.guard?.replication !== false ||
    verifiedRoles.guard?.bypassRls !== false ||
    verifiedRoles.guard?.membershipCount !== 0 ||
    verifiedRoles.schemaOwner?.username !== releaseSchemaOwnerRoleName ||
    verifiedRoles.schemaOwner?.login !== false ||
    verifiedRoles.schemaOwner?.superuser !== false ||
    verifiedRoles.schemaOwner?.createDatabase !== false ||
    verifiedRoles.schemaOwner?.createRole !== false ||
    verifiedRoles.schemaOwner?.replication !== false ||
    verifiedRoles.schemaOwner?.bypassRls !== false ||
    verifiedRoles.schemaOwner?.migrationCanSet !== false ||
    verifiedRoles.schemaOwner?.bootstrapCanSet !== false ||
    verifiedRoles.ownership?.databaseOwner !== canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.publicSchemaOwner !== releaseSchemaOwnerRoleName ||
    verifiedRoles.ownership?.bootstrapSchemaOwner !==
      canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.bootstrapFunctionOwner !==
      canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.bootstrapFunctionCount !== 1 ||
    verifiedRoles.ownership?.unexpectedPublicObjectOwnerCount !== 0
  )
    throw new Error("release_migration_role_observation_failed");
  return verifiedRoles;
}

function observeCanonicalRoleTopology(run, url, env) {
  return assertCanonicalRoleTopology(
    JSON.parse(
      run(
        "verify_roles",
        "psql",
        [
          url,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--command",
          canonicalRoleTopologyObservationSql(),
        ],
        { env },
      ).trim(),
    ),
  );
}

export function canonicalDatabaseGenerationObservationSql() {
  return `SELECT json_build_object(
    'systemIdentifier', system.system_identifier::text,
    'recoveryWitnessSha256', binding.value->>'recoveryWitnessSha256'
  )
  FROM pg_control_system() system
  CROSS JOIN LATERAL (
    SELECT shobj_description(database.oid, 'pg_database')::jsonb AS value
    FROM pg_database database
    WHERE database.datname = current_database()
  ) binding`;
}

function observeDatabaseGeneration(run, url, env) {
  const generation = JSON.parse(
    run(
      "verify_database_generation",
      "psql",
      [
        url,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        canonicalDatabaseGenerationObservationSql(),
      ],
      { env },
    ).trim(),
  );
  if (
    !generation ||
    Object.keys(generation).length !== 2 ||
    typeof generation.systemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(generation.systemIdentifier ?? "") ||
    typeof generation.recoveryWitnessSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(generation.recoveryWitnessSha256 ?? "")
  ) {
    throw new Error("release_migration_database_generation_unproven");
  }
  return Object.freeze(generation);
}

export function resolveReleaseMigrationConfiguration(
  env,
  resolveDatabaseIdentity = databaseIdentity,
) {
  const releaseUrl = parseDatabaseUrl(
    required(env, "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL"),
  );
  if (
    decodeURIComponent(releaseUrl.username) !== "reviewrouter_release_migration"
  )
    throw new Error("release_migration_caller_role_mismatch");
  const identity = resolveDatabaseIdentity(releaseUrl);
  const releasePassword = decodeURIComponent(releaseUrl.password);
  if (!releasePassword)
    throw new Error("release_migration_release_password_missing");
  const roles = runtimeRoles.map(([role, username, environmentName]) => {
    const url = parseDatabaseUrl(required(env, environmentName));
    if (
      decodeURIComponent(url.username) !== username ||
      resolveDatabaseIdentity(url) !== identity
    )
      throw new Error(`release_migration_runtime_role_mismatch:${role}`);
    const password = decodeURIComponent(url.password);
    if (!password)
      throw new Error(`release_migration_runtime_password_missing:${role}`);
    return { environmentName, password, role, username };
  });
  const commit = required(env, "REVIEW_ROUTER_RELEASE_COMMIT_SHA");
  const imageDigest = required(env, "REVIEW_ROUTER_RELEASE_IMAGE_DIGEST");
  let applicationSchemas;
  try {
    applicationSchemas = JSON.parse(
      env.REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON ?? '["public"]',
    );
  } catch {
    throw new Error("release_migration_application_schemas_invalid");
  }
  if (
    !/^[a-f0-9]{40}$/u.test(commit) ||
    !/^sha256:[a-f0-9]{64}$/u.test(imageDigest) ||
    !Array.isArray(applicationSchemas) ||
    !applicationSchemas.length ||
    new Set(applicationSchemas).size !== applicationSchemas.length ||
    applicationSchemas.some(
      (schema) =>
        typeof schema !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema) ||
        schema === "information_schema" ||
        schema.startsWith("pg_"),
    )
  )
    throw new Error("release_migration_immutable_release_identity_invalid");
  return {
    commit,
    databaseIdentity: identity,
    imageDigest,
    releaseUrl: releaseUrl.toString(),
    releasePassword,
    roles,
    applicationSchemas,
  };
}

export function resolveRoleBootstrapConfiguration(env) {
  const configuration = resolveReleaseMigrationConfiguration(env);
  const bootstrapUrl = parseDatabaseUrl(
    required(env, "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL"),
  );
  if (
    decodeURIComponent(bootstrapUrl.username) !== "reviewrouter_role_bootstrap"
  )
    throw new Error("release_migration_bootstrap_role_mismatch");
  if (databaseIdentity(bootstrapUrl) !== configuration.databaseIdentity)
    throw new Error("release_migration_bootstrap_database_mismatch");
  if (!decodeURIComponent(bootstrapUrl.password))
    throw new Error("release_migration_bootstrap_password_missing");
  return { ...configuration, bootstrapUrl: bootstrapUrl.toString() };
}

export function roleProvisioningSql(
  configuration,
  { ownerAuthorizedInitialRuntimeGateClosed = false } = {},
) {
  assertCanonicalRuntimeRoleConfiguration(configuration);
  if (typeof ownerAuthorizedInitialRuntimeGateClosed !== "boolean")
    throw new Error("release_migration_initial_runtime_gate_mode_invalid");
  const reconciliationPrerequisiteIndex =
    atomicReleaseMigrationEntries.findIndex(
      ([migrationName]) =>
        migrationName === "000064_codex_oauth_versioned_secret_namespaces",
    );
  if (reconciliationPrerequisiteIndex !== 4)
    throw new Error("release_migration_reconciliation_boundary_invalid");
  const guardedPreReconciliationBundle = guardedAtomicReleaseMigrationBundleSql(
    atomicReleaseMigrationEntries.slice(0, reconciliationPrerequisiteIndex + 1),
  );
  const guardedPostReconciliationBundle =
    guardedAtomicReleaseMigrationBundleSql(
      atomicReleaseMigrationEntries.slice(reconciliationPrerequisiteIndex + 1),
    );
  const guardedGrants = guardOwnedRuntimeGrantSql();
  const guardedAclGate = guardOwnedRuntimeAclGateSql(configuration);
  // Initial bootstrap runs with database-owner authority before the guarded
  // helper chain exists. These static statements establish the first
  // canonical database ACL; later phase transitions must use the helper.
  const initialRuntimeGrants = runtimeGrantStatements(configuration);
  const initialRuntimeAclGate = runtimeAclGateStatements(configuration);
  const runtimeRoleLiterals = configuration.roles
    .map(({ username }) => quoted(username))
    .join(",");
  const guardedLegacyReconciliation = `${guardedLegacyAmbiguityReconciliationProcedureSql(
    releaseSchemaOwnerRoleName,
  )}`;
  const createAndConverge = [
    ...configuration.roles,
    {
      username: "reviewrouter_release_migration",
      password: configuration.releasePassword,
    },
  ]
    .map(
      ({ username, password }) => `
DO $role$
DECLARE observed record;
BEGIN
  SELECT * INTO observed FROM pg_roles WHERE rolname = '${username}';
  IF NOT FOUND THEN
    CREATE ROLE ${username} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted(password)};
  ELSIF observed.rolsuper
     OR observed.rolcreatedb
     OR observed.rolreplication
     OR observed.rolbypassrls THEN
    RAISE EXCEPTION 'refusing to converge unexpectedly privileged role ${username}';
  END IF;
END
$role$;
ALTER ROLE ${username} LOGIN NOCREATEROLE PASSWORD ${quoted(password)};
DO $membership$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name,
      grantor.rolname AS grantor_name
    FROM pg_auth_members edge
    JOIN pg_roles granted ON granted.oid = edge.roleid
    JOIN pg_roles member ON member.oid = edge.member
    JOIN pg_roles grantor ON grantor.oid = edge.grantor
    WHERE (granted.rolname = '${username}' OR member.rolname = '${username}')
      AND NOT (
        granted.rolname = '${username}'
        AND member.rolname = 'reviewrouter_role_bootstrap'
      )
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY %I CASCADE',
      membership.granted_name,
      membership.member_name,
      membership.grantor_name
    );
  END LOOP;
END
$membership$;
`,
    )
    .join("\n");
  return `\\set ON_ERROR_STOP on
BEGIN;
${activationMigrationExclusionSql}
DO $trusted_bootstrap_authority$
DECLARE observed pg_roles%ROWTYPE;
BEGIN
  IF current_user <> '${canonicalBootstrapRoleName}'
     OR session_user <> '${canonicalBootstrapRoleName}' THEN
    RAISE EXCEPTION 'trusted role provisioning caller is invalid';
  END IF;
  SELECT * INTO observed FROM pg_roles
  WHERE rolname='${canonicalBootstrapRoleName}';
  IF NOT FOUND OR observed.rolcanlogin IS DISTINCT FROM true
     OR observed.rolsuper IS DISTINCT FROM true OR observed.rolcreatedb
     OR observed.rolcreaterole IS DISTINCT FROM true
     OR observed.rolreplication OR observed.rolbypassrls THEN
    RAISE EXCEPTION 'trusted role bootstrap authority is not exact';
  END IF;
END
$trusted_bootstrap_authority$;
DO $receipt_guard$
DECLARE observed record;
BEGIN
  SELECT * INTO observed
  FROM pg_roles
  WHERE rolname = '${activationReceiptGuardRoleName}';
  IF NOT FOUND
     OR observed.rolcanlogin
     OR observed.rolsuper
     OR observed.rolcreatedb
     OR observed.rolcreaterole
     OR observed.rolreplication
     OR observed.rolbypassrls THEN
    RAISE EXCEPTION 'external activation receipt guard is not pre-provisioned canonically';
  END IF;
END
$receipt_guard$;
DO $receipt_guard_membership$
DECLARE total_count integer;
BEGIN
  SELECT count(*) INTO total_count
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles grantor ON grantor.oid = membership.grantor
  WHERE granted.rolname = '${activationReceiptGuardRoleName}'
     OR member.rolname = '${activationReceiptGuardRoleName}';
  IF total_count <> 0 THEN
    RAISE EXCEPTION 'activation receipt guard must have no membership edges';
  END IF;
END
$receipt_guard_membership$;
DO $schema_owner$
DECLARE observed record;
BEGIN
  SELECT * INTO observed FROM pg_roles
  WHERE rolname='${releaseSchemaOwnerRoleName}';
  IF NOT FOUND THEN
    CREATE ROLE ${releaseSchemaOwnerRoleName} NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF observed.rolcanlogin OR observed.rolsuper OR observed.rolcreatedb
     OR observed.rolcreaterole OR observed.rolreplication
     OR observed.rolbypassrls THEN
    RAISE EXCEPTION 'release schema owner is not canonical';
  END IF;
END
$schema_owner$;
${createAndConverge}
DO $grantor_topology$
DECLARE total_count integer;
DECLARE canonical_count integer;
DECLARE schema_owner_handoff_count integer;
DECLARE granted_role_count integer;
DECLARE grantor_count integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (
             WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND member.rolname = '${canonicalBootstrapRoleName}'
             AND grantor.rolname <> '${canonicalBootstrapRoleName}'
             AND grantor.rolname <> ALL (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND membership.admin_option
             AND NOT membership.inherit_option
             AND NOT membership.set_option
         ),
         count(*) FILTER (
             WHERE granted.rolname = '${releaseSchemaOwnerRoleName}'
             AND member.rolname = '${canonicalBootstrapRoleName}'
             AND grantor.rolname <> '${canonicalBootstrapRoleName}'
             AND grantor.rolname <> '${releaseSchemaOwnerRoleName}'
             AND grantor.rolname <> ALL (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND membership.admin_option
             AND NOT membership.inherit_option
             AND membership.set_option
         ),
         count(DISTINCT granted.oid) FILTER (
             WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND member.rolname = '${canonicalBootstrapRoleName}'
         ),
         count(DISTINCT grantor.oid) FILTER (
             WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND member.rolname = '${canonicalBootstrapRoleName}'
         )
  INTO total_count, canonical_count, schema_owner_handoff_count,
       granted_role_count, grantor_count
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles grantor ON grantor.oid = membership.grantor
  WHERE (
      granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
      OR member.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
      OR granted.rolname = '${releaseSchemaOwnerRoleName}'
      OR member.rolname = '${releaseSchemaOwnerRoleName}'
      OR grantor.rolname = '${releaseSchemaOwnerRoleName}'
      OR granted.rolname = '${canonicalBootstrapRoleName}'
      OR member.rolname = '${canonicalBootstrapRoleName}'
    )
    AND granted.rolname <> '${activationReceiptGuardRoleName}'
    AND member.rolname <> '${activationReceiptGuardRoleName}'
  ;
  IF total_count <> ${canonicalRoleNames.length + 1}
     OR canonical_count <> ${canonicalRoleNames.length}
     OR schema_owner_handoff_count <> 1
     OR granted_role_count <> ${canonicalRoleNames.length}
     OR grantor_count <> 1 THEN
    RAISE EXCEPTION
      'refusing non-canonical role membership topology: total %, canonical %, schema owner handoff %, roles %, grantors %',
      total_count, canonical_count, schema_owner_handoff_count,
      granted_role_count, grantor_count;
  END IF;
END
$grantor_topology$;
SELECT 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'
WHERE EXISTS (
  SELECT 1
  FROM pg_namespace namespace,
       LATERAL aclexplode(coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
  WHERE namespace.nspname = 'public'
    AND acl.grantee = 0
    AND acl.privilege_type = 'CREATE'
)
\\gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database())
\\gexec
SELECT format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM reviewrouter_release_migration', current_database())
\\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO reviewrouter_release_migration', current_database())
\\gexec
SELECT format('GRANT CREATE ON DATABASE %I TO ${releaseSchemaOwnerRoleName}', current_database())
\\gexec
SELECT format('GRANT TEMPORARY ON DATABASE %I TO ${releaseSchemaOwnerRoleName}', current_database())
\\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ${releaseSchemaOwnerRoleName} WITH GRANT OPTION', current_database())
\\gexec
DO $database_delegation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_database database,
         LATERAL aclexplode(coalesce(database.datacl, acldefault('d', database.datdba))) acl
    WHERE database.datname = current_database()
      AND acl.grantee = '${releaseSchemaOwnerRoleName}'::regrole
      AND acl.privilege_type = 'CONNECT'
      AND acl.is_grantable
  ) OR NOT has_database_privilege(
    '${releaseSchemaOwnerRoleName}',current_database(),'CREATE'
  ) OR NOT has_database_privilege(
    '${releaseSchemaOwnerRoleName}',current_database(),'TEMP'
  ) OR EXISTS (
    SELECT 1
    FROM pg_database database,
         LATERAL aclexplode(coalesce(database.datacl, acldefault('d', database.datdba))) acl
    WHERE database.datname = current_database()
      AND acl.grantee = 'reviewrouter_release_migration'::regrole
      AND (acl.privilege_type = 'CREATE' OR acl.is_grantable)
  ) THEN
    RAISE EXCEPTION 'release migration database delegation is non-canonical';
  END IF;
END
$database_delegation$;
GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;
GRANT USAGE, CREATE ON SCHEMA public TO ${releaseSchemaOwnerRoleName};
DO $ownership$
DECLARE unexpected_owner text;
BEGIN
  SELECT owner_name INTO unexpected_owner
  FROM (
    SELECT owner.rolname AS owner_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT owner.rolname AS owner_name
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE namespace.nspname = 'public'
    UNION ALL
    SELECT owner.rolname AS owner_name
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_roles owner ON owner.oid = type.typowner
    WHERE namespace.nspname = 'public'
      AND type.typtype IN ('d', 'e', 'm', 'r')
  ) owned
  WHERE owner_name NOT IN ('reviewrouter_role_bootstrap',
    'reviewrouter_release_migration','${releaseSchemaOwnerRoleName}')
  ORDER BY owner_name
  LIMIT 1;
  IF unexpected_owner IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to take over public objects owned by unexpected role %', unexpected_owner;
  END IF;
END
$ownership$;
SELECT reviewrouter_activation.assert_no_activation_receipt();
DROP FUNCTION IF EXISTS reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text);
DROP FUNCTION IF EXISTS reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text);
DO $transfer_public_ownership$
DECLARE owned_object record;
BEGIN
  FOR owned_object IN
    SELECT relation.oid, relation.relkind
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_role_bootstrap'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND (
        relation.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend dependency
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = relation.oid
            AND dependency.refclassid = 'pg_class'::regclass
            AND dependency.deptype IN ('a', 'i')
        )
      )
  LOOP
    EXECUTE CASE owned_object.relkind
      WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      WHEN 'v' THEN format('ALTER VIEW %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      ELSE format('ALTER TABLE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
    END;
  END LOOP;
  FOR owned_object IN
    SELECT routine.oid
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_role_bootstrap'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regprocedure);
  END LOOP;
  FOR owned_object IN
    SELECT type.typname, type.typtype
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_roles owner ON owner.oid = type.typowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_role_bootstrap'
      AND type.typtype IN ('d', 'e', 'm', 'r')
  LOOP
    IF owned_object.typtype = 'd' THEN
      EXECUTE format('ALTER DOMAIN public.%I OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.typname);
    ELSE
      EXECUTE format('ALTER TYPE public.%I OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.typname);
    END IF;
  END LOOP;
END
$transfer_public_ownership$;
-- The release LOGIN owns objects created by Prisma migrations. Admit a SET
-- path only in this uncommitted transaction so the current session can act as
-- that owner, and give that current role the equally transaction-local SET
-- path required by ALTER ... OWNER TO. Other sessions cannot observe either
-- edge, and every later failure rolls their creation back with the transfer.
GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_ROLE;
GRANT ${releaseSchemaOwnerRoleName} TO reviewrouter_release_migration
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SET LOCAL ROLE reviewrouter_release_migration;
DO $transfer_release_public_ownership$
DECLARE owned_object record;
BEGIN
  FOR owned_object IN
    SELECT relation.oid, relation.relkind
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_release_migration'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND (
        relation.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend dependency
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = relation.oid
            AND dependency.refclassid = 'pg_class'::regclass
            AND dependency.deptype IN ('a', 'i')
        )
      )
  LOOP
    EXECUTE CASE owned_object.relkind
      WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      WHEN 'v' THEN format('ALTER VIEW %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
      ELSE format('ALTER TABLE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regclass)
    END;
  END LOOP;
  FOR owned_object IN
    SELECT routine.oid
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_release_migration'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.oid::regprocedure);
  END LOOP;
  FOR owned_object IN
    SELECT type.typname, type.typtype
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_roles owner ON owner.oid = type.typowner
    WHERE namespace.nspname = 'public'
      AND owner.rolname = 'reviewrouter_release_migration'
      AND type.typtype IN ('d', 'e', 'm', 'r')
  LOOP
    IF owned_object.typtype = 'd' THEN
      EXECUTE format('ALTER DOMAIN public.%I OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.typname);
    ELSE
      EXECUTE format('ALTER TYPE public.%I OWNER TO ${releaseSchemaOwnerRoleName}', owned_object.typname);
    END IF;
  END LOOP;
END
$transfer_release_public_ownership$;
RESET ROLE;
DO $release_owner_transfer_edge_cleanup$
DECLARE edge record;
DECLARE canonical_count integer;
BEGIN
  FOR edge IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name,
      grantor.rolname AS grantor_name
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles grantor ON grantor.oid = membership.grantor
    WHERE granted.rolname = 'reviewrouter_release_migration'
      AND member.rolname = '${canonicalBootstrapRoleName}'
      AND grantor.rolname = '${canonicalBootstrapRoleName}'
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE',
      edge.granted_name,edge.member_name,edge.grantor_name);
  END LOOP;
  SELECT count(*) FILTER (
    WHERE grantor.rolname <> '${canonicalBootstrapRoleName}'
      AND grantor.rolname <> ALL (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
  ) INTO canonical_count
  FROM pg_auth_members membership
  JOIN pg_roles grantor ON grantor.oid=membership.grantor
  WHERE membership.roleid='reviewrouter_release_migration'::regrole
    AND membership.member='${canonicalBootstrapRoleName}'::regrole;
  IF EXISTS (
      SELECT 1 FROM pg_auth_members membership
      WHERE membership.roleid='reviewrouter_release_migration'::regrole
        AND membership.member='${canonicalBootstrapRoleName}'::regrole
        AND membership.grantor='${canonicalBootstrapRoleName}'::regrole
    ) OR canonical_count <> 1 THEN
    RAISE EXCEPTION
      'temporary release owner transfer cleanup or canonical membership failed';
  END IF;
END
$release_owner_transfer_edge_cleanup$;
DO $public_ownership_converged$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT relation.relowner AS owner_oid
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL
      SELECT routine.proowner
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT type.typowner
      FROM pg_type type
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public'
        AND type.typtype IN ('d', 'e', 'm', 'r')
    ) owned
    WHERE pg_get_userbyid(owned.owner_oid) <> '${releaseSchemaOwnerRoleName}'
  ) THEN
    RAISE EXCEPTION 'public ownership convergence did not reach the release schema owner';
  END IF;
END
$public_ownership_converged$;
SELECT 'ALTER SCHEMA public OWNER TO ${releaseSchemaOwnerRoleName}'
WHERE (SELECT owner.rolname FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname = 'public') <> '${releaseSchemaOwnerRoleName}'
\\gexec
-- Routine ownership changes and ACL changes are both immediately visible to
-- later commands in this transaction. Canonicalize as the final owner before
-- dropping bootstrap's temporary SET edge; a later exception would roll this
-- convergence back together with the ownership transfer.
GRANT CREATE ON SCHEMA reviewrouter_activation
  TO ${releaseSchemaOwnerRoleName};
SET LOCAL ROLE ${releaseSchemaOwnerRoleName};
${guardedLegacyReconciliation}
DROP PROCEDURE IF EXISTS public.reviewrouter_execute_release_migration(
  text,text,text,text,text,bigint,text,jsonb);
DROP PROCEDURE IF EXISTS public.reviewrouter_execute_release_migration(
  text,text,text,text,text,bigint,text,jsonb,boolean);
DROP PROCEDURE IF EXISTS public.reviewrouter_execute_release_migration(
  text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean);
CREATE OR REPLACE PROCEDURE public.reviewrouter_execute_release_migration(
  requested_rollout_id text,
  requested_target_system_identifier text,
  requested_target_recovery_witness_sha256 text,
  requested_transition_sha256 text,
  requested_previous_receipt_sha256 text,
  requested_permit_epoch bigint,
  requested_permit_nonce text,
  requested_source_legacy_ambiguity jsonb,
  requested_eligibility_cutoff timestamptz,
  requested_acl_gate_closed boolean,
  requested_catalog_capture_only boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_catalog remains implicitly first for name resolution. Keeping it out of
-- the explicit path makes public the creation target for unqualified DDL.
SET search_path = public, pg_temp
AS $rr_guarded_release_executor_v1$
DECLARE permit_result text;
DECLARE requested_inventory jsonb;
DECLARE observed_inventory jsonb;
DECLARE capture_binding jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration' THEN
    RAISE EXCEPTION 'release migration executor caller invalid';
  END IF;
  IF requested_acl_gate_closed IS NULL OR requested_catalog_capture_only IS NULL THEN
    RAISE EXCEPTION 'release migration executor ACL gate mode invalid';
  END IF;
  IF requested_catalog_capture_only THEN
    SELECT pg_catalog.shobj_description(database.oid,'pg_database')::jsonb
    INTO STRICT capture_binding
    FROM pg_catalog.pg_database database
    WHERE database.datname=pg_catalog.current_database();
    IF pg_catalog.current_setting(
         'reviewrouter.activation_catalog_candidate_capture',true
       ) IS DISTINCT FROM 'disposable-only'
       OR capture_binding->'disposableCaptureAttestation'->>'kind'
          IS DISTINCT FROM 'reviewrouter-disposable-database-attestation-v1'
       OR capture_binding->'disposableCaptureAttestation'->>'identity'
          IS DISTINCT FROM pg_catalog.current_setting(
            'reviewrouter.activation_catalog_disposable_database_identity',true
          )
       OR capture_binding->'disposableCaptureAttestation'->>'systemIdentifier'
          IS DISTINCT FROM requested_target_system_identifier
       OR capture_binding->'disposableCaptureAttestation'->>'recoveryWitnessSha256'
          IS DISTINCT FROM requested_target_recovery_witness_sha256
    THEN RAISE EXCEPTION 'release migration catalog capture target invalid'; END IF;
  END IF;
  permit_result := reviewrouter_activation.consume_migration_permit(
    requested_rollout_id,requested_target_system_identifier,
    requested_target_recovery_witness_sha256,requested_transition_sha256,
    requested_previous_receipt_sha256,requested_source_legacy_ambiguity,
    requested_eligibility_cutoff,requested_permit_epoch,
    requested_permit_nonce);
  IF permit_result='replay' THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[${runtimeRoleLiterals}]) AS roles(role_name)
      WHERE pg_catalog.has_database_privilege(
        role_name,pg_catalog.current_database(),'CONNECT'
      ) IS DISTINCT FROM NOT requested_acl_gate_closed
    ) THEN
      RAISE EXCEPTION 'release migration executor replay ACL gate mode conflict';
    END IF;
    RETURN;
  END IF;
  IF permit_result IS DISTINCT FROM 'execute' THEN
    RAISE EXCEPTION 'release migration executor permit invalid';
  END IF;
  IF jsonb_typeof(requested_source_legacy_ambiguity) IS DISTINCT FROM 'object'
     OR requested_source_legacy_ambiguity->'stable' IS DISTINCT FROM 'true'::jsonb
     OR jsonb_array_length(requested_source_legacy_ambiguity->'observations') <> 2
  THEN RAISE EXCEPTION 'legacy_reconciliation_source_evidence_invalid'; END IF;
  requested_inventory := jsonb_build_object(
    'activeLeaseIds',requested_source_legacy_ambiguity->'activeLeaseIds',
    'fetchedSetupIds',requested_source_legacy_ambiguity->'fetchedSetupIds',
    'pendingIntentIds',requested_source_legacy_ambiguity->'pendingIntentIds',
    'intentStatuses',requested_source_legacy_ambiguity->'intentStatuses');
  LOCK TABLE public."CodexOAuthProviderInstance" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public."RepositoryConnection" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public."CodexOAuthSetupManifest" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public."CodexOAuthLease" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public."CodexOAuthWritebackIntent" IN SHARE ROW EXCLUSIVE MODE;
  SELECT jsonb_build_object(
    'activeLeaseIds',coalesce((SELECT jsonb_agg("id" ORDER BY "id") FROM public."CodexOAuthLease" WHERE "status" IN ('preleased','finalized')),'[]'::jsonb),
    'fetchedSetupIds',coalesce((SELECT jsonb_agg("id" ORDER BY "id") FROM public."CodexOAuthSetupManifest" WHERE "status"='fetched'),'[]'::jsonb),
    'pendingIntentIds',coalesce((SELECT jsonb_agg("id" ORDER BY "id") FROM public."CodexOAuthWritebackIntent" WHERE "status"='pending'),'[]'::jsonb),
    'intentStatuses',coalesce((SELECT jsonb_agg(DISTINCT "status" ORDER BY "status") FROM public."CodexOAuthWritebackIntent"),'[]'::jsonb))
  INTO STRICT observed_inventory;
  IF EXISTS (SELECT 1 FROM public."CodexOAuthWritebackIntent"
             WHERE "status" NOT IN ('completed','failed','pending','remote_outcome_unknown'))
  THEN RAISE EXCEPTION 'legacy_reconciliation_intent_status_unclassified'; END IF;
  IF observed_inventory IS DISTINCT FROM requested_inventory
  THEN RAISE EXCEPTION 'legacy_reconciliation_inventory_changed'; END IF;
${guardedPreReconciliationBundle}
  CALL public.reviewrouter_reconcile_legacy_ambiguity(
    requested_rollout_id,requested_target_recovery_witness_sha256,
    requested_inventory,
    requested_source_legacy_ambiguity->>'inventorySha256',
    requested_eligibility_cutoff);
${guardedPostReconciliationBundle}
${guardedGrants}
  IF requested_acl_gate_closed THEN
${guardedAclGate}
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[${runtimeRoleLiterals}]) AS roles(role_name)
    WHERE pg_catalog.has_database_privilege(
      role_name,pg_catalog.current_database(),'CONNECT'
    ) IS DISTINCT FROM NOT requested_acl_gate_closed
  ) THEN
    RAISE EXCEPTION 'release migration executor runtime CONNECT gate mismatch';
  END IF;
  IF requested_acl_gate_closed AND (
    EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[${runtimeRoleLiterals}]) AS roles(role_name)
      CROSS JOIN pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid=relation.relnamespace
      CROSS JOIN pg_catalog.unnest(
        ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']
      ) AS privileges(privilege)
      WHERE namespace.nspname='public'
        AND relation.relkind IN ('r','p','v','m','f')
        AND pg_catalog.has_table_privilege(role_name,relation.oid,privilege)
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[${runtimeRoleLiterals}]) AS roles(role_name)
      CROSS JOIN pg_catalog.pg_class sequence
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid=sequence.relnamespace
      CROSS JOIN pg_catalog.unnest(ARRAY['USAGE','UPDATE'])
        AS privileges(privilege)
      WHERE namespace.nspname='public' AND sequence.relkind='S'
        AND pg_catalog.has_sequence_privilege(role_name,sequence.oid,privilege)
    )
  ) THEN
    RAISE EXCEPTION 'release migration executor runtime write gate mismatch';
  END IF;
  IF NOT requested_catalog_capture_only THEN
    PERFORM reviewrouter_activation.complete_migration_permit(
      requested_rollout_id,requested_permit_epoch,requested_permit_nonce,
      '{}'::jsonb);
  END IF;
END
$rr_guarded_release_executor_v1$;
REVOKE ALL ON PROCEDURE public.reviewrouter_execute_release_migration(
  text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON PROCEDURE public.reviewrouter_execute_release_migration(
  text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean,boolean) TO reviewrouter_release_migration;
DO $transferred_public_routine_acl$
DECLARE routine_row record;
BEGIN
  FOR routine_row IN
    SELECT catalog_routine.oid
    FROM pg_proc catalog_routine
    JOIN pg_namespace namespace ON namespace.oid = catalog_routine.pronamespace
    WHERE namespace.nspname = 'public'
    ORDER BY catalog_routine.oid
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ROUTINE %s FROM ${activationReceiptReaderRoleName}',
      routine_row.oid::regprocedure
    );
    EXECUTE format(
      'REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC',
      routine_row.oid::regprocedure
    );
  END LOOP;
END
$transferred_public_routine_acl$;
DO $transferred_public_routine_acl_gate$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND has_function_privilege(
        '${activationReceiptReaderRoleName}', routine.oid, 'EXECUTE'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) acl
    WHERE namespace.nspname = 'public'
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'transferred public routine ACL is non-canonical';
  END IF;
END
$transferred_public_routine_acl_gate$;
${
  ownerAuthorizedInitialRuntimeGateClosed
    ? `-- A fresh target may need its first canonical ACL projection before the
-- external permit can bind the expected post-catalog digest. This executes
-- only while the transaction-local schema-owner SET edge is active. The
-- guarded executor must still consume and complete a one-shot permit below.
${initialRuntimeGrants}
${initialRuntimeAclGate}`
    : ""
}
GRANT EXECUTE ON PROCEDURE public.reviewrouter_execute_release_migration(
  text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean,boolean) TO reviewrouter_release_migration;
GRANT SELECT ON TABLE public._prisma_migrations TO reviewrouter_release_migration;
GRANT SELECT ("id","status") ON TABLE public."CodexOAuthLease",
  public."CodexOAuthSetupManifest", public."CodexOAuthWritebackIntent"
  TO reviewrouter_release_migration;
RESET ROLE;
REVOKE CREATE ON SCHEMA reviewrouter_activation
  FROM ${releaseSchemaOwnerRoleName};
CREATE SCHEMA IF NOT EXISTS reviewrouter_bootstrap AUTHORIZATION reviewrouter_role_bootstrap;
DO $bootstrap_schema$
BEGIN
  IF (SELECT owner.rolname FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname = 'reviewrouter_bootstrap') <> 'reviewrouter_role_bootstrap' THEN
    RAISE EXCEPTION 'reviewrouter bootstrap schema owner is invalid';
  END IF;
END
$bootstrap_schema$;
REVOKE ALL ON SCHEMA reviewrouter_bootstrap FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_bootstrap TO reviewrouter_release_migration;
DO $activation_authority_boundary$
DECLARE failed_invariant text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(
      coalesce(routine.proacl, acldefault('f', routine.proowner))
    ) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE routine.oid =
      'reviewrouter_activation.read_activation_migration_manifest_identity()'::regprocedure
      AND acl.privilege_type = 'EXECUTE'
      AND (
        acl.grantee = 0
        OR grantee.rolname NOT IN (
          '${activationReceiptGuardRoleName}',
          '${activationPermitInstallerRoleName}',
          '${activationReceiptReaderRoleName}',
          'reviewrouter_release_migration'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'activation_authority_boundary:unrelated_principal_manifest_identity_execute_present';
  END IF;
  IF NOT has_function_privilege(
    '${activationPermitInstallerRoleName}',
    'reviewrouter_activation.read_activation_migration_manifest_identity()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    '${activationReceiptReaderRoleName}',
    'reviewrouter_activation.read_activation_migration_manifest_identity()',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'reviewrouter_release_migration',
    'reviewrouter_activation.read_activation_migration_manifest_identity()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'activation_authority_boundary:required_manifest_identity_execute_missing';
  END IF;
  IF NOT has_function_privilege(
    '${activationReceiptReaderRoleName}',
    'reviewrouter_activation.read_migration_receipt(text,bigint,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'activation_authority_boundary:receipt_reader_migration_receipt_execute_missing';
  END IF;
  CASE
    WHEN to_regclass('reviewrouter_activation.activation_permit') IS NULL THEN
      failed_invariant := 'activation_permit_relation_missing';
    WHEN to_regclass('reviewrouter_activation.activation_receipt') IS NULL THEN
      failed_invariant := 'activation_receipt_relation_missing';
    WHEN to_regclass('reviewrouter_activation.activation_principal_evidence') IS NULL THEN
      failed_invariant := 'activation_principal_evidence_relation_missing';
    WHEN to_regclass('reviewrouter_activation.migration_permit') IS NULL THEN
      failed_invariant := 'migration_permit_relation_missing';
    WHEN to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)') IS NULL THEN
      failed_invariant := 'install_activation_permit_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.project_effective_principal_authority(text)') IS NULL THEN
      failed_invariant := 'project_effective_principal_authority_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)') IS NULL THEN
      failed_invariant := 'validate_principal_evidence_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)') IS NULL THEN
      failed_invariant := 'stage_principal_evidence_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.activate_generation(text)') IS NULL THEN
      failed_invariant := 'activate_generation_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()') IS NULL THEN
      failed_invariant := 'capture_catalog_policy_candidate_pair_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.apply_runtime_acl()') IS NULL THEN
      failed_invariant := 'apply_runtime_acl_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.apply_runtime_database_acl(text)') IS NULL THEN
      failed_invariant := 'apply_runtime_database_acl_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.capture_runtime_acl_policy_pair()') IS NULL THEN
      failed_invariant := 'capture_runtime_acl_policy_pair_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NULL THEN
      failed_invariant := 'read_activation_receipt_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()') IS NULL THEN
      failed_invariant := 'assert_no_activation_receipt_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)') IS NULL THEN
      failed_invariant := 'install_migration_permit_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)') IS NULL THEN
      failed_invariant := 'consume_migration_permit_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)') IS NULL THEN
      failed_invariant := 'complete_migration_permit_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)') IS NULL THEN
      failed_invariant := 'terminalize_migration_permit_routine_missing';
    WHEN to_regprocedure('reviewrouter_activation.read_migration_receipt(text,bigint,text)') IS NULL THEN
      failed_invariant := 'read_migration_receipt_routine_missing';
    ELSE NULL;
  END CASE;
  IF failed_invariant IS NULL THEN
    CASE
      WHEN pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='reviewrouter_activation.activation_permit'::regclass)) <> '${activationReceiptGuardRoleName}' THEN
        failed_invariant := 'activation_permit_owner_mismatch';
      WHEN pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='reviewrouter_activation.activation_receipt'::regclass)) <> '${activationReceiptGuardRoleName}' THEN
        failed_invariant := 'activation_receipt_owner_mismatch';
      WHEN pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='reviewrouter_activation.activation_principal_evidence'::regclass)) <> '${activationReceiptGuardRoleName}' THEN
        failed_invariant := 'activation_principal_evidence_owner_mismatch';
      WHEN pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='reviewrouter_activation.migration_permit'::regclass)) <> '${activationReceiptGuardRoleName}' THEN
        failed_invariant := 'migration_permit_owner_mismatch';
      ELSE NULL;
    END CASE;
  END IF;
  IF failed_invariant IS NULL THEN
    CASE
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)','EXECUTE') THEN
        failed_invariant := 'release_migration_install_activation_permit_execute_present';
      WHEN has_function_privilege('${activationPermitInstallerRoleName}','reviewrouter_activation.activate_generation(text)','EXECUTE') THEN
        failed_invariant := 'permit_installer_activate_generation_execute_present';
      WHEN has_function_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.activate_generation(text)','EXECUTE') THEN
        failed_invariant := 'receipt_reader_activate_generation_execute_present';
      WHEN has_function_privilege('${activationPermitInstallerRoleName}','reviewrouter_activation.stage_principal_evidence(text)','EXECUTE') THEN
        failed_invariant := 'permit_installer_stage_principal_evidence_execute_present';
      WHEN has_function_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.stage_principal_evidence(text)','EXECUTE') THEN
        failed_invariant := 'receipt_reader_stage_principal_evidence_execute_present';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.project_effective_principal_authority(text)','EXECUTE') THEN
        failed_invariant := 'release_migration_project_authority_execute_present';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.validate_principal_evidence(text,bigint)','EXECUTE') THEN
        failed_invariant := 'release_migration_validate_principal_evidence_execute_present';
      WHEN has_function_privilege('${activationPermitInstallerRoleName}','reviewrouter_activation.canonical_json(jsonb)','EXECUTE') THEN
        failed_invariant := 'permit_installer_canonical_json_execute_present';
      WHEN has_function_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.canonical_json(jsonb)','EXECUTE') THEN
        failed_invariant := 'receipt_reader_canonical_json_execute_present';
      WHEN NOT has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.stage_principal_evidence(text)','EXECUTE') THEN
        failed_invariant := 'release_migration_stage_principal_evidence_execute_missing';
      WHEN NOT has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.activate_generation(text)','EXECUTE') THEN
        failed_invariant := 'release_migration_activate_generation_execute_missing';
      WHEN NOT has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.capture_catalog_policy_candidate_pair()','EXECUTE') THEN
        failed_invariant := 'release_migration_capture_catalog_policy_candidate_pair_execute_missing';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.apply_runtime_acl()','EXECUTE') THEN
        failed_invariant := 'release_migration_apply_runtime_acl_execute_present';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.apply_runtime_database_acl(text)','EXECUTE') THEN
        failed_invariant := 'release_migration_apply_runtime_database_acl_execute_present';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.capture_runtime_acl_policy_pair()','EXECUTE') THEN
        failed_invariant := 'release_migration_capture_runtime_acl_policy_pair_execute_present';
      WHEN NOT has_function_privilege('${activationReceiptGuardRoleName}','reviewrouter_activation.apply_runtime_acl()','EXECUTE') THEN
        failed_invariant := 'activation_guard_apply_runtime_acl_execute_missing';
      WHEN NOT has_function_privilege('${activationReceiptGuardRoleName}','reviewrouter_activation.capture_runtime_acl_policy_pair()','EXECUTE') THEN
        failed_invariant := 'activation_guard_capture_runtime_acl_policy_pair_execute_missing';
      WHEN NOT has_function_privilege('${releaseSchemaOwnerRoleName}','reviewrouter_activation.apply_runtime_database_acl(text)','EXECUTE') THEN
        failed_invariant := 'schema_owner_apply_runtime_database_acl_execute_missing';
      WHEN NOT has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.read_activation_receipt(text)','EXECUTE') THEN
        failed_invariant := 'release_migration_read_activation_receipt_execute_missing';
      WHEN has_table_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.activation_receipt','SELECT') THEN
        failed_invariant := 'receipt_reader_activation_receipt_select_present';
      -- Bootstrap is intentionally still a superuser until the final atomic
      -- cleanup/demotion. has_table_privilege() would therefore always report
      -- true here even with no ACL. Inspect the exact catalog grant instead;
      -- the post-commit connection proof separately rejects surviving
      -- superuser authority.
      WHEN EXISTS (
        SELECT 1
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(
          coalesce(relation.relacl, acldefault('r', relation.relowner))
        ) acl
        WHERE relation.oid=
          'reviewrouter_activation.activation_receipt'::regclass
          AND acl.grantee='${canonicalBootstrapRoleName}'::regrole
          AND acl.privilege_type='SELECT'
      ) THEN
        failed_invariant := 'bootstrap_activation_receipt_select_present';
      WHEN NOT has_function_privilege('${canonicalBootstrapRoleName}','reviewrouter_activation.assert_no_activation_receipt()','EXECUTE') THEN
        failed_invariant := 'bootstrap_assert_no_activation_receipt_execute_missing';
      WHEN NOT has_function_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.read_activation_receipt(text)','EXECUTE') THEN
        failed_invariant := 'receipt_reader_read_activation_receipt_execute_missing';
      WHEN NOT has_function_privilege('${activationPermitInstallerRoleName}','reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)','EXECUTE') THEN
        failed_invariant := 'permit_installer_install_migration_permit_execute_missing';
      WHEN NOT has_function_privilege('${activationPermitInstallerRoleName}','reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)','EXECUTE') THEN
        failed_invariant := 'permit_installer_terminalize_migration_permit_execute_missing';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)','EXECUTE') THEN
        failed_invariant := 'release_migration_consume_migration_permit_execute_present';
      WHEN has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)','EXECUTE') THEN
        failed_invariant := 'release_migration_complete_migration_permit_execute_present';
      WHEN NOT has_function_privilege('${releaseSchemaOwnerRoleName}','reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)','EXECUTE') THEN
        failed_invariant := 'schema_owner_consume_migration_permit_execute_missing';
      WHEN NOT has_function_privilege('${releaseSchemaOwnerRoleName}','reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)','EXECUTE') THEN
        failed_invariant := 'schema_owner_complete_migration_permit_execute_missing';
      WHEN NOT has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.read_migration_receipt(text,bigint,text)','EXECUTE') THEN
        failed_invariant := 'release_migration_read_migration_receipt_execute_missing';
      ELSE NULL;
    END CASE;
  END IF;
  IF failed_invariant IS NOT NULL THEN
    RAISE EXCEPTION 'activation_authority_boundary:%', failed_invariant;
  END IF;
END
$activation_authority_boundary$;
CREATE OR REPLACE FUNCTION reviewrouter_bootstrap.consume_migration_evidence(
  artifact_digest text,
  artifact_id text,
  rollout_id text,
  run_id text,
  run_attempt integer,
  job_id text,
  workflow_path text,
  commit_sha text,
  image_digest text,
  expected_system_identifier text,
  expected_recovery_witness_sha256 text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $receipt$
DECLARE
  binding jsonb;
  receipts jsonb;
  receipt jsonb;
  normalized_receipts jsonb := '[]'::jsonb;
BEGIN
  IF session_user <> 'reviewrouter_release_migration'
     OR artifact_digest !~ '^sha256:[a-f0-9]{64}$'
     OR artifact_id !~ '^[1-9][0-9]*$'
     OR rollout_id = ''
     OR run_id !~ '^[1-9][0-9]*$'
     OR run_attempt <= 0
     OR job_id !~ '^[1-9][0-9]*$'
     OR workflow_path <> '.github/workflows/codex-rotating-release-migration.yml'
     OR commit_sha !~ '^[a-f0-9]{40}$'
     OR image_digest !~ '^sha256:[a-f0-9]{64}$'
     OR expected_system_identifier !~ '^[0-9]+$'
     OR expected_recovery_witness_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'trusted migration evidence receipt invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(1381126735, 1129271120);
  SELECT shobj_description(oid, 'pg_database')::jsonb INTO binding
  FROM pg_database WHERE datname = current_database();
  IF binding IS NULL
     OR (SELECT count(*) FROM jsonb_object_keys(binding)) NOT IN (3, 4)
     OR NOT binding ?& ARRAY['version','systemIdentifier','recoveryWitnessSha256']
     OR binding->'version' NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb)
     OR jsonb_typeof(binding->'systemIdentifier') <> 'string'
     OR jsonb_typeof(binding->'recoveryWitnessSha256') <> 'string'
     OR (binding ? 'consumedMigrationEvidence' AND jsonb_typeof(binding->'consumedMigrationEvidence') <> 'array')
     OR (NOT binding ? 'consumedMigrationEvidence' AND (SELECT count(*) FROM jsonb_object_keys(binding)) <> 3)
     OR binding->>'systemIdentifier' <> (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'recoveryWitnessSha256' !~ '^[a-f0-9]{64}$'
     OR binding->>'systemIdentifier' <> expected_system_identifier
     OR binding->>'recoveryWitnessSha256' <> expected_recovery_witness_sha256 THEN
    RAISE EXCEPTION 'trusted migration evidence database generation binding invalid';
  END IF;
  receipts := coalesce(binding->'consumedMigrationEvidence', '[]'::jsonb);
  IF jsonb_typeof(receipts) <> 'array' THEN
    RAISE EXCEPTION 'trusted migration evidence receipt history invalid';
  END IF;
  FOR receipt IN SELECT value FROM jsonb_array_elements(receipts)
  LOOP
    IF jsonb_typeof(receipt) <> 'object' THEN
      RAISE EXCEPTION 'trusted migration evidence receipt history invalid';
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) = 5
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','claimedAt']
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      receipt := receipt || jsonb_build_object('receiptVersion', 2);
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) = 6
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','claimedAt','receiptVersion']
      AND receipt->'receiptVersion' = '2'::jsonb
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      NULL;
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) IN (10, 11)
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','runAttempt','jobId','workflowPath','commit','imageDigest','claimedAt']
      AND ((SELECT count(*) FROM jsonb_object_keys(receipt)) = 10 OR receipt->'receiptVersion' = '3'::jsonb)
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'runAttempt') = 'number'
      AND jsonb_typeof(receipt->'jobId') = 'string'
      AND jsonb_typeof(receipt->'workflowPath') = 'string'
      AND jsonb_typeof(receipt->'commit') = 'string'
      AND jsonb_typeof(receipt->'imageDigest') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND (receipt->>'runAttempt') ~ '^[1-9][0-9]*$'
      AND receipt->>'jobId' ~ '^[1-9][0-9]*$'
      AND receipt->>'workflowPath' = '.github/workflows/codex-rotating-release-migration.yml'
      AND receipt->>'commit' ~ '^[a-f0-9]{40}$'
      AND receipt->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      receipt := receipt || jsonb_build_object('receiptVersion', 3);
    ELSIF (SELECT count(*) FROM jsonb_object_keys(receipt)) = 13
      AND receipt ?& ARRAY['artifactDigest','artifactId','rolloutId','runId','runAttempt','jobId','workflowPath','commit','imageDigest','claimedAt','receiptVersion','systemIdentifier','recoveryWitnessSha256']
      AND receipt->'receiptVersion' = '4'::jsonb
      AND jsonb_typeof(receipt->'artifactDigest') = 'string'
      AND jsonb_typeof(receipt->'artifactId') = 'string'
      AND jsonb_typeof(receipt->'rolloutId') = 'string'
      AND jsonb_typeof(receipt->'runId') = 'string'
      AND jsonb_typeof(receipt->'runAttempt') = 'number'
      AND jsonb_typeof(receipt->'jobId') = 'string'
      AND jsonb_typeof(receipt->'workflowPath') = 'string'
      AND jsonb_typeof(receipt->'commit') = 'string'
      AND jsonb_typeof(receipt->'imageDigest') = 'string'
      AND jsonb_typeof(receipt->'claimedAt') = 'string'
      AND jsonb_typeof(receipt->'systemIdentifier') = 'string'
      AND jsonb_typeof(receipt->'recoveryWitnessSha256') = 'string'
      AND receipt->>'artifactDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'artifactId' ~ '^[1-9][0-9]*$'
      AND receipt->>'rolloutId' <> ''
      AND receipt->>'runId' ~ '^[1-9][0-9]*$'
      AND (receipt->>'runAttempt') ~ '^[1-9][0-9]*$'
      AND receipt->>'jobId' ~ '^[1-9][0-9]*$'
      AND receipt->>'workflowPath' = '.github/workflows/codex-rotating-release-migration.yml'
      AND receipt->>'commit' ~ '^[a-f0-9]{40}$'
      AND receipt->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND receipt->>'claimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      AND receipt->>'systemIdentifier' = expected_system_identifier
      AND receipt->>'recoveryWitnessSha256' = expected_recovery_witness_sha256
      AND to_char((receipt->>'claimedAt')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = receipt->>'claimedAt' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'trusted migration evidence receipt history invalid';
    END IF;
    normalized_receipts := normalized_receipts || jsonb_build_array(receipt);
  END LOOP;
  receipts := normalized_receipts;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) item
    GROUP BY item->>'artifactDigest' HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) item
    GROUP BY item->>'rolloutId' HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) item
    GROUP BY item->>'runId', item->>'artifactId' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'trusted migration evidence receipt history replay invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) existing_receipt
    WHERE existing_receipt->>'artifactDigest' = artifact_digest
       OR existing_receipt->>'rolloutId' = rollout_id
       OR (existing_receipt->>'runId' = run_id AND existing_receipt->>'artifactId' = artifact_id)
  ) THEN
    RAISE EXCEPTION 'trusted migration evidence replay rejected';
  END IF;
  binding := jsonb_set(binding, '{version}', '4'::jsonb, true);
  binding := jsonb_set(
    binding,
    '{consumedMigrationEvidence}',
    receipts || jsonb_build_array(jsonb_build_object(
      'artifactDigest', artifact_digest,
      'artifactId', artifact_id,
      'rolloutId', rollout_id,
      'runId', run_id,
      'runAttempt', run_attempt,
      'jobId', job_id,
      'workflowPath', workflow_path,
      'commit', commit_sha,
      'imageDigest', image_digest,
      'receiptVersion', 4,
      'systemIdentifier', expected_system_identifier,
      'recoveryWitnessSha256', expected_recovery_witness_sha256,
      'claimedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )),
    true
  );
  EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
  RETURN true;
END
$receipt$;
ALTER FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text) OWNER TO reviewrouter_role_bootstrap;
REVOKE ALL ON FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reviewrouter_bootstrap.consume_migration_evidence(text,text,text,text,integer,text,text,text,text,text,text) TO reviewrouter_release_migration;
-- The trusted release-owned transaction retains superuser authority through
-- all setup. Resolve every schema-owner-related membership by its actual PG17
-- catalog grantor, prove the topology empty, then self-demote as the final
-- statement before the atomic commit.
DO $schema_owner_membership_cleanup$
DECLARE edge record;
BEGIN
  LOOP
    SELECT granted.rolname AS granted_name, member.rolname AS member_name,
      grantor.rolname AS grantor_name INTO edge
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles grantor ON grantor.oid=membership.grantor
    WHERE membership.roleid='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.member='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.grantor='${releaseSchemaOwnerRoleName}'::regrole
    ORDER BY granted.rolname,member.rolname,grantor.rolname
    LIMIT 1;
    EXIT WHEN NOT FOUND;
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE',
      edge.granted_name,edge.member_name,edge.grantor_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members membership
    WHERE membership.roleid='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.member='${releaseSchemaOwnerRoleName}'::regrole
       OR membership.grantor='${releaseSchemaOwnerRoleName}'::regrole) THEN
    RAISE EXCEPTION
      'release schema owner membership survived trusted bootstrap cleanup';
  END IF;
END
$schema_owner_membership_cleanup$;
ALTER ROLE ${canonicalBootstrapRoleName} NOSUPERUSER NOCREATEROLE;
COMMIT;
`;
}

function connectionRoleObservationSql() {
  return `SELECT json_build_object(
    'currentUser', current_user,
    'sessionUser', session_user,
    'login', role.rolcanlogin,
    'superuser', role.rolsuper,
    'createDatabase', role.rolcreatedb,
    'createRole', role.rolcreaterole,
    'replication', role.rolreplication,
    'bypassRls', role.rolbypassrls
  ) FROM pg_roles role WHERE role.rolname = session_user`;
}

function observeConnectionRole(run, step, url, env) {
  return JSON.parse(
    run(
      step,
      "psql",
      [
        url,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        connectionRoleObservationSql(),
      ],
      { env },
    ).trim(),
  );
}

function assertConnectionRole(
  observed,
  expectedUser,
  { expectSuperuser = false, expectCreateRole = false } = {},
) {
  if (
    observed?.currentUser !== expectedUser ||
    observed?.sessionUser !== expectedUser ||
    observed?.login !== true ||
    observed?.createRole !== expectCreateRole ||
    observed?.superuser !== expectSuperuser ||
    observed?.createDatabase !== false ||
    observed?.replication !== false ||
    observed?.bypassRls !== false
  )
    throw new Error(
      `release_migration_connection_authority_mismatch:${expectedUser}`,
    );
}

export function runtimeGrantStatements(
  configuration,
  databaseTarget = ':"DBNAME"',
  { skipDatabaseAcl = false } = {},
) {
  const databaseAclStatement = (statement) => {
    if (skipDatabaseAcl) return "";
    return statement.replaceAll("__DATABASE_TARGET__", databaseTarget);
  };
  const rotatingEvidenceLiterals = rotatingEvidenceTables
    .map((table) => `'${table}'`)
    .join(",");
  const quarantineLiterals = quarantineTables
    .map((table) => `'${table}'`)
    .join(",");
  const staleColumnAclLiterals = [
    "RepositoryConnection",
    ...rotatingEvidenceTables,
    ...fullyProtectedRuntimeTables,
    workerOwnedMaintenanceCheckpointTable,
  ]
    .map((table) => `'${table}'`)
    .join(",");
  const providerUpdateColumnList = providerRuntimeUpdateColumns
    .map((column) => `"${column}"`)
    .join(", ");
  return `
${databaseAclStatement("REVOKE CREATE ON DATABASE __DATABASE_TARGET__ FROM PUBLIC;")}
${databaseAclStatement("REVOKE CONNECT ON DATABASE __DATABASE_TARGET__ FROM PUBLIC;")}
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
${configuration.roles
  .filter(({ role }) => role !== "effect-authority")
  .map(
    ({
      role,
      username,
    }) => `${databaseAclStatement(`GRANT CONNECT ON DATABASE __DATABASE_TARGET__ TO ${username};`)}
GRANT USAGE ON SCHEMA public TO ${username};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_database_authority_challenge"(text, text, integer) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_consume_database_authority"(text, text, integer) TO ${username};
${
  role === "web"
    ? `GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_setup_confirmation"(text, integer, text) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_provider_identity_repair_challenge"(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_repair_quarantined_provider"(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint,text) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_reattest_active_namespace_v4_to_v5"(text,text,text,text,bigint,text,text,text,text,text,integer,integer,text,text,text,text,text,text,text,text,integer) TO ${username};`
    : role === "api"
      ? `GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_runtime_confirmation"(text, text, integer, text) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_runtime_completion"(text, text) TO ${username};`
      : ""
}
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${username};
REVOKE ALL ON TABLE public."_prisma_migrations" FROM ${username};
DO $runtime_acl$
DECLARE protected_column record;
BEGIN
  FOR protected_column IN
    SELECT relation.relname AS table_name, attribute.attname AS column_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (${staleColumnAclLiterals})
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    EXECUTE format(
      'REVOKE ALL (%I) ON TABLE public.%I FROM %I',
      protected_column.column_name,
      protected_column.table_name,
      '${username}'
    );
  END LOOP;
END
$runtime_acl$;
REVOKE INSERT, UPDATE, DELETE ON TABLE public."RepositoryConnection" FROM ${username};
GRANT SELECT ON TABLE public."RepositoryConnection" TO ${username};
DO $runtime_evidence_acl$
DECLARE protected_table text;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[${rotatingEvidenceLiterals}] LOOP
    EXECUTE format(
      'REVOKE DELETE ON TABLE public.%I FROM %I',
      protected_table,
      '${username}'
    );
  END LOOP;
  FOREACH protected_table IN ARRAY ARRAY[${quarantineLiterals}] LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I',
      protected_table,
      '${username}'
    );
  END LOOP;
END
$runtime_evidence_acl$;
REVOKE UPDATE ON TABLE public."CodexOAuthProviderInstance" FROM ${username};
GRANT UPDATE (${providerUpdateColumnList}) ON TABLE public."CodexOAuthProviderInstance" TO ${username};
REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityKey" FROM ${username};
REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityReceipt" FROM ${username};
REVOKE ALL ON TABLE public."CodexOAuthWorkflowCompatibility" FROM ${username};
${role === "api" || role === "web" ? `GRANT SELECT ON TABLE public."CodexOAuthWorkflowCompatibility" TO ${username};` : ""}
REVOKE ALL ON TABLE public."RuntimeGenerationWitnessProof" FROM ${username};
REVOKE ALL ON TABLE public."RuntimeCanaryChallenge" FROM ${username};
REVOKE ALL ON TABLE public."RuntimeCanaryChallengeProof" FROM ${username};
REVOKE ALL ON TABLE public."${workerOwnedMaintenanceCheckpointTable}" FROM ${username};
${
  role === "worker"
    ? `GRANT SELECT, INSERT, UPDATE ON TABLE public."${workerOwnedMaintenanceCheckpointTable}" TO ${username};`
    : ""
}
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE ${releaseSchemaOwnerRoleName} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE ${releaseSchemaOwnerRoleName} IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${username};`,
  )
  .join("\n")}
GRANT EXECUTE ON FUNCTION public.reviewrouter_record_runtime_generation_witness_proof(TEXT, TEXT, TEXT, TEXT) TO reviewrouter_web, reviewrouter_api, reviewrouter_worker;
GRANT EXECUTE ON FUNCTION public.reviewrouter_read_runtime_generation_witness_proofs(TEXT, TEXT) TO reviewrouter_api;
GRANT EXECUTE ON FUNCTION public.reviewrouter_runtime_generation_write_read_canary(TEXT, TEXT) TO reviewrouter_api;
ALTER FUNCTION public.reviewrouter_runtime_generation_write_read_canary(TEXT, TEXT)
  SET search_path TO pg_catalog, public, pg_temp;
GRANT EXECUTE ON FUNCTION public.reviewrouter_request_runtime_canary_challenge(TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, JSONB) TO reviewrouter_api;
GRANT EXECUTE ON FUNCTION public.reviewrouter_read_runtime_canary_challenge_proofs(TEXT) TO reviewrouter_api;
GRANT EXECUTE ON FUNCTION public.reviewrouter_answer_runtime_canary_challenge(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO reviewrouter_web, reviewrouter_api, reviewrouter_worker;
${databaseAclStatement("GRANT CONNECT ON DATABASE __DATABASE_TARGET__ TO reviewrouter_codex_effect_authority;")}
GRANT USAGE ON SCHEMA public TO reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE CREATE ON SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM reviewrouter_codex_effect_authority;
GRANT EXECUTE ON FUNCTION public."codex_oauth_sign_database_authority"(text) TO reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
`;
}

export function runtimeAclGateStatements(
  configuration,
  databaseTarget = ':"DBNAME"',
  { skipDatabaseAcl = false } = {},
) {
  const databaseAclStatement = (statement) => {
    if (skipDatabaseAcl) return "";
    return statement.replaceAll("__DATABASE_TARGET__", databaseTarget);
  };
  return `${configuration.roles
    .map(
      ({
        username,
      }) => `${databaseAclStatement(`REVOKE CONNECT ON DATABASE __DATABASE_TARGET__ FROM ${username};`)}
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${username};
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${username};`,
    )
    .join("\n")}`;
}

/**
 * Standalone convergence for a legitimate bootstrap/database administrator
 * that still owns, or has grant authority over, the target catalog. Once
 * ownership has converged, release LOGIN callers must use the permit-guarded
 * executor instead of this administrative path.
 */
export function runtimeGrantSql(configuration, { gateClosed = false } = {}) {
  const runtimeRoleLiterals = configuration.roles
    .map(({ username }) => quoted(username))
    .join(",");
  return `\\set ON_ERROR_STOP on
BEGIN;
${activationMigrationExclusionSql}
${runtimeGrantStatements(configuration)}
${gateClosed ? runtimeAclGateStatements(configuration) : ""}
DO $runtime_connect_acl$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[${runtimeRoleLiterals}] LOOP
    IF has_database_privilege(role_name, current_database(), 'CONNECT')
       IS DISTINCT FROM ${gateClosed ? "false" : "true"} THEN
      RAISE EXCEPTION 'runtime CONNECT state mismatch for %', role_name;
    END IF;
  END LOOP;
  IF has_database_privilege('public', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'PUBLIC retained database CONNECT';
  END IF;
END
$runtime_connect_acl$;
COMMIT;
`;
}

/** Canonical projection of the live V70-V73 security catalog. */
export const liveV70V73CatalogDigestSql = fencedLiveV70V73CatalogDigestSql;

export const liveV70V72CatalogDigestSql = liveV70V73CatalogDigestSql;
export const liveV70V79CatalogDigestSql = liveV70V73CatalogDigestSql;

export function releaseMigrationPermitFromEnv(env) {
  const permit = {
    rolloutId: required(env, "REVIEW_ROUTER_ROLLOUT_ID"),
    targetSystemIdentifier: required(
      env,
      "REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_SYSTEM_IDENTIFIER",
    ),
    targetRecoveryWitnessSha256: required(
      env,
      "REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_RECOVERY_WITNESS_SHA256",
    ),
    transitionSha256: required(
      env,
      "REVIEW_ROUTER_MIGRATION_PERMIT_TRANSITION_SHA256",
    ),
    previousReceiptSha256: required(
      env,
      "REVIEW_ROUTER_MIGRATION_PERMIT_PREVIOUS_RECEIPT_SHA256",
    ),
    epoch: required(env, "REVIEW_ROUTER_MIGRATION_PERMIT_EPOCH"),
    nonce: required(env, "REVIEW_ROUTER_MIGRATION_PERMIT_NONCE"),
    sourceLegacyAmbiguity: JSON.parse(
      Buffer.from(
        required(
          env,
          "REVIEW_ROUTER_MIGRATION_PERMIT_SOURCE_LEGACY_AMBIGUITY_BASE64URL",
        ),
        "base64url",
      ).toString("utf8"),
    ),
    eligibilityCutoff: required(
      env,
      "REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF",
    ),
  };
  const trustedSourceReceipt = assertLegacyAmbiguityEvidence(
    permit.sourceLegacyAmbiguity,
  );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/u.test(permit.rolloutId) ||
    !/^[1-9][0-9]{0,19}$/u.test(permit.targetSystemIdentifier) ||
    !/^[a-f0-9]{64}$/u.test(permit.targetRecoveryWitnessSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(permit.transitionSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(permit.previousReceiptSha256) ||
    !/^[1-9][0-9]{0,18}$/u.test(permit.epoch) ||
    !/^[a-f0-9]{32}$/u.test(permit.nonce) ||
    !Number.isFinite(Date.parse(permit.eligibilityCutoff)) ||
    new Date(permit.eligibilityCutoff).toISOString() !==
      permit.eligibilityCutoff ||
    permit.eligibilityCutoff !== trustedSourceReceipt.eligibilityCutoff
  )
    throw new Error("release_migration_target_permit_invalid");
  return Object.freeze(permit);
}

export function atomicMigrationAndGrantSql(
  configuration,
  {
    gateClosed = false,
    catalogCaptureOnly = false,
    disposableDatabaseIdentity,
    migrationBundleSql = atomicReleaseMigrationBundleSql(),
    migrationPermit,
    legacyReconciliation,
  } = {},
) {
  if (!migrationPermit)
    throw new Error("release_migration_target_permit_missing");
  if (migrationBundleSql !== atomicReleaseMigrationBundleSql())
    throw new Error("release_migration_bundle_override_forbidden");
  if (!legacyReconciliation?.evidence)
    throw new Error("release_migration_legacy_reconciliation_missing");
  if (
    catalogCaptureOnly &&
    !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
      disposableDatabaseIdentity ?? "",
    )
  )
    throw new Error(
      "activation_catalog_policy_candidate_disposable_identity_required",
    );
  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '120000ms';
${
  catalogCaptureOnly
    ? `SET LOCAL reviewrouter.activation_catalog_candidate_capture = 'disposable-only';
SET LOCAL reviewrouter.activation_catalog_disposable_database_identity = ${quoted(disposableDatabaseIdentity)};`
    : ""
}
-- Migration takes the target lock exclusively before touching catalog state.
-- Authority begin/complete use target-shared then control-authority order and
-- never upgrade a shared lock, preventing cross-worker upgrade deadlocks.
${activationMigrationExclusionSql}
CALL public.reviewrouter_execute_release_migration(
  ${quoted(migrationPermit.rolloutId)},
  ${quoted(migrationPermit.targetSystemIdentifier)},
  ${quoted(migrationPermit.targetRecoveryWitnessSha256)},
  ${quoted(migrationPermit.transitionSha256)},
  ${quoted(migrationPermit.previousReceiptSha256)},
  ${migrationPermit.epoch}::bigint,
  ${quoted(migrationPermit.nonce)},
  ${quoted(JSON.stringify(legacyReconciliation.evidence))}::jsonb,
  ${quoted(migrationPermit.eligibilityCutoff)}::timestamptz,
  ${gateClosed ? "true" : "false"}::boolean,
  ${catalogCaptureOnly ? "true" : "false"}::boolean);
SET LOCAL search_path = pg_catalog, pg_temp;
DO $phase_aware_manifest_postcondition$
DECLARE manifest_identity text;
DECLARE catalog_digest text;
DECLARE receipt_catalog_digest text;
BEGIN
  SELECT 'sha256:' || encode(pg_catalog.sha256(convert_to(
    coalesce(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''),
    'UTF8')), 'hex')
  INTO manifest_identity
  FROM public._prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF manifest_identity <> '${canonicalReleaseMigrationArtifact.postManifestIdentity}'
    THEN RAISE EXCEPTION 'release migration post manifest mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL)
    THEN RAISE EXCEPTION 'release migration unresolved history'; END IF;
  IF to_regclass('public."RuntimeCanaryChallenge"') IS NULL
    OR to_regclass('public."RuntimeCanaryChallengeProof"') IS NULL
    OR to_regprocedure('public.reviewrouter_request_runtime_canary_challenge(text,text,timestamp with time zone,text,text,text,jsonb)') IS NULL
    OR to_regprocedure('public.reviewrouter_read_runtime_canary_challenge_proofs(text)') IS NULL
    OR to_regprocedure('public.reviewrouter_answer_runtime_canary_challenge(text,text,text,text,text,text)') IS NULL
    THEN RAISE EXCEPTION 'release migration V72 catalog postcondition missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid IN (
      'public.reviewrouter_request_runtime_canary_challenge(text,text,timestamp with time zone,text,text,text,jsonb)'::regprocedure,
      'public.reviewrouter_read_runtime_canary_challenge_proofs(text)'::regprocedure,
      'public.reviewrouter_answer_runtime_canary_challenge(text,text,text,text,text,text)'::regprocedure
    ) AND NOT prosecdef
  ) THEN RAISE EXCEPTION 'release migration V72 routine security invalid'; END IF;
  SELECT digest INTO STRICT catalog_digest FROM (${liveV70V73CatalogDigestSql}) live(digest);
  ${
    catalogCaptureOnly
      ? ""
      : `SELECT reviewrouter_activation.read_migration_receipt(
    ${quoted(migrationPermit.rolloutId)},${migrationPermit.epoch}::bigint,
    ${quoted(migrationPermit.nonce)}
  )->>'postCatalogDigest' INTO STRICT receipt_catalog_digest;
  IF catalog_digest IS DISTINCT FROM receipt_catalog_digest
    THEN RAISE EXCEPTION 'release migration V70-V73 live catalog digest mismatch'; END IF;`
  }
END
$phase_aware_manifest_postcondition$;
COMMIT;
`;
}

/**
 * Read-only operational capture. The owner routine rolls the exact production
 * grants back in an inner subtransaction; the outer rollback remains defense
 * in depth.
 */
export function canonicalActivationCatalogPolicyCandidateSql(
  _configuration,
  disposableDatabaseIdentity,
) {
  if (
    !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
      disposableDatabaseIdentity ?? "",
    )
  )
    throw new Error(
      "activation_catalog_policy_candidate_disposable_identity_required",
    );
  const disposableIdentityLiteral = quoted(disposableDatabaseIdentity);
  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL reviewrouter.activation_catalog_candidate_capture = 'disposable-only';
SET LOCAL reviewrouter.activation_catalog_disposable_database_identity = ${disposableIdentityLiteral};
${activationMigrationExclusionSql}
SELECT reviewrouter_activation.capture_catalog_policy_candidate_pair();
ROLLBACK;
`;
}

export function canonicalActivationRecoverySql(rolloutId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(rolloutId))
    throw new Error("release_migration_activation_identity_invalid");
  return `\\set ON_ERROR_STOP on
SELECT reviewrouter_activation.read_activation_receipt(
  '${String(rolloutId).replaceAll("'", "''")}'
);
`;
}

export function canonicalActivationSql(_configuration, activation) {
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(activation.rolloutId))
    throw new Error("release_migration_activation_identity_invalid");
  return {
    sql: `\\set ON_ERROR_STOP on
BEGIN;
${activationMigrationExclusionSql}
SELECT reviewrouter_activation.stage_principal_evidence(
  ${literal(activation.rolloutId)}
);
SELECT reviewrouter_activation.activate_generation(
  ${literal(activation.rolloutId)}
);
COMMIT;
`,
  };
}

export function runReleaseMigrationSubprocess(
  step,
  command,
  args,
  { env, input } = {},
) {
  const databaseUrl = env?.DATABASE_URL;
  if (!databaseUrl)
    throw sanitizedDiagnosticError({
      code: "release_migration_step_failed",
      phase: "release_migration",
    });
  const directory = mkdtempSync(join(tmpdir(), "rr-canonical-db-"));
  chmodSync(directory, 0o700);
  try {
    let childArgs = [...args];
    let childEnv;
    if (command === "psql") {
      const urlIndex = childArgs.findIndex(
        (arg) =>
          arg.startsWith("postgres://") || arg.startsWith("postgresql://"),
      );
      if (urlIndex < 0)
        throw sanitizedDiagnosticError({
          code: "release_migration_step_failed",
          phase: "release_migration",
        });
      let url;
      try {
        url = new URL(childArgs[urlIndex]);
      } catch {
        throw sanitizedDiagnosticError({
          code: "release_migration_step_failed",
          phase: "release_migration",
        });
      }
      const passfile = join(directory, "pgpass");
      const credentialPath = join(directory, "database-url");
      const escape = (value) =>
        value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
      writeFileSync(
        passfile,
        `${escape(url.hostname)}:${escape(url.port || "5432")}:${escape(decodeURIComponent(url.pathname.slice(1)))}:${escape(decodeURIComponent(url.username))}:${escape(decodeURIComponent(url.password))}\n`,
        { mode: 0o600, flag: "wx" },
      );
      writeFileSync(credentialPath, databaseUrl, {
        mode: 0o600,
        flag: "wx",
      });
      childArgs.splice(
        urlIndex,
        1,
        "--host",
        url.hostname,
        "--port",
        url.port || "5432",
        "--username",
        decodeURIComponent(url.username),
        "--dbname",
        decodeURIComponent(url.pathname.slice(1)),
      );
      const normalized = normalizeSecretSafePostgresArguments(childArgs, input);
      childArgs = [...normalized.args];
      input = normalized.input;
      childEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        PGPASSFILE: passfile,
        REVIEW_ROUTER_DATABASE_URL_FILE: credentialPath,
        ...(url.searchParams.get("sslmode")
          ? { PGSSLMODE: url.searchParams.get("sslmode") }
          : {}),
      };
    } else if (command === "node" || command === "pnpm") {
      const allowed =
        (command === "node" &&
          JSON.stringify(childArgs) ===
            JSON.stringify([
              "--import",
              "tsx",
              "scripts/preflight-codex-rotating-migration-history.ts",
            ])) ||
        (command === "pnpm" &&
          JSON.stringify(childArgs) ===
            JSON.stringify([
              "--filter",
              "@reviewrouter/platform-db",
              "db:migrate:deploy",
            ]));
      if (!allowed)
        throw sanitizedDiagnosticError({
          code: "release_migration_step_failed",
          phase: "process_boundary",
        });
      const credentialPath = join(directory, "database-url");
      writeFileSync(credentialPath, databaseUrl, { mode: 0o600, flag: "wx" });
      childEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        REVIEW_ROUTER_DATABASE_URL_FILE: credentialPath,
      };
    } else {
      throw sanitizedDiagnosticError({
        code: "release_migration_step_failed",
        phase: "release_migration",
      });
    }
    const result = spawnSync(command, childArgs, {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: childEnv,
      input,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    });
    if (result.status !== 0 || result.error) {
      const safeStep = /^[a-z][a-z0-9_]{2,63}$/u.test(step) ? step : "unknown";
      process.stderr.write(`release_migration_substep_failed:${safeStep}\n`);
      const diagnostic = (() => {
        const prismaCode = result.stderr?.match(/\b(P[0-9]{4})\b/u)?.[1];
        const migration = result.stderr?.match(
          /Migration name:\s*([0-9]{6}_[a-z0-9_]+)/u,
        )?.[1];
        if (prismaCode)
          return migration
            ? `prisma ${prismaCode} migration ${migration}`
            : `prisma ${prismaCode}`;
        if (/ERROR:\s*permission denied/iu.test(result.stderr ?? ""))
          return "permission denied";
        if (/ERROR:\s*release migration/iu.test(result.stderr ?? ""))
          return "release migration invariant rejected";
        return /ERROR:/u.test(result.stderr ?? "")
          ? "postgres error"
          : undefined;
      })();
      if (diagnostic)
        process.stderr.write(
          `release_migration_postgres_error:${safeStep}:${diagnostic}\n`,
        );
      throw sanitizedDiagnosticError({
        code: "release_migration_step_failed",
        phase: "release_migration",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
    }
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function executeCanonicalRoleBootstrap(
  env = process.env,
  run = runReleaseMigrationSubprocess,
) {
  const configuration = resolveRoleBootstrapConfiguration(env);
  const bootstrapEnv = { ...env, DATABASE_URL: configuration.bootstrapUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_bootstrap_authority",
      configuration.bootstrapUrl,
      bootstrapEnv,
    ),
    "reviewrouter_role_bootstrap",
    { expectSuperuser: true, expectCreateRole: true },
  );
  run(
    "provision_roles",
    "psql",
    [configuration.bootstrapUrl, "--no-psqlrc", "--quiet"],
    { env: bootstrapEnv, input: roleProvisioningSql(configuration) },
  );
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_bootstrap_demotion",
      configuration.bootstrapUrl,
      bootstrapEnv,
    ),
    "reviewrouter_role_bootstrap",
  );
  const releaseEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_release_authority",
      configuration.releaseUrl,
      releaseEnv,
    ),
    "reviewrouter_release_migration",
  );
  const verifiedRoles = observeCanonicalRoleTopology(
    run,
    configuration.bootstrapUrl,
    bootstrapEnv,
  );
  return {
    version: 2,
    caller: "scripts/run-codex-rotating-role-bootstrap.mjs",
    commit: configuration.commit,
    databaseIdentity: configuration.databaseIdentity,
    imageDigest: configuration.imageDigest,
    roles: verifiedRoles.roles,
    bootstrapMemberships: verifiedRoles.bootstrapMemberships,
    status: "succeeded",
  };
}

export function classifyActivationCatalogCaptureStateShape(rawState) {
  if (typeof rawState !== "string") return "not_string";
  const trimmed = rawState.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.includes("\u0000")) return "contains_nul";
  const lineCount = trimmed.split(/\r?\n/u).length;
  const objectBounded = trimmed.startsWith("{") && trimmed.endsWith("}");
  if (lineCount === 1)
    return objectBounded ? "single_line_object" : "single_line_other";
  return objectBounded ? "multi_line_object_boundary" : "multi_line_other";
}

export function parseActivationCatalogCaptureState(rawState) {
  try {
    return JSON.parse(rawState.trim());
  } catch {
    process.stderr.write(
      `activation_catalog_policy_capture_state_json_invalid:${classifyActivationCatalogCaptureStateShape(rawState)}\n`,
    );
    throw new Error("activation_catalog_policy_capture_state_json_invalid");
  }
}

export function executeCanonicalReleaseMigration(
  env = process.env,
  run = runReleaseMigrationSubprocess,
  resolveDatabaseIdentity = databaseIdentity,
) {
  if (
    env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE !== undefined &&
    !["open", "closed"].includes(env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE)
  )
    throw new Error("release_migration_acl_gate_mode_invalid");
  const configuration = resolveReleaseMigrationConfiguration(
    env,
    resolveDatabaseIdentity,
  );
  const migrationPermit = releaseMigrationPermitFromEnv(env);
  const childEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_release_authority",
      configuration.releaseUrl,
      childEnv,
    ),
    "reviewrouter_release_migration",
  );
  const preflightOutput = run(
    "migration_history_preflight",
    "node",
    [
      "--import",
      "tsx",
      "scripts/preflight-codex-rotating-migration-history.ts",
    ],
    { env: childEnv },
  );
  const legacyReconciliation = prepareLegacyAmbiguityReconciliation(
    {
      databaseUrl: configuration.releaseUrl,
      recoveryWitnessSha256: migrationPermit.targetRecoveryWitnessSha256,
      rolloutId: migrationPermit.rolloutId,
      legacyAmbiguity: migrationPermit.sourceLegacyAmbiguity,
      eligibilityCutoff: migrationPermit.eligibilityCutoff,
      env: childEnv,
    },
    run,
  );
  const catalogCaptureOnly =
    env.REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY ===
    "1";
  run(
    "deploy_migrations_and_converge_grants",
    "psql",
    [configuration.releaseUrl, "--no-psqlrc", "--quiet"],
    {
      env: childEnv,
      input: atomicMigrationAndGrantSql(configuration, {
        gateClosed: env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE === "closed",
        catalogCaptureOnly,
        disposableDatabaseIdentity:
          env.REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY,
        migrationPermit,
        legacyReconciliation,
      }),
    },
  );
  if (catalogCaptureOnly) {
    const rawCaptureState = run(
      "verify_catalog_capture_migration_state",
      "psql",
      [
        configuration.releaseUrl,
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--command",
        `COPY (SELECT jsonb_build_object(
            'manifestIdentity','sha256:'||encode(pg_catalog.sha256(convert_to(coalesce(string_agg(
              migration_name||':'||checksum,',' ORDER BY migration_name),''),'UTF8')),'hex'),
            'catalogDigest',(SELECT digest FROM (${fencedLiveV70V73CatalogDigestSql}) live(digest)),
            'permitState',(SELECT state FROM reviewrouter_activation.migration_permit
              WHERE rollout_id=${quoted(migrationPermit.rolloutId)}),
            'unfinishedCount',(SELECT count(*) FROM public._prisma_migrations
              WHERE finished_at IS NULL AND rolled_back_at IS NULL)
          ) FROM public._prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) TO STDOUT`,
      ],
      { env: childEnv },
    );
    process.stderr.write(
      "activation_catalog_policy_capture_raw_state_received\n",
    );
    const captureState = parseActivationCatalogCaptureState(rawCaptureState);
    process.stderr.write(
      "activation_catalog_policy_capture_json_parse_complete\n",
    );
    const captureStateChecks = Object.freeze({
      manifestIdentityExact:
        captureState.manifestIdentity ===
        canonicalReleaseMigrationArtifact.postManifestIdentity,
      catalogDigestValid: /^sha256:[a-f0-9]{64}$/u.test(
        captureState.catalogDigest ?? "",
      ),
      catalogDigestUnpromoted:
        captureState.catalogDigest !==
        canonicalReleaseMigrationArtifact.postCatalogDigest,
      permitConsumed: captureState.permitState === "consumed",
      noUnfinishedMigrations: Number(captureState.unfinishedCount) === 0,
    });
    process.stderr.write(
      "activation_catalog_policy_capture_checks_constructed\n",
    );
    if (Object.values(captureStateChecks).some((check) => !check)) {
      process.stderr.write(
        `activation_catalog_policy_capture_state_invalid:${JSON.stringify(captureStateChecks)}\n`,
      );
      throw new Error("activation_catalog_policy_capture_state_invalid");
    }
    return Object.freeze({
      version: 1,
      captureOnlyStatus: "catalog_candidate_ready",
      candidate: Object.freeze({
        commitSha: configuration.commit,
        databaseIdentity: configuration.databaseIdentity,
        manifestIdentity: captureState.manifestIdentity,
        projectionSha256: `sha256:${createHash("sha256")
          .update(fencedLiveV70V73CatalogDigestSql)
          .digest("hex")}`,
        catalogDigest: captureState.catalogDigest,
      }),
    });
  }
  const targetMigrationReceipt = JSON.parse(
    run(
      "read_target_migration_receipt",
      "psql",
      [
        configuration.releaseUrl,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT reviewrouter_activation.read_migration_receipt(${quoted(
          migrationPermit.rolloutId,
        )},${migrationPermit.epoch}::bigint,${quoted(migrationPermit.nonce)})`,
      ],
      { env: childEnv },
    ).trim(),
  );
  const verifiedLegacyReconciliation = verifyLegacyAmbiguityReconciliation(
    {
      databaseUrl: configuration.releaseUrl,
      recoveryWitnessSha256: migrationPermit.targetRecoveryWitnessSha256,
      rolloutId: migrationPermit.rolloutId,
      env: childEnv,
    },
    run,
    {
      ...legacyReconciliation,
      receipt: targetMigrationReceipt.legacyReconciliation,
    },
  );
  const verifiedRoles = observeCanonicalRoleTopology(
    run,
    configuration.releaseUrl,
    childEnv,
  );
  const databaseGeneration = observeDatabaseGeneration(
    run,
    configuration.releaseUrl,
    childEnv,
  );
  return {
    version: 3,
    caller: "scripts/run-codex-rotating-release-migration.mjs",
    callerCount: 1,
    commit: configuration.commit,
    databaseIdentity: configuration.databaseIdentity,
    databaseGeneration,
    imageDigest: configuration.imageDigest,
    migrationStatus: "succeeded",
    aclGateState:
      env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE === "closed" ? "closed" : "open",
    preflightOutputSha256: createHash("sha256")
      .update(preflightOutput)
      .digest("hex"),
    preflightStatus: "passed",
    legacyReconciliation: verifiedLegacyReconciliation,
    targetMigrationReceipt,
    roles: verifiedRoles.roles,
    status: "succeeded",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(executeCanonicalReleaseMigration())}\n`,
    );
  } catch (error) {
    const safeError = isSanitizedDiagnosticError(error)
      ? error
      : sanitizedDiagnosticError({
          code: "release_migration_step_failed",
          phase: "release_migration",
        });
    process.stderr.write(`FAIL: ${JSON.stringify(safeError)}\n`);
    process.exitCode = 1;
  }
}
