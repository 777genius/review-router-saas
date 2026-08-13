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
    "sha256:28079c64266e1045c9db82743f82412d9630f6b97f3143fcbe7730c290c33e94",
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
    "sha256:e49fe0f8c161fbe39953f01e299c81a752a152809c2261815a639bcf732c428a",
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
    "sha256:14ce6300054668f4bba3d9c7415ba34217791892bce86dc9d7dbe9203f8efaa7",
  ],
  [
    "000010_recovery_effect_permits",
    "sha256:a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd",
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

export function releaseAuthorityMigrationBundle(root = process.cwd()) {
  const migrations = releaseAuthorityMigrationPaths.map((path) => ({
    path,
    source: readFileSync(resolve(root, path), "utf8"),
  }));
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
    "\\if :authority_schema_absent",
    ...historicalMigrations.flatMap(({ path, source }) => [
      `\\echo applying ${path}`,
      migrationBody(source, path),
    ]),
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

const postgresEnvironment = (encoded) => {
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
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGUSER: user,
    PGPASSWORD: decodeURIComponent(url.password),
    ...(url.searchParams.get("sslmode")
      ? { PGSSLMODE: url.searchParams.get("sslmode") }
      : {}),
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
      env: postgresEnvironment(databaseUrl),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `release_authority_install_failed:exit=${result.status ?? "signal"}:${String(result.stderr ?? "").slice(0, 2_000)}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  installReleaseAuthorityDatabase();
