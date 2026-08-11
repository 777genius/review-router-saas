#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHostname } from "../packages/shared/src/validation/loopback-hostname.mjs";
import { canonicalProviderJson } from "./codex-rotating-provider-provenance.mjs";
import {
  codexRotatingCatalogTables,
  codexRotatingCatalogColumns,
  codexRotatingPrimaryKeys,
  codexRotatingCatalogForeignKeyNames,
  codexRotatingDatabaseRoles,
} from "./codex-rotating-production-writer-schema.mjs";

const checkoutRoot = resolve(import.meta.dirname, "..");
const catalogManifestSourceFile =
  "scripts/codex-rotating-production-writer-schema.mjs";
const migrationFiles = [
  [
    "000060_codex_oauth_setup_serialization",
    "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
  ],
  [
    "000061_codex_oauth_provider_mutation_fence",
    "packages/platform/db/prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
  ],
  [
    "000062_codex_oauth_remote_outcome_unknown",
    "packages/platform/db/prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
  ],
  [
    "000063_codex_oauth_setup_payload_claim",
    "packages/platform/db/prisma/migrations/000063_codex_oauth_setup_payload_claim/migration.sql",
  ],
  [
    "000064_codex_oauth_versioned_secret_namespaces",
    "packages/platform/db/prisma/migrations/000064_codex_oauth_versioned_secret_namespaces/migration.sql",
  ],
];
assertExactMigrationInventory(
  readdirSync(resolve(checkoutRoot, "packages/platform/db/prisma/migrations"))
    .filter((name) => /^0000(?:6[0-9]|[7-9][0-9])_/u.test(name))
    .sort(),
  migrationFiles.map(([id]) => id),
);

