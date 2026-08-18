#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizedDiagnosticError } from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import {
  releaseAuthorityCatalogVerifier,
  releaseAuthorityMigrationContract,
  releaseAuthorityMigrationManifest,
  releaseAuthorityMigrationPaths,
} from "../apps/api/src/release-authority/domain/readiness-contract.mjs";
import {
  releaseAuthorityAclFingerprintSql,
  releaseAuthorityCatalogDigestExpression,
  releaseAuthorityCatalogFingerprintSql,
} from "../apps/api/src/release-authority/adapters/catalog-fingerprint.mjs";
import {
  releaseAuthorityDefaultAclExactExpression,
  releaseAuthorityDefaultAclPreflightSql,
  releaseAuthorityFinalAclExactExpression,
  releaseAuthorityProviderTerminalTopologyExactExpression,
} from "../apps/api/src/release-authority/adapters/acl-policy-postgres.mjs";
import {
  parseReleaseAuthorityPostgresUrl,
  releaseAuthorityPostgresEndpoint,
  releaseAuthorityPostgresPassfileLine,
} from "./lib/release-authority-postgres-url.mjs";

export {
  releaseAuthorityAclFingerprintSql,
  releaseAuthorityCatalogFingerprintSql,
  releaseAuthorityMigrationManifest,
  releaseAuthorityMigrationPaths,
};

export const releaseAuthorityMigrationModes = Object.freeze([
  "fresh-install",
  "incremental-upgrade",
]);

const migrationLeaseKeys = Object.freeze([
  "leaseId",
  "loginRole",
  "databaseName",
  "ownerRole",
  "expectedCommitSha",
  "workflowRunId",
  "workflowRunAttempt",
  "operation",
  "expiresAt",
  "passwordSha256",
  "nonce",
  "receiptSha256",
]);

const validateMigrationLease = (lease, mode) => {
  if (!lease) return undefined;
  if (
    mode !== "incremental-upgrade" ||
    typeof lease !== "object" ||
    Array.isArray(lease) ||
    Object.keys(lease).sort().join("\n") !==
      [...migrationLeaseKeys].sort().join("\n") ||
    !/^rrml-[a-f0-9]{64}$/u.test(lease.leaseId) ||
    !/^rr_migration_[a-f0-9]{24}$/u.test(lease.loginRole) ||
    lease.ownerRole !== "reviewrouter_authority_owner" ||
    !/^[a-f0-9]{40}$/u.test(lease.expectedCommitSha) ||
    !/^[1-9][0-9]*$/u.test(lease.workflowRunId) ||
    !Number.isSafeInteger(lease.workflowRunAttempt) ||
    lease.workflowRunAttempt < 1 ||
    lease.operation !== mode ||
    !/^sha256:[a-f0-9]{64}$/u.test(lease.passwordSha256) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(lease.nonce) ||
    !/^sha256:[a-f0-9]{64}$/u.test(lease.receiptSha256) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(lease.expiresAt)
  )
    throw new Error("release_authority_migration_lease_invalid");
  return Object.freeze({ ...lease });
};

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const sqlIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
export const releaseAuthorityBootstrapAdministratorRole =
  "reviewrouter_bootstrap_administrator";

const providerRootAttestationKeys = Object.freeze([
  "contractVersion",
  "systemIdentifier",
  "rootOid",
  "rootName",
  "providerOid",
  "providerName",
]);

export const validateProviderRootAttestation = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !==
      [...providerRootAttestationKeys].sort().join("\n") ||
    value.contractVersion !== 1 ||
    !/^[1-9][0-9]*$/u.test(value.systemIdentifier) ||
    !Number.isSafeInteger(value.rootOid) ||
    value.rootOid < 1 ||
    typeof value.rootName !== "string" ||
    value.rootName.length < 1 ||
    value.rootName.length > 63 ||
    value.rootName.includes("\0") ||
    !Number.isSafeInteger(value.providerOid) ||
    value.providerOid < 1 ||
    value.providerName !== releaseAuthorityBootstrapAdministratorRole ||
    value.rootOid === value.providerOid ||
    value.rootName === value.providerName
  )
    throw new Error("release_authority_provider_root_attestation_invalid");
  return Object.freeze({ ...value });
};

const providerRootSql = (attestation) => {
  const pin = validateProviderRootAttestation(attestation);
  return Object.freeze({
    systemIdentifier: sqlLiteral(pin.systemIdentifier),
    rootOid: String(pin.rootOid),
    rootName: sqlLiteral(pin.rootName),
    providerOid: String(pin.providerOid),
    providerName: sqlLiteral(pin.providerName),
  });
};

export function releaseAuthorityProviderRootProbeSql(probeRole) {
  if (!/^rr_root_probe_[a-f0-9]{32}$/u.test(probeRole))
    throw new Error("release_authority_provider_root_probe_role_invalid");
  const probe = sqlIdentifier(probeRole);
  const probeLiteral = sqlLiteral(probeRole);
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
SET LOCAL createrole_self_grant='';
DO $probe_preflight$
BEGIN
  IF session_user IS DISTINCT FROM current_user
    OR current_user IS DISTINCT FROM '${releaseAuthorityBootstrapAdministratorRole}'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.oid=current_user::pg_catalog.regrole
        AND role.rolname='${releaseAuthorityBootstrapAdministratorRole}'
        AND role.rolcanlogin AND role.rolcreaterole AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolreplication
        AND NOT role.rolbypassrls)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${probeLiteral}) THEN
    RAISE EXCEPTION 'release authority provider root probe preflight failed';
  END IF;
