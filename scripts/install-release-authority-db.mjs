#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const releaseAuthorityMigrationPaths = Object.freeze([
  "packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql",
  "packages/platform/release-authority-db/migrations/000002_external_effect_protocol/migration.sql",
  "packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql",
  "packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql",
  "packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql",
  "packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql",
  "packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql",
  "packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql",
  "packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql",
  "packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql",
  "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
]);

export const releaseAuthorityMigrationManifest = Object.freeze([
  [
    "000001_release_authority",
    "sha256:eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
  ],
  [
    "000002_external_effect_protocol",
    "sha256:66a1cd48303f31691596ae4e64d952d0fe3543444d042b17243c1a60efb10201",
  ],
  [
    "000002_transactional_service_transition",
    "sha256:5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099",
  ],
  [
    "000003_partial_source_freeze",
    "sha256:02dcd03e3d86c362598537e2ac7afc1dff2d20713fa01158f65e02db621d0da5",
  ],
  [
    "000004_selective_source_recovery",
    "sha256:c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97",
  ],
  [
    "000005_late_runner_effects",
    "sha256:35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb",
  ],
  [
    "000006_runner_provider_creation_boundary",
    "sha256:4ee3a75a1528870df6d66a24eded9fc588aed2681b82aef57335ad7bbadf1260",
  ],
  [
    "000007_compensation_effect_fence",
    "sha256:99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9",
  ],
  [
    "000008_trigger_helper_acl",
    "sha256:550e7c1e5f11bd795a867c03873d09a6b681c559f07b2101b8e8a3dbea3408c8",
  ],
  [
    "000009_authority_history_and_forward_repairs",
    "sha256:f1b29f3ff66ef22ed91230f8295b53aaa642fed6e34c081d9c8f6ce3453723f4",
  ],
  [
    "000010_recovery_effect_permits",
    "sha256:5e75a0deb033644c9a418082181dd9f21d65771cd47a7684f7497aa56e157107",
  ],
]);

const migrationBody = (source, path) => {
  const withoutBegin = source.replace(/^(?:--[^\n]*\n)*BEGIN;\s*/u, (header) =>
    header.replace(/BEGIN;\s*$/u, ""),
  );
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/u, "\n");
  if (withoutBegin === source || withoutCommit === withoutBegin)
    throw new Error(`release_authority_migration_transaction_invalid:${path}`);
  return withoutCommit;
};