function assertExactMigrationInventory(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Codex rotating migration inventory mismatch: ${JSON.stringify({ actual, expected })}`,
    );
  }
}

const sqlLiterals = (values) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
const ownedColumnPredicate = codexRotatingCatalogColumns
  .map(
    ({ table, name }) => `(c.relname = '${table}' AND a.attname = '${name}')`,
  )
  .join(" OR ");
const catalogTriggerTables = [
  "RepositoryConnection",
  ...codexRotatingCatalogTables,
];
const releaseMigrationRole = codexRotatingDatabaseRoles.releaseMigration;
const runtimeDatabaseRoles = codexRotatingDatabaseRoles.runtime;
const allDatabaseRoles = [
  releaseMigrationRole,
  codexRotatingDatabaseRoles.effectAuthority,
  ...runtimeDatabaseRoles,
];

export const codexRotatingProductionWriterBaseObservationSql = String.raw`
SELECT jsonb_build_object(
  'databaseIdentity', jsonb_build_object(
    'currentDatabase', current_database(),
    'currentSchema', current_schema(),
    'serverAddress', concat(coalesce(inet_server_addr()::text, 'local'), ':', inet_server_port()),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system())
  ),
  'isWriter', NOT pg_is_in_recovery(),
  'postgresVersion', current_setting('server_version'),
  'databaseCaller', jsonb_build_object(
    'databaseRole', current_user,
    'sessionUser', session_user
  ),
  'databaseGenerationBinding', (
    SELECT CASE
      WHEN obj_description(d.oid, 'pg_database') IS NULL THEN NULL
      ELSE obj_description(d.oid, 'pg_database')::jsonb
    END
    FROM pg_database d WHERE d.datname = current_database()
  ),
  'admittedRecoveryEvidence', jsonb_build_object(
    'witnessFingerprints', coalesce((
      SELECT jsonb_agg(value ORDER BY value) FROM (
        SELECT DISTINCT value FROM (
          SELECT "databaseRecoveryWitness" AS value FROM "CodexOAuthSetupManifest"
          UNION ALL SELECT "databaseRecoveryWitness" FROM "CodexOAuthWritebackIntent"
          UNION ALL SELECT "databaseRecoveryWitness" FROM "CodexOAuthSetupRecoveryRequest"
          UNION ALL SELECT "databaseRecoveryWitness" FROM "CodexOAuthSetupPayloadClaim"
          UNION ALL SELECT "databaseRecoveryWitness" FROM "CodexOAuthSecretNamespace"
        ) admitted WHERE value IS NOT NULL
      ) unique_values
    ), '[]'::jsonb),
    'databaseIncarnations', coalesce((
      SELECT jsonb_agg(value ORDER BY value) FROM (
        SELECT DISTINCT value FROM (
          SELECT "databaseIncarnation" AS value FROM "CodexOAuthWritebackIntent"
          UNION ALL SELECT "databaseIncarnation" FROM "CodexOAuthSetupPayloadClaim"
        ) admitted WHERE value IS NOT NULL
      ) unique_values
    ), '[]'::jsonb)
  ),
  'databaseAuthorization', jsonb_build_object(
    'databaseOwner', (SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = current_database()),
    'schemaOwner', (SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = current_schema()),
    'roles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', r.rolname,
        'canLogin', r.rolcanlogin,
        'superuser', r.rolsuper,
        'createDatabase', r.rolcreatedb,
        'createRole', r.rolcreaterole,
        'bypassRls', r.rolbypassrls,
        'databaseCreate', has_database_privilege(r.rolname, current_database(), 'CREATE'),
        'schemaCreate', has_schema_privilege(r.rolname, current_schema(), 'CREATE'),
        'schemaUsage', has_schema_privilege(r.rolname, current_schema(), 'USAGE'),
        'canSetReleaseRole', coalesce(pg_has_role(
          r.oid,
          (SELECT oid FROM pg_roles WHERE rolname = '${releaseMigrationRole}'),
          'SET'
        ), false),
        'ownsCatalogObject', EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname IN (${sqlLiterals([...codexRotatingCatalogTables, "_prisma_migrations"])})
            AND c.relowner = r.oid
        ),
        'ddlTablePrivileges', EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
            AND (
              has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
              OR has_table_privilege(r.rolname, c.oid, 'REFERENCES')
              OR has_table_privilege(r.rolname, c.oid, 'TRIGGER')
            )
        )
      ) ORDER BY r.rolname)
      FROM pg_roles r WHERE r.rolname IN (${sqlLiterals(allDatabaseRoles)})
    ), '[]'::jsonb),
    'memberships', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'role', granted.rolname,
        'member', member.rolname,
        'grantor', grantor.rolname,
        'adminOption', m.admin_option,
        'inheritOption', m.inherit_option,
        'setOption', m.set_option
      ) ORDER BY granted.rolname, member.rolname)
      FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles grantor ON grantor.oid = m.grantor
      WHERE granted.rolname IN (${sqlLiterals(allDatabaseRoles)})
         OR member.rolname IN (${sqlLiterals(allDatabaseRoles)})
    ), '[]'::jsonb),
    'releaseRoleSettableByLoginRoles', coalesce((
      SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
      FROM pg_roles r
      WHERE r.rolcanlogin AND coalesce(pg_has_role(
        r.oid,
        (SELECT oid FROM pg_roles WHERE rolname = '${releaseMigrationRole}'),
        'SET'
      ), false)
    ), '[]'::jsonb),
    'nonReleaseOwnedCatalogObjects', coalesce((
      SELECT jsonb_agg(c.relname ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname IN (${sqlLiterals([...codexRotatingCatalogTables, "_prisma_migrations"])})
        AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = '${releaseMigrationRole}')
    ), '[]'::jsonb),
    'nonReleaseOwnedFunctions', coalesce((
      SELECT jsonb_agg(p.proname ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
        AND p.proname LIKE 'codex_oauth_%'
        AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = '${releaseMigrationRole}')
    ), '[]'::jsonb)
  ),
  'unsafeWork', jsonb_build_object(
    'activeLeasesWithoutPositiveEpoch', (SELECT count(*)::int FROM "CodexOAuthLease" WHERE status IN ('preleased','finalized') AND ("mutationEpoch" IS NULL OR "mutationEpoch" <= 0)),
    'activeManifestsWithoutPositiveEpoch', (SELECT count(*)::int FROM "CodexOAuthSetupManifest" WHERE status IN ('issued','fetched') AND ("mutationEpoch" IS NULL OR "mutationEpoch" <= 0)),
    'pendingIntents', (SELECT count(*)::int FROM "CodexOAuthWritebackIntent" WHERE status = 'pending'),
    'pendingIntentsWithoutPositiveEpoch', (SELECT count(*)::int FROM "CodexOAuthWritebackIntent" WHERE status = 'pending' AND ("mutationEpoch" IS NULL OR "mutationEpoch" <= 0))
  ),
  'recoveryOwnerId', (
    SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance"
    WHERE "mutationOwner" = 'recovery'
      AND (
        "mutationOwnerId" LIKE 'setup-recovery:%'
        OR "mutationOwnerId" LIKE 'versioned-namespace-cutover:%'
      )
    ORDER BY
      CASE WHEN "mutationOwnerId" LIKE 'setup-recovery:%' THEN 0 ELSE 1 END,
      id
    LIMIT 1
  ),
  'history', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'migration_name', migration_name,
      'checksum', checksum,
      'finished', finished_at IS NOT NULL AND rolled_back_at IS NULL,
      'current', rolled_back_at IS NULL,
      'applied_steps_count', applied_steps_count
    ) ORDER BY started_at)
    FROM _prisma_migrations
    WHERE migration_name IN (
      '000060_codex_oauth_setup_serialization',
      '000061_codex_oauth_provider_mutation_fence'
      ,'000062_codex_oauth_remote_outcome_unknown'
      ,'000063_codex_oauth_setup_payload_claim'
      ,'000064_codex_oauth_versioned_secret_namespaces'
    )
  ), '[]'::jsonb),
  'catalog', jsonb_build_object(
    'tables', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', c.relname,
        'kind', c.relkind,
        'persistence', c.relpersistence,
        'rowSecurity', c.relrowsecurity,
        'forceRowSecurity', c.relforcerowsecurity
      ) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname LIKE 'CodexOAuth%'
    ), '[]'::jsonb),
    'inventory', jsonb_build_object(
      'columns', coalesce((
        SELECT jsonb_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attnum)
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
          AND a.attnum > 0 AND NOT a.attisdropped
      ), '[]'::jsonb),
      'checks', coalesce((
        SELECT jsonb_agg(con.conname ORDER BY con.conname)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
          AND con.contype = 'c'
      ), '[]'::jsonb),
      'indexes', coalesce((
        SELECT jsonb_agg(index_class.relname ORDER BY index_class.relname)
        FROM pg_index i
        JOIN pg_class table_class ON table_class.oid = i.indrelid
        JOIN pg_class index_class ON index_class.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = table_class.relnamespace
        WHERE n.nspname = current_schema()
          AND table_class.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
      ), '[]'::jsonb),
      'foreignKeys', coalesce((
        SELECT jsonb_agg(con.conname ORDER BY con.conname)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_class referenced ON referenced.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND (
            c.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
            OR referenced.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
          )
          AND con.contype = 'f'
      ), '[]'::jsonb),
      'triggers', coalesce((
        SELECT jsonb_agg(t.tgname ORDER BY t.tgname)
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = current_schema()
          AND c.relname IN (${sqlLiterals(catalogTriggerTables)})
      ), '[]'::jsonb),
      'functions', coalesce((
        SELECT jsonb_agg(p.proname ORDER BY p.proname)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema()
          AND (
            p.proname LIKE 'codex_oauth_%'
            OR p.oid IN (
              SELECT t.tgfoid FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace tn ON tn.oid = c.relnamespace
              WHERE NOT t.tgisinternal
                AND tn.nspname = current_schema()
                AND c.relname IN (${sqlLiterals(catalogTriggerTables)})
            )
          )
      ), '[]'::jsonb)
    ),
    'columns', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'table', c.relname,
        'name', a.attname,
        'ordinal', a.attnum,
        'type', format_type(a.atttypid, a.atttypmod),
        'nullable', NOT a.attnotnull,
        'defaultExpression', CASE WHEN d.adbin IS NULL THEN NULL ELSE pg_get_expr(d.adbin, d.adrelid) END,
        'identity', a.attidentity,
        'generated', a.attgenerated
      ) ORDER BY c.relname, a.attnum)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = current_schema() AND a.attnum > 0 AND NOT a.attisdropped
        AND (${ownedColumnPredicate})
    ), '[]'::jsonb),
    'triggers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', t.tgname,
        'table', c.relname,
        'function', p.proname,
        'type', t.tgtype,
        'enabled', t.tgenabled
      ) ORDER BY t.tgname)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT t.tgisinternal
        AND n.nspname = current_schema()
        AND pn.nspname = current_schema()
        AND c.relname IN ('RepositoryConnection','CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent','CodexOAuthSetupRecoveryRequest','CodexOAuthSetupPayloadClaim','CodexOAuthSecretNamespace','CodexOAuthSetupDispatchAttempt')
    ), '[]'::jsonb),
    'functions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', p.proname,
        'bodySha256', encode(sha256(convert_to(btrim(
          replace(replace(p.prosrc, E'\r\n', E'\n'), E'\r', E'\n'),
          E' \t\n\r'
        ), 'UTF8')), 'hex'),
        'prokind', p.prokind,
        'proretset', p.proretset,
        'prosupport', CASE
          WHEN p.prosupport = 0::oid THEN NULL
          ELSE p.prosupport::regproc::text
        END,
        'procost', p.procost,
        'prorows', p.prorows,
        'securityDefiner', p.prosecdef,
        'config', p.proconfig,
        'language', l.lanname,
        'volatility', p.provolatile,
        'parallel', p.proparallel,
        'leakproof', p.proleakproof,
        'strict', p.proisstrict,
        'resultType', pg_get_function_result(p.oid),
        'arguments', pg_get_function_arguments(p.oid)
      ) ORDER BY p.proname)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = current_schema()
        AND (
          p.proname LIKE 'codex_oauth_%'
          OR p.oid IN (
            SELECT t.tgfoid FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace tn ON tn.oid = c.relnamespace
            WHERE NOT t.tgisinternal
              AND tn.nspname = current_schema()
              AND c.relname IN (${sqlLiterals(catalogTriggerTables)})
          )
        )
    ), '[]'::jsonb),
    'checks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', con.conname,
        'table', c.relname,
        'definition', pg_get_constraintdef(con.oid),
        'definitionSha256', encode(sha256(convert_to(
          btrim(regexp_replace(pg_get_constraintdef(con.oid), E'\\s+', ' ', 'g')),
          'UTF8'
        )), 'hex'),
        'validated', con.convalidated
      ) ORDER BY con.conname)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'c'
        AND n.nspname = current_schema()
        AND c.relname IN ('CodexOAuthDatabaseAuthorityKey','CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent','CodexOAuthSetupRecoveryRequest','CodexOAuthSetupPayloadClaim','CodexOAuthSecretNamespace','CodexOAuthSetupDispatchAttempt')
        AND con.conname IN (
          'CodexOAuthDatabaseAuthorityKey_singleton_check',
          'CodexOAuthProviderInstance_mutation_fence_check',
          'CodexOAuthLease_pullRequestNumber_check',
          'CodexOAuthSetupManifest_epoch_check',
          'CodexOAuthLease_epoch_check',
          'CodexOAuthWritebackIntent_epoch_check'
          ,'CodexOAuthSetupRecoveryRequest_epoch_check'
          ,'CodexOAuthSetupRecoveryRequest_contract_check'
          ,'CodexOAuthSetupRecoveryRequest_database_recovery_witness_check'
          ,'CodexOAuthSetupManifest_payload_claim_complete_check'
          ,'CodexOAuthSetupManifest_recovery_expiry_check'
          ,'CodexOAuthSetupManifest_database_recovery_witness_check'
          ,'CodexOAuthSetupPayloadClaim_payload_check'
          ,'CodexOAuthSecretNamespace_lifecycle_check'
          ,'CodexOAuthSecretNamespace_name_check'
          ,'CodexOAuthSecretNamespace_recovery_witness_check'
          ,'CodexOAuthSetupDispatchAttempt_lifecycle_check'
          ,'CodexOAuthProviderInstance_active_namespace_pair_check'
          ,'CodexOAuthLease_secret_namespace_pair_check'
          ,'CodexOAuthWritebackIntent_versioned_dispatch_check'
          ,'CodexOAuthWritebackIntent_executor_lease_check'
          ,'CodexOAuthWritebackIntent_provider_response_check'
          ,'CodexOAuthWritebackIntent_database_incarnation_check'
          ,'CodexOAuthWritebackIntent_database_recovery_witness_check'
          ,'CodexOAuthWritebackIntent_account_identity_check'
          ,'CodexOAuthWritebackIntent_recovery_resolution_check'
        )
    ), '[]'::jsonb),
    'indexes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', index_class.relname,
        'definition', pg_get_indexdef(index_class.oid),
        'definitionSha256', encode(sha256(convert_to(
          btrim(regexp_replace(pg_get_indexdef(index_class.oid), E'\\s+', ' ', 'g')),
          'UTF8'
        )), 'hex'),
        'predicate', coalesce(pg_get_expr(i.indpred, i.indrelid), ''),
        'predicateSha256', CASE WHEN i.indpred IS NULL THEN NULL ELSE encode(sha256(convert_to(
          btrim(regexp_replace(pg_get_expr(i.indpred, i.indrelid), E'\\s+', ' ', 'g')),
          'UTF8'
        )), 'hex') END,
        'unique', i.indisunique,
        'valid', i.indisvalid,
        'ready', i.indisready,
        'method', am.amname,
        'keyCount', i.indnkeyatts,
        'includeCount', i.indnatts - i.indnkeyatts,
        'keys', (SELECT jsonb_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
          LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
          WHERE key.ordinality <= i.indnkeyatts),
        'opclasses', (SELECT jsonb_agg(opc.opcname ORDER BY key.ordinality)
          FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS key(opcoid, ordinality)
          JOIN pg_opclass opc ON opc.oid = key.opcoid
          WHERE key.ordinality <= i.indnkeyatts),
        'options', (SELECT jsonb_agg(option ORDER BY key.ordinality)
          FROM unnest(i.indoption::smallint[]) WITH ORDINALITY AS key(option, ordinality)
          WHERE key.ordinality <= i.indnkeyatts)
      ) ORDER BY index_class.relname)
      FROM pg_index i
      JOIN pg_class table_class ON table_class.oid = i.indrelid
      JOIN pg_class index_class ON index_class.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = index_class.relnamespace
      JOIN pg_am am ON am.oid = index_class.relam
      WHERE n.nspname = current_schema()
        AND table_class.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint primary_constraint
          WHERE primary_constraint.conindid = i.indexrelid
            AND primary_constraint.contype = 'p'
        )
    ), '[]'::jsonb),
    'foreignKeys', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', con.conname,
        'table', c.relname,
        'definition', pg_get_constraintdef(con.oid),
        'validated', con.convalidated
      ) ORDER BY con.conname)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND con.conname IN (
        ${sqlLiterals(codexRotatingCatalogForeignKeyNames)}
      )
    ), '[]'::jsonb),
    'primaryKeys', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', con.conname,
        'table', c.relname,
        'definition', pg_get_constraintdef(con.oid),
        'validated', con.convalidated
      ) ORDER BY con.conname)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'p'
        AND n.nspname = current_schema()
        AND con.conname IN (${sqlLiterals(codexRotatingPrimaryKeys.map(({ name }) => name))})
    ), '[]'::jsonb),
    'privileges', jsonb_build_object(
      'functions', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'name', p.proname,
          'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
          'grantor', grantor.rolname,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) ORDER BY p.proname, grantee.rolname NULLS FIRST, acl.privilege_type)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
        JOIN pg_roles grantor ON grantor.oid = acl.grantor
        WHERE n.nspname = current_schema()
          AND (
            p.proname LIKE 'codex_oauth_%'
            OR p.oid IN (
              SELECT t.tgfoid FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace tn ON tn.oid = c.relnamespace
              WHERE NOT t.tgisinternal
                AND tn.nspname = current_schema()
                AND c.relname IN (${sqlLiterals(catalogTriggerTables)})
            )
          )
      ), '[]'::jsonb),
      'tables', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'name', c.relname,
          'grantee', CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
          'grantor', grantor.rolname,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) ORDER BY c.relname, grantee.rolname NULLS FIRST, acl.privilege_type)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
        JOIN pg_roles grantor ON grantor.oid = acl.grantor
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND c.relname IN (${sqlLiterals(codexRotatingCatalogTables)})
      ), '[]'::jsonb)
    )
  )
)::text;
`;

const drainObservationSql = String.raw`
SELECT jsonb_build_object(
  'databaseIdentity', jsonb_build_object(
    'currentDatabase', current_database(),
    'currentSchema', current_schema(),
    'serverAddress', concat(coalesce(inet_server_addr()::text, 'local'), ':', inet_server_port()),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system())
  ),
  'isWriter', NOT pg_is_in_recovery(),
  'activeLeases', (SELECT count(*)::int FROM "CodexOAuthLease" WHERE status IN ('preleased','finalized')),
  'fetchedSetups', (SELECT count(*)::int FROM "CodexOAuthSetupManifest" WHERE status = 'fetched'),
  'pendingIntents', (SELECT count(*)::int FROM "CodexOAuthWritebackIntent" WHERE status = 'pending'),
  'writerInFlight', (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND classid = 1381126735 AND objid = 1129271119 AND mode = 'ShareLock' AND granted),
  'observedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)::text;