END
$probe_preflight$;
CREATE ROLE ${probe} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
SELECT pg_catalog.json_build_object(
  'contractVersion',1,
  'systemIdentifier',(SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
  'rootOid',grantor.oid::integer,
  'rootName',grantor.rolname,
  'providerOid',provider.oid::integer,
  'providerName',provider.rolname)::text
FROM pg_catalog.pg_auth_members membership
JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
JOIN pg_catalog.pg_roles provider ON provider.oid=membership.member
JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
WHERE granted.rolname=${probeLiteral}
  AND provider.rolname='${releaseAuthorityBootstrapAdministratorRole}'
  AND membership.admin_option AND NOT membership.inherit_option
  AND NOT membership.set_option
  AND (SELECT count(*) FROM pg_catalog.pg_auth_members edge
    WHERE edge.roleid=granted.oid OR edge.member=granted.oid)=1
  AND grantor.oid<>provider.oid
  AND grantor.rolname NOT IN ('${releaseAuthorityBootstrapAdministratorRole}',
    'reviewrouter_authority_owner','reviewrouter_migration_broker')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members root_edge
    WHERE root_edge.roleid=grantor.oid OR root_edge.member=grantor.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
    JOIN pg_catalog.pg_namespace namespace
      ON dependency.classid='pg_catalog.pg_namespace'::pg_catalog.regclass
      AND namespace.oid=dependency.objid
    WHERE dependency.refobjid=grantor.oid
      AND namespace.nspname IN ('release_authority',
        'reviewrouter_migration_credential','reviewrouter_migration_bootstrap'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database database
    WHERE database.datname=current_database() AND database.datdba=grantor.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace namespace
    WHERE namespace.nspowner=grantor.oid
      AND namespace.nspname IN ('release_authority',
        'reviewrouter_migration_credential','reviewrouter_migration_bootstrap'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class object
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.relnamespace
    WHERE object.relowner=grantor.oid AND namespace.nspname IN (
      'release_authority','reviewrouter_migration_credential'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc object
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=object.pronamespace
    WHERE object.proowner=grantor.oid AND namespace.nspname IN (
      'release_authority','reviewrouter_migration_credential'));
DROP ROLE ${probe};
COMMIT;
`;
}

export function releaseAuthorityBootstrapLifecycleSql(
  bootstrapRole,
  attestation,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const bootstrap = sqlLiteral(bootstrapRole);
  const root = providerRootSql(attestation);
  return `WITH facts AS (
  SELECT
    (SELECT system_identifier::text FROM pg_catalog.pg_control_system())=${root.systemIdentifier}
      AS system_exact,
    (SELECT oid=${root.rootOid} AND rolname=${root.rootName}
       FROM pg_catalog.pg_roles WHERE oid=${root.rootOid}) AS root_exact,
    (SELECT oid=${root.providerOid} AND rolname=${root.providerName}
       FROM pg_catalog.pg_roles WHERE oid=${root.providerOid}) AS provider_exact,
    pg_catalog.to_regrole(${bootstrap}) IS NOT NULL AS bootstrap_exists,
    pg_catalog.to_regrole('reviewrouter_authority_owner') IS NOT NULL AS owner_exists,
    pg_catalog.to_regrole('reviewrouter_migration_broker') IS NOT NULL AS broker_exists,
    coalesce((SELECT bool_and(
        CASE role.rolname
          WHEN 'reviewrouter_authority_owner' THEN NOT role.rolcanlogin
            AND NOT role.rolcreaterole
          WHEN 'reviewrouter_migration_broker' THEN NOT role.rolcanlogin
            AND role.rolcreaterole END
        AND NOT role.rolsuper AND NOT role.rolcreatedb
        AND NOT role.rolreplication AND NOT role.rolbypassrls)
      FROM pg_catalog.pg_roles role
      WHERE role.rolname IN ('reviewrouter_authority_owner',
        'reviewrouter_migration_broker')),false) AS provider_roles_exact,
    coalesce((SELECT role.rolcanlogin AND role.rolcreaterole
        AND NOT role.rolsuper AND NOT role.rolcreatedb
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=1
        AND (role.rolvaliduntil IS NULL
          OR role.rolvaliduntil='infinity'::timestamptz)
        AND coalesce(array_length(role.rolconfig,1),0)=0
      FROM pg_catalog.pg_roles role WHERE role.rolname=${bootstrap}),false)
      AS bootstrap_active,
    coalesce((SELECT NOT role.rolcanlogin AND NOT role.rolcreaterole
        AND NOT role.rolsuper AND NOT role.rolcreatedb
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=1
        AND (role.rolvaliduntil IS NULL
          OR role.rolvaliduntil='infinity'::timestamptz)
        AND coalesce(array_length(role.rolconfig,1),0)=0
      FROM pg_catalog.pg_roles role WHERE role.rolname=${bootstrap}),false)
      AS bootstrap_quiesced,
    (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database
      WHERE datname=current_database()) AS database_owner,
    coalesce((SELECT count(*)=1 AND bool_and(membership.grantor=${root.rootOid}
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      WHERE granted.rolname=${bootstrap} AND member.oid=${root.providerOid}),false)
      AS bootstrap_edge_exact,
    coalesce((SELECT count(*)=2 AND bool_and(membership.grantor=${root.rootOid}
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      WHERE granted.rolname IN ('reviewrouter_authority_owner',
          'reviewrouter_migration_broker') AND membership.member=${root.providerOid}),false)
      AS provider_edges_exact,
    coalesce((SELECT count(*)=1 AND bool_and(grantor.oid=${root.providerOid}
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE granted.rolname='reviewrouter_authority_owner'
        AND member.rolname='reviewrouter_migration_broker'),false) AS broker_edge_exact
    ,(SELECT count(*) FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      WHERE granted.rolname IN (${bootstrap},'reviewrouter_authority_owner',
          'reviewrouter_migration_broker')
        OR member.rolname IN (${bootstrap},'reviewrouter_authority_owner',
          'reviewrouter_migration_broker')) AS bounded_edge_count
)
SELECT CASE
  WHEN NOT system_exact OR NOT root_exact OR NOT provider_exact THEN 'drifted'
  WHEN bootstrap_exists AND database_owner=${bootstrap}
    AND bootstrap_active AND bootstrap_edge_exact
    AND bounded_edge_count=1 AND NOT owner_exists AND NOT broker_exists THEN 'fresh'
  WHEN bootstrap_exists AND database_owner=${bootstrap}
    AND bootstrap_active AND bootstrap_edge_exact AND owner_exists AND broker_exists
    AND provider_roles_exact AND provider_edges_exact AND broker_edge_exact
    AND bounded_edge_count=6
    AND pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NOT NULL
    AND pg_catalog.to_regprocedure(
      'reviewrouter_migration_bootstrap.quiesce(name,name)') IS NOT NULL
    THEN 'provisioned'
  WHEN bootstrap_exists AND database_owner=${bootstrap}
    AND bootstrap_quiesced AND bootstrap_edge_exact AND owner_exists AND broker_exists
    AND provider_roles_exact AND provider_edges_exact AND broker_edge_exact
    AND bounded_edge_count=4
    AND pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NULL
    THEN 'retryable'
  WHEN bootstrap_exists AND database_owner='reviewrouter_authority_owner'
    AND bootstrap_quiesced AND bootstrap_edge_exact AND owner_exists AND broker_exists
    AND provider_roles_exact AND provider_edges_exact AND broker_edge_exact
    AND bounded_edge_count=4
    AND pg_catalog.to_regnamespace('release_authority') IS NOT NULL
    AND pg_catalog.to_regprocedure(
      'reviewrouter_migration_bootstrap.quiesce(name,name)') IS NOT NULL
    THEN 'cleanup-pending'
  WHEN NOT bootstrap_exists AND database_owner='reviewrouter_authority_owner'
    AND owner_exists AND broker_exists AND provider_roles_exact
    AND provider_edges_exact AND broker_edge_exact AND bounded_edge_count=3
    AND pg_catalog.to_regnamespace('release_authority') IS NOT NULL THEN 'terminal'
  ELSE 'drifted' END
FROM facts`;
}

export function releaseAuthorityBootstrapRecoverySql(
  bootstrapRole,
  bootstrapPassword,
  attestation,
  lifecycle = "fresh",
) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const bootstrap = sqlIdentifier(bootstrapRole);
  const bootstrapLiteral = sqlLiteral(bootstrapRole);
  const password = sqlLiteral(bootstrapPassword);
  const root = providerRootSql(attestation);
  if (!["fresh", "retryable"].includes(lifecycle))
    throw new Error("release_authority_bootstrap_lifecycle_invalid");
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
DO $recover$
BEGIN
  IF session_user IS DISTINCT FROM current_user
    OR current_user IS DISTINCT FROM '${releaseAuthorityBootstrapAdministratorRole}'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname=current_user AND role.rolcanlogin AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND role.rolcreaterole AND NOT role.rolreplication
        AND NOT role.rolbypassrls AND role.rolconnlimit=1
        AND role.rolvaliduntil IS NULL
        AND coalesce(array_length(role.rolconfig,1),0)=0)
    OR NOT pg_catalog.pg_has_role(current_user,'pg_signal_backend','MEMBER')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname=${bootstrapLiteral} AND NOT role.rolsuper
        AND NOT role.rolcreatedb AND NOT role.rolreplication
        AND NOT role.rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database database
      WHERE database.datname=current_database()
        AND database.datdba=${bootstrapLiteral}::pg_catalog.regrole)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
        AND membership.member=current_user::pg_catalog.regrole
        AND membership.grantor=${root.rootOid}
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE member.rolname=current_user
        AND NOT ((granted.rolname='pg_signal_backend'
              AND NOT membership.admin_option AND membership.inherit_option
              AND membership.set_option)
          OR (granted.rolname IN (${bootstrapLiteral},
                'reviewrouter_authority_owner','reviewrouter_migration_broker')
              AND grantor.oid=${root.rootOid}
              AND membership.admin_option AND NOT membership.inherit_option
              AND NOT membership.set_option)))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid=current_user::pg_catalog.regrole) THEN
    RAISE EXCEPTION 'release authority bootstrap recovery authority is noncanonical';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      WHERE dependency.refobjid=current_user::pg_catalog.regrole
        AND dependency.deptype='o')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE (granted.rolname=${bootstrapLiteral}
          OR member.rolname=${bootstrapLiteral})
        AND NOT (granted.rolname=${bootstrapLiteral}
          AND member.rolname=current_user AND grantor.oid=${root.rootOid}
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname IN ('reviewrouter_authority_owner',
              'reviewrouter_migration_broker')
          AND member.rolname=${bootstrapLiteral}
          AND grantor.rolname=current_user AND membership.admin_option
          AND NOT membership.inherit_option AND membership.set_option))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      WHERE dependency.refobjid=${bootstrapLiteral}::pg_catalog.regrole
        AND dependency.deptype='o'
        AND NOT (dependency.dbid=(SELECT oid FROM pg_catalog.pg_database
              WHERE datname=current_database())
          OR (dependency.dbid=0
            AND dependency.classid='pg_catalog.pg_database'::pg_catalog.regclass
            AND dependency.objid=(SELECT oid FROM pg_catalog.pg_database
              WHERE datname=current_database())))) THEN
    RAISE EXCEPTION 'release authority bootstrap recovery topology is noncanonical';
  END IF;
END
$recover$;
DO $root_pin$
BEGIN
  IF (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
      IS DISTINCT FROM ${root.systemIdentifier}
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=${root.rootOid} AND rolname=${root.rootName})
    OR current_user::pg_catalog.regrole::oid<>${root.providerOid}
    OR current_user<>${root.providerName} THEN
    RAISE EXCEPTION 'release authority provider root pin changed';
  END IF;
END
$root_pin$;
ALTER ROLE ${bootstrap} LOGIN PASSWORD ${password} CREATEROLE
  CONNECTION LIMIT 1 VALID UNTIL 'infinity';
ALTER ROLE ${bootstrap} RESET ALL;
COMMIT;
`;
}

export function releaseAuthorityBootstrapPreparationSql(
  bootstrapRole,
  attestation,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const bootstrap = sqlLiteral(bootstrapRole);
  const root = providerRootSql(attestation);
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
DO $prepare$
BEGIN
  IF session_user IS DISTINCT FROM ${bootstrap}
    OR current_user IS DISTINCT FROM session_user
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname=${bootstrap} AND role.rolcanlogin
        AND NOT role.rolsuper AND NOT role.rolcreatedb AND role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls
        AND role.rolconnlimit=1
        AND (role.rolvaliduntil IS NULL
          OR role.rolvaliduntil='infinity'::timestamptz)
        AND coalesce(array_length(role.rolconfig,1),0)=0)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database
      WHERE datname=current_database() AND datdba=current_user::pg_catalog.regrole)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='${releaseAuthorityBootstrapAdministratorRole}'
        AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=1
        AND rolvaliduntil IS NULL AND coalesce(array_length(rolconfig,1),0)=0)
    OR NOT pg_catalog.pg_has_role(
      '${releaseAuthorityBootstrapAdministratorRole}','pg_signal_backend','MEMBER')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid=${bootstrap}::pg_catalog.regrole
        AND membership.member='${releaseAuthorityBootstrapAdministratorRole}'::pg_catalog.regrole
        AND membership.grantor=${root.rootOid}
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE member.rolname='${releaseAuthorityBootstrapAdministratorRole}'
        AND NOT ((granted.rolname='pg_signal_backend'
              AND NOT membership.admin_option AND membership.inherit_option
              AND membership.set_option)
          OR (granted.rolname=${bootstrap} AND membership.admin_option
              AND grantor.oid=${root.rootOid}
              AND NOT membership.inherit_option AND NOT membership.set_option)
          OR (granted.rolname IN ('reviewrouter_authority_owner',
                'reviewrouter_migration_broker') AND grantor.oid=${root.rootOid}
              AND membership.admin_option
              AND NOT membership.inherit_option AND NOT membership.set_option)))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      WHERE granted.rolname='${releaseAuthorityBootstrapAdministratorRole}') THEN
    RAISE EXCEPTION 'release authority bootstrap preparation is noncanonical';
  END IF;
END
$prepare$;
GRANT CREATE ON DATABASE :"DBNAME"
  TO ${releaseAuthorityBootstrapAdministratorRole};
COMMIT;
`;
}

export function releaseAuthorityBootstrapRelinquishSql(bootstrapRole) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const bootstrap = sqlLiteral(bootstrapRole);
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
DO $relinquish$
BEGIN
  IF session_user IS DISTINCT FROM ${bootstrap}
    OR current_user IS DISTINCT FROM session_user
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database
      WHERE datname=current_database() AND datdba=current_user::pg_catalog.regrole) THEN
    RAISE EXCEPTION 'release authority bootstrap relinquishment is noncanonical';
  END IF;
END
$relinquish$;
REVOKE CREATE ON DATABASE :"DBNAME"
  FROM ${releaseAuthorityBootstrapAdministratorRole};
COMMIT;
`;
}

