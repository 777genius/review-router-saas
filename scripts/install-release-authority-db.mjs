#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const releaseAuthorityMigrationPaths = Object.freeze([
  "packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql",
  "packages/platform/release-authority-db/migrations/000002_external_effect_protocol/migration.sql",
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
  return [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    ...migrations.flatMap(({ path, source }) => [
      `\\echo applying ${path}`,
      migrationBody(source, path),
    ]),
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