`;

export function assertProductionWriterCaptureConfiguration(env) {
  if (env.REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION !== "1") {
    throw new Error(
      "production writer observation acknowledgement is required",
    );
  }
  const databaseUrl = env.REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("production writer database URL is required");
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("production writer database URL must use PostgreSQL");
  }
  if (isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      "production writer observation cannot use a loopback database",
    );
  }
  const deployObservationPath = env.REVIEW_ROUTER_RENDER_OBSERVATION_PATH;
  if (!deployObservationPath) {
    throw new Error("trusted Render observation path is required");
  }
  let deployObservationBytes;
  let deployObservation;
  try {
    deployObservationBytes = readFileSync(resolve(deployObservationPath));
    deployObservation = JSON.parse(deployObservationBytes.toString("utf8"));
  } catch {
    throw new Error("trusted Render observation is unreadable");
  }
  const migrationCallers = deployObservation?.migrationCallers;
  if (
    deployObservation?.observationVersion !== 2 ||
    deployObservation?.source !== "render-api" ||
    deployObservation?.captureIdentity?.authenticated !== true ||
    deployObservation?.captureIdentity?.apiHost !== "api.render.com" ||
    !Array.isArray(deployObservation?.rawResponses) ||
    deployObservation.rawResponses.length === 0 ||
    deployObservation.captureIdentity.rawResponsesSha256 !==
      sha256(
        Buffer.from(canonicalProviderJson(deployObservation.rawResponses)),
      ) ||
    !Array.isArray(migrationCallers) ||
    migrationCallers.length !== 1
  ) {
    throw new Error(
      "trusted Render observation must identify one migration caller",
    );
  }
  const platformIdentity = migrationCallers[0];
  if (
    platformIdentity?.name !== "reviewrouter-release-migration" ||
    platformIdentity?.role !== "release-migration" ||
    !/^srv-[A-Za-z0-9_-]+$/u.test(platformIdentity?.serviceId ?? "") ||
    !/^dep-[A-Za-z0-9_-]+$/u.test(platformIdentity?.deployId ?? "") ||
    !/^job-[A-Za-z0-9_-]+$/u.test(platformIdentity?.jobId ?? "") ||
    !/^[a-f0-9]{40}$/u.test(platformIdentity?.commit ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(platformIdentity?.imageDigest ?? "") ||
    platformIdentity?.status !== "succeeded" ||
    !Number.isFinite(Date.parse(platformIdentity?.observedAt ?? ""))
  ) {
    throw new Error("trusted Render migration caller identity is invalid");
  }
  return {
    databaseUrl,
    platformIdentity,
    platformDeployObservationSha256: sha256(deployObservationBytes),
    runtimeWitnessSha256: deployObservation?.runtimeWitness?.sha256,
  };
}

function queryJson(databaseUrl, sql) {
  try {
    const stdout = execFileSync(
      "psql",
      [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error("production writer observation query failed");
  }
}

export async function captureProductionWriterObservation(
  env,
  {
    query = queryJson,
    sleep = (delayMs) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  } = {},
) {
  const configuration = assertProductionWriterCaptureConfiguration(env);
  const intervalMs = Number(
    env.REVIEW_ROUTER_DRAIN_OBSERVATION_INTERVAL_MS ?? 60_000,
  );
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000) {
    throw new Error("drain observation interval must be at least 15000ms");
  }
  const base = query(
    configuration.databaseUrl,
    codexRotatingProductionWriterBaseObservationSql,
  );
  if (
    base?.databaseCaller?.databaseRole !== releaseMigrationRole ||
    base?.databaseCaller?.sessionUser !== releaseMigrationRole ||
    base?.isWriter !== true
  ) {
    throw new Error(
      "database caller is not the canonical writer release-migration role",
    );
  }
  const generationBinding = base?.databaseGenerationBinding;
  if (
    generationBinding?.version !== 1 ||
    generationBinding?.systemIdentifier !==
      base?.databaseIdentity?.systemIdentifier ||
    !/^[a-f0-9]{64}$/u.test(generationBinding?.recoveryWitnessSha256 ?? "")
  ) {
    throw new Error("database generation witness binding is absent or invalid");
  }
  const recoveryWitnessSha256 = generationBinding.recoveryWitnessSha256;
  if (
    !Array.isArray(base?.admittedRecoveryEvidence?.witnessFingerprints) ||
    !Array.isArray(base?.admittedRecoveryEvidence?.databaseIncarnations) ||
    base.admittedRecoveryEvidence.witnessFingerprints.length === 0 ||
    base.admittedRecoveryEvidence.databaseIncarnations.length === 0 ||
    !base.admittedRecoveryEvidence.witnessFingerprints.every(
      (value) => value === recoveryWitnessSha256,
    ) ||
    !base.admittedRecoveryEvidence.databaseIncarnations.every(
      (value) => value === base.databaseIdentity.systemIdentifier,
    )
  ) {
    throw new Error(
      "admitted recovery evidence does not match the database generation",
    );
  }
  if (configuration.runtimeWitnessSha256 !== recoveryWitnessSha256) {
    throw new Error(
      "database recovery witness is not independently bound to the Render runtime secret",
    );
  }
  const bindDrainObservation = (observation) => ({
    ...observation,
    recoveryWitnessSha256,
  });
  const firstDrain = bindDrainObservation(
    query(configuration.databaseUrl, drainObservationSql),
  );
  await sleep(intervalMs);
  const secondDrain = bindDrainObservation(
    query(configuration.databaseUrl, drainObservationSql),
  );
  return {
    observationVersion: 4,
    source: "production-postgresql-writer",
    captureKind: "database-query",
    rehearsal: false,
    databaseIdentity: base.databaseIdentity,
    isWriter: base.isWriter,
    recoveryWitnessSha256,
    databaseGenerationBinding: generationBinding,
    admittedRecoveryEvidence: base.admittedRecoveryEvidence,
    databaseAuthorization: base.databaseAuthorization,
    callerIdentity: {
      id: "release-migration",
      kind: "immutable-release-migration",
      platform: "render",
      platformDeployObservationSha256:
        configuration.platformDeployObservationSha256,
      serviceId: configuration.platformIdentity.serviceId,
      deployId: configuration.platformIdentity.deployId,
      jobId: configuration.platformIdentity.jobId,
      commit: configuration.platformIdentity.commit,
      imageDigest: configuration.platformIdentity.imageDigest,
      observedAt: configuration.platformIdentity.observedAt,
      ...base.databaseCaller,
    },
    postgresVersion: base.postgresVersion,
    unsafeWork: base.unsafeWork,
    recoveryOwnerId: base.recoveryOwnerId,
    catalogManifest: {
      sourceFile: catalogManifestSourceFile,
      sha256: sha256(
        readFileSync(resolve(checkoutRoot, catalogManifestSourceFile)),
      ),
    },
    migrationSources: migrationFiles.map(([id, sourceFile]) => ({
      id,
      sha256: sha256(readFileSync(resolve(checkoutRoot, sourceFile))),
    })),
    history: base.history,
    catalog: base.catalog,
    drainObservations: [firstDrain, secondDrain],
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function main(env = process.env, stdout = process.stdout) {
  const observation = await captureProductionWriterObservation(env);
  stdout.write(`${JSON.stringify(observation)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "production writer observation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