// The legacy bootstrap has no trustworthy ledger.  Build a catalog-only
// representation that deliberately excludes table data while including every
// schema object shape, routine body, trigger, owner, and ACL.  A canonical
// shadow is produced from the immutable migration bytes in the same
// transaction, so there is no hand-maintained sample of "important" objects.
export const releaseAuthorityCatalogFingerprintSql = String.raw`
CREATE TEMP TABLE release_authority_catalog_verification (
  catalog_fingerprint text NOT NULL,
  byte_variant text NOT NULL CHECK (byte_variant IN ('canonical','legacy_equivalent')),
  verifier text NOT NULL CHECK (verifier = 'complete_catalog_v1')
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.release_authority_acl_fingerprint(p_acl aclitem[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $acl$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grantor',CASE WHEN acl.grantor=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
    'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    'privilege_type',acl.privilege_type,
    'is_grantable',acl.is_grantable
  ) ORDER BY
    CASE WHEN acl.grantor=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
    CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
    acl.privilege_type,acl.is_grantable),'[]'::jsonb)
  FROM pg_catalog.aclexplode(CASE
    WHEN pg_catalog.cardinality(p_acl)>0 THEN p_acl
    ELSE NULL::aclitem[]
  END) acl
$acl$;

CREATE FUNCTION pg_temp.release_authority_catalog_fingerprint(p_schema text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $fingerprint$
  WITH target AS (
    SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname=p_schema
  ), records(kind, identity, definition) AS (
    SELECT 'schema', p_schema,
      jsonb_build_object(
        'owner', pg_catalog.pg_get_userbyid(nspowner),
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(nspacl,pg_catalog.acldefault('n',nspowner)))
    FROM target
    UNION ALL
    SELECT 'relation', relation.relname,
      jsonb_build_object(
        'kind',relation.relkind,'persistence',relation.relpersistence,
        'owner',pg_catalog.pg_get_userbyid(relation.relowner),
        'replicaIdentity',relation.relreplident,'rowSecurity',relation.relrowsecurity,
        'forceRowSecurity',relation.relforcerowsecurity,
        'options',coalesce(to_jsonb(relation.reloptions),'[]'::jsonb),
        'accessMethod',coalesce(access_method.amname,''),
        'tablespace',CASE WHEN relation.reltablespace=0 THEN ''
          ELSE pg_catalog.pg_tablespace_location(relation.reltablespace) END,
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(relation.relacl,pg_catalog.acldefault(
            CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,
            relation.relowner))),
        'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object(
          'position',attribute.attnum,'name',attribute.attname,
          'type',replace(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),p_schema,'release_authority'),
          'notNull',attribute.attnotnull,'identity',attribute.attidentity,
          'generated',attribute.attgenerated,'compression',attribute.attcompression,
          'collation',CASE WHEN attribute.attcollation=0 THEN ''
            ELSE attribute.attcollation::regcollation::text END,
          'storage',attribute.attstorage,'statistics',attribute.attstattarget,
          'default',replace(coalesce(pg_catalog.pg_get_expr(default_record.adbin,default_record.adrelid),''),p_schema,'release_authority')
          ,'acl',pg_temp.release_authority_acl_fingerprint(attribute.attacl)
        ) ORDER BY attribute.attnum),'[]'::jsonb)
          FROM pg_catalog.pg_attribute attribute
          LEFT JOIN pg_catalog.pg_attrdef default_record
            ON default_record.adrelid=attribute.attrelid AND default_record.adnum=attribute.attnum
          WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
        'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(constraint_record.conname,
          constraint_record.contype,constraint_record.condeferrable,constraint_record.condeferred,
          constraint_record.convalidated,replace(pg_catalog.pg_get_constraintdef(constraint_record.oid,true),p_schema,'release_authority'))
          ORDER BY constraint_record.conname),'[]'::jsonb)
          FROM pg_catalog.pg_constraint constraint_record WHERE constraint_record.conrelid=relation.oid),
        'indexes',(SELECT coalesce(jsonb_agg(replace(pg_catalog.pg_get_indexdef(index_record.indexrelid),p_schema,'release_authority')
          ORDER BY index_record.indexrelid::regclass::text),'[]'::jsonb)
          FROM pg_catalog.pg_index index_record WHERE index_record.indrelid=relation.oid),
        'sequence',(SELECT jsonb_build_array(sequence_record.seqtypid::regtype::text,
          sequence_record.seqstart,sequence_record.seqincrement,sequence_record.seqmax,
          sequence_record.seqmin,sequence_record.seqcache,sequence_record.seqcycle)
          FROM pg_catalog.pg_sequence sequence_record WHERE sequence_record.seqrelid=relation.oid)
      )
    FROM pg_catalog.pg_class relation JOIN target ON target.oid=relation.relnamespace
    LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid=relation.relam
    UNION ALL
    SELECT 'function', procedure.oid::regprocedure::text,
      jsonb_build_object(
        'identityArgs',replace(pg_catalog.pg_get_function_identity_arguments(procedure.oid),p_schema,'release_authority'),
        'arguments',replace(pg_catalog.pg_get_function_arguments(procedure.oid),p_schema,'release_authority'),
        'result',replace(pg_catalog.pg_get_function_result(procedure.oid),p_schema,'release_authority'),
        'kind',procedure.prokind,'language',language.lanname,'volatility',procedure.provolatile,
        'strict',procedure.proisstrict,'securityDefiner',procedure.prosecdef,
        'leakproof',procedure.proleakproof,'parallel',procedure.proparallel,
        'cost',procedure.procost,'rows',procedure.prorows,
        'config',coalesce(to_jsonb(procedure.proconfig),'[]'::jsonb),
        'owner',pg_catalog.pg_get_userbyid(procedure.proowner),
        'source',replace(procedure.prosrc,p_schema,'release_authority'),
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)))
      )
    FROM pg_catalog.pg_proc procedure
    JOIN target ON target.oid=procedure.pronamespace
    JOIN pg_catalog.pg_language language ON language.oid=procedure.prolang
    UNION ALL
    SELECT 'trigger', relation.relname||'.'||trigger.tgname,
      jsonb_build_object('enabled',trigger.tgenabled,
        'definition',replace(pg_catalog.pg_get_triggerdef(trigger.oid,true),p_schema,'release_authority'))
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
    JOIN target ON target.oid=relation.relnamespace WHERE NOT trigger.tgisinternal
    UNION ALL
    SELECT 'type', type_record.typname,
      jsonb_build_object(
        'kind',type_record.typtype,'category',type_record.typcategory,
        'owner',pg_catalog.pg_get_userbyid(type_record.typowner),
        'notNull',type_record.typnotnull,'byValue',type_record.typbyval,
        'alignment',type_record.typalign,'storage',type_record.typstorage,
        'base',replace(CASE WHEN type_record.typbasetype=0 THEN '' ELSE type_record.typbasetype::regtype::text END,p_schema,'release_authority'),
        'element',replace(CASE WHEN type_record.typelem=0 THEN '' ELSE type_record.typelem::regtype::text END,p_schema,'release_authority'),
        'default',coalesce(type_record.typdefault,''),
        'acl',pg_temp.release_authority_acl_fingerprint(
          coalesce(type_record.typacl,pg_catalog.acldefault('T',type_record.typowner))),
        'enum',(SELECT coalesce(jsonb_agg(enum_record.enumlabel ORDER BY enum_record.enumsortorder),'[]'::jsonb)
          FROM pg_catalog.pg_enum enum_record WHERE enum_record.enumtypid=type_record.oid)
      )
    FROM pg_catalog.pg_type type_record JOIN target ON target.oid=type_record.typnamespace
  )
  SELECT coalesce(jsonb_agg(jsonb_build_array(kind,
    replace(identity,p_schema,'release_authority'),definition)
    ORDER BY kind,replace(identity,p_schema,'release_authority')),'[]'::jsonb)::text
  FROM records
$fingerprint$;`;

