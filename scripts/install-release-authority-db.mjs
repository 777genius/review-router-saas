#!/usr/bin/env node
import { createHash } from "node:crypto";
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
} from "../apps/api/src/release-authority/adapters/acl-policy-postgres.mjs";

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
  const bootstrapMigration = migrations.at(-3);
  const forwardMigrations = migrations.slice(-2);
  if (!bootstrapMigration || forwardMigrations.length !== 2)
    throw new Error("release_authority_migrations_empty");
  const historicalMigrations = migrations.slice(0, -3);
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
    "BEGIN;",
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
       IF current_user IS DISTINCT FROM session_user
          OR current_user IS DISTINCT FROM authority_owner THEN
         RAISE EXCEPTION 'release authority migration caller is not the database owner session';
       END IF;
       IF '${mode}' = 'fresh-install'
          AND pg_catalog.to_regnamespace('release_authority') IS NOT NULL THEN
         RAISE EXCEPTION 'release authority fresh install requires an absent authority schema';
       END IF;
       IF '${mode}' = 'incremental-upgrade'
          AND pg_catalog.to_regnamespace('release_authority') IS NULL THEN
         RAISE EXCEPTION 'release authority incremental upgrade requires an existing authority schema';
       END IF;
       IF '${mode}' = 'incremental-upgrade'
          AND (SELECT pg_catalog.pg_get_userbyid(nspowner)
                 FROM pg_catalog.pg_namespace
                WHERE nspname='release_authority') IS DISTINCT FROM current_user THEN
         RAISE EXCEPTION 'release authority migration caller does not own the authority schema';
       END IF;
     END
     $upgrade_gate$;`,
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
       IF (SELECT count(*) NOT IN (10,11,12)
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
         WHERE position > 10 AND NOT (
           position=11
             AND migration_name='000010_recovery_effect_permits'
             AND checksum_sha256='${releaseAuthorityMigrationManifest[10][1]}'
             AND byte_variant='canonical'
           OR position=12
             AND migration_name='000011_default_and_final_acl_exactness'
             AND checksum_sha256='${releaseAuthorityMigrationManifest[11][1]}'
             AND byte_variant='canonical')
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
      return [
        migrationBody(
          rewriteAuthoritySchema(
            migration.source,
            "release_authority_verify_final",
          ),
          migration.path,
        ),
        `INSERT INTO release_authority_verify_final.schema_migration
       (position,migration_name,checksum_sha256,byte_variant)
     VALUES (${position},'${name}','${checksum}','canonical');`,
      ];
    }),
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
           'verifier','${releaseAuthorityCatalogVerifier}')::text);
     END
     $final_catalog$;`,
    "DROP SCHEMA release_authority_verify_final CASCADE;",
    "COMMIT;",
    "",
  ].join("\n");
}

export const postgresEnvironment = (
  encoded,
  environment = process.env,
  passfile = "/run/reviewrouter/release-authority.pgpass",
) => {
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
        "release_authority_owner_database_url_parameter_unsupported",
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
    PGPASSFILE: passfile,
  };
};

function postgresPassfileLine(encoded) {
  const url = new URL(encoded);
  const escape = (value) =>
    value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  return `${escape(url.hostname)}:${escape(url.port || "5432")}:${escape(decodeURIComponent(url.pathname.slice(1)))}:${escape(decodeURIComponent(url.username))}:${escape(decodeURIComponent(url.password))}\n`;
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
  const databaseUrl = readFileSync(credentialFile, "utf8").trim();
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
  process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE = mode;
  installReleaseAuthorityDatabase();
}
