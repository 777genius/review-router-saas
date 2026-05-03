#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
};

const quoteIdentifier = (identifier) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    fail(`Unsafe database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const baseUrlValue = process.env.DATABASE_URL;
if (!baseUrlValue) fail("DATABASE_URL is required for migration smoke test");

const baseUrl = new URL(baseUrlValue);
const sourceDbName = decodeURIComponent(baseUrl.pathname.replace(/^\//, ""));
if (!sourceDbName) fail("DATABASE_URL must include a database name");

requireCommand("psql");
requireCommand("pnpm");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const smokeDbName = `review_router_migration_smoke_${suffix}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const smokeUrl = new URL(baseUrl);
smokeUrl.pathname = `/${smokeDbName}`;
smokeUrl.search = "";

const psql = (
  sql,
  url = adminUrl.toString(),
  stdio = "inherit",
  extraArgs = [],
) =>
  run("psql", [url, "-v", "ON_ERROR_STOP=1", ...extraArgs, "-c", sql], {
    stdio,
  });

let created = false;
try {
  console.log(`Creating migration smoke database from ${sourceDbName}...`);
  psql(`CREATE DATABASE ${quoteIdentifier(smokeDbName)}`);
  created = true;

  console.log("Applying Prisma migrations to fresh database...");
  run("pnpm", ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"], {
    env: { ...process.env, DATABASE_URL: smokeUrl.toString() },
  });

  console.log("Verifying migrated schema invariants...");
  const invariantSql = `
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Workspace') AS workspace_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ActionRunHealthReport') AS health_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'RateLimitBucket') AS rate_limit_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'DistributedLock') AS distributed_lock_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ActionOidcReplayNonce') AS replay_nonce_table,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ActionRunHealthReport' AND indexname = 'ActionRunHealthReport_repositoryId_githubRunId_githubRunAtt_key') AS health_unique_index,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations') AS migrations_table;
  `;
  const result = psql(invariantSql, smokeUrl.toString(), "pipe", ["-At"]);
  const output = result.stdout.trim();
  if (output !== "1|1|1|1|1|1|1") {
    console.error(output);
    fail("Migrated schema invariants failed");
  }

  console.log("Migration smoke test passed.");
} finally {
  if (created) {
    console.log("Dropping migration smoke database...");
    const forcedDrop = spawnSync(
      "psql",
      [
        adminUrl.toString(),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `DROP DATABASE IF EXISTS ${quoteIdentifier(smokeDbName)} WITH (FORCE)`,
      ],
      { stdio: "inherit" },
    );
    if (forcedDrop.status !== 0) {
      spawnSync(
        "psql",
        [
          adminUrl.toString(),
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `DROP DATABASE IF EXISTS ${quoteIdentifier(smokeDbName)}`,
        ],
        { stdio: "inherit" },
      );
    }
  }
}
