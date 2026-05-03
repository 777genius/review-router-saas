#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";

if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: false });
}
if (existsSync(".env")) {
  dotenv.config({ path: ".env", override: false });
}

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const requireCommand = (command) => {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  if (result.status !== 0) fail(`Missing required command: ${command}`);
  return command;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${command} ${args[0] ?? ""} failed with exit code ${result.status}`);
  }
  return result;
};

const quoteIdentifier = (identifier) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    fail(`Unsafe database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const sourceUrlValue =
  process.env.REVIEW_ROUTER_BACKUP_SOURCE_URL ?? process.env.DATABASE_URL;
if (!sourceUrlValue) {
  fail("DATABASE_URL or REVIEW_ROUTER_BACKUP_SOURCE_URL is required");
}

const psqlCommand = requireCommand(process.env.REVIEW_ROUTER_PSQL ?? "psql");

const sourceUrl = postgresToolUrl(sourceUrlValue);
const sourceDbName = decodeURIComponent(sourceUrl.pathname.replace(/^\//, ""));
if (!sourceDbName) fail("source database URL must include a database name");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const restoreDbName = `review_router_restore_smoke_${suffix}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const restoreUrl = new URL(sourceUrl);
restoreUrl.pathname = `/${restoreDbName}`;
restoreUrl.search = "";
const tempDir = mkdtempSync(join(tmpdir(), "reviewrouter-restore-smoke-"));
const dumpFile = join(tempDir, "reviewrouter.dump");

const psql = (
  sql,
  url = adminUrl.toString(),
  stdio = "inherit",
  extraArgs = [],
) =>
  run(psqlCommand, [url, "-v", "ON_ERROR_STOP=1", ...extraArgs, "-c", sql], {
    stdio,
  });

const readScalar = (sql, url) => psql(sql, url, "pipe", ["-At"]).stdout.trim();

const serverMajor = readScalar(
  "SELECT current_setting('server_version_num')::int / 10000",
  sourceUrl.toString(),
);
const pgDumpCommand = selectPostgresTool("pg_dump", serverMajor);
const pgRestoreCommand = selectPostgresTool("pg_restore", serverMajor);

const invariantSql = `
  SELECT
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Workspace') AS workspace_table,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'RepositoryConnection') AS repository_table,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ReviewConfiguration') AS review_configuration_table,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'OutboxEvent') AS outbox_table,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'AuditEvent') AS audit_table,
    (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ActionRunHealthReport' AND indexname = 'ActionRunHealthReport_repositoryId_githubRunId_githubRunAtt_key') AS health_unique_index,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations') AS migrations_table;
`;

const rowCountSql = `
  SELECT
    (SELECT count(*) FROM "Workspace"),
    (SELECT count(*) FROM "RepositoryConnection"),
    (SELECT count(*) FROM "ReviewConfiguration"),
    (SELECT count(*) FROM "OutboxEvent"),
    (SELECT count(*) FROM "AuditEvent");
`;

let created = false;
try {
  console.log(`Creating backup smoke dump from ${sourceDbName}...`);
  run(pgDumpCommand, [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file",
    dumpFile,
    sourceUrl.toString(),
  ]);

  const sourceInvariants = readScalar(invariantSql, sourceUrl.toString());
  if (sourceInvariants !== "1|1|1|1|1|1|1") {
    fail("source database schema invariants failed");
  }
  const sourceCounts = readScalar(rowCountSql, sourceUrl.toString());

  console.log("Creating restore smoke database...");
  psql(`CREATE DATABASE ${quoteIdentifier(restoreDbName)}`);
  created = true;

  console.log("Restoring backup smoke dump...");
  run(pgRestoreCommand, [
    "--no-owner",
    "--no-privileges",
    "--dbname",
    restoreUrl.toString(),
    dumpFile,
  ]);

  console.log("Verifying restored schema and metadata counts...");
  const restoredInvariants = readScalar(invariantSql, restoreUrl.toString());
  if (restoredInvariants !== sourceInvariants) {
    fail("restored schema invariants do not match source");
  }
  const restoredCounts = readScalar(rowCountSql, restoreUrl.toString());
  if (restoredCounts !== sourceCounts) {
    fail("restored metadata row counts do not match source");
  }

  console.log("Backup restore smoke test passed.");
} finally {
  if (created) {
    console.log("Dropping restore smoke database...");
    const forcedDrop = spawnSync(
      psqlCommand,
      [
        adminUrl.toString(),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDbName)} WITH (FORCE)`,
      ],
      { stdio: "inherit" },
    );
    if (forcedDrop.status !== 0) {
      spawnSync(
        psqlCommand,
        [
          adminUrl.toString(),
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDbName)}`,
        ],
        { stdio: "inherit" },
      );
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
}

function postgresToolUrl(value) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url;
}

function selectPostgresTool(tool, serverMajor) {
  const envName = `REVIEW_ROUTER_${tool.toUpperCase()}`;
  const candidates = [
    process.env[envName],
    `/opt/homebrew/opt/postgresql@${serverMajor}/bin/${tool}`,
    `/usr/local/opt/postgresql@${serverMajor}/bin/${tool}`,
    tool,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) continue;
    const major = parsePostgresMajor(result.stdout || result.stderr);
    if (major === String(serverMajor)) {
      return candidate;
    }
  }

  fail(
    `Missing ${tool} compatible with PostgreSQL server major ${serverMajor}. ` +
      `Install postgresql@${serverMajor} client tools or set ${envName}.`,
  );
}

function parsePostgresMajor(versionOutput) {
  const match = versionOutput.match(/\(PostgreSQL\)\s+(\d+)/);
  return match?.[1] ?? "";
}