export function releaseAuthorityBootstrapProvisioningSql(
  bootstrapRole,
  bootstrapPassword = "bootstrap-password-not-used-by-static-contract",
  attestation,
  lifecycle = "fresh",
) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const bootstrap = sqlIdentifier(bootstrapRole);
  const bootstrapLiteral = sqlLiteral(bootstrapRole);
  const bootstrapPasswordLiteral = sqlLiteral(bootstrapPassword);
  const root = providerRootSql(attestation);
  if (!["fresh", "retryable"].includes(lifecycle))
    throw new Error("release_authority_bootstrap_lifecycle_invalid");
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1381126735,1381258072);
SET LOCAL createrole_self_grant='';
DO $provider_preflight$
BEGIN
  IF session_user IS DISTINCT FROM current_user
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='${releaseAuthorityBootstrapAdministratorRole}'
        AND rolname=current_user AND rolcanlogin AND NOT rolsuper
        AND NOT rolcreatedb AND rolcreaterole AND NOT rolreplication
        AND NOT rolbypassrls AND rolconnlimit=1 AND rolvaliduntil IS NULL
        AND coalesce(array_length(rolconfig,1),0)=0)
    OR NOT pg_catalog.pg_has_role(current_user,'pg_signal_backend','MEMBER')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database database
      JOIN pg_catalog.pg_roles owner ON owner.oid=database.datdba
      WHERE database.datname=current_database() AND owner.rolname=${bootstrapLiteral}
        AND NOT owner.rolsuper AND NOT owner.rolcreatedb
        AND NOT owner.rolreplication AND NOT owner.rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
        AND membership.member=current_user::pg_catalog.regrole
        AND membership.grantor=${root.rootOid}
        AND membership.admin_option AND NOT membership.inherit_option
        AND NOT membership.set_option)
    OR (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
        IS DISTINCT FROM ${root.systemIdentifier}
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=${root.rootOid} AND rolname=${root.rootName})
    OR current_user::pg_catalog.regrole::oid<>${root.providerOid}
    OR current_user<>${root.providerName}
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
        AND membership.member=current_user::pg_catalog.regrole)<>1 THEN
    RAISE EXCEPTION 'release authority provider administrator is noncanonical';
  END IF;
END
$provider_preflight$;
ALTER ROLE ${bootstrap} LOGIN PASSWORD ${bootstrapPasswordLiteral}
  CREATEROLE CONNECTION LIMIT 1 VALID UNTIL 'infinity';
ALTER ROLE ${bootstrap} RESET ALL;
DO $provider$
BEGIN
  IF session_user IS DISTINCT FROM current_user
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='${releaseAuthorityBootstrapAdministratorRole}'
        AND rolname=current_user AND rolcanlogin AND NOT rolsuper
        AND NOT rolcreatedb AND rolcreaterole AND NOT rolreplication
        AND NOT rolbypassrls AND rolconnlimit=1 AND rolvaliduntil IS NULL
        AND coalesce(array_length(rolconfig,1),0)=0)
    OR NOT pg_catalog.pg_has_role(current_user,'pg_signal_backend','MEMBER') THEN
    RAISE EXCEPTION 'release authority provider administrator is noncanonical';
  END IF;
  IF '${lifecycle}'='fresh' AND (EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='reviewrouter_authority_owner') OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='reviewrouter_migration_broker')) THEN
    RAISE EXCEPTION 'release authority fresh lifecycle contains provider roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='reviewrouter_authority_owner') THEN
    CREATE ROLE reviewrouter_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='reviewrouter_migration_broker') THEN
    CREATE ROLE reviewrouter_migration_broker NOLOGIN NOSUPERUSER NOCREATEDB
      CREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      WHERE granted.rolname IN (${bootstrapLiteral},
          'reviewrouter_authority_owner','reviewrouter_migration_broker')
        AND membership.member=current_user::pg_catalog.regrole)<>3
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      WHERE granted.rolname IN (${bootstrapLiteral},
          'reviewrouter_authority_owner','reviewrouter_migration_broker')
        AND membership.member=current_user::pg_catalog.regrole
        AND (membership.grantor<>${root.rootOid}
          OR NOT membership.admin_option OR membership.inherit_option
          OR membership.set_option)) THEN
    RAISE EXCEPTION 'release authority provider ADMIN topology is noncanonical';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
        AND membership.member=current_user::pg_catalog.regrole
        AND membership.admin_option) THEN
    RAISE EXCEPTION 'release authority provider lacks ADMIN on bootstrap';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      JOIN pg_catalog.pg_database database
        ON database.datname=current_database() AND database.datdba=role.oid
      WHERE role.rolname=${bootstrapLiteral} AND role.rolcanlogin
        AND NOT role.rolsuper AND NOT role.rolcreatedb AND role.rolcreaterole
        AND NOT role.rolreplication AND NOT role.rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='reviewrouter_authority_owner' AND NOT rolcanlogin
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname='reviewrouter_migration_broker' AND NOT rolcanlogin
        AND NOT rolsuper AND NOT rolcreatedb AND rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'release authority bootstrap roles are noncanonical';
  END IF;
END
$provider$;
DO $known_edge_gate$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      WHERE (granted.rolname IN ('reviewrouter_authority_owner',
            'reviewrouter_migration_broker') AND member.rolname=${bootstrapLiteral})
        AND NOT (membership.grantor=${root.providerOid}
          AND NOT membership.admin_option AND membership.set_option
          AND membership.inherit_option IS NOT DISTINCT FROM
            (granted.rolname='reviewrouter_authority_owner')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      WHERE granted.rolname='reviewrouter_authority_owner'
        AND member.rolname='reviewrouter_migration_broker'
        AND NOT (membership.grantor=${root.providerOid}
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)) THEN
    RAISE EXCEPTION 'release authority existing P-owned edges are noncanonical';
  END IF;
END
$known_edge_gate$;
REVOKE reviewrouter_authority_owner FROM ${bootstrap}
  GRANTED BY ${releaseAuthorityBootstrapAdministratorRole} RESTRICT;
REVOKE reviewrouter_migration_broker FROM ${bootstrap}
  GRANTED BY ${releaseAuthorityBootstrapAdministratorRole} RESTRICT;
GRANT reviewrouter_authority_owner TO reviewrouter_migration_broker
  WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT reviewrouter_authority_owner TO ${bootstrap}
  WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
GRANT reviewrouter_migration_broker TO ${bootstrap}
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
CREATE SCHEMA reviewrouter_migration_bootstrap AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA reviewrouter_migration_bootstrap FROM PUBLIC;
CREATE FUNCTION reviewrouter_migration_bootstrap.quiesce(
  p_bootstrap name,p_database name) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  IF session_user IS DISTINCT FROM p_bootstrap
    OR current_database() IS DISTINCT FROM p_database
    OR current_user IS DISTINCT FROM '${releaseAuthorityBootstrapAdministratorRole}'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database
      WHERE datname=p_database
        AND datdba='reviewrouter_authority_owner'::pg_catalog.regrole)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
      WHERE usename=p_bootstrap AND pid<>pg_catalog.pg_backend_pid()) THEN
    RAISE EXCEPTION 'bootstrap quiescence is noncanonical';
  END IF;
  EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL',p_bootstrap);
  EXECUTE pg_catalog.format(
    'ALTER ROLE %I NOLOGIN NOCREATEROLE PASSWORD NULL',p_bootstrap);
  EXECUTE pg_catalog.format(
    'REVOKE reviewrouter_authority_owner FROM %I GRANTED BY ${releaseAuthorityBootstrapAdministratorRole} RESTRICT',
    p_bootstrap);
  EXECUTE pg_catalog.format(
    'REVOKE reviewrouter_migration_broker FROM %I GRANTED BY ${releaseAuthorityBootstrapAdministratorRole} RESTRICT',
    p_bootstrap);
END
$body$;
REVOKE ALL ON FUNCTION reviewrouter_migration_bootstrap.quiesce(name,name)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_migration_bootstrap
  TO ${bootstrap},reviewrouter_authority_owner;
GRANT EXECUTE ON FUNCTION reviewrouter_migration_bootstrap.quiesce(name,name)
  TO ${bootstrap},reviewrouter_authority_owner;
