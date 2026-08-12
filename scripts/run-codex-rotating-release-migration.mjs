#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  "CodexOAuthDatabaseAuthorityKey",
  "CodexOAuthDatabaseAuthorityReceipt",
]);

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
const activationPermitInstallerRoleName =
  "reviewrouter_activation_permit_installer";
const activationReceiptReaderRoleName =
  "reviewrouter_activation_receipt_reader";

export function activationAuthorityProvisioningSql() {
  return `\\set ON_ERROR_STOP on
BEGIN;
DO $authority_roles$
DECLARE guard pg_roles%ROWTYPE;
DECLARE installer pg_roles%ROWTYPE;
DECLARE reader pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO guard FROM pg_roles WHERE rolname = '${activationReceiptGuardRoleName}';
  SELECT * INTO installer FROM pg_roles WHERE rolname = '${activationPermitInstallerRoleName}';
  SELECT * INTO reader FROM pg_roles WHERE rolname = '${activationReceiptReaderRoleName}';
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
  IF EXISTS (
    SELECT 1 FROM pg_auth_members edge
    WHERE edge.roleid IN (guard.oid, installer.oid, reader.oid)
       OR edge.member IN (guard.oid, installer.oid, reader.oid)
  ) THEN
    RAISE EXCEPTION 'activation authority roles must have no membership edges';
  END IF;
END
$authority_roles$;
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${activationReceiptReaderRoleName};
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
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
  first_write_receipt_sha256 text NOT NULL,
  transaction_id bigint NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE reviewrouter_activation.activation_permit OWNER TO ${activationReceiptGuardRoleName};
ALTER TABLE reviewrouter_activation.activation_receipt OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${activationPermitInstallerRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${activationReceiptReaderRoleName};
REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM ${canonicalBootstrapRoleName};
CREATE OR REPLACE FUNCTION reviewrouter_activation.install_activation_permit(
  requested_rollout_id text, requested_source_system_identifier text,
  requested_target_system_identifier text, requested_postgres_major integer,
  requested_expected_commit_sha text, requested_migration_checksum text,
  requested_target_deploy_ids jsonb, requested_permit_epoch bigint,
  requested_permit_nonce text
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
     OR requested_permit_epoch < 1
     OR requested_permit_nonce !~ '^[a-f0-9]{32}$' THEN
    RAISE EXCEPTION 'activation permit invalid';
  END IF;
  INSERT INTO reviewrouter_activation.activation_permit (
    rollout_id, source_system_identifier, target_system_identifier,
    postgres_major, expected_commit_sha, migration_checksum,
    target_deploy_ids, permit_epoch, permit_nonce
  ) VALUES (
    requested_rollout_id, requested_source_system_identifier,
    requested_target_system_identifier, requested_postgres_major,
    requested_expected_commit_sha, requested_migration_checksum,
    requested_target_deploy_ids, requested_permit_epoch, requested_permit_nonce
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
     AND existing.permit_nonce = requested_permit_nonce THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'activation permit conflicts with installed tuple';
END
$install_permit$;
ALTER FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_activation TO ${activationPermitInstallerRoleName};
GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) TO ${activationPermitInstallerRoleName};
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
CREATE OR REPLACE FUNCTION reviewrouter_activation.activate_generation(
  requested_rollout_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $activate$
DECLARE permit reviewrouter_activation.activation_permit%ROWTYPE;
DECLARE receipt reviewrouter_activation.activation_receipt%ROWTYPE;
DECLARE live_system_identifier text;
DECLARE live_postgres_major integer;
DECLARE live_migration_checksum text;
DECLARE database_binding jsonb;
DECLARE expected_acl_facts jsonb;
DECLARE catalog_acl_facts jsonb;
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
       OR receipt.permit_nonce <> permit.permit_nonce THEN
      RAISE EXCEPTION 'activation receipt conflicts with permit replay';
    END IF;
  ELSIF permit.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'consumed activation permit has no receipt';
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
       ) THEN
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
        has_column_privilege(role_name,relation.oid,attribute.attnum,'UPDATE') AS can_update
      FROM runtime_roles
      CROSS JOIN pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE namespace.nspname='public' AND relation.relname IN (
        'RepositoryConnection','CodexOAuthChildIdentityQuarantine','CodexOAuthLease',
        'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance','CodexOAuthSecretNamespace',
        'CodexOAuthSetupDispatchAttempt','CodexOAuthSetupManifest','CodexOAuthSetupPayloadClaim',
        'CodexOAuthSetupRecoveryRequest','CodexOAuthWritebackIntent',
        'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt'
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
           AND relname NOT IN ('CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt'))
         OR can_insert IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname NOT IN (
           '_prisma_migrations','RepositoryConnection','CodexOAuthChildIdentityQuarantine',
           'CodexOAuthProviderIdentityQuarantine','CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt'))
         OR can_update IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname NOT IN (
           '_prisma_migrations','RepositoryConnection','CodexOAuthChildIdentityQuarantine',
           'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance',
           'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt'))
         OR can_delete IS DISTINCT FROM (role_kind <> 'effect-authority' AND relname NOT IN (
           '_prisma_migrations','RepositoryConnection','CodexOAuthChildIdentityQuarantine','CodexOAuthLease',
           'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance','CodexOAuthSecretNamespace',
           'CodexOAuthSetupDispatchAttempt','CodexOAuthSetupManifest','CodexOAuthSetupPayloadClaim',
           'CodexOAuthSetupRecoveryRequest','CodexOAuthWritebackIntent',
           'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt'))
         OR can_truncate OR can_reference OR can_trigger)
       OR EXISTS (SELECT 1 FROM column_facts WHERE can_update IS DISTINCT FROM (
         role_kind <> 'effect-authority' AND (
           (relname='CodexOAuthProviderInstance'
             AND attname=ANY(ARRAY[${providerRuntimeUpdateColumns.map((column) => `'${column}'`).join(",")}]))
           OR relname NOT IN (
             'RepositoryConnection','CodexOAuthChildIdentityQuarantine',
             'CodexOAuthProviderIdentityQuarantine','CodexOAuthProviderInstance',
             'CodexOAuthDatabaseAuthorityKey','CodexOAuthDatabaseAuthorityReceipt'
           )
         )
       ))
       OR EXISTS (SELECT 1 FROM sequence_facts WHERE
         can_usage IS DISTINCT FROM (role_kind <> 'effect-authority')
         OR can_select OR can_update)
       OR EXISTS (SELECT 1 FROM function_facts WHERE can_execute IS DISTINCT FROM CASE
         WHEN role_kind='effect-authority' THEN proname='codex_oauth_sign_database_authority'
           AND argument_types='text'
         WHEN proname='codex_oauth_database_authority_challenge' THEN argument_types='text, text, integer'
         WHEN proname='codex_oauth_consume_database_authority' THEN argument_types='text, text, integer'
         WHEN role_kind='api' AND proname='codex_oauth_authorize_runtime_confirmation' THEN argument_types='text, text, integer, text'
         WHEN role_kind='api' AND proname='codex_oauth_authorize_runtime_completion' THEN argument_types='text, text'
         WHEN role_kind='web' AND proname='codex_oauth_authorize_setup_confirmation' THEN argument_types='text, integer, text'
         WHEN role_kind='web' AND proname='codex_oauth_provider_identity_repair_challenge' THEN argument_types='text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, bigint'
         WHEN role_kind='web' AND proname='codex_oauth_repair_quarantined_provider' THEN argument_types='text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, bigint, text'
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
  catalog_facts_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
    jsonb_build_object('policyVersion',1,'facts',catalog_acl_facts)::text,'UTF8')),'hex');
  IF receipt.rollout_id IS NOT NULL THEN
    IF receipt.canonical_privileges_sha256 <> canonical_privileges_sha256
       OR receipt.catalog_facts_sha256 <> catalog_facts_sha256 THEN
      RAISE EXCEPTION 'activation receipt conflicts with catalog replay';
    END IF;
  ELSE
    first_write_receipt_sha256 := 'sha256:' || encode(pg_catalog.sha256(convert_to(
      permit.rollout_id || ':' || permit.source_system_identifier || ':' ||
      permit.target_system_identifier || ':' || permit.postgres_major::text || ':' ||
      permit.expected_commit_sha || ':' || permit.migration_checksum || ':' ||
      permit.target_deploy_ids::text || ':' || permit.permit_epoch::text || ':' ||
      permit.permit_nonce || ':' || canonical_privileges_sha256 || ':' ||
      catalog_facts_sha256, 'UTF8')), 'hex');
    INSERT INTO reviewrouter_activation.activation_receipt (
      rollout_id, source_system_identifier, target_system_identifier,
      postgres_major, expected_commit_sha, migration_checksum, target_deploy_ids,
      permit_epoch, permit_nonce, canonical_privileges_sha256,
      catalog_facts_sha256, first_write_receipt_sha256, transaction_id
    ) VALUES (
      permit.rollout_id, permit.source_system_identifier,
      permit.target_system_identifier, permit.postgres_major,
      permit.expected_commit_sha, permit.migration_checksum,
      permit.target_deploy_ids, permit.permit_epoch, permit.permit_nonce,
      canonical_privileges_sha256, catalog_facts_sha256,
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
    'firstWriteReceiptSha256',receipt.first_write_receipt_sha256,
    'transactionId',receipt.transaction_id::text,
    'activatedAt',to_char(receipt.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'firstWriteBoundary',true
  );
END
$activate$;
ALTER FUNCTION reviewrouter_activation.activate_generation(text) OWNER TO ${activationReceiptGuardRoleName};
REVOKE ALL ON FUNCTION reviewrouter_activation.activate_generation(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_release_migration;
GRANT EXECUTE ON FUNCTION reviewrouter_activation.activate_generation(text) TO reviewrouter_release_migration;
CREATE OR REPLACE FUNCTION reviewrouter_activation.read_activation_receipt(
  requested_rollout_id text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $read_receipt$
DECLARE receipt reviewrouter_activation.activation_receipt%ROWTYPE;
BEGIN
  IF session_user <> '${activationReceiptReaderRoleName}'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$' THEN
    RAISE EXCEPTION 'activation receipt read request invalid';
  END IF;
  SELECT * INTO receipt FROM reviewrouter_activation.activation_receipt
  WHERE rollout_id=requested_rollout_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
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
COMMIT;
`;
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
          AND owner.rolname <> 'reviewrouter_release_migration'
        UNION ALL
        SELECT owner.rolname
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        JOIN pg_roles owner ON owner.oid = routine.proowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname <> 'reviewrouter_release_migration'
        UNION ALL
        SELECT owner.rolname
        FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        JOIN pg_roles owner ON owner.oid = type.typowner
        WHERE namespace.nspname = 'public'
          AND type.typtype IN ('d', 'e', 'm', 'r')
          AND owner.rolname <> 'reviewrouter_release_migration'
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
    verifiedRoles.ownership?.databaseOwner !== canonicalBootstrapRoleName ||
    verifiedRoles.ownership?.publicSchemaOwner !==
      "reviewrouter_release_migration" ||
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

export function roleProvisioningSql(configuration) {
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
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
    FROM pg_auth_members edge
    JOIN pg_roles granted ON granted.oid = edge.roleid
    JOIN pg_roles member ON member.oid = edge.member
    WHERE (granted.rolname = '${username}' OR member.rolname = '${username}')
      AND NOT (
        granted.rolname = '${username}'
        AND member.rolname = 'reviewrouter_role_bootstrap'
      )
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY reviewrouter_role_bootstrap',
      membership.granted_name,
      membership.member_name
    );
  END LOOP;
END
$membership$;
`,
    )
    .join("\n");
  return `\\set ON_ERROR_STOP on
BEGIN;
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
${createAndConverge}
DO $grantor_topology$
DECLARE total_count integer;
DECLARE canonical_count integer;
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
         count(DISTINCT granted.oid) FILTER (
           WHERE granted.rolname = ANY (ARRAY[${canonicalRoleNames.map(quoted).join(",")}])
             AND member.rolname = '${canonicalBootstrapRoleName}'
         ),
         count(DISTINCT grantor.oid)
  INTO total_count, canonical_count, granted_role_count, grantor_count
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
    AND member.rolname <> '${activationReceiptGuardRoleName}'
  ;
  IF total_count <> ${canonicalRoleNames.length}
     OR canonical_count <> ${canonicalRoleNames.length}
     OR granted_role_count <> ${canonicalRoleNames.length}
     OR grantor_count <> 1 THEN
    RAISE EXCEPTION
      'refusing non-canonical role membership topology: total %, canonical %, roles %, grantors %',
      total_count, canonical_count, granted_role_count, grantor_count;
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
SELECT format('GRANT CREATE ON DATABASE %I TO reviewrouter_release_migration', current_database())
\\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO reviewrouter_release_migration WITH GRANT OPTION', current_database())
\\gexec
DO $database_delegation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_database database,
         LATERAL aclexplode(coalesce(database.datacl, acldefault('d', database.datdba))) acl
    WHERE database.datname = current_database()
      AND acl.grantee = 'reviewrouter_release_migration'::regrole
      AND acl.privilege_type = 'CONNECT'
      AND acl.is_grantable
  ) OR EXISTS (
    SELECT 1
    FROM pg_database database,
         LATERAL aclexplode(coalesce(database.datacl, acldefault('d', database.datdba))) acl
    WHERE database.datname = current_database()
      AND acl.grantee = 'reviewrouter_release_migration'::regrole
      AND acl.privilege_type = 'CREATE'
      AND acl.is_grantable
  ) THEN
    RAISE EXCEPTION 'release migration database delegation is non-canonical';
  END IF;
