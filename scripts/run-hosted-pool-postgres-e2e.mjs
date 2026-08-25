import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import pg from "pg";

const mode = process.argv[2];
if (mode && mode !== "--migration-only" && mode !== "--postgres-only") {
  throw new Error("hosted_pool_e2e_mode_invalid");
}
const runMigration = mode !== "--postgres-only";
const runPostgresE2e = mode !== "--migration-only";

const image =
  "postgres:17-alpine@sha256:d4bb0a8c1b7bb2e29f976d099e7bfb9a5d8858cffe9e46b35cd302cd1f1f8168";
const suffix = randomBytes(6).toString("hex");
const container = `reviewrouter-hosted-pool-e2e-${suffix}`;
const database = `reviewrouter_hosted_pool_e2e_${suffix}`;
const migrationDatabase = `reviewrouter_hosted_pool_migration_${suffix}`;
const password = randomBytes(24).toString("base64url");
const port = await reservePort();
const dockerNetwork =
  process.env.REVIEW_ROUTER_HOSTED_POOL_DOCKER_NETWORK?.trim();
if (
  dockerNetwork &&
  !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dockerNetwork)
) {
  throw new Error("hosted_pool_e2e_docker_network_invalid");
}
const hostNetwork = dockerNetwork === "host";
const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}?schema=public`;
const migrationDatabaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${migrationDatabase}?schema=public`;

let started = false;
let rehearsalDirectory;
try {
  run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    ...(dockerNetwork ? ["--network", dockerNetwork] : []),
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `POSTGRES_DB=${database}`,
    ...(!hostNetwork ? ["--publish", `127.0.0.1:${port}:5432`] : []),
    image,
    ...(hostNetwork ? ["-c", `port=${port}`] : []),
  ]);
  started = true;
  await waitForPostgres(container);
  if (runMigration) {
    run("docker", [
      "exec",
      container,
      "createdb",
      "--username",
      "postgres",
      ...(hostNetwork ? ["--port", String(port)] : []),
      migrationDatabase,
    ]);
    rehearsalDirectory = prepareMigrationRehearsal();
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    runMigrationTest(migrationDatabaseUrl, "seed-000074");
    addSecurityCertificationMigration(rehearsalDirectory);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    runMigrationTest(migrationDatabaseUrl, "verify-000075");
    addTerminalizationMigration(rehearsalDirectory);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    runMigrationTest(migrationDatabaseUrl, "verify-000076");
    addR57RemediationMigration(rehearsalDirectory);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    runMigrationTest(migrationDatabaseUrl, "verify-000077");
    addOutputLimitsMigration(rehearsalDirectory);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    runMigrationTest(migrationDatabaseUrl, "verify-000079");

    const migrationCount = await countAppliedMigrations(migrationDatabaseUrl);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    const repeatedMigrationCount =
      await countAppliedMigrations(migrationDatabaseUrl);
    if (repeatedMigrationCount !== migrationCount) {
      throw new Error("hosted_pool_migration_rehearsal_not_idempotent");
    }
  }
  if (runPostgresE2e) {
    runMigrationDeploy("packages/platform/db", databaseUrl);
    try {
      run(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "scripts/hosted-pool-e2e/hosted-pool-postgres.e2e.test.ts",
        ],
        {
          REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL: databaseUrl,
          REVIEW_ROUTER_RUN_HOSTED_POOL_POSTGRES_E2E: "1",
        },
      );
    } finally {
      const evidencePath =
        process.env.REVIEW_ROUTER_HOSTED_CERTIFICATION_DB_EXPORT?.trim();
      if (evidencePath) await exportRelayEffectRows(databaseUrl, evidencePath);
    }
  }
} finally {
  if (rehearsalDirectory)
    rmSync(rehearsalDirectory, { recursive: true, force: true });
  if (started) {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
}

async function exportRelayEffectRows(connectionString, outputPath) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT row_to_json(r)::text AS body FROM "HostedCodexRelayRequest" r
      UNION ALL
      SELECT row_to_json(e)::text AS body FROM "HostedCodexUpstreamEffectAttempt" e
    `);
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      outputPath,
      `${result.rows.map((row) => String(row.body)).join("\n")}\n`,
      { mode: 0o600 },
    );
  } finally {
    await client.end();
  }
}

function prepareMigrationRehearsal() {
  const directory = mkdtempSync("packages/platform/db/.hosted-pool-migration-");
  cpSync(
    "packages/platform/db/prisma.config.ts",
    join(directory, "prisma.config.ts"),
  );
  cpSync("packages/platform/db/prisma", join(directory, "prisma"), {
    recursive: true,
    filter: (source) =>
      ![
        "000075_hosted_codex_security_certification",
        "000076_hosted_codex_terminalization_restore_invariants",
        "000077_hosted_codex_r57_security_race_remediation",
        "000079_hosted_codex_output_limits",
      ].includes(basename(source)),
  });
  return directory;
}

function addOutputLimitsMigration(directory) {
  cpSync(
    "packages/platform/db/prisma/migrations/000079_hosted_codex_output_limits",
    join(directory, "prisma/migrations/000079_hosted_codex_output_limits"),
    { recursive: true },
  );
}

function addR57RemediationMigration(directory) {
  cpSync(
    "packages/platform/db/prisma/migrations/000077_hosted_codex_r57_security_race_remediation",
    join(
      directory,
      "prisma/migrations/000077_hosted_codex_r57_security_race_remediation",
    ),
    { recursive: true },
  );
}

function addTerminalizationMigration(directory) {
  cpSync(
    "packages/platform/db/prisma/migrations/000076_hosted_codex_terminalization_restore_invariants",
    join(
      directory,
      "prisma/migrations/000076_hosted_codex_terminalization_restore_invariants",
    ),
    { recursive: true },
  );
}

function addSecurityCertificationMigration(directory) {
  cpSync(
    "packages/platform/db/prisma/migrations/000075_hosted_codex_security_certification",
    join(
      directory,
      "prisma/migrations/000075_hosted_codex_security_certification",
    ),
    { recursive: true },
  );
}

function runMigrationDeploy(directory, url) {
  run(
    "pnpm",
    [
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      join(directory, "prisma.config.ts"),
    ],
    { DATABASE_URL: url },
  );
}

function runMigrationTest(url, phase) {
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "scripts/hosted-pool-e2e/hosted-pool-migration-rehearsal.test.ts",
    ],
    {
      REVIEW_ROUTER_HOSTED_POOL_MIGRATION_DATABASE_URL: url,
      REVIEW_ROUTER_HOSTED_POOL_MIGRATION_PHASE: phase,
    },
  );
}

async function countAppliedMigrations(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `);
    return result.rows[0].count;
  } finally {
    await client.end();
  }
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

async function waitForPostgres(name) {
  let consecutiveReady = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        name,
        "psql",
        "--username",
        "postgres",
        ...(hostNetwork ? ["--port", String(port)] : []),
        "--dbname",
        "postgres",
        "--tuples-only",
        "--command",
        "SELECT 1",
      ],
      { stdio: "ignore" },
    );
    consecutiveReady = result.status === 0 ? consecutiveReady + 1 : 0;
    if (consecutiveReady >= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("disposable_postgres_not_ready");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed_to_reserve_port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