COMMIT;
`;
}

export function releaseAuthorityBootstrapCleanupSql(
  bootstrapRole,
  attestation,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const bootstrapLiteral = sqlLiteral(bootstrapRole);
  const bootstrapIdentifier = sqlIdentifier(bootstrapRole);
  const root = providerRootSql(attestation);
  return `\\set ON_ERROR_STOP on
SELECT pg_catalog.pg_advisory_lock(1381126735,1381258072);
DO $cleanup$
DECLARE backend record;
DECLARE database_owner name;
BEGIN
  IF session_user IS DISTINCT FROM '${releaseAuthorityBootstrapAdministratorRole}'
    OR current_user IS DISTINCT FROM session_user
    OR NOT pg_catalog.pg_has_role(current_user,'pg_signal_backend','MEMBER')
    OR (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
        IS DISTINCT FROM ${root.systemIdentifier}
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=${root.rootOid} AND rolname=${root.rootName})
    OR current_user::pg_catalog.regrole::oid<>${root.providerOid}
    OR current_user<>${root.providerName}
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.rolname=${bootstrapLiteral}
        AND (role.rolsuper OR role.rolcreatedb OR role.rolreplication
          OR role.rolbypassrls)) THEN
    RAISE EXCEPTION 'release authority cleanup administrator is noncanonical';
  END IF;
  SELECT pg_catalog.pg_get_userbyid(datdba) INTO STRICT database_owner
  FROM pg_catalog.pg_database WHERE datname=current_database();
  IF database_owner='reviewrouter_authority_owner' THEN
    IF NOT reviewrouter_migration_credential.provider_root_pin_is_exact(
        ${root.systemIdentifier},${root.rootOid}::oid,${root.rootName}::name,
        ${root.providerOid}::oid,${root.providerName}::name)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE usename=${bootstrapLiteral}) THEN
      RAISE EXCEPTION 'release authority terminal root/session pin is noncanonical';
    END IF;
  ELSE
    FOR backend IN SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE usename=${bootstrapLiteral}
    LOOP
      IF NOT pg_catalog.pg_terminate_backend(backend.pid,5000) THEN
        RAISE EXCEPTION 'release authority cleanup backend termination failed';
      END IF;
    END LOOP;
    PERFORM pg_catalog.pg_stat_clear_snapshot();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
      WHERE usename=${bootstrapLiteral}) THEN
    RAISE EXCEPTION 'release authority cleanup left bootstrap sessions';
  END IF;
  IF pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
        WHERE nspname='reviewrouter_migration_bootstrap'
          AND nspowner=current_user::pg_catalog.regrole)
      OR (SELECT count(*) FROM pg_catalog.pg_proc procedure
          WHERE procedure.pronamespace=
            'reviewrouter_migration_bootstrap'::pg_catalog.regnamespace)<>1
      OR pg_catalog.to_regprocedure(
          'reviewrouter_migration_bootstrap.quiesce(name,name)') IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc procedure
        WHERE procedure.oid=pg_catalog.to_regprocedure(
            'reviewrouter_migration_bootstrap.quiesce(name,name)')
          AND procedure.proowner=current_user::pg_catalog.regrole
          AND procedure.prosecdef
          AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            procedure.prosrc,'UTF8')),'hex')=
            '37ede41e54d75bc6c8fc4f5b27516c45864b7f99d3a68a21c170e5dbfbcfb9a2') THEN
      RAISE EXCEPTION 'release authority cleanup helper is noncanonical';
    END IF;
    DROP FUNCTION reviewrouter_migration_bootstrap.quiesce(name,name) RESTRICT;
    DROP SCHEMA reviewrouter_migration_bootstrap RESTRICT;
  END IF;
  IF database_owner=${bootstrapLiteral} THEN
    EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL',${bootstrapLiteral});
    EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN PASSWORD NULL '
      ||'NOCREATEROLE '
      ||'CONNECTION LIMIT 1 VALID UNTIL ''infinity''',${bootstrapLiteral});
    REVOKE reviewrouter_authority_owner FROM ${bootstrapIdentifier}
      GRANTED BY ${releaseAuthorityBootstrapAdministratorRole} RESTRICT;
    REVOKE reviewrouter_migration_broker FROM ${bootstrapIdentifier}
      GRANTED BY ${releaseAuthorityBootstrapAdministratorRole} RESTRICT;
    IF (SELECT count(*) FROM pg_catalog.pg_auth_members membership
        WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
          OR membership.member=${bootstrapLiteral}::pg_catalog.regrole)<>1
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
        WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
          AND membership.member=
            '${releaseAuthorityBootstrapAdministratorRole}'::pg_catalog.regrole
          AND membership.grantor=${root.rootOid}
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option) THEN
      RAISE EXCEPTION 'release authority cleanup left bootstrap memberships';
    END IF;
  ELSIF database_owner='reviewrouter_authority_owner' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
        WHERE role.rolname=${bootstrapLiteral} AND NOT role.rolcanlogin
          AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole
          AND NOT role.rolreplication AND NOT role.rolbypassrls)
      OR (SELECT count(*) FROM pg_catalog.pg_auth_members membership
          WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
            OR membership.member=${bootstrapLiteral}::pg_catalog.regrole)<>1
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
          WHERE membership.roleid=${bootstrapLiteral}::pg_catalog.regrole
            AND membership.member=${root.providerOid}
            AND membership.grantor=${root.rootOid}
            AND membership.admin_option AND NOT membership.inherit_option
            AND NOT membership.set_option)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
          WHERE dependency.refobjid=${bootstrapLiteral}::pg_catalog.regrole
            AND dependency.deptype='o') THEN
      RAISE EXCEPTION 'release authority terminal bootstrap deletion is noncanonical';
    END IF;
    PERFORM reviewrouter_migration_credential.mark_bootstrap_deleted(
      ${bootstrapLiteral},${root.rootOid}::oid,${root.providerOid}::oid);
    DROP ROLE ${bootstrapIdentifier};
  ELSE
    RAISE EXCEPTION 'release authority cleanup lifecycle is drifted';
  END IF;