const rewriteAuthoritySchema = (source, schema) =>
  source.replaceAll("release_authority", schema);

const legacyCatalogPaths = [
  "packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql",
  "packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql",
];

const legacyCatalogChecksums = [
  "e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
  "cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e",
];

export function releaseAuthorityMigrationBundle(root = process.cwd()) {
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
  const bootstrapMigration = migrations.at(-2);
  const forwardMigration = migrations.at(-1);
  if (!bootstrapMigration || !forwardMigration)
    throw new Error("release_authority_migrations_empty");
  const historicalMigrations = migrations.slice(0, -2);
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
    .slice(0, -1)
    .map(
      ([name, checksum], index) =>
        `(${index + 1},'${name}','${checksum}','canonical')`,
    )
    .join(",\n          ");
  const allowedHistoryValues = `${expectedHistoryValues},
          (1,'000001_release_authority','sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b','legacy_equivalent'),
          (2,'000002_external_effect_protocol','sha256:cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e','legacy_equivalent')`;
  return [
    "\\set ON_ERROR_STOP on",
    "SELECT (to_regnamespace('release_authority') IS NULL) AS authority_schema_absent,",
    "  (to_regclass('release_authority.schema_migration') IS NOT NULL) AS authority_history_present \\gset",
    "BEGIN;",
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
       IF (SELECT count(*) NOT IN (10,11)
             FROM release_authority.schema_migration)
       OR (SELECT count(*) <> 10 FROM release_authority.schema_migration
             WHERE position <= 10)
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
         WHERE position > 10 AND (
           position <> 11
           OR migration_name <> '000010_recovery_effect_permits'
           OR checksum_sha256 <> '${releaseAuthorityMigrationManifest[10][1]}'
           OR byte_variant <> 'canonical'
         )
       ) THEN
         RAISE EXCEPTION 'release authority migration history mismatch';
       END IF;
     END
     $migration_history$;`,
    `SELECT EXISTS (
       SELECT 1 FROM release_authority.schema_migration
       WHERE position=11
         AND migration_name='000010_recovery_effect_permits'
         AND checksum_sha256='${releaseAuthorityMigrationManifest[10][1]}'
         AND byte_variant='canonical'
     ) AS authority_forward_present \\gset`,
    "\\if :authority_forward_present",
    "\\echo release authority forward migration already present",
    "\\else",
    `\\echo applying ${forwardMigration.path}`,
    migrationBody(forwardMigration.source, forwardMigration.path),
    `INSERT INTO release_authority.schema_migration
      (position, migration_name, checksum_sha256, byte_variant)
     VALUES (11, '000010_recovery_effect_permits',
       '${releaseAuthorityMigrationManifest[10][1]}', 'canonical');`,
    "\\endif",
    "COMMIT;",
    "",
  ].join("\n");
}

export const postgresEnvironment = (encoded, environment = process.env) => {
  const url = new URL(encoded);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("release_authority_owner_database_url_invalid");
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  if (!url.hostname || !database || !user || !url.password)
    throw new Error("release_authority_owner_database_url_invalid");
  const allowed = new Set(["sslmode"]);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key))
      throw new Error(
        `release_authority_owner_database_url_parameter_unsupported:${key}`,
      );
  return {
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: environment.LANG ?? "C.UTF-8",
    LC_ALL: environment.LC_ALL ?? environment.LANG ?? "C.UTF-8",
    PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGUSER: user,
    PGPASSWORD: decodeURIComponent(url.password),
  };
};

export function installReleaseAuthorityDatabase(environment = process.env) {
  const credentialFile =
    environment.REVIEW_ROUTER_RELEASE_AUTHORITY_OWNER_DATABASE_URL_FILE;
  if (!credentialFile)
    throw new Error(
      "release_authority_env_missing:REVIEW_ROUTER_RELEASE_AUTHORITY_OWNER_DATABASE_URL_FILE",
    );
  const credential = statSync(credentialFile);
  if (!credential.isFile() || (credential.mode & 0o077) !== 0)
    throw new Error(
      "release_authority_owner_database_url_file_permissions_invalid",
    );
  const databaseUrl = readFileSync(credentialFile, "utf8").trim();
  const result = spawnSync(
    environment.REVIEW_ROUTER_PSQL_BINARY ?? "psql",
    ["--no-psqlrc", "--quiet"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      input: releaseAuthorityMigrationBundle(
        fileURLToPath(new URL("..", import.meta.url)),
      ),
      env: postgresEnvironment(databaseUrl, environment),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    },
  );
  if (result.error?.code === "ETIMEDOUT")
    throw new Error("release_authority_install_timeout");
  if (result.status !== 0)
    throw new Error(
      `release_authority_install_failed:exit=${result.status ?? "signal"}:${String(result.stderr ?? "").slice(0, 2_000)}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  installReleaseAuthorityDatabase();
