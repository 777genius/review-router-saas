import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import pg from "pg";
import { assertCanaryPhasePostgresResult } from "./hosted-pool-canary-phase-gate.mjs";
import { runProviderScopeConcurrencyOperation } from "./manage-review-provider-scope-concurrency.mjs";
import { runtimeGrantStatements } from "./run-codex-rotating-release-migration.mjs";

const mode = process.argv[2];
const prismaBinary = join(process.cwd(), "node_modules/.bin/prisma");
const vitestBinary = join(process.cwd(), "node_modules/.bin/vitest");
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
const canaryPhaseDatabase = `reviewrouter_canary_phase_${suffix}`;
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
const canaryPhaseDatabaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${canaryPhaseDatabase}`;
const migrationDatabaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${migrationDatabase}?schema=public`;
const custodyPassword = randomBytes(24).toString("base64url");
const apiPassword = randomBytes(24).toString("base64url");
const releaseMigrationPassword = randomBytes(24).toString("base64url");
const custodyDatabaseUrl = `postgresql://reviewrouter_comment_token_custody:${custodyPassword}@127.0.0.1:${port}/${database}?schema=public`;
const apiDatabaseUrl = `postgresql://reviewrouter_api:${apiPassword}@127.0.0.1:${port}/${database}?schema=public`;
const releaseMigrationDatabaseUrl = `postgresql://reviewrouter_release_migration:${releaseMigrationPassword}@127.0.0.1:${port}/${database}?schema=public`;

const hostedPoolStagedMigrations = [
  {
    name: "000075_hosted_codex_security_certification",
    phase: "verify-000075",
  },
  {
    name: "000076_hosted_codex_terminalization_restore_invariants",
    phase: "verify-000076",
  },
  {
    name: "000077_hosted_codex_r57_security_race_remediation",
    phase: "verify-000077",
  },
  { name: "000079_hosted_codex_output_limits", phase: "verify-000079" },
  { name: "000080_hosted_codex_attempt_generation", phase: "verify-000080" },
  { name: "000081_hosted_codex_runtime_gate", phase: "verify-000081" },
  {
    name: "000082_validate_hosted_codex_output_limits",
    phase: "verify-000082",
  },
  {
    name: "000083_hosted_codex_comment_token_mint_protocol",
    phase: "verify-000083",
  },
  {
    name: "000084_harden_comment_token_custody",
    phase: "verify-000084",
  },
  {
    name: "000085_comment_token_gate_lock_result",
    phase: "verify-000085",
  },
  {
    name: "000086_comment_token_custody_r18_remediation",
    phase: "verify-000086",
  },
];

const publicEligibilityMigration =
  "000096_hosted_pool_public_repository_eligibility";

const codexOAuthV5Migrations = [
  "000087_codex_oauth_v4_v5_workflow_reattestation",
  "000088_codex_oauth_reattestation_mutation_owner_fence",
  "000089_codex_oauth_v4_v5_staged_compatibility",
  "000089_workflow_provisioning_writer_quiescence",
  "000090_workflow_provisioning_attempt_authority",
  "000091_workflow_provisioning_artifact_and_inventory",
];