END
$cleanup$;
SELECT pg_catalog.pg_advisory_unlock(1381126735,1381258072);
`;
}

export const releaseAuthorityBootstrapTerminalSql = (
  bootstrapRole,
  attestation,
) => {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u.test(bootstrapRole))
    throw new Error("release_authority_bootstrap_role_invalid");
  const role = sqlLiteral(bootstrapRole);
  const root = providerRootSql(attestation);
  const providerTopology =
    releaseAuthorityProviderTerminalTopologyExactExpression();
  return `SELECT CASE WHEN
    pg_catalog.to_regnamespace('release_authority') IS NOT NULL
    AND pg_catalog.to_regnamespace('reviewrouter_migration_credential') IS NOT NULL
    AND pg_catalog.obj_description(
      pg_catalog.to_regnamespace('release_authority'),'pg_namespace')::jsonb
        ->'schemaVersion'=pg_catalog.to_jsonb(16)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_database database
      JOIN pg_catalog.pg_roles owner ON owner.oid=database.datdba
      WHERE database.datname=current_database()
        AND owner.rolname='reviewrouter_authority_owner')
    AND (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
      =${root.systemIdentifier}
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=${root.rootOid} AND rolname=${root.rootName})
    AND reviewrouter_migration_credential.provider_root_pin_is_exact(
      ${root.systemIdentifier},${root.rootOid}::oid,${root.rootName}::name,
      ${root.providerOid}::oid,${root.providerName}::name)
    AND reviewrouter_migration_credential.bootstrap_is_retired(${role})
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${role})
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=${role})
    AND pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NULL
    AND pg_catalog.to_regprocedure(
      'reviewrouter_migration_bootstrap.quiesce(name,name)') IS NULL
    AND ${providerTopology}
    AND (SELECT count(*)=3 AND bool_and(
      NOT fixed.rolsuper AND NOT fixed.rolcreatedb
      AND NOT fixed.rolreplication AND NOT fixed.rolbypassrls
      AND fixed.rolvaliduntil IS NULL
      AND coalesce(array_length(fixed.rolconfig,1),0)=0
      AND CASE fixed.rolname
        WHEN 'reviewrouter_authority_owner' THEN
          NOT fixed.rolcanlogin AND NOT fixed.rolcreaterole
            AND fixed.rolconnlimit=(-1)
        WHEN 'reviewrouter_migration_broker' THEN
          NOT fixed.rolcanlogin AND fixed.rolcreaterole
            AND fixed.rolconnlimit=(-1)
        WHEN 'reviewrouter_migration_issuer' THEN
          fixed.rolcanlogin AND NOT fixed.rolcreaterole
            AND fixed.rolconnlimit=(-1)
      END)
      FROM pg_catalog.pg_roles fixed
      WHERE fixed.rolname IN ('reviewrouter_authority_owner',
        'reviewrouter_migration_broker','reviewrouter_migration_issuer'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE (granted.rolname IN ('reviewrouter_authority_owner',
            'reviewrouter_migration_broker','reviewrouter_migration_issuer')
         OR member.rolname IN ('reviewrouter_authority_owner',
            'reviewrouter_migration_broker','reviewrouter_migration_issuer'))
        AND NOT (granted.rolname='reviewrouter_authority_owner'
          AND member.rolname='reviewrouter_migration_broker'
          AND grantor.oid=${root.providerOid}
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname IN ('reviewrouter_authority_owner',
              'reviewrouter_migration_broker')
          AND member.oid=${root.providerOid}
          AND membership.grantor=${root.rootOid}
          AND membership.admin_option AND NOT membership.inherit_option
          AND NOT membership.set_option)
        AND NOT (granted.rolname~'^rr_migration_[a-f0-9]{24}$'
          AND member.rolname='reviewrouter_migration_broker'
          AND reviewrouter_migration_credential.login_role_is_inert(
            granted.rolname)))
    AND (SELECT count(*)=6 AND bool_and(
      acl.grantor=database.datdba AND NOT acl.is_grantable
      AND ((acl.grantee=database.datdba
            AND acl.privilege_type IN ('CREATE','CONNECT','TEMPORARY'))
        OR (acl.grantee=0
            AND acl.privilege_type IN ('CONNECT','TEMPORARY'))
        OR (acl.grantee=(SELECT oid FROM pg_catalog.pg_roles
              WHERE rolname='reviewrouter_migration_issuer')
            AND acl.privilege_type='CONNECT')))
      FROM pg_catalog.pg_database database
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
        database.datacl,pg_catalog.acldefault('d',database.datdba))) acl
      WHERE database.datname=current_database())
  THEN 'terminal' ELSE 'requires-migration' END`;
};

const migrationGateDefaults = Object.freeze({
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 120_000,
});

const validateMigrationGateOptions = (mode, options = {}) => {
  if (!releaseAuthorityMigrationModes.includes(mode))
    throw new Error("release_authority_migration_mode_required");
  const lockTimeoutMs =
    options.lockTimeoutMs ?? migrationGateDefaults.lockTimeoutMs;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? migrationGateDefaults.statementTimeoutMs;
  if (
    !Number.isSafeInteger(lockTimeoutMs) ||
    lockTimeoutMs < 100 ||
    lockTimeoutMs > 30_000
  )
    throw new Error("release_authority_lock_timeout_invalid");
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1_000 ||
    statementTimeoutMs > 600_000 ||
    statementTimeoutMs <= lockTimeoutMs
  )
    throw new Error("release_authority_statement_timeout_invalid");
  return { lockTimeoutMs, statementTimeoutMs };
};

const migrationBody = (source, path) => {
  const withoutBegin = source.replace(/^(?:--[^\n]*\n)*BEGIN;\s*/u, (header) =>
    header.replace(/BEGIN;\s*$/u, ""),
  );
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/u, "\n");
  if (withoutBegin === source || withoutCommit === withoutBegin)
    throw new Error(`release_authority_migration_transaction_invalid:${path}`);
  return withoutCommit;
};

const rewriteAuthoritySchema = (source, schema) =>
  source
    .replaceAll("release_authority", schema)
    // These are verifier session objects, not members of the authority schema.
    .replaceAll(
      `${schema}_catalog_verification`,
      "release_authority_catalog_verification",
    )
    .replaceAll(
      `${schema}_catalog_fingerprint`,
      "release_authority_catalog_fingerprint",
    );

const legacyCatalogPaths = [
  "packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql",
  "packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql",
];

const legacyCatalogChecksums = releaseAuthorityMigrationContract
  .slice(0, 2)
  .map((identity) => identity[2]?.replace(/^sha256:/u, ""));

export function releaseAuthorityMigrationBundle(
  mode,
  root = process.cwd(),
  options = {},
) {
  const { lockTimeoutMs, statementTimeoutMs } = validateMigrationGateOptions(
    mode,
    options,
  );
  const lease = validateMigrationLease(options.lease, mode);
  const leaseJson = lease ? sqlLiteral(JSON.stringify(lease)) : undefined;
  const migrations = releaseAuthorityMigrationPaths.map((path) => ({
    path,
    source: readFileSync(resolve(root, path), "utf8"),
  }));
  const legacyCatalogMigrations = legacyCatalogPaths.map((path, index) => {
    const source = readFileSync(resolve(root, path), "utf8");
    if (
      createHash("sha256").update(source).digest("hex") !==
      legacyCatalogChecksums[index]
    )
      throw new Error(
        `release_authority_legacy_catalog_checksum_invalid:${path}`,
      );
    return { path, source };
  });
  const checksums = migrations.map(({ source }) =>
    createHash("sha256").update(source).digest("hex"),
  );
  releaseAuthorityMigrationManifest.forEach(([, expectedChecksum], index) => {
    if (`sha256:${checksums[index]}` !== expectedChecksum)
      throw new Error(
        `release_authority_migration_checksum_invalid:${releaseAuthorityMigrationPaths[index]}`,
      );
  });
  const bootstrapPosition = 10;
  const bootstrapMigration = migrations[bootstrapPosition - 1];
  const forwardMigrations = migrations.slice(bootstrapPosition);
  if (!bootstrapMigration || forwardMigrations.length < 1)
    throw new Error("release_authority_migrations_empty");
  const historicalMigrations = migrations.slice(0, bootstrapPosition - 1);
  // Audit the two published variants at their last independently observable
  // boundary. Migration 000003 replaces the only catalog difference between
  // the 000001 byte variants, so building shadows through later migrations
  // would make a mixed pair indistinguishable and fabricate its history.
  const shadowMigrations = (schema, migrationsToAudit) =>
    migrationsToAudit.flatMap(({ path, source }) => [
      `\\echo building verified catalog ${schema} from ${path}`,
      migrationBody(rewriteAuthoritySchema(source, schema), path),
    ]);
  const expectedHistoryValues = releaseAuthorityMigrationManifest
    .map(
      ([name, checksum], index) =>
        `(${index + 1},'${name}','${checksum}','canonical')`,
    )
    .join(",\n          ");
  const legacyHistoryValues = releaseAuthorityMigrationContract
    .slice(0, 2)
    .map(
      ([name, , legacyChecksum], index) =>
        `(${index + 1},'${name}','${legacyChecksum}','legacy_equivalent')`,
    )
    .join(",\n          ");
  const allowedHistoryValues = `${expectedHistoryValues},
          ${legacyHistoryValues}`;
  const allowedForwardHistory = releaseAuthorityMigrationManifest
    .slice(bootstrapPosition)
    .map(
      ([name, checksum], index) =>
        `(position=${bootstrapPosition + index + 1}
             AND migration_name='${name}'
             AND checksum_sha256='${checksum}'
             AND byte_variant='canonical')`,
    )
    .join(" OR ");
  const forwardApplicationSteps = forwardMigrations.flatMap(
    (migration, forwardIndex) => {
      const position = 11 + forwardIndex;
      const [name, checksum] = releaseAuthorityMigrationManifest[position - 1];
      const variable = `authority_forward_${position}_present`;
      return [
        `SELECT EXISTS (
       SELECT 1 FROM release_authority.schema_migration
       WHERE position=${position}
         AND migration_name='${name}'
         AND checksum_sha256='${checksum}'
         AND byte_variant='canonical'
     ) AS ${variable} \\gset`,
        `\\if :${variable}`,
        `\\echo release authority forward migration ${position} already present`,
        "\\else",
        `\\echo applying ${migration.path}`,
        migrationBody(migration.source, migration.path),
        `INSERT INTO release_authority.schema_migration
      (position, migration_name, checksum_sha256, byte_variant)
     VALUES (${position}, '${name}', '${checksum}', 'canonical');`,
        "\\endif",
      ];
    },
  );
  return [
    "\\set ON_ERROR_STOP on",
    ...(lease
      ? [
          "BEGIN;",
          `SELECT reviewrouter_migration_credential.consume(${leaseJson}::jsonb);`,
          "SET ROLE reviewrouter_authority_owner;",
        ]
      : ["BEGIN;"]),
    `SET LOCAL lock_timeout = '${lockTimeoutMs}ms';`,
    `SET LOCAL statement_timeout = '${statementTimeoutMs}ms';`,
    `DO $upgrade_gate$
     DECLARE authority_owner name;
     BEGIN
       IF NOT pg_catalog.pg_try_advisory_xact_lock(1381126735, 1381258071) THEN
         RAISE EXCEPTION 'release authority migration gate is already held';
       END IF;
       SELECT pg_catalog.pg_get_userbyid(datdba) INTO STRICT authority_owner
         FROM pg_catalog.pg_database WHERE datname=current_database();
       ${
         lease
           ? `IF current_user IS DISTINCT FROM 'reviewrouter_authority_owner'
          OR session_user IS DISTINCT FROM '${lease.loginRole}'
          OR NOT reviewrouter_migration_credential.active(
            '${lease.leaseId}','${lease.expectedCommitSha}','${lease.workflowRunId}',
            ${lease.workflowRunAttempt},'${lease.operation}') THEN
         RAISE EXCEPTION 'release authority migration lease is not active';
       END IF;`
           : `IF current_user IS DISTINCT FROM session_user
          OR current_user IS DISTINCT FROM authority_owner THEN
         RAISE EXCEPTION 'release authority migration caller is not the database owner session';
       END IF;`
       }
       IF '${mode}' = 'fresh-install'
          AND pg_catalog.to_regnamespace('release_authority') IS NOT NULL THEN
         RAISE EXCEPTION 'release authority fresh install requires an absent authority schema';
       END IF;
       IF '${mode}' = 'incremental-upgrade'
          AND pg_catalog.to_regnamespace('release_authority') IS NULL THEN
         RAISE EXCEPTION 'release authority incremental upgrade requires an existing authority schema';
       END IF;
       IF '${mode}' = 'incremental-upgrade' AND ${lease ? "false" : "true"}
          AND (SELECT pg_catalog.pg_get_userbyid(nspowner)
                 FROM pg_catalog.pg_namespace
                WHERE nspname='release_authority') NOT IN
              (current_user,'reviewrouter_authority_owner') THEN
         RAISE EXCEPTION 'release authority migration caller does not own the authority schema';
       END IF;
     END
     $upgrade_gate$;`,
    `REVOKE CREATE ON DATABASE :"DBNAME"
       FROM ${releaseAuthorityBootstrapAdministratorRole};`,
    "SELECT coalesce((SELECT pg_catalog.pg_get_userbyid(nspowner)='reviewrouter_authority_owner' FROM pg_catalog.pg_namespace WHERE nspname='release_authority'),false) AS authority_uses_fixed_owner \\gset",
    "\\if :authority_uses_fixed_owner",
    "SET ROLE reviewrouter_authority_owner;",
    "\\endif",
    releaseAuthorityDefaultAclPreflightSql("release_authority"),
    "SELECT (to_regnamespace('release_authority') IS NULL) AS authority_schema_absent,",
    "  (to_regclass('release_authority.schema_migration') IS NOT NULL) AS authority_history_present \\gset",
    `CREATE TEMP TABLE release_authority_catalog_verification (
  catalog_fingerprint text NOT NULL,
  byte_variant text NOT NULL CHECK (byte_variant IN ('canonical','legacy_equivalent')),
  verifier text NOT NULL CHECK (verifier IN ('complete_catalog_v1','${releaseAuthorityCatalogVerifier}'))
) ON COMMIT DROP;`,
    releaseAuthorityCatalogFingerprintSql,
    "\\if :authority_schema_absent",
    ...historicalMigrations.flatMap(({ path, source }) => [
      `\\echo applying ${path}`,
      migrationBody(source, path),
    ]),
    `INSERT INTO release_authority_catalog_verification
       (catalog_fingerprint,byte_variant,verifier)
     VALUES (pg_temp.release_authority_catalog_fingerprint('release_authority'),
       'canonical','complete_catalog_v1');`,
    "\\else",
    "\\if :authority_history_present",
    "\\echo existing migration history will be verified below",
    "\\else",
    ...shadowMigrations(
      "release_authority_verify_canonical",
      historicalMigrations.slice(0, 2),
    ),
    ...shadowMigrations(
      "release_authority_verify_legacy",
      legacyCatalogMigrations,
    ),
    `DO $catalog_verification$
     DECLARE live text := pg_temp.release_authority_catalog_fingerprint('release_authority');
     DECLARE canonical text := pg_temp.release_authority_catalog_fingerprint('release_authority_verify_canonical');
     DECLARE legacy text := pg_temp.release_authority_catalog_fingerprint('release_authority_verify_legacy');
     DECLARE matches integer;
     BEGIN
       matches := (live=canonical)::integer + (live=legacy)::integer;
       IF matches <> 1 THEN
         RAISE EXCEPTION 'release authority legacy catalog is ambiguous or modified; audited repair required';
       END IF;
       INSERT INTO release_authority_catalog_verification
         (catalog_fingerprint,byte_variant,verifier)
      VALUES (live,CASE WHEN live=canonical THEN 'canonical' ELSE 'legacy_equivalent' END,
        'complete_catalog_v1');
     END
     $catalog_verification$;`,
    "DROP SCHEMA release_authority_verify_canonical CASCADE;",
    "DROP SCHEMA release_authority_verify_legacy CASCADE;",
    ...historicalMigrations
      .slice(2)
      .flatMap(({ path, source }) => [
        `\\echo applying ${path}`,
        migrationBody(source, path),
      ]),
    `UPDATE release_authority_catalog_verification
       SET catalog_fingerprint=
         pg_temp.release_authority_catalog_fingerprint('release_authority');`,
    "\\endif",
    "\\endif",
    "\\if :authority_history_present",
    "\\echo release authority migration history already present",
    "\\else",
    `\\echo applying ${bootstrapMigration.path}`,
    migrationBody(bootstrapMigration.source, bootstrapMigration.path),
    `INSERT INTO release_authority.schema_migration
      (position, migration_name, checksum_sha256, byte_variant)
     VALUES (10, '000009_authority_history_and_forward_repairs',
       '${releaseAuthorityMigrationManifest[9][1]}', 'canonical');`,
    "\\endif",
    `DO $migration_history$
     BEGIN
       IF (SELECT count(*) NOT BETWEEN ${bootstrapPosition}
             AND ${releaseAuthorityMigrationManifest.length}
             FROM release_authority.schema_migration)
       OR (SELECT count(*) <> 10 FROM release_authority.schema_migration
             WHERE position <= 10)
       OR EXISTS (
         SELECT expected_position
         FROM pg_catalog.generate_series(1,(SELECT count(*)::integer
           FROM release_authority.schema_migration)) expected_position
         EXCEPT SELECT position FROM release_authority.schema_migration
       )
       OR (SELECT byte_variant FROM release_authority.schema_migration
             WHERE position=1) IS DISTINCT FROM
          (SELECT byte_variant FROM release_authority.schema_migration
             WHERE position=2)
       OR EXISTS (
         SELECT position,migration_name,checksum_sha256,byte_variant
           FROM release_authority.schema_migration WHERE position <= 10
         EXCEPT
         (VALUES
          ${allowedHistoryValues})
       ) OR EXISTS (
         SELECT 1 FROM release_authority.schema_migration
         WHERE position > ${bootstrapPosition} AND NOT (
           ${allowedForwardHistory})
       ) THEN
         RAISE EXCEPTION 'release authority migration history mismatch';
       END IF;
     END
     $migration_history$;`,
    ...forwardApplicationSteps,
    "DELETE FROM release_authority_catalog_verification;",
    ...shadowMigrations("release_authority_verify_final", historicalMigrations),
    `INSERT INTO release_authority_catalog_verification
       (catalog_fingerprint,byte_variant,verifier)
     VALUES (pg_temp.release_authority_catalog_fingerprint(
       'release_authority_verify_final'),'canonical','complete_catalog_v1');`,
    migrationBody(
      rewriteAuthoritySchema(
        bootstrapMigration.source,
        "release_authority_verify_final",
      ),
      bootstrapMigration.path,
    ),
    `INSERT INTO release_authority_verify_final.schema_migration
       (position,migration_name,checksum_sha256,byte_variant)
     VALUES (10,'000009_authority_history_and_forward_repairs',
       '${releaseAuthorityMigrationManifest[9][1]}','canonical');`,
    ...forwardMigrations.flatMap((migration, forwardIndex) => {
      const position = 11 + forwardIndex;
      const [name, checksum] = releaseAuthorityMigrationManifest[position - 1];
      const body =
        name === "000015_migration_credential_lease"
          ? `DO $schema_version_marker$
