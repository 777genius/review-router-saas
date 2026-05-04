#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = loadEnvFile(".env.local", loadEnvFile(".env", process.env));
const urls = [
  ["DATABASE_URL", env.DATABASE_URL],
  ["TEST_DATABASE_URL", env.TEST_DATABASE_URL],
].filter(([, value]) => typeof value === "string" && value.length > 0);

if (urls.length === 0) {
  fail(
    "DATABASE_URL and TEST_DATABASE_URL are missing. Create .env.local first.",
  );
}

for (const [name, value] of urls) {
  ensureDatabase(name, value);
}

console.log(`Ensured ${urls.length} local database(s).`);

function ensureDatabase(name, rawUrl) {
  const parsed = parsePostgresUrl(name, rawUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!databaseName) fail(`${name} must include a database name.`);

  const adminUrl = new URL(parsed.toString());
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";

  const exists = runPsql(adminUrl.toString(), [
    "-Atc",
    `SELECT 1 FROM pg_database WHERE datname = '${escapeSqlLiteral(databaseName)}'`,
  ]).stdout.trim();

  if (exists === "1") {
    console.log(`${name}: database ${databaseName} already exists.`);
    return;
  }

  console.log(`${name}: creating database ${databaseName}...`);
  runPsql(adminUrl.toString(), [
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
  ]);
}

function parsePostgresUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} is not a valid URL.`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    fail(`${name} must use postgresql:// or postgres://.`);
  }
  return parsed;
}

function runPsql(url, args) {
  const result = spawnSync("psql", [url, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `psql failed with status ${result.status}`,
    );
  }
  return result;
}

function loadEnvFile(path, base) {
  const result = { ...base };
  if (!existsSync(path)) return result;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = unquoteEnv(rawValue.trim());
  }
  return result;
}

function unquoteEnv(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function escapeSqlLiteral(value) {
  return value.replaceAll("'", "''");
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