END
$database_delegation$;
GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_migration;
GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH SET TRUE;
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
  WHERE owner_name NOT IN ('reviewrouter_role_bootstrap', 'reviewrouter_release_migration')
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
      WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      WHEN 'v' THEN format('ALTER VIEW %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
      ELSE format('ALTER TABLE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regclass)
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
    EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_release_migration', owned_object.oid::regprocedure);
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
      EXECUTE format('ALTER DOMAIN public.%I OWNER TO reviewrouter_release_migration', owned_object.typname);
    ELSE
      EXECUTE format('ALTER TYPE public.%I OWNER TO reviewrouter_release_migration', owned_object.typname);
    END IF;
  END LOOP;
END
$transfer_public_ownership$;
SELECT 'ALTER SCHEMA public OWNER TO reviewrouter_release_migration'
WHERE (SELECT owner.rolname FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname = 'public') <> 'reviewrouter_release_migration'
\\gexec
REVOKE reviewrouter_release_migration FROM reviewrouter_role_bootstrap GRANTED BY CURRENT_ROLE;
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
BEGIN
  IF to_regclass('reviewrouter_activation.activation_permit') IS NULL
     OR to_regclass('reviewrouter_activation.activation_receipt') IS NULL
     OR to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)') IS NULL
     OR to_regprocedure('reviewrouter_activation.activate_generation(text)') IS NULL
     OR to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NULL
     OR to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()') IS NULL
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='reviewrouter_activation.activation_permit'::regclass)) <> '${activationReceiptGuardRoleName}'
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='reviewrouter_activation.activation_receipt'::regclass)) <> '${activationReceiptGuardRoleName}'
     OR has_function_privilege('reviewrouter_release_migration','reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)','EXECUTE')
     OR has_function_privilege('${activationPermitInstallerRoleName}','reviewrouter_activation.activate_generation(text)','EXECUTE')
     OR has_function_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.activate_generation(text)','EXECUTE')
     OR has_table_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.activation_receipt','SELECT')
     OR has_table_privilege('${canonicalBootstrapRoleName}','reviewrouter_activation.activation_receipt','SELECT')
     OR NOT has_function_privilege('${canonicalBootstrapRoleName}','reviewrouter_activation.assert_no_activation_receipt()','EXECUTE')
     OR NOT has_function_privilege('${activationReceiptReaderRoleName}','reviewrouter_activation.read_activation_receipt(text)','EXECUTE') THEN
    RAISE EXCEPTION 'external activation authority boundary is not installed canonically';
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

