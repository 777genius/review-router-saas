#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
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

const defaultLocalUrl = `postgresql://${encodeURIComponent(
  userInfo().username,
)}@127.0.0.1:5432/postgres?schema=public`;
const baseUrlValue =
  process.env.REVIEW_ROUTER_MEMORY_E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  defaultLocalUrl;

let baseUrl;
try {
  baseUrl = new URL(baseUrlValue);
} catch {
  fail("Memory E2E database URL is not a valid URL.");
}

if (baseUrl.protocol !== "postgresql:" && baseUrl.protocol !== "postgres:") {
  fail("Memory E2E database URL must use postgresql:// or postgres://.");
}

requireCommand(process.env.REVIEW_ROUTER_PSQL ?? "psql");
requireCommand("pnpm");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const e2eDbName = `review_router_memory_e2e_${suffix}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const e2eUrl = new URL(baseUrl);
e2eUrl.pathname = `/${e2eDbName}`;

const psqlCommand = process.env.REVIEW_ROUTER_PSQL ?? "psql";
const psql = (sql, url = adminUrl.toString()) =>
  run(psqlCommand, [url, "-v", "ON_ERROR_STOP=1", "-c", sql]);

let created = false;
try {
  console.log(`Creating memory E2E database ${e2eDbName}...`);
  psql(`CREATE DATABASE ${quoteIdentifier(e2eDbName)}`);
  created = true;

  console.log("Applying Prisma migrations to memory E2E database...");
  run("pnpm", ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"], {
    env: { ...process.env, DATABASE_URL: e2eUrl.toString() },
  });

  console.log("Running action memory flow E2E...");
  run("pnpm", ["exec", "tsx", "spikes/github-oidc/src/memory-flow-e2e.ts"], {
    env: { ...process.env, DATABASE_URL: e2eUrl.toString() },
  });

  console.log("Memory E2E passed.");
} finally {
  if (created && process.env.REVIEW_ROUTER_MEMORY_E2E_KEEP_DB !== "1") {
    console.log(`Dropping memory E2E database ${e2eDbName}...`);
    const forcedDrop = spawnSync(
      psqlCommand,
      [
        adminUrl.toString(),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `DROP DATABASE IF EXISTS ${quoteIdentifier(e2eDbName)} WITH (FORCE)`,
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
          `DROP DATABASE IF EXISTS ${quoteIdentifier(e2eDbName)}`,
        ],
        { stdio: "inherit" },
      );
    }
  }
}