DECLARE marker jsonb := coalesce(pg_catalog.obj_description(
  'release_authority_verify_final'::pg_catalog.regnamespace,'pg_namespace')::jsonb,'{}'::jsonb);
BEGIN
  EXECUTE pg_catalog.format('COMMENT ON SCHEMA release_authority_verify_final IS %L',
    (marker||pg_catalog.jsonb_build_object('schemaVersion',16))::text);
END
$schema_version_marker$;`
          : migrationBody(
              rewriteAuthoritySchema(
                migration.source,
                "release_authority_verify_final",
              ),
              migration.path,
            );
      return [
        body,
        `INSERT INTO release_authority_verify_final.schema_migration
       (position,migration_name,checksum_sha256,byte_variant)
     VALUES (${position},'${name}','${checksum}','canonical');`,
      ];
    }),
    `DO $final_global_roles$
     DECLARE bootstrap_role name := pg_catalog.obj_description(
       'reviewrouter_migration_credential'::pg_catalog.regnamespace,
       'pg_namespace')::jsonb->>'bootstrapRole';
     DECLARE provider_root_oid oid := (SELECT root_oid
       FROM reviewrouter_migration_credential.provider_root_pin WHERE singleton);
     DECLARE provider_oid oid := (SELECT provider_oid
       FROM reviewrouter_migration_credential.provider_root_pin WHERE singleton);
     DECLARE bootstrap_retired boolean :=
       reviewrouter_migration_credential.bootstrap_is_retired();
     BEGIN
       IF (pg_catalog.to_regprocedure(
            'reviewrouter_migration_bootstrap.quiesce(name,name)') IS NULL)
            IS DISTINCT FROM bootstrap_retired
       OR NOT EXISTS (SELECT 1
            FROM reviewrouter_migration_credential.provider_root_pin pin
            JOIN pg_catalog.pg_roles root ON root.oid=pin.root_oid
            JOIN pg_catalog.pg_roles provider ON provider.oid=pin.provider_oid
            WHERE pin.singleton AND pin.contract_version=1
              AND pin.system_identifier=(SELECT system_identifier::text
                FROM pg_catalog.pg_control_system())
              AND root.rolname=pin.root_name
              AND provider.rolname=pin.provider_name
              AND provider.rolname='reviewrouter_bootstrap_administrator')
       OR (SELECT count(*) FROM pg_catalog.pg_stat_activity
             WHERE usename=bootstrap_role) <> (CASE
               WHEN NOT bootstrap_retired AND session_user::name=bootstrap_role THEN 1
               ELSE 0 END)
       OR (NOT bootstrap_retired AND session_user::name=bootstrap_role
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
               WHERE usename=bootstrap_role AND pid=pg_catalog.pg_backend_pid()))
       OR (pg_catalog.to_regrole(bootstrap_role) IS NULL)
            IS DISTINCT FROM bootstrap_retired
       OR (SELECT count(*) FROM pg_catalog.pg_roles role
             WHERE role.rolname IN ('reviewrouter_authority_owner',
               'reviewrouter_migration_broker','reviewrouter_migration_issuer',
               'reviewrouter_bootstrap_administrator',bootstrap_role)) <>
                  (CASE WHEN bootstrap_retired THEN 4 ELSE 5 END)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
             WHERE role.rolname IN ('reviewrouter_authority_owner',
               'reviewrouter_migration_broker','reviewrouter_migration_issuer',
               'reviewrouter_bootstrap_administrator',bootstrap_role)
             AND (role.rolsuper OR role.rolreplication OR role.rolbypassrls
               OR (role.rolname=bootstrap_role AND role.rolvaliduntil IS NOT NULL
                 AND role.rolvaliduntil<>'infinity'::timestamptz)
               OR (role.rolname<>bootstrap_role AND role.rolvaliduntil IS NOT NULL)
               OR coalesce(array_length(role.rolconfig,1),0)<>0
               OR role.rolconnlimit<>CASE WHEN role.rolname IN
                    ('reviewrouter_bootstrap_administrator',bootstrap_role)
                  THEN 1 ELSE -1 END
               OR role.rolcreatedb
               OR role.rolcreaterole IS DISTINCT FROM (role.rolname IN
                    ('reviewrouter_migration_broker',
                     'reviewrouter_bootstrap_administrator'))
               OR role.rolcanlogin IS DISTINCT FROM (role.rolname IN
                    ('reviewrouter_migration_issuer',
                     'reviewrouter_bootstrap_administrator'))))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
             JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
             JOIN pg_catalog.pg_roles member ON member.oid=membership.member
             JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
             WHERE (granted.rolname IN ('reviewrouter_authority_owner',
                    'reviewrouter_migration_broker','reviewrouter_migration_issuer',
                    bootstrap_role)
                OR member.rolname IN ('reviewrouter_authority_owner',
                    'reviewrouter_migration_broker','reviewrouter_migration_issuer',
                    bootstrap_role))
               AND NOT (granted.rolname='reviewrouter_authority_owner'
                 AND member.rolname='reviewrouter_migration_broker'
                 AND grantor.oid=provider_oid
                 AND membership.admin_option AND NOT membership.inherit_option
                 AND NOT membership.set_option)
               AND NOT (granted.rolname='reviewrouter_authority_owner'
                 AND grantor.rolname='reviewrouter_migration_broker'
                 AND NOT membership.admin_option
                 AND NOT membership.inherit_option AND membership.set_option
                 AND reviewrouter_migration_credential.membership_is_active(
                   member.rolname,granted.rolname))
               AND NOT (member.rolname='reviewrouter_migration_broker'
                 AND grantor.oid=provider_root_oid
                 AND membership.admin_option
                 AND NOT membership.inherit_option
                 AND NOT membership.set_option
                 AND reviewrouter_migration_credential.login_role_membership_is_canonical(
                   granted.rolname,member.rolname))
               AND NOT (granted.rolname IN (bootstrap_role,
                    'reviewrouter_authority_owner','reviewrouter_migration_broker')
                 AND member.rolname='reviewrouter_bootstrap_administrator'
                 AND grantor.oid=provider_root_oid
                 AND membership.admin_option AND NOT membership.inherit_option
                 AND NOT membership.set_option))
       OR (SELECT count(*) FROM pg_catalog.pg_auth_members membership
             JOIN pg_catalog.pg_roles member ON member.oid=membership.member
             WHERE member.rolname='reviewrouter_bootstrap_administrator') <>
                  (CASE WHEN bootstrap_retired THEN 3 ELSE 4 END)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
             JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
             WHERE granted.rolname='reviewrouter_bootstrap_administrator')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership
             JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
             JOIN pg_catalog.pg_roles member ON member.oid=membership.member
             JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
             WHERE member.rolname='reviewrouter_bootstrap_administrator'
               AND NOT ((granted.rolname='pg_signal_backend'
                    AND NOT membership.admin_option
                    AND membership.inherit_option AND membership.set_option)
                 OR (granted.rolname IN (bootstrap_role,
                       'reviewrouter_authority_owner','reviewrouter_migration_broker')
                    AND grantor.oid=provider_root_oid
                    AND membership.admin_option
                    AND NOT membership.inherit_option
                    AND NOT membership.set_option)))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
             JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
             WHERE dependency.deptype='o' AND (
               role.rolname IN ('reviewrouter_migration_issuer',
                 bootstrap_role)
               OR (role.rolname='reviewrouter_migration_broker'
                 AND dependency.dbid<>(SELECT oid FROM pg_catalog.pg_database
                   WHERE datname=current_database()))
               OR (role.rolname='reviewrouter_authority_owner' AND NOT (
                 dependency.dbid=(SELECT oid FROM pg_catalog.pg_database
                   WHERE datname=current_database())
                 OR (dependency.dbid=0
                   AND dependency.classid=
                     'pg_catalog.pg_database'::pg_catalog.regclass
                   AND dependency.objid=(SELECT oid FROM pg_catalog.pg_database
                     WHERE datname=current_database()))))))
       OR pg_catalog.has_database_privilege(
            (SELECT oid FROM pg_catalog.pg_roles
              WHERE rolname='reviewrouter_bootstrap_administrator'),
            current_database(),'CREATE')
       OR pg_catalog.has_database_privilege(
            (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=bootstrap_role),
            current_database(),'CREATE')
       OR (SELECT count(*) FROM pg_catalog.pg_database database
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               coalesce(database.datacl,
                 pg_catalog.acldefault('d',database.datdba))) acl
             WHERE database.datname=current_database())<>6
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_database database
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               coalesce(database.datacl,
                 pg_catalog.acldefault('d',database.datdba))) acl
             WHERE database.datname=current_database()
               AND (acl.grantor<>database.datdba OR acl.is_grantable
                 OR NOT ((acl.grantee=database.datdba
                       AND acl.privilege_type IN ('CREATE','CONNECT','TEMPORARY'))
                   OR (acl.grantee=0
                       AND acl.privilege_type IN ('CONNECT','TEMPORARY'))
                   OR (acl.grantee=(SELECT oid FROM pg_catalog.pg_roles
                         WHERE rolname='reviewrouter_migration_issuer')
                       AND acl.privilege_type='CONNECT'))))
       THEN RAISE EXCEPTION 'release authority final global role topology mismatch';
       END IF;
     END
     $final_global_roles$;`,
    `DO $final_catalog$
     DECLARE live_digest text := ${releaseAuthorityCatalogDigestExpression("release_authority")};
     DECLARE expected_digest text := ${releaseAuthorityCatalogDigestExpression("release_authority_verify_final")};
     BEGIN
       IF NOT (${releaseAuthorityDefaultAclExactExpression("release_authority")}) THEN
         RAISE EXCEPTION 'release authority final default ACL is noncanonical';
       END IF;
       IF NOT (${releaseAuthorityFinalAclExactExpression("release_authority")}) THEN
         RAISE EXCEPTION 'release authority final object ACL matrix mismatch';
       END IF;
       IF live_digest IS DISTINCT FROM expected_digest THEN
         RAISE EXCEPTION 'release authority final catalog fingerprint mismatch';
       END IF;
       EXECUTE pg_catalog.format('COMMENT ON SCHEMA release_authority IS %L',
         jsonb_build_object('catalogFingerprint','sha256:'||expected_digest,
           'schemaVersion',16,
           'verifier','${releaseAuthorityCatalogVerifier}')::text);
     END
    $final_catalog$;`,
    "DROP SCHEMA release_authority_verify_final CASCADE;",
    ...(lease
      ? [
          "RESET ROLE;",
          `SELECT reviewrouter_migration_credential.finalize(${leaseJson}::jsonb);`,
        ]
      : []),
    "COMMIT;",
    "",
  ].join("\n");
}

export const postgresEnvironment = (
  encoded,
  environment = process.env,
  passfile = "/run/reviewrouter/release-authority.pgpass",
) => {
  const connection = parseReleaseAuthorityPostgresUrl(encoded);
  return {
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: environment.LANG ?? "C.UTF-8",
    LC_ALL: environment.LC_ALL ?? environment.LANG ?? "C.UTF-8",
    PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: connection.sslmode,
    PGHOST: connection.hostname,
    PGPORT: connection.port,
    PGDATABASE: connection.database,
    PGUSER: connection.username,
    PGPASSFILE: passfile,
  };
};

export function postgresPassfileLine(encoded) {
  return releaseAuthorityPostgresPassfileLine(encoded);
}

const readPrivateCredentialFile = (path, errorCode) => {
  if (!path) throw new Error(`${errorCode}_missing`);
  const metadata = statSync(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new Error(`${errorCode}_file_permissions_invalid`);
  return readFileSync(path, "utf8");
};

export function provisionReleaseAuthorityBootstrap(environment = process.env) {
  const providerUrl = readPrivateCredentialFile(
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE,
    "release_authority_provider_database_url",
  );
  const bootstrapUrl = readPrivateCredentialFile(
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE,
    "release_authority_bootstrap_database_url",
  );
  const provider = parseReleaseAuthorityPostgresUrl(providerUrl);
  const bootstrap = parseReleaseAuthorityPostgresUrl(bootstrapUrl);
  if (
    releaseAuthorityPostgresEndpoint(providerUrl) !==
    releaseAuthorityPostgresEndpoint(bootstrapUrl)
  )
    throw new Error("release_authority_bootstrap_database_endpoint_mismatch");
  if (provider.username !== releaseAuthorityBootstrapAdministratorRole)
    throw new Error("release_authority_provider_role_identity_invalid");
  const bootstrapRole = bootstrap.username;
  const bootstrapPassword = bootstrap.password;
  const attestation = probeProviderRoot(environment);
  const lifecycle = executeProviderSql(
    releaseAuthorityBootstrapLifecycleSql(bootstrapRole, attestation),
    environment,
    false,
  );
  if (!["fresh", "retryable"].includes(lifecycle))
    throw new Error(`release_authority_bootstrap_lifecycle_${lifecycle}`);
  executeProviderSql(
    releaseAuthorityBootstrapRecoverySql(
      bootstrapRole,
      bootstrapPassword,
      attestation,
      lifecycle,
    ),
    environment,
  );
  executeBootstrapSql(
    releaseAuthorityBootstrapPreparationSql(bootstrapRole, attestation),
    environment,
  );
  const psqlBinary = environment.REVIEW_ROUTER_PSQL_BINARY ?? "psql";
  if (!/^(?:psql|\/[A-Za-z0-9._+/-]{1,1023})$/u.test(psqlBinary))
    throw new Error("release_authority_psql_binary_invalid");
  try {
    const directory = mkdtempSync(join(tmpdir(), "rr-authority-provisioning-"));
    const passfile = join(directory, "pgpass");
    writeFileSync(passfile, postgresPassfileLine(providerUrl), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      const reprobe = probeProviderRoot(environment);
      if (JSON.stringify(reprobe) !== JSON.stringify(attestation))
        throw new Error("release_authority_provider_root_pin_changed");
      const result = spawnSync(psqlBinary, ["--no-psqlrc", "--quiet"], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        input: releaseAuthorityBootstrapProvisioningSql(
          bootstrapRole,
          bootstrapPassword,
          attestation,
          lifecycle,
        ),
        env: postgresEnvironment(providerUrl, environment, passfile),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      });
      if (result.status !== 0 || result.error)
        throw sanitizedDiagnosticError({
          code: "release_authority_bootstrap_provisioning_process_failed",
          phase: "authority_bootstrap_provisioning",
          exitCode: result.status,
          signal: result.signal,
          timedOut: result.error?.code === "ETIMEDOUT",
        });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    executeBootstrapSql(
      releaseAuthorityBootstrapRelinquishSql(bootstrapRole),
      environment,
    );
  }
}

const bootstrapConnectionContext = (environment) => {
  const providerUrl = readPrivateCredentialFile(
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE,
    "release_authority_provider_database_url",
  );
  const bootstrapUrl = readPrivateCredentialFile(
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE,
    "release_authority_bootstrap_database_url",
  );
  const provider = parseReleaseAuthorityPostgresUrl(providerUrl);
  const bootstrap = parseReleaseAuthorityPostgresUrl(bootstrapUrl);
  if (
    releaseAuthorityPostgresEndpoint(providerUrl) !==
    releaseAuthorityPostgresEndpoint(bootstrapUrl)
  )
    throw new Error("release_authority_bootstrap_database_endpoint_mismatch");
  if (provider.username !== releaseAuthorityBootstrapAdministratorRole)
    throw new Error("release_authority_provider_role_identity_invalid");
  return {
    providerUrl,
    bootstrapUrl,
    bootstrapRole: bootstrap.username,
  };
};

const executeConnectionSql = (sql, databaseUrl, environment, quiet = true) => {
  const psqlBinary = environment.REVIEW_ROUTER_PSQL_BINARY ?? "psql";
  if (!/^(?:psql|\/[A-Za-z0-9._+/-]{1,1023})$/u.test(psqlBinary))
    throw new Error("release_authority_psql_binary_invalid");
  const directory = mkdtempSync(join(tmpdir(), "rr-authority-provider-"));
  const passfile = join(directory, "pgpass");
  writeFileSync(passfile, postgresPassfileLine(databaseUrl), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    const result = spawnSync(
      psqlBinary,
      [
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        ...(quiet ? ["--quiet"] : []),
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        input: sql,
        env: postgresEnvironment(databaseUrl, environment, passfile),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (result.status !== 0 || result.error)
      throw sanitizedDiagnosticError({
        code: "release_authority_migration_process_failed",
        phase: "authority_migration",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
    return result.stdout.trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const executeProviderSql = (sql, environment, quiet = true) => {
  const { providerUrl } = bootstrapConnectionContext(environment);
  return executeConnectionSql(sql, providerUrl, environment, quiet);
};

const executeBootstrapSql = (sql, environment, quiet = true) => {
  const { bootstrapUrl } = bootstrapConnectionContext(environment);
  return executeConnectionSql(sql, bootstrapUrl, environment, quiet);
};

const probeProviderRoot = (environment) => {
  const probeRole = `rr_root_probe_${randomBytes(16).toString("hex")}`;
  const output = executeProviderSql(
    releaseAuthorityProviderRootProbeSql(probeRole),
    environment,
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("release_authority_provider_root_probe_invalid");
  }
  return validateProviderRootAttestation(parsed);
};

export function cleanupReleaseAuthorityBootstrap(environment = process.env) {
  const { bootstrapRole } = bootstrapConnectionContext(environment);
  const attestation = probeProviderRoot(environment);
  const terminal = executeProviderSql(
    releaseAuthorityBootstrapTerminalSql(bootstrapRole, attestation),
    environment,
    false,
  );
  if (terminal === "terminal") return "already-terminal";
  const lifecycle = executeProviderSql(
    releaseAuthorityBootstrapLifecycleSql(bootstrapRole, attestation),
    environment,
    false,
  );
  if (lifecycle === "terminal" || lifecycle === "drifted")
    throw new Error("release_authority_bootstrap_cleanup_state_unverified");
  executeProviderSql(
    releaseAuthorityBootstrapCleanupSql(bootstrapRole, attestation),
    environment,
  );
  if (lifecycle === "cleanup-pending") {
    const verified = executeProviderSql(
      releaseAuthorityBootstrapTerminalSql(bootstrapRole, attestation),
      environment,
      false,
    );
    if (verified !== "terminal")
      throw new Error("release_authority_bootstrap_terminal_state_unverified");
    return "terminal";
  }
  return "quiesced";
}

export function bootstrapReleaseAuthorityDatabase(
  mode,
  environment = process.env,
) {
  const { bootstrapRole } = bootstrapConnectionContext(environment);
  const attestation = probeProviderRoot(environment);
  const lifecycle = executeProviderSql(
    releaseAuthorityBootstrapLifecycleSql(bootstrapRole, attestation),
    environment,
    false,
  );
  if (lifecycle === "terminal") {
    const state = executeProviderSql(
      releaseAuthorityBootstrapTerminalSql(bootstrapRole, attestation),
      environment,
      false,
    );
    if (state === "terminal") return "already-terminal";
    throw new Error("release_authority_bootstrap_terminal_state_unverified");
  }
  if (lifecycle === "drifted")
    throw new Error("release_authority_bootstrap_lifecycle_drifted");
  if (lifecycle === "cleanup-pending") {
    cleanupReleaseAuthorityBootstrap(environment);
    return "installed";
  }
  try {
    provisionReleaseAuthorityBootstrap(environment);
    installReleaseAuthorityDatabase({
      ...environment,
      REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE: mode,
    });
  } finally {
    cleanupReleaseAuthorityBootstrap(environment);
  }
  const terminalAttestation = probeProviderRoot(environment);
  const terminal = executeProviderSql(
    releaseAuthorityBootstrapTerminalSql(bootstrapRole, terminalAttestation),
    environment,
    false,
  );
  if (terminal !== "terminal")
    throw new Error("release_authority_bootstrap_terminal_state_unverified");
  return "installed";
}

export function installReleaseAuthorityDatabase(environment = process.env) {
  const mode = environment.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE;
  validateMigrationGateOptions(mode);
  const credentialFile =
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE;
  if (!credentialFile)
    throw new Error(
      "release_authority_env_missing:REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE",
    );
  const credential = statSync(credentialFile);
  if (!credential.isFile() || (credential.mode & 0o077) !== 0)
    throw new Error(
      "release_authority_owner_database_url_file_permissions_invalid",
    );
  const databaseUrl = readFileSync(credentialFile, "utf8");
  const leaseFile =
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE;
  let lease;
  if (leaseFile) {
    const metadata = statSync(leaseFile);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error(
        "release_authority_migration_lease_file_permissions_invalid",
      );
    lease = validateMigrationLease(
      JSON.parse(readFileSync(leaseFile, "utf8")),
      mode,
    );
  }
  const psqlBinary = environment.REVIEW_ROUTER_PSQL_BINARY ?? "psql";
  if (!/^(?:psql|\/[A-Za-z0-9._+/-]{1,1023})$/u.test(psqlBinary))
    throw new Error("release_authority_psql_binary_invalid");
  const directory = mkdtempSync(join(tmpdir(), "rr-authority-migration-"));
  const passfile = join(directory, "pgpass");
  writeFileSync(passfile, postgresPassfileLine(databaseUrl), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    const result = spawnSync(psqlBinary, ["--no-psqlrc", "--quiet"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      input: releaseAuthorityMigrationBundle(
        mode,
        fileURLToPath(new URL("..", import.meta.url)),
        { lease },
      ),
      env: postgresEnvironment(databaseUrl, environment, passfile),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    });
    if (result.status !== 0 || result.error)
      throw sanitizedDiagnosticError({
        code: "release_authority_migration_process_failed",
        phase: "authority_migration",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const argumentsAfterScript = process.argv.slice(2);
  if (argumentsAfterScript.length !== 1)
    throw new Error("release_authority_migration_mode_required");
  const mode = argumentsAfterScript[0]?.replace(/^--/u, "");
  if (mode === "provision-bootstrap") {
    provisionReleaseAuthorityBootstrap();
    process.exit(0);
  }
  if (mode === "cleanup-bootstrap") {
    cleanupReleaseAuthorityBootstrap();
    process.exit(0);
  }
  if (
    process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE &&
    (mode === "fresh-install" || mode === "incremental-upgrade")
  ) {
    bootstrapReleaseAuthorityDatabase(mode);
    process.exit(0);
  }
  process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE = mode;
  installReleaseAuthorityDatabase();
}