function assertConnectionRole(observed, expectedUser, expectCreateRole) {
  if (
    observed?.currentUser !== expectedUser ||
    observed?.sessionUser !== expectedUser ||
    observed?.login !== true ||
    observed?.createRole !== expectCreateRole ||
    observed?.superuser !== false ||
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
) {
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
  ]
    .map((table) => `'${table}'`)
    .join(",");
  const providerUpdateColumnList = providerRuntimeUpdateColumns
    .map((column) => `"${column}"`)
    .join(", ");
  return `
REVOKE CREATE ON DATABASE ${databaseTarget} FROM PUBLIC;
REVOKE CONNECT ON DATABASE ${databaseTarget} FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
${configuration.roles
  .filter(({ role }) => role !== "effect-authority")
  .map(
    ({
      role,
      username,
    }) => `GRANT CONNECT ON DATABASE ${databaseTarget} TO ${username};
GRANT USAGE ON SCHEMA public TO ${username};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_database_authority_challenge"(text, text, integer) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_consume_database_authority"(text, text, integer) TO ${username};
${
  role === "web"
    ? `GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_setup_confirmation"(text, integer, text) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_provider_identity_repair_challenge"(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint) TO ${username};
GRANT EXECUTE ON FUNCTION public."codex_oauth_repair_quarantined_provider"(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,bigint,text) TO ${username};`
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
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${username};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${username};
ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_migration IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${username};`,
  )
  .join("\n")}
GRANT CONNECT ON DATABASE ${databaseTarget} TO reviewrouter_codex_effect_authority;
GRANT USAGE ON SCHEMA public TO reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE CREATE ON SCHEMA public FROM reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM reviewrouter_codex_effect_authority;
GRANT EXECUTE ON FUNCTION public."codex_oauth_sign_database_authority"(text) TO reviewrouter_codex_effect_authority;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
`;
}

export function runtimeAclGateStatements(configuration) {
  return `${configuration.roles
    .map(
      ({ username }) => `REVOKE CONNECT ON DATABASE :"DBNAME" FROM ${username};
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${username};
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${username};`,
    )
    .join("\n")}`;
}

export function runtimeGrantSql(configuration, { gateClosed = false } = {}) {
  const runtimeRoleLiterals = configuration.roles
    .map(({ username }) => quoted(username))
    .join(",");
  return `\\set ON_ERROR_STOP on
BEGIN;
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

export function canonicalActivationSql(configuration, activation) {
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(activation.rolloutId))
    throw new Error("release_migration_activation_identity_invalid");
  return {
    sql: `\\set ON_ERROR_STOP on
BEGIN;
${runtimeGrantStatements(configuration)}
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
    throw new Error(`release_migration_step_failed:${step}:credential_missing`);
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
        throw new Error(`release_migration_step_failed:${step}:url_missing`);
      let url;
      try {
        url = new URL(childArgs[urlIndex]);
      } catch {
        throw new Error(`release_migration_step_failed:${step}:url_invalid`);
      }
      const passfile = join(directory, "pgpass");
      const escape = (value) =>
        value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
      writeFileSync(
        passfile,
        `${escape(url.hostname)}:${escape(url.port || "5432")}:${escape(decodeURIComponent(url.pathname.slice(1)))}:${escape(decodeURIComponent(url.username))}:${escape(decodeURIComponent(url.password))}\n`,
        { mode: 0o600, flag: "wx" },
      );
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
      childEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        PGPASSFILE: passfile,
        ...(url.searchParams.get("sslmode")
          ? { PGSSLMODE: url.searchParams.get("sslmode") }
          : {}),
      };
    } else if (command === "node" || command === "pnpm") {
      const credentialPath = join(directory, "database-url");
      writeFileSync(credentialPath, databaseUrl, { mode: 0o600, flag: "wx" });
      childEnv = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        REVIEW_ROUTER_DATABASE_URL_FILE: credentialPath,
      };
    } else {
      throw new Error(
        `release_migration_step_failed:${step}:command_forbidden`,
      );
    }
    const result = spawnSync(command, childArgs, {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: childEnv,
      input,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`release_migration_step_failed:${step}`);
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
    true,
  );
  run(
    "provision_roles",
    "psql",
    [configuration.bootstrapUrl, "--no-psqlrc", "--quiet"],
    { env: bootstrapEnv, input: roleProvisioningSql(configuration) },
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
    false,
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
  const childEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  assertConnectionRole(
    observeConnectionRole(
      run,
      "verify_release_authority",
      configuration.releaseUrl,
      childEnv,
    ),
    "reviewrouter_release_migration",
    false,
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
  run(
    "deploy_migrations",
    "pnpm",
    ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"],
    { env: childEnv },
  );
  run(
    "converge_runtime_grants",
    "psql",
    [configuration.releaseUrl, "--no-psqlrc", "--quiet"],
    {
      env: childEnv,
      input: runtimeGrantSql(configuration, {
        gateClosed: env.REVIEW_ROUTER_RELEASE_ACL_GATE_MODE === "closed",
      }),
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
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "release_migration_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