let started = false;
const rehearsalDirectories = [];
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
  await provisionAdversarialRuntimeRoles(databaseUrl, {
    custodyPassword,
    apiPassword,
    releaseMigrationPassword,
  });
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
    await grantMigrationSchemaOwnerAuthority(migrationDatabaseUrl);
    const rehearsalDirectory = prepareMigrationRehearsal({
      excludeHostedPoolMigrations: true,
    });
    rehearsalDirectories.push(rehearsalDirectory);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    runMigrationTest(migrationDatabaseUrl, "seed-000074");
    for (const migration of hostedPoolStagedMigrations) {
      addMigration(rehearsalDirectory, migration.name);
      runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
      runMigrationTest(migrationDatabaseUrl, migration.phase);
    }
    await prepareCodexOAuthV5ReleaseAuthority(migrationDatabaseUrl);
    applyCodexOAuthV5Migrations(rehearsalDirectory, migrationDatabaseUrl);
    await applyPublicEligibilityMigration(
      rehearsalDirectory,
      migrationDatabaseUrl,
    );

    const migrationCount = await countAppliedMigrations(migrationDatabaseUrl);
    runMigrationDeploy(rehearsalDirectory, migrationDatabaseUrl);
    const repeatedMigrationCount =
      await countAppliedMigrations(migrationDatabaseUrl);
    if (repeatedMigrationCount !== migrationCount) {
      throw new Error("hosted_pool_migration_rehearsal_not_idempotent");
    }
  }
  if (runPostgresE2e) {
    const rehearsalDirectory = prepareMigrationRehearsal({
      excludeHostedPoolMigrations: false,
    });
    rehearsalDirectories.push(rehearsalDirectory);
    runMigrationDeploy(rehearsalDirectory, databaseUrl);
    await prepareCodexOAuthV5ReleaseAuthority(databaseUrl);
    applyCodexOAuthV5Migrations(rehearsalDirectory, databaseUrl);
    await applyPublicEligibilityMigration(rehearsalDirectory, databaseUrl);
    await applyProductionRuntimeAcl(databaseUrl, database);
    await prepareProviderScopeConcurrencyReleaseAuthority(databaseUrl);
    await proveProviderScopeConcurrencyRollout(
      releaseMigrationDatabaseUrl,
      databaseUrl,
    );
    await proveCustodyCredentialRotation(databaseUrl, custodyDatabaseUrl);
    // Recovery requires an empty Workspace table and its own migrated loopback
    // database. Reuse this disposable container and the existing migration path.
    run("docker", [
      "exec",
      container,
      "createdb",
      "--username",
      "postgres",
      ...(hostNetwork ? ["--port", String(port)] : []),
      canaryPhaseDatabase,
    ]);
    await grantMigrationSchemaOwnerAuthority(canaryPhaseDatabaseUrl);
    const canaryDirectory = prepareMigrationRehearsal({
      excludeHostedPoolMigrations: false,
    });
    rehearsalDirectories.push(canaryDirectory);
    runMigrationDeploy(canaryDirectory, canaryPhaseDatabaseUrl);
    await prepareCodexOAuthV5ReleaseAuthority(canaryPhaseDatabaseUrl);
    applyCodexOAuthV5Migrations(canaryDirectory, canaryPhaseDatabaseUrl);
    if (
      (await countAppliedMigrations(canaryPhaseDatabaseUrl)) !==
      (await countAppliedMigrations(databaseUrl))
    )
      throw new Error("canary_phase_pg17_migration_count_mismatch");
    const canaryReport = join(canaryDirectory, "canary-phase-vitest.json");
    run(
      vitestBinary,
      [
        "run",
        "scripts/hosted-pool-canary-phase-recovery.postgres.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${canaryReport}`,
      ],
      {
        REVIEW_ROUTER_CANARY_PHASE_PG17_URL: canaryPhaseDatabaseUrl,
        REVIEW_ROUTER_RUN_HOSTED_POOL_POSTGRES_E2E: "1",
      },
    );
    assertCanaryPhasePostgresResult(
      JSON.parse(readFileSync(canaryReport, "utf8")),
    );
    try {
      run(
        vitestBinary,
        ["run", "scripts/hosted-pool-e2e/hosted-pool-postgres.e2e.test.ts"],
        {
          REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL: databaseUrl,
          REVIEW_ROUTER_HOSTED_POOL_E2E_CUSTODY_DATABASE_URL:
            custodyDatabaseUrl,
          REVIEW_ROUTER_HOSTED_POOL_E2E_API_DATABASE_URL: apiDatabaseUrl,
          REVIEW_ROUTER_RUN_HOSTED_POOL_POSTGRES_E2E: "1",
        },
      );
      run(
        vitestBinary,
        [
          "run",
          "scripts/hosted-pool-e2e/hosted-pool-public-eligibility.postgres.test.ts",
        ],
        {
          REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL: databaseUrl,
          REVIEW_ROUTER_HOSTED_POOL_E2E_CUSTODY_DATABASE_URL:
            custodyDatabaseUrl,
          REVIEW_ROUTER_HOSTED_POOL_E2E_API_DATABASE_URL: apiDatabaseUrl,
          REVIEW_ROUTER_RUN_HOSTED_POOL_PUBLIC_PG: "1",
        },
      );
    } finally {
      const evidencePath =
        process.env.REVIEW_ROUTER_HOSTED_CERTIFICATION_DB_EXPORT?.trim();
      if (evidencePath) await exportRelayEffectRows(databaseUrl, evidencePath);
    }
  }
} finally {
  for (const rehearsalDirectory of rehearsalDirectories)
    rmSync(rehearsalDirectory, { recursive: true, force: true });
  if (started) {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
}

async function proveProviderScopeConcurrencyRollout(
  restrictedConnectionString,
  providerAdminConnectionString,
) {
  const client = new pg.Client({
    connectionString: restrictedConnectionString,
  });
  await client.connect();
  try {
    const restrictedAuthority = await client.query(`
      SELECT current_user, session_user, login.rolcanlogin, login.rolsuper,
             login.rolcreaterole, login.rolinherit, login.rolcreatedb,
             login.rolreplication, login.rolbypassrls,
             (SELECT count(*)::integer
                FROM pg_auth_members membership
                WHERE membership.roleid =
                        'reviewrouter_release_schema_owner'::regrole
                   OR membership.member =
                        'reviewrouter_release_schema_owner'::regrole
                   OR membership.grantor =
                        'reviewrouter_release_schema_owner'::regrole) AS owner_memberships,
             has_table_privilege(
               login.rolname,
               'public."ReviewProviderScopeConcurrencyControl"',
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
             ) AS has_control_table_privilege,
             has_function_privilege(
               login.rolname,
               'public.reviewrouter_provider_scope_concurrency_activate()',
               'EXECUTE'
             ) AS can_activate,
             pg_has_role(
               login.rolname,
               'reviewrouter_release_schema_owner',
               'SET'
             ) AS can_set_schema_owner,
             (SELECT count(*)::integer
                FROM pg_proc routine
                JOIN pg_roles owner ON owner.oid = routine.proowner
                WHERE routine.oid IN (
                  'public.reviewrouter_provider_scope_concurrency_snapshot()'::regprocedure,
                  'public.reviewrouter_provider_scope_concurrency_status()'::regprocedure,
                  'public.reviewrouter_provider_scope_concurrency_activate()'::regprocedure,
                  'public.reviewrouter_provider_scope_concurrency_close_for_rollback()'::regprocedure,
                  'public.reviewrouter_provider_scope_concurrency_verify_rollback()'::regprocedure
                )
                  AND owner.rolname = 'reviewrouter_release_schema_owner'
                  AND routine.prosecdef
                  AND routine.proconfig =
                      ARRAY['search_path=pg_catalog, public']::text[]
                  AND NOT has_function_privilege(
                    'public', routine.oid, 'EXECUTE'
                  )) AS bounded_routines
      FROM pg_roles login
      WHERE login.rolname = 'reviewrouter_release_migration'
    `);
    if (
      restrictedAuthority.rows.length !== 1 ||
      restrictedAuthority.rows[0]?.current_user !==
        "reviewrouter_release_migration" ||
      restrictedAuthority.rows[0]?.session_user !==
        "reviewrouter_release_migration" ||
      restrictedAuthority.rows[0]?.rolcanlogin !== true ||
      restrictedAuthority.rows[0]?.rolsuper !== false ||
      restrictedAuthority.rows[0]?.rolcreaterole !== false ||
      restrictedAuthority.rows[0]?.rolinherit !== false ||
      restrictedAuthority.rows[0]?.rolcreatedb !== false ||
      restrictedAuthority.rows[0]?.rolreplication !== false ||
      restrictedAuthority.rows[0]?.rolbypassrls !== false ||
      restrictedAuthority.rows[0]?.owner_memberships !== 0 ||
      restrictedAuthority.rows[0]?.has_control_table_privilege !== false ||
      restrictedAuthority.rows[0]?.can_activate !== true ||
      restrictedAuthority.rows[0]?.can_set_schema_owner !== false ||
      restrictedAuthority.rows[0]?.bounded_routines !== 5
    ) {
      throw new Error("provider_scope_concurrency_release_authority_invalid");
    }
    const runtimeAuthority = await client.query(`
      SELECT role_name,
        has_table_privilege(
          role_name, 'public."ReviewProviderScopeConcurrencyControl"', 'SELECT'
        ) AS can_select,
        has_table_privilege(
          role_name, 'public."ReviewProviderScopeConcurrencyControl"',
          'INSERT,UPDATE,DELETE,TRUNCATE'
        ) AS can_mutate
      FROM unnest(ARRAY[
        'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker'
      ]) AS role_name
      ORDER BY role_name
    `);
    if (
      runtimeAuthority.rows.some(
        (row) => row.can_select !== true || row.can_mutate !== false,
      )
    ) {
      throw new Error("provider_scope_concurrency_runtime_acl_invalid");
    }

    await client
      .query(
        `UPDATE public."ReviewProviderScopeConcurrencyControl"
              SET "activated" = true WHERE "singleton" = true`,
      )
      .then(
        () => {
          throw new Error("provider_scope_concurrency_restricted_dml_present");
        },
        () => undefined,
      );
    await client
      .query(
        `CREATE INDEX provider_scope_forbidden_ddl
              ON public."ReviewInvocationLeaseV2" ("leaseId")`,
      )
      .then(
        () => {
          throw new Error("provider_scope_concurrency_restricted_ddl_present");
        },
        () => undefined,
      );

    let discardCommittedActivationResponse = true;
    const recoveredActivation = await runProviderScopeConcurrencyOperation({
      operation: "activate",
      databaseUrl: restrictedConnectionString,
      createClient: () => {
        const connection = new pg.Client({
          connectionString: restrictedConnectionString,
        });
        return {
          connect: () => connection.connect(),
          end: () => connection.end(),
          query: async (...queryArgs) => {
            const result = await connection.query(...queryArgs);
            if (
              discardCommittedActivationResponse &&
              String(queryArgs[0]).includes(
                "reviewrouter_provider_scope_concurrency_activate",
              )
            ) {
              discardCommittedActivationResponse = false;
              const responseLoss = new Error(
                "simulated connection loss after committed activation",
              );
              responseLoss.code = "08006";
              throw responseLoss;
            }
            return result;
          },
        };
      },
    });
    if (
      recoveredActivation.reconciledAfterAmbiguousCommit !== true ||
      recoveredActivation.status.activated !== true ||
      recoveredActivation.status.legacyProviderVoteIndex !== null
    ) {
      throw new Error(
        "provider_scope_concurrency_commit_response_loss_recovery_invalid",
      );
    }
    run(
      "node",
      [
        "scripts/manage-review-provider-scope-concurrency.mjs",
        "--activate",
        "--confirm-old-replicas-drained",
      ],
      { DATABASE_URL: restrictedConnectionString },
    );
    run(
      "node",
      [
        "scripts/manage-review-provider-scope-concurrency.mjs",
        "--close-for-rollback",
        "--confirm-no-old-replica-started",
      ],
      { DATABASE_URL: restrictedConnectionString },
    );
    const admin = new pg.Client({
      connectionString: providerAdminConnectionString,
    });
    await admin.connect();
    try {
      await admin.query(`
        CREATE INDEX "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
        ON "ReviewInvocationLeaseV2" ("leaseId")
      `);
    } finally {
      await admin.end();
    }
    run(
      "node",
      [
        "scripts/manage-review-provider-scope-concurrency.mjs",
        "--verify-rollback-ready",
      ],
      { DATABASE_URL: restrictedConnectionString },
    );
    const repaired = await client.query(`
        SELECT index_catalog.indisvalid,
               index_catalog.indisready,
               index_catalog.indisunique,
               pg_get_indexdef(index_catalog.indexrelid) AS definition
        FROM pg_catalog.pg_index index_catalog
        WHERE index_catalog.indexrelid =
          'public."ReviewInvocationLeaseV2_one_active_provider_vote_lane"'::regclass
      `);
    const expectedDefinition =
      'CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_provider_vote_lane" ON public."ReviewInvocationLeaseV2" USING btree ("providerVoteIdentityHash") WHERE ((state = \'active\'::"ReviewInvocationLeaseStateV2") AND (purpose = \'provider_execution\'::"ReviewInvocationLeasePurposeV2"))';
    if (
      repaired.rows.length !== 1 ||
      repaired.rows[0]?.indisvalid !== true ||
      repaired.rows[0]?.indisready !== true ||
      repaired.rows[0]?.indisunique !== true ||
      repaired.rows[0]?.definition !== expectedDefinition
    ) {
      throw new Error("provider_scope_concurrency_rollback_repair_invalid");
    }
  } finally {
    await client.end();
  }
}

async function proveCustodyCredentialRotation(
  providerAdminDatabaseUrl,
  currentCustodyDatabaseUrl,
) {
  const current = new URL(currentCustodyDatabaseUrl);
  const oldPassword = decodeURIComponent(current.password);
  const newPassword = randomBytes(24).toString("base64url");
  if (
    !/^[A-Za-z0-9_-]+$/u.test(oldPassword) ||
    !/^[A-Za-z0-9_-]+$/u.test(newPassword)
  )
    throw new Error("hosted_pool_e2e_custody_rotation_password_invalid");
  const rotated = new URL(current);
  rotated.password = newPassword;
  const admin = new pg.Client({ connectionString: providerAdminDatabaseUrl });
  const retained = new pg.Client({ connectionString: current.toString() });
  retained.on("error", () => undefined);
  await admin.connect();
  await retained.connect();
  try {
    // Each query is its own committed transaction, matching the release
    // bootstrap phases. Race an old-credential reconnect against termination
    // only after committed NOLOGIN is externally observable.
    await admin.query("ALTER ROLE reviewrouter_comment_token_custody NOLOGIN");
    const [oldReconnectSucceeded] = await Promise.all([
      canConnect(current.toString()),
      admin.query(`SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE usename='reviewrouter_comment_token_custody'
          AND pid<>pg_backend_pid()`),
    ]);
    const remaining = await admin.query(
      `SELECT count(*)::integer AS count FROM pg_stat_activity
       WHERE usename='reviewrouter_comment_token_custody'`,
    );
    const retainedBackendSurvived = await retained.query("SELECT 1").then(
      () => true,
      () => false,
    );
    if (
      oldReconnectSucceeded ||
      retainedBackendSurvived ||
      remaining.rows[0]?.count !== 0
    )
      throw new Error("hosted_pool_e2e_custody_old_backend_survived");

    await admin.query(
      `ALTER ROLE reviewrouter_comment_token_custody LOGIN PASSWORD '${newPassword}'`,
    );
    if (
      (await canConnect(current.toString())) ||
      !(await canConnect(rotated.toString()))
    )
      throw new Error("hosted_pool_e2e_custody_rotation_reconnect_invalid");
  } finally {
    await admin
      .query(
        `ALTER ROLE reviewrouter_comment_token_custody LOGIN PASSWORD '${oldPassword}'`,
      )
      .catch(() => undefined);
    await retained.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

async function canConnect(connectionString) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2_000,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function provisionAdversarialRuntimeRoles(
  connectionString,
  { custodyPassword, apiPassword, releaseMigrationPassword },
) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (
      !/^[A-Za-z0-9_-]+$/u.test(custodyPassword) ||
      !/^[A-Za-z0-9_-]+$/u.test(apiPassword) ||
      !/^[A-Za-z0-9_-]+$/u.test(releaseMigrationPassword)
    )
      throw new Error("hosted_pool_e2e_role_password_invalid");
    await client.query(
      `CREATE ROLE reviewrouter_comment_token_custody LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${custodyPassword}'`,
    );
    await client.query(
      `CREATE ROLE reviewrouter_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${apiPassword}'`,
    );
    await client.query(
      "CREATE ROLE reviewrouter_web NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    );
    await client.query(
      "CREATE ROLE reviewrouter_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    );
    await client.query(
      "CREATE ROLE reviewrouter_codex_effect_authority NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    );
    await client.query(
      "CREATE ROLE reviewrouter_release_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    );
    await client.query(
      `CREATE ROLE reviewrouter_release_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${releaseMigrationPassword}'`,
    );
    await client.query(
      "GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_schema_owner",
    );
  } finally {
    await client.end();
  }
}

async function prepareProviderScopeConcurrencyReleaseAuthority(
  connectionString,
) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      ALTER TABLE public."ReviewInvocationLeaseV2"
        OWNER TO reviewrouter_release_schema_owner;
      ALTER TABLE public."ReviewProviderScopeConcurrencyControl"
        OWNER TO reviewrouter_release_schema_owner;
      GRANT USAGE, CREATE ON SCHEMA public
        TO reviewrouter_release_schema_owner;
      GRANT CONNECT ON DATABASE ${database}
        TO reviewrouter_release_migration;
      GRANT USAGE ON SCHEMA public TO reviewrouter_release_migration;
      REVOKE ALL
        ON TABLE public."ReviewProviderScopeConcurrencyControl"
        FROM reviewrouter_release_migration;
    `);
  } finally {
    await client.end();
  }
}

async function grantMigrationSchemaOwnerAuthority(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      "GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_schema_owner",
    );
  } finally {
    await client.end();
  }
}

async function applyProductionRuntimeAcl(connectionString, databaseName) {
  if (!/^reviewrouter_hosted_pool_e2e_[a-f0-9]+$/u.test(databaseName))
    throw new Error("hosted_pool_e2e_database_name_invalid");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      runtimeGrantStatements(
        {
          roles: [
            { role: "api", username: "reviewrouter_api" },
            { role: "web", username: "reviewrouter_web" },
            { role: "worker", username: "reviewrouter_worker" },
            {
              role: "comment-token-custody",
              username: "reviewrouter_comment_token_custody",
            },
            {
              role: "effect-authority",
              username: "reviewrouter_codex_effect_authority",
            },
          ],
        },
        `"${databaseName}"`,
      ),
    );
  } finally {
    await client.end();
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

function prepareMigrationRehearsal({ excludeHostedPoolMigrations }) {
  const directory = mkdtempSync("packages/platform/db/.hosted-pool-migration-");
  cpSync(
    "packages/platform/db/prisma.config.ts",
    join(directory, "prisma.config.ts"),
  );
  const excludedMigrations = new Set([
    publicEligibilityMigration,
    ...codexOAuthV5Migrations,
    ...(excludeHostedPoolMigrations
      ? hostedPoolStagedMigrations.map((migration) => migration.name)
      : []),
  ]);
  cpSync("packages/platform/db/prisma", join(directory, "prisma"), {
    recursive: true,
    filter: (source) => !excludedMigrations.has(basename(source)),
  });
  return directory;
}

function addMigration(directory, migrationName) {
  cpSync(
    join("packages/platform/db/prisma/migrations", migrationName),
    join(directory, "prisma/migrations", migrationName),
    { recursive: true },
  );
}

function applyCodexOAuthV5Migrations(directory, url) {
  for (const migrationName of codexOAuthV5Migrations) {
    addMigration(directory, migrationName);
    runMigrationDeploy(directory, url);
  }
}

async function prepareCodexOAuthV5ReleaseAuthority(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      ALTER SCHEMA public OWNER TO reviewrouter_release_schema_owner;
      ALTER TABLE public."CodexOAuthSecretNamespace"
        OWNER TO reviewrouter_release_schema_owner;
    `);
    const authority = await client.query(`
      SELECT
        (SELECT owner.rolname
         FROM pg_catalog.pg_namespace namespace
         JOIN pg_catalog.pg_roles owner ON owner.oid = namespace.nspowner
         WHERE namespace.nspname = 'public') AS schema_owner,
        (SELECT owner.rolname
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_roles owner ON owner.oid = relation.relowner
         WHERE relation.oid =
           'public."CodexOAuthSecretNamespace"'::regclass) AS namespace_owner
    `);
    if (
      authority.rows.length !== 1 ||
      authority.rows[0]?.schema_owner !== "reviewrouter_release_schema_owner" ||
      authority.rows[0]?.namespace_owner !== "reviewrouter_release_schema_owner"
    ) {
      throw new Error("codex_oauth_v5_release_authority_invalid");
    }
  } finally {
    await client.end();
  }
}

function runMigrationDeploy(directory, url) {
  run(
    prismaBinary,
    ["migrate", "deploy", "--config", join(directory, "prisma.config.ts")],
    { DATABASE_URL: url },
  );
}

function runMigrationTest(url, phase) {
  run(
    vitestBinary,
    ["run", "scripts/hosted-pool-e2e/hosted-pool-migration-rehearsal.test.ts"],
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

async function applyPublicEligibilityMigration(directory, url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Compare actual catalog identity/security before and after the additive
    // migration. No new role grants, trigger toggles, or body rewriting.
    const catalogSql = `
      SELECT p.oid::text, p.proname, p.proowner::text, p.proacl::text,
        p.prosecdef, p.proconfig, p.prorettype::text, p.proargtypes::text,
        t.oid::text AS trigger_oid, t.tgenabled, pg_get_triggerdef(t.oid) AS trigger_definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_trigger t ON t.tgfoid=p.oid
      WHERE n.nspname='public' AND p.proname IN
        ('hosted_codex_comment_token_mint_guard', 'hosted_codex_comment_token_prepare_authority_complete')
      ORDER BY p.proname, t.oid
    `;
    const before = (await client.query(catalogSql)).rows;
    if (before.length !== 2)
      throw new Error("hosted_public_eligibility_prior_guards_missing");
    addMigration(directory, publicEligibilityMigration);
    runMigrationDeploy(directory, url);
    const after = (await client.query(catalogSql)).rows;
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error("hosted_public_eligibility_guard_security_drift");
    }
    const applied = await client.query(
      `
      SELECT count(*)::int AS count FROM "_prisma_migrations"
      WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL
    `,
      [publicEligibilityMigration],
    );
    if (applied.rows[0]?.count !== 1)
      throw new Error("hosted_public_eligibility_migration_not_committed");
    console.log("hosted_public_eligibility_guard_catalog_preserved:2");
  } finally {
    await client.end();
  }
}
