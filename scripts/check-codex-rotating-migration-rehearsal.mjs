import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexRotatingProductionWriterBaseObservationSql } from "./capture-codex-rotating-production-writer.mjs";
import { verifyCodexRotatingDatabaseCatalog } from "./verify-codex-rotating-rollout.mjs";

const root = resolve(import.meta.dirname, "..");
const dbDirectory = join(root, "packages/platform/db");
const migrationsDirectory = join(dbDirectory, "prisma/migrations");
const migration60Name = "000060_codex_oauth_setup_serialization";
const migration61Name = "000061_codex_oauth_provider_mutation_fence";
const migration62Name = "000062_codex_oauth_remote_outcome_unknown";
const migration63Name = "000063_codex_oauth_setup_payload_claim";
const migration64Name = "000064_codex_oauth_versioned_secret_namespaces";
const migration60 = join(migrationsDirectory, migration60Name, "migration.sql");
const migration61 = join(migrationsDirectory, migration61Name, "migration.sql");
const migration62 = join(migrationsDirectory, migration62Name, "migration.sql");
const migration63 = join(migrationsDirectory, migration63Name, "migration.sql");
const migration64 = join(migrationsDirectory, migration64Name, "migration.sql");
const rotatingMigrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^0000(?:6[0-9]|[7-9][0-9])_/u.test(name))
  .sort();
assert(
  JSON.stringify(rotatingMigrationNames) ===
    JSON.stringify([
      migration60Name,
      migration61Name,
      migration62Name,
      migration63Name,
      migration64Name,
    ]),
  "rehearsal migration inventory must exactly match every checked-in migration from 000060 onward",
);
const baseUrl = requireLocalPostgres(
  process.env.REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL ??
    process.env.REVIEW_ROUTER_TEST_DATABASE_URL ??
    "",
);
const psqlBinary = requirePostgres17();
const databaseName = `rr_codex_fence_${process.pid}_${Date.now()}`;
const adminUrl = databaseUrl(baseUrl, "postgres");
const rehearsalUrl = databaseUrl(baseUrl, databaseName);

try {
  psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(databaseName)}`]);
  assert(
    psql(rehearsalUrl, ["-Atc", "SHOW server_version_num"])
      .stdout.trim()
      .startsWith("17"),
    "the rehearsal database server must be PostgreSQL 17",
  );
  ensureRuntimeRoles(rehearsalUrl);
  applyBaselineThrough59(rehearsalUrl);
  seedDirtyFixtures(rehearsalUrl);
  await proveMigration60LockTimeout(rehearsalUrl);
  migrateResolve(rehearsalUrl, "--rolled-back", migration60Name);
  await proveCombinedLockTimeout(rehearsalUrl);
  proveMigrationRunnerHistory(rehearsalUrl, migration60Name, true);
  proveFetchedAmbiguityStillPresent(rehearsalUrl);
  await proveTtlCrossedAfter60(rehearsalUrl);

  proveStatementTimeoutConfiguration(rehearsalUrl);
  proveInjected61Rollback(rehearsalUrl);
  migrateResolve(rehearsalUrl, "--rolled-back", migration61Name);
  migrateDeploy(rehearsalUrl);
  convergeRuntimePrivileges(rehearsalUrl);

  proveSuccessfulCombinedRelease(rehearsalUrl);
  proveDatabasePrivileges(rehearsalUrl);
  proveTerminalInsertGuards(rehearsalUrl);
  proveSequentialFabricationDeniedForEveryRuntimeRole(rehearsalUrl);
  proveRuntimeVersionedWriteback(rehearsalUrl);
  proveAccountSwitchRecoveryContract(rehearsalUrl);
  proveCompletedRecoveryEvidenceRetention(rehearsalUrl);
  const versionedNamespaceEvidence =
    proveVersionedNamespaceLedger(rehearsalUrl);
  provePrismaCleanupRetention(rehearsalUrl, versionedNamespaceEvidence);
  proveLegacyChildWritesRejected(rehearsalUrl);
  proveParentIdentityWriteRejected(rehearsalUrl);
  proveQuarantineCleanupPath(rehearsalUrl);
  proveExactProductionCatalogContract(rehearsalUrl);
  proveMigrateDeployNoOp(rehearsalUrl);
  proveLateMigrationRollbackAndReplayMatrix();
  const observation = collectObservation(rehearsalUrl);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
  process.stderr.write(
    "Codex rotating PostgreSQL 17 combined 000060+000061+000062+000063+000064 rehearsal passed.\n",
  );
} finally {
  psql(
    adminUrl,
    [
      "-c",
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    ],
    false,
  );
}

function proveLateMigrationRollbackAndReplayMatrix() {
  const cases = [
    {
      name: migration63Name,
      source: migration63,
      prior: [
        [migration60Name, migration60],
        [migration61Name, migration61],
        [migration62Name, migration62],
      ],
      decoy:
        'CREATE INDEX "CodexOAuthSetupManifest_recovery_expiry_idx" ON "CodexOAuthSetupManifest"("status")',
      cleanup: 'DROP INDEX "CodexOAuthSetupManifest_recovery_expiry_idx"',
      leaked:
        "SELECT count(*) FROM information_schema.columns WHERE table_name='CodexOAuthSetupManifest' AND column_name='payloadVersion'",
    },
    {
      name: migration64Name,
      source: migration64,
      prior: [
        [migration60Name, migration60],
        [migration61Name, migration61],
        [migration62Name, migration62],
        [migration63Name, migration63],
      ],
      decoy:
        'CREATE INDEX "CodexOAuthSecretNamespace_secretName_key" ON "CodexOAuthProviderInstance"("id")',
      cleanup: 'DROP INDEX "CodexOAuthSecretNamespace_secretName_key"',
      leaked:
        "SELECT count(*) FROM information_schema.tables WHERE table_name='CodexOAuthSecretNamespace'",
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const name = `${databaseName}_atomic_${index}`;
    const url = databaseUrl(baseUrl, name);
    psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(name)}`]);
    try {
      applyBaselineThrough59(url);
      psql(url, ["-c", testCase.decoy]);
      const failed = migrateDeploy(url, false);
      assert(failed.status !== 0, `${testCase.name} injected failure missing`);
      for (const [migrationName] of testCase.prior) {
        proveMigrationRunnerHistory(url, migrationName, true);
      }
      proveMigrationRunnerHistory(url, testCase.name, false);
      assert(
        psql(url, ["-Atc", testCase.leaked]).stdout.trim() === "0",
        `${testCase.name} leaked partial catalog state after rollback`,
      );
      psql(url, ["-c", testCase.cleanup]);
      migrateResolve(url, "--rolled-back", testCase.name);
      migrateDeploy(url);
      proveMigrationRunnerHistory(url, testCase.name, true);
    } finally {
      psql(
        adminUrl,
        ["-c", `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`],
        false,
      );
    }
  }
}

function applyBaselineThrough59(url) {
  const applied = [];
  for (const directory of readdirSync(migrationsDirectory).sort()) {
    const number = Number.parseInt(directory.slice(0, 6), 10);
    if (!Number.isInteger(number) || number > 59) continue;
    const source = join(migrationsDirectory, directory, "migration.sql");
    psql(url, ["-f", source]);
    applied.push({
      name: directory,
      checksum: createHash("sha256").update(readFileSync(source)).digest("hex"),
    });
  }
  psql(url, [
    "-c",
    String.raw`
      CREATE TABLE "_prisma_migrations" (
        "id" VARCHAR(36) PRIMARY KEY NOT NULL,
        "checksum" VARCHAR(64) NOT NULL,
        "finished_at" TIMESTAMPTZ,
        "migration_name" VARCHAR(255) NOT NULL,
        "logs" TEXT,
        "rolled_back_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )`,
  ]);
  for (const migration of applied) {
    psql(url, [
      "-c",
      `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count") VALUES (${quoteLiteral(randomUUID())}, ${quoteLiteral(migration.checksum)}, now(), ${quoteLiteral(migration.name)}, 1)`,
    ]);
  }
}

function seedDirtyFixtures(url) {
  psql(url, [
    "-c",
    String.raw`
      INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt")
      VALUES ('ws-proof', 'ws-proof', 'migration proof', CURRENT_TIMESTAMP);
      INSERT INTO "RepositoryConnection" (
        "id", "workspaceId", "githubRepositoryId", "externalRepositoryId",
        "owner", "name", "fullName", "defaultBranch", "visibility", "updatedAt"
      )
      SELECT 'repo-' || n, 'ws-proof', 900000 + n, (900000 + n)::text,
        'local', 'proof-' || n, 'local/proof-' || n, 'main', 'private', CURRENT_TIMESTAMP
      FROM generate_series(1, 13) n;
      UPDATE "RepositoryConnection"
      SET "provider" = 'gitlab', "githubRepositoryId" = NULL
      WHERE "id" = 'repo-12';
      UPDATE "RepositoryConnection"
      SET "externalRepositoryId" = 'dirty-external-id'
      WHERE "id" = 'repo-13';

      INSERT INTO "CodexOAuthProviderInstance" (
        "id", "workspaceId", "repositoryId", "providerInstanceId", "authMode",
        "secretName", "state", "generationHashSalt", "accountFingerprintSalt",
        "activeLeaseId", "activeLeaseExpiresAt", "updatedAt"
      ) VALUES
        ('p-fetched', 'ws-proof', 'repo-1', 'codex-rotating:900001', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'setup_pending', 'salt', 'salt', NULL, NULL, now()),
        ('p-issued', 'ws-proof', 'repo-2', 'codex-rotating:900002', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'setup_pending', 'salt', 'salt', NULL, NULL, now()),
        ('p-active-lease', 'ws-proof', 'repo-3', 'codex-rotating:900003', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', 'lease-active', now() + interval '10 minutes', now()),
        ('p-expired-lease', 'ws-proof', 'repo-4', 'codex-rotating:900004', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', 'lease-expired', now() - interval '1 minute', now()),
        ('p-pending', 'ws-proof', 'repo-5', 'codex-rotating:900005', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', NULL, NULL, now()),
        ('p-quarantine', 'ws-proof', 'repo-6', 'legacy-wrong-id', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', NULL, NULL, now()),
        ('p-clean', 'ws-proof', 'repo-7', 'codex-rotating:900007', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', NULL, NULL, now()),
        ('p-recovery', 'ws-proof', 'repo-8', 'codex-rotating:900008', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'unknown_auth_state', 'salt', 'salt', 'lease-recovery', now() + interval '1 minute', now());
      INSERT INTO "CodexOAuthProviderInstance" (
        "id", "workspaceId", "repositoryId", "providerInstanceId", "authMode",
        "secretName", "state", "generationHashSalt", "accountFingerprintSalt", "updatedAt"
      ) VALUES
        ('p-stray-lease', 'ws-proof', 'repo-9', 'codex-rotating:900009', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', now()),
        ('p-dirty-child', 'ws-proof', 'repo-10', 'codex-rotating:900010', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', now()),
        ('p-crossing', 'ws-proof', 'repo-11', 'codex-rotating:900011', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'setup_pending', 'salt', 'salt', now()),
        ('p-parent-dirty', 'ws-proof', 'repo-12', 'legacy-parent-id', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', now()),
        ('p-parent-external-dirty', 'ws-proof', 'repo-13', 'codex-rotating:900013', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', now());

      INSERT INTO "CodexOAuthSetupManifest" (
        "id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId",
        "setupNonce", "manifestJson", "status", "expiresAt", "createdAt"
      ) VALUES
        ('fetched-old', 'ws-proof', 'repo-1', 'p-fetched', 'codex-rotating:900001', 'nonce-fetched-old', '{}', 'fetched', now() - interval '2 hours', '2026-01-01'),
        ('fetched-new', 'ws-proof', 'repo-1', 'p-fetched', 'codex-rotating:900001', 'nonce-fetched-new', '{}', 'fetched', now() - interval '1 hour', '2026-01-02'),
        ('issued-expired', 'ws-proof', 'repo-2', 'p-issued', 'codex-rotating:900002', 'nonce-issued-expired', '{}', 'issued', now() - interval '1 second', '2026-01-01'),
        ('issued-old', 'ws-proof', 'repo-2', 'p-issued', 'codex-rotating:900002', 'nonce-issued-old', '{}', 'issued', now() + interval '1 hour', '2026-01-02'),
        ('issued-new', 'ws-proof', 'repo-2', 'p-issued', 'codex-rotating:900002', 'nonce-issued-new', '{}', 'issued', now() + interval '1 hour', '2026-01-03'),
        ('issued-crossing', 'ws-proof', 'repo-11', 'p-crossing', 'codex-rotating:900011', 'nonce-crossing', '{}', 'issued', now() + interval '5 minutes', '2026-01-05'),
        ('manifest-dirty', 'ws-proof', 'repo-9', 'p-dirty-child', 'wrong-provider-id', 'nonce-dirty', '{}', 'issued', now() + interval '1 hour', '2026-01-06');
      INSERT INTO "CodexOAuthSetupManifest" (
        "id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId",
        "setupNonce", "manifestJson", "status", "expiresAt", "createdAt"
      ) VALUES
        ('fetched-recovery', 'ws-proof', 'repo-8', 'p-recovery', 'codex-rotating:900008', 'nonce-fetched-recovery', '{}', 'fetched', now() - interval '1 hour', '2026-01-04');

      INSERT INTO "CodexOAuthLease" (
        "id", "providerInstanceRowId", "providerInstanceId", "workspaceId", "repositoryId",
        "githubRunId", "githubRunAttempt", "leaseKey", "status", "expiresAt"
      ) VALUES
        ('lease-active', 'p-active-lease', 'codex-rotating:900003', 'ws-proof', 'repo-3', 'run-3', '1', 'key-3', 'preleased', now() + interval '10 minutes'),
        ('lease-expired', 'p-expired-lease', 'codex-rotating:900004', 'ws-proof', 'repo-4', 'run-4', '1', 'key-4', 'finalized', now() - interval '1 minute'),
        ('lease-pending', 'p-pending', 'codex-rotating:900005', 'ws-proof', 'repo-5', 'run-5', '1', 'key-5', 'preleased', now() + interval '1 minute'),
        ('lease-recovery', 'p-recovery', 'codex-rotating:900008', 'ws-proof', 'repo-8', 'run-8', '1', 'key-8', 'preleased', now() + interval '1 minute'),
        ('lease-stray', 'p-stray-lease', 'codex-rotating:900009', 'ws-proof', 'repo-9', 'run-9', '1', 'key-9', 'preleased', now() + interval '1 minute'),
        ('lease-provider-dirty', 'p-quarantine', 'legacy-wrong-id', 'ws-proof', 'repo-6', 'run-6', '1', 'key-6', 'preleased', now() + interval '1 minute'),
        ('lease-dirty', 'p-dirty-child', 'wrong-provider-id', 'ws-proof', 'repo-9', 'run-10', '1', 'key-10', 'preleased', now() + interval '1 minute');
      INSERT INTO "CodexOAuthWritebackIntent" (
        "id", "providerInstanceRowId", "leaseId", "providerInstanceId", "idempotencyKey",
        "generation", "latestGenerationHash", "encryptedPayloadDigest", "keyId", "status", "updatedAt"
      ) VALUES
        ('intent-pending', 'p-pending', 'lease-pending', 'codex-rotating:900005', 'intent-key', 2, 'hash', 'digest', 'kid', 'pending', now()),
        ('intent-history', 'p-pending', 'lease-pending', 'codex-rotating:900005', 'history-key', 1, 'hash', 'digest', 'kid', 'completed', now()),
        ('intent-dirty', 'p-dirty-child', 'lease-dirty', 'wrong-provider-id', 'dirty-key', 1, 'hash', 'digest', 'kid', 'pending', now());
    `,
  ]);
}

async function proveMigration60LockTimeout(url) {
  const applicationName = `rr_setup_lock_${process.pid}`;
  const holder = spawn(
    psqlBinary,
    [
      url,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      'BEGIN; LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS SHARE MODE; SELECT pg_sleep(60);',
    ],
    { stdio: "ignore", env: { ...process.env, PGAPPNAME: applicationName } },
  );
  try {
    await waitForLock(url, applicationName, '"CodexOAuthSetupManifest"');
    const directStartedAt = Date.now();
    const directFailure = psql(url, ["-f", migration60], false);
    const directElapsedMs = Date.now() - directStartedAt;
    const directOutput = `${directFailure.stdout}${directFailure.stderr}`;
    assert(
      directFailure.status !== 0,
      "held manifest lock must reject direct 000060",
    );
    assert(
      directOutput.toLowerCase().includes("lock timeout"),
      `direct 000060 must expose lock timeout: ${directOutput}`,
    );
    assert(
      directElapsedMs >= 14_000 && directElapsedMs < 30_000,
      `direct 000060 lock timeout was not bounded near 15s (${directElapsedMs}ms)`,
    );

    const runnerStartedAt = Date.now();
    const runnerFailure = migrateDeploy(url, false);
    const runnerElapsedMs = Date.now() - runnerStartedAt;
    const runnerOutput = `${runnerFailure.stdout}${runnerFailure.stderr}`;
    assert(
      runnerFailure.status !== 0,
      "held manifest lock must reject runner 000060",
    );
    assert(
      runnerElapsedMs >= 14_000 && runnerElapsedMs < 30_000,
      `Prisma 000060 lock timeout was not bounded near 15s (${runnerElapsedMs}ms): ${runnerOutput}`,
    );
    proveMigrationRunnerHistory(url, migration60Name, false);
    psql(url, [
      "-c",
      String.raw`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CodexOAuthSetupManifest' AND column_name = 'confirmationJson')
          OR to_regclass('public."CodexOAuthSetupManifest_one_active_provider_key"') IS NOT NULL
        THEN RAISE EXCEPTION '000060 lock timeout leaked schema state'; END IF;
        IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'issued-expired') <> 'issued'
        THEN RAISE EXCEPTION '000060 lock timeout leaked data state'; END IF;
      END $$;`,
    ]);
  } finally {
    await terminateChild(holder);
    psql(
      url,
      [
        "-Atc",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${quoteLiteral(applicationName)}`,
      ],
      false,
    );
  }
}

async function proveCombinedLockTimeout(url) {
  const applicationName = `rr_fence_lock_${process.pid}`;
  const holder = spawn(
    psqlBinary,
    [
      url,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      'BEGIN; LOCK TABLE "CodexOAuthProviderInstance" IN ACCESS SHARE MODE; SELECT pg_sleep(60);',
    ],
    { stdio: "ignore", env: { ...process.env, PGAPPNAME: applicationName } },
  );
  try {
    await waitForLock(url, applicationName, '"CodexOAuthProviderInstance"');
    const directStartedAt = Date.now();
    const directFailure = psql(url, ["-f", migration61], false);
    const directElapsedMs = Date.now() - directStartedAt;
    const directFailureOutput = `${directFailure.stdout}${directFailure.stderr}`;
    assert(
      directFailure.status !== 0,
      "held provider lock must reject direct 000061 execution",
    );
    assert(
      directFailureOutput.toLowerCase().includes("lock timeout"),
      `direct 000061 execution must expose lock timeout: ${directFailureOutput}`,
    );
    assert(
      directElapsedMs >= 14_000 && directElapsedMs < 30_000,
      `direct 000061 lock timeout was not bounded near 15s (${directElapsedMs}ms)`,
    );

    const startedAt = Date.now();
    const failed = migrateDeploy(url, false);
    const elapsedMs = Date.now() - startedAt;
    const failedOutput = `${failed.stdout}${failed.stderr}`;
    assert(
      failed.status !== 0,
      "held provider lock must reject combined runner release",
    );
    assert(
      elapsedMs >= 14_000 && elapsedMs < 30_000,
      `Prisma 000061 lock failure was not bounded near 15s (${elapsedMs}ms): ${failedOutput}`,
    );
    proveMigrationRunnerHistory(url, migration60Name, true);
    proveMigrationRunnerHistory(url, migration61Name, false);
    proveFetchedAmbiguityStillPresent(url);
    psql(url, [
      "-c",
      String.raw`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name IN ('CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent') AND column_name = 'mutationEpoch')
        OR to_regclass('public."CodexOAuthProviderIdentityQuarantine"') IS NOT NULL
        OR to_regclass('public."CodexOAuthChildIdentityQuarantine"') IS NOT NULL
        OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'CodexOAuth%fence%guard' OR tgname LIKE 'CodexOAuth%identity%guard' OR tgname LIKE 'CodexOAuth%transition%guard')
        OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE 'CodexOAuth%epoch_check' OR conname = 'CodexOAuthProviderInstance_mutation_fence_check')
        OR EXISTS (SELECT 1 FROM pg_indexes WHERE indexname LIKE 'CodexOAuth%epoch_idx' OR indexname = 'CodexOAuthProviderInstance_mutation_owner_idx')
        OR EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('codex_oauth_repository_identity_guard','codex_oauth_provider_identity_guard','codex_oauth_provider_mutation_transition_guard','codex_oauth_child_identity_fence_guard','codex_oauth_repair_quarantined_child','codex_oauth_repair_quarantined_provider'))
      THEN RAISE EXCEPTION 'lock-timeout failure leaked 000061 state'; END IF;
    END $$;`,
    ]);
  } finally {
    await terminateChild(holder);
    psql(
      url,
      [
        "-Atc",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${quoteLiteral(applicationName)}`,
      ],
      false,
    );
  }
  migrateResolve(url, "--rolled-back", migration61Name);
}

function proveInjected61Rollback(url) {
  psql(url, [
    "-c",
    'CREATE INDEX "CodexOAuthProviderInstance_mutation_owner_idx" ON "CodexOAuthProviderInstance"("id")',
  ]);
  const before = databaseFingerprintBefore61(url);
  const directFailure = psql(url, ["-f", migration61], false);
  const directFailureOutput = `${directFailure.stdout}${directFailure.stderr}`;
  assert(
    directFailure.status !== 0,
    "decoy 000061 index must reject direct migration execution",
  );
  assert(
    directFailureOutput.toLowerCase().includes("already exists"),
    `direct injected failure did not reach the late 000061 index: ${directFailureOutput}`,
  );
  assert(
    databaseFingerprintBefore61(url) === before,
    "direct 000061 transaction did not roll back atomically",
  );

  const failed = migrateDeploy(url, false);
  assert(
    failed.status !== 0,
    "decoy 000061 index must inject a runner failure",
  );
  assert(
    databaseFingerprintBefore61(url) === before,
    "Prisma 000061 transaction did not roll back atomically",
  );
  psql(url, [
    "-c",
    String.raw`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CodexOAuthProviderInstance' AND column_name = 'mutationEpoch')
        OR to_regclass('public."CodexOAuthProviderIdentityQuarantine"') IS NOT NULL
        OR to_regclass('public."CodexOAuthChildIdentityQuarantine"') IS NOT NULL
        OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('CodexOAuthProviderInstance_identity_guard','RepositoryConnection_codex_oauth_identity_guard'))
      THEN RAISE EXCEPTION '000061 schema leaked after injected rollback'; END IF;
    END $$;
    DROP INDEX "CodexOAuthProviderInstance_mutation_owner_idx";`,
  ]);
}

function proveFetchedAmbiguityStillPresent(url) {
  psql(url, [
    "-c",
    String.raw`DO $$ BEGIN
      IF (SELECT count(*) FROM "CodexOAuthSetupManifest" WHERE "providerInstanceRowId" = 'p-fetched' AND "status" = 'fetched') <> 1
        OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'fetched-new') <> 'fetched'
        OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'fetched-old') <> 'superseded'
      THEN RAISE EXCEPTION 'fetched ambiguity marker was erased or not deterministically reduced'; END IF;
      IF (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'issued-expired') <> 'expired'
        OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'issued-new') <> 'issued'
        OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'issued-old') <> 'superseded'
      THEN RAISE EXCEPTION 'issued expiry/ranking cleanup is wrong'; END IF;
    END $$;`,
  ]);
}

async function proveTtlCrossedAfter60(url) {
  psql(url, [
    "-c",
    String.raw`DO $$ BEGIN
      IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') <> 'issued'
      THEN RAISE EXCEPTION '000060 did not leave the future-TTL crossing fixture issued'; END IF;
    END $$;
    UPDATE "CodexOAuthSetupManifest"
    SET "expiresAt" = clock_timestamp() + interval '250 milliseconds'
    WHERE id = 'issued-crossing';`,
  ]);
  await delay(350);
  psql(url, [
    "-c",
    String.raw`DO $$ BEGIN
      IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') <> 'issued'
        OR (SELECT "expiresAt" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') > CURRENT_TIMESTAMP
      THEN RAISE EXCEPTION 'TTL-crossing fixture did not remain issued after committed 000060'; END IF;
    END $$;`,
  ]);
}

function proveStatementTimeoutConfiguration(url) {
  psql(url, [
    "-c",
    String.raw`
      CREATE FUNCTION rr_observe_61_statement_timeout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('statement_timeout')::interval <> interval '5 minutes' THEN
          RAISE EXCEPTION 'rr_000061_wrong_statement_timeout:%', current_setting('statement_timeout');
        END IF;
        RAISE EXCEPTION 'rr_000061_statement_timeout_observed_5min';
      END $$;
      CREATE TRIGGER rr_observe_61_statement_timeout
      BEFORE UPDATE ON "CodexOAuthProviderInstance"
      FOR EACH STATEMENT EXECUTE FUNCTION rr_observe_61_statement_timeout();
    `,
  ]);
  const before = databaseFingerprintBefore61(url);
  const failed = psql(url, ["-f", migration61], false);
  const output = `${failed.stdout}${failed.stderr}`;
  assert(failed.status !== 0, "statement-timeout observer must abort 000061");
  assert(
    output.includes("rr_000061_statement_timeout_observed_5min"),
    `000061 did not expose its transaction-local 5m statement timeout: ${output}`,
  );
  assert(
    databaseFingerprintBefore61(url) === before,
    "statement-timeout observation failure did not roll 000061 back atomically",
  );
  psql(url, [
    "-c",
    'DROP TRIGGER rr_observe_61_statement_timeout ON "CodexOAuthProviderInstance"; DROP FUNCTION rr_observe_61_statement_timeout();',
  ]);

  const startedAt = Date.now();
  const timeout = psql(
    url,
    ["-c", "SET statement_timeout = '250ms'; SELECT pg_sleep(2)"],
    false,
  );
  const elapsedMs = Date.now() - startedAt;
  assert(timeout.status !== 0, "PostgreSQL statement_timeout must cancel work");
  assert(
    `${timeout.stdout}${timeout.stderr}`
      .toLowerCase()
      .includes("statement timeout"),
    "PostgreSQL statement timeout cancellation was not observable",
  );
  assert(
    elapsedMs >= 200 && elapsedMs < 2_000,
    `statement timeout was not bounded (${elapsedMs}ms)`,
  );
}

function proveSuccessfulCombinedRelease(url) {
  psql(url, [
    "-c",
    String.raw`DO $$ DECLARE actual text[]; expected text[]; BEGIN
      IF (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched') <> 'recovery'
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched') <> 'versioned-namespace-cutover:p-fetched'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-new') <> 1
      THEN RAISE EXCEPTION 'fetched ambiguity did not enter versioned recovery ownership'; END IF;
      IF (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-issued') <> 'versioned-namespace-cutover:p-issued'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-new') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-active') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-expired') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-pending') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-stray') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-recovery') <> 1
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-recovery') <> 'recovery'
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-stray-lease') <> 'versioned-namespace-cutover:p-stray-lease'
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-clean') <> 'recovery'
        OR EXISTS (
          SELECT 1 FROM "CodexOAuthProviderInstance" p
          WHERE p."activeSecretNamespaceId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" q WHERE q."providerInstanceRowId" = p.id AND q."resolvedAt" IS NULL)
            AND (p."state" <> 'unknown_auth_state' OR p."mutationOwner" <> 'recovery' OR p."mutationOwnerId" <> 'versioned-namespace-cutover:' || p.id)
        )
      THEN RAISE EXCEPTION 'setup/lease/provider versioned cutover backfills are wrong'; END IF;
      IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') <> 'expired'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') IS NOT NULL
        OR (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') <> 1
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') <> 'recovery'
      THEN RAISE EXCEPTION '000061 did not re-expire the TTL-crossing issued manifest safely'; END IF;
      -- 000061 first terminalizes a legacy pending write. 000062 then
      -- deliberately upgrades that evidence to the stronger, permanent
      -- remote-outcome-unknown classification; the combined-release proof
      -- must assert the final inventory, not the intermediate 000061 value.
      IF (SELECT status FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 'remote_outcome_unknown'
        OR (SELECT "safeErrorCode" FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 'legacy_remote_outcome_unknown'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 1
      THEN RAISE EXCEPTION 'pending intent recovery backfill is wrong'; END IF;
      IF NOT EXISTS (SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId" = 'p-quarantine' AND reason = 'canonical_id_mismatch')
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-quarantine') <> 'recovery'
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-quarantine') <> 'child-quarantine:lease:lease-provider-dirty'
        OR NOT EXISTS (SELECT 1 FROM "CodexOAuthChildIdentityQuarantine" WHERE "childKind"='lease' AND "childId"='lease-provider-dirty' AND reason='provider_identity_quarantined')
        OR (SELECT status FROM "CodexOAuthLease" WHERE id='lease-provider-dirty') <> 'identity_quarantined'
      THEN RAISE EXCEPTION 'dirty identity was not quarantined and recovery-owned'; END IF;
      IF (SELECT count(*) FROM "CodexOAuthChildIdentityQuarantine" WHERE "providerInstanceRowId" = 'p-dirty-child' AND "resolvedAt" IS NULL) <> 3
        OR (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'manifest-dirty') <> 'identity_quarantined'
        OR (SELECT status FROM "CodexOAuthLease" WHERE id = 'lease-dirty') <> 'identity_quarantined'
        OR (SELECT status FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-dirty') <> 'failed'
        OR (SELECT "safeErrorCode" FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-dirty') <> 'identity_quarantined'
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-dirty-child') <> 'recovery'
      THEN RAISE EXCEPTION 'dirty children were not evidence-preserved, terminalized, and recovery-owned'; END IF;
      IF EXISTS (
        SELECT 1 FROM "CodexOAuthSetupManifest" WHERE status IN ('issued','fetched') AND COALESCE("mutationEpoch",0) <= 0
        UNION ALL SELECT 1 FROM "CodexOAuthLease" WHERE status IN ('preleased','finalized') AND COALESCE("mutationEpoch",0) <= 0
        UNION ALL SELECT 1 FROM "CodexOAuthWritebackIntent" WHERE status = 'pending' AND COALESCE("mutationEpoch",0) <= 0
      ) THEN RAISE EXCEPTION 'unsafe active OAuth work remains'; END IF;

      SELECT array_agg(tgname ORDER BY tgname) INTO actual FROM pg_trigger
      WHERE NOT tgisinternal AND (tgname LIKE 'CodexOAuth%guard' OR tgname = 'RepositoryConnection_codex_oauth_identity_guard');
      expected := ARRAY['CodexOAuthLease_identity_fence_guard','CodexOAuthProviderInstance_identity_guard','CodexOAuthProviderInstance_mutation_transition_guard','CodexOAuthSecretNamespace_tombstone_guard','CodexOAuthSetupDispatchAttempt_evidence_guard','CodexOAuthSetupManifest_evidence_guard','CodexOAuthSetupManifest_identity_fence_guard','CodexOAuthSetupPayloadClaim_evidence_guard','CodexOAuthSetupRecoveryRequest_evidence_guard','CodexOAuthWritebackIntent_identity_fence_guard','CodexOAuthWritebackIntent_runtime_evidence_guard','RepositoryConnection_codex_oauth_identity_guard'];
      IF actual <> expected THEN RAISE EXCEPTION 'trigger catalog mismatch: %', actual; END IF;
      IF EXISTS (
        SELECT 1 FROM (VALUES
          ('CodexOAuthProviderInstance_identity_guard','CodexOAuthProviderInstance','codex_oauth_provider_identity_guard',23::smallint),
          ('CodexOAuthProviderInstance_mutation_transition_guard','CodexOAuthProviderInstance','codex_oauth_provider_mutation_transition_guard',19::smallint),
          ('CodexOAuthSetupManifest_identity_fence_guard','CodexOAuthSetupManifest','codex_oauth_child_identity_fence_guard',23::smallint),
          ('CodexOAuthSetupManifest_evidence_guard','CodexOAuthSetupManifest','codex_oauth_setup_manifest_evidence_guard',31::smallint),
          ('CodexOAuthLease_identity_fence_guard','CodexOAuthLease','codex_oauth_child_identity_fence_guard',23::smallint),
          ('CodexOAuthWritebackIntent_identity_fence_guard','CodexOAuthWritebackIntent','codex_oauth_child_identity_fence_guard',23::smallint),
          ('CodexOAuthWritebackIntent_runtime_evidence_guard','CodexOAuthWritebackIntent','codex_oauth_runtime_writeback_evidence_guard',31::smallint),
          ('CodexOAuthSecretNamespace_tombstone_guard','CodexOAuthSecretNamespace','codex_oauth_secret_namespace_tombstone_guard',31::smallint),
          ('CodexOAuthSetupDispatchAttempt_evidence_guard','CodexOAuthSetupDispatchAttempt','codex_oauth_setup_attempt_evidence_guard',31::smallint),
          ('CodexOAuthSetupPayloadClaim_evidence_guard','CodexOAuthSetupPayloadClaim','codex_oauth_setup_claim_evidence_guard',31::smallint),
          ('CodexOAuthSetupRecoveryRequest_evidence_guard','CodexOAuthSetupRecoveryRequest','codex_oauth_setup_recovery_evidence_guard',31::smallint),
          ('RepositoryConnection_codex_oauth_identity_guard','RepositoryConnection','codex_oauth_repository_identity_guard',17::smallint)
        ) wanted(trigger_name, table_name, function_name, trigger_type)
        WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgname=wanted.trigger_name AND c.relname=wanted.table_name AND p.proname=wanted.function_name AND t.tgtype=wanted.trigger_type)
      ) THEN RAISE EXCEPTION 'trigger event/table/function definition mismatch'; END IF;

      SELECT array_agg(conname ORDER BY conname) INTO actual FROM pg_constraint
      WHERE conname IN ('CodexOAuthProviderInstance_mutation_fence_check','CodexOAuthSetupManifest_epoch_check','CodexOAuthLease_epoch_check','CodexOAuthWritebackIntent_epoch_check');
      expected := ARRAY['CodexOAuthLease_epoch_check','CodexOAuthProviderInstance_mutation_fence_check','CodexOAuthSetupManifest_epoch_check','CodexOAuthWritebackIntent_epoch_check'];
      IF actual <> expected THEN RAISE EXCEPTION 'check catalog mismatch: %', actual; END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ANY(expected) AND contype <> 'c')
        OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodexOAuthProviderInstance_mutation_fence_check' AND NOT convalidated)
        OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ANY(ARRAY['CodexOAuthSetupManifest_epoch_check','CodexOAuthLease_epoch_check','CodexOAuthWritebackIntent_epoch_check']) AND convalidated)
      THEN RAISE EXCEPTION 'check validation/catalog flags mismatch'; END IF;
      IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='CodexOAuthProviderInstance_mutation_fence_check')) NOT LIKE '%mutationEpoch%mutationOwner%mutationOwnerId%runtime%setup%recovery%'
        OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='CodexOAuthSetupManifest_epoch_check')) NOT LIKE '%status%issued%fetched%mutationEpoch%'
        OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='CodexOAuthLease_epoch_check')) NOT LIKE '%status%preleased%finalized%mutationEpoch%'
        OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='CodexOAuthWritebackIntent_epoch_check')) NOT LIKE '%status%pending%mutationEpoch%'
      THEN RAISE EXCEPTION 'check expression definition mismatch'; END IF;

      SELECT array_agg(indexname ORDER BY indexname) INTO actual FROM pg_indexes WHERE indexname IN (
        'CodexOAuthSetupManifest_one_active_provider_key','CodexOAuthProviderInstance_mutation_owner_idx',
        'CodexOAuthSetupManifest_provider_epoch_idx','CodexOAuthLease_provider_epoch_idx','CodexOAuthWritebackIntent_provider_epoch_idx',
        'CodexOAuthChildIdentityQuarantine_provider_idx');
      expected := ARRAY['CodexOAuthChildIdentityQuarantine_provider_idx','CodexOAuthLease_provider_epoch_idx','CodexOAuthProviderInstance_mutation_owner_idx','CodexOAuthSetupManifest_one_active_provider_key','CodexOAuthSetupManifest_provider_epoch_idx','CodexOAuthWritebackIntent_provider_epoch_idx'];
      IF actual <> expected THEN RAISE EXCEPTION 'index catalog mismatch: %', actual; END IF;
      IF pg_get_indexdef('"CodexOAuthProviderInstance_mutation_owner_idx"'::regclass, 1, true) <> '"mutationOwner"'
        OR pg_get_indexdef('"CodexOAuthProviderInstance_mutation_owner_idx"'::regclass, 2, true) <> '"mutationEpoch"'
        OR pg_get_indexdef('"CodexOAuthSetupManifest_provider_epoch_idx"'::regclass, 1, true) <> '"providerInstanceRowId"'
        OR pg_get_indexdef('"CodexOAuthSetupManifest_provider_epoch_idx"'::regclass, 2, true) <> '"mutationEpoch"'
        OR pg_get_indexdef('"CodexOAuthLease_provider_epoch_idx"'::regclass, 1, true) <> '"providerInstanceRowId"'
        OR pg_get_indexdef('"CodexOAuthLease_provider_epoch_idx"'::regclass, 2, true) <> '"mutationEpoch"'
        OR pg_get_indexdef('"CodexOAuthWritebackIntent_provider_epoch_idx"'::regclass, 1, true) <> '"providerInstanceRowId"'
        OR pg_get_indexdef('"CodexOAuthWritebackIntent_provider_epoch_idx"'::regclass, 2, true) <> '"mutationEpoch"'
        OR pg_get_indexdef('"CodexOAuthChildIdentityQuarantine_provider_idx"'::regclass, 1, true) <> '"providerInstanceRowId"'
        OR pg_get_indexdef('"CodexOAuthChildIdentityQuarantine_provider_idx"'::regclass, 2, true) <> '"resolvedAt"'
      THEN RAISE EXCEPTION 'index key definition mismatch'; END IF;
      IF pg_get_expr((SELECT indpred FROM pg_index WHERE indexrelid = '"CodexOAuthSetupManifest_one_active_provider_key"'::regclass), '"CodexOAuthSetupManifest"'::regclass)
         <> '(status = ANY (ARRAY[''issued''::text, ''fetched''::text]))'
      THEN RAISE EXCEPTION 'active-manifest predicate mismatch'; END IF;
      IF NOT (SELECT indisunique AND indisvalid AND indisready FROM pg_index WHERE indexrelid = '"CodexOAuthSetupManifest_one_active_provider_key"'::regclass)
      THEN RAISE EXCEPTION 'active-manifest index flags mismatch'; END IF;
    END $$;`,
  ]);
  proveMigrationRunnerHistory(url, migration60Name, true);
  proveMigrationRunnerHistory(url, migration61Name, true);
  proveMigrationRunnerHistory(url, migration62Name, true);
  proveMigrationRunnerHistory(url, migration63Name, true);
  proveMigrationRunnerHistory(url, migration64Name, true);
}

function proveVersionedNamespaceLedger(url) {
  const evidence = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_build_object(
        'tombstone', (
          SELECT row_to_json(exact_tombstone) FROM (
            SELECT claim."id" AS "claimId", attempt."id" AS "attemptId",
              namespace."id" AS "namespaceId", namespace."secretName",
              namespace."namespaceEpoch"::text AS "namespaceEpoch",
              namespace."databaseRecoveryWitness", claim."status" AS "claimStatus",
              attempt."status" AS "attemptStatus", namespace."status" AS "namespaceStatus",
              namespace."permanentlyRetired"
            FROM "CodexOAuthSetupPayloadClaim" claim
            JOIN "CodexOAuthSetupDispatchAttempt" attempt ON attempt."claimId" = claim."id"
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
            WHERE claim."providerInstanceRowId" = 'p-clean'
              AND claim."operationId" = 'operation:runtime-proof-initial'
              AND attempt."idempotencyKey" = 'dispatch:runtime-proof-initial'
          ) exact_tombstone
        ),
        'active', (
          SELECT row_to_json(exact_active) FROM (
            SELECT claim."id" AS "claimId", attempt."id" AS "attemptId",
              namespace."id" AS "namespaceId", namespace."secretName",
              namespace."namespaceEpoch"::text AS "namespaceEpoch",
              claim."accountIdentityHash", claim."status" AS "claimStatus",
              attempt."status" AS "attemptStatus", namespace."status" AS "namespaceStatus",
              namespace."permanentlyRetired"
            FROM "CodexOAuthSetupPayloadClaim" claim
            JOIN "CodexOAuthSetupDispatchAttempt" attempt ON attempt."claimId" = claim."id"
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
            WHERE claim."providerInstanceRowId" = 'p-clean'
              AND claim."operationId" = 'operation:runtime-proof-recovery'
              AND attempt."idempotencyKey" = 'dispatch:runtime-proof-recovery'
          ) exact_active
        ),
        'ambiguous', (
          SELECT row_to_json(exact_ambiguous) FROM (
            SELECT intent."id" AS "intentId", namespace."id" AS "namespaceId",
              namespace."status" AS "namespaceStatus", namespace."permanentlyRetired",
              intent."status" AS "intentStatus", intent."recoveryRequestRowId"
            FROM "CodexOAuthWritebackIntent" intent
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = intent."secretNamespaceId"
            WHERE intent."providerInstanceRowId" = 'p-clean'
              AND intent."idempotencyKey" = 'proof:ambiguous'
          ) exact_ambiguous
        ),
        'provider', (
          SELECT row_to_json(exact_provider) FROM (
            SELECT provider."id", provider."workspaceId", provider."repositoryId",
              repository."githubRepositoryId"::text AS "githubRepositoryId",
              provider."activeSecretNamespaceId",
              provider."activeSecretNamespaceEpoch"::text AS "activeSecretNamespaceEpoch",
              provider."activeSecretNamespaceName", provider."activeAccountIdentityHash"
            FROM "CodexOAuthProviderInstance" provider
            JOIN "RepositoryConnection" repository ON repository."id" = provider."repositoryId"
            WHERE provider."id" = 'p-clean'
          ) exact_provider
        )
      )`,
    ]).stdout.trim(),
  );
  assert(
    evidence.tombstone?.claimStatus === "retired_active" &&
      evidence.tombstone.attemptStatus === "retired_confirmed" &&
      evidence.tombstone.namespaceStatus === "retired_superseded" &&
      evidence.tombstone.permanentlyRetired === true,
    "runtime production path did not retain the exact superseded setup namespace tombstone",
  );
  assert(
    evidence.active?.claimStatus === "active" &&
      evidence.active.attemptStatus === "confirmed" &&
      evidence.active.namespaceStatus === "active" &&
      evidence.active.permanentlyRetired === false &&
      evidence.provider?.activeSecretNamespaceId ===
        evidence.active.namespaceId &&
      evidence.provider.activeSecretNamespaceEpoch ===
        evidence.active.namespaceEpoch &&
      evidence.provider.activeSecretNamespaceName ===
        evidence.active.secretName &&
      evidence.provider.activeAccountIdentityHash ===
        evidence.active.accountIdentityHash,
    "runtime production path exact active namespace binding is incomplete",
  );
  assert(
    evidence.ambiguous?.namespaceStatus === "retired_ambiguous" &&
      evidence.ambiguous.permanentlyRetired === true &&
      evidence.ambiguous.intentStatus === "remote_outcome_unknown" &&
      typeof evidence.ambiguous.recoveryRequestRowId === "string",
    "runtime production path did not retain the exact ambiguous namespace tombstone",
  );

  const tombstone = evidence.tombstone;
  const active = evidence.active;
  const provider = evidence.provider;
  const recreate = psql(
    url,
    [
      "-c",
      `INSERT INTO "CodexOAuthSecretNamespace" ("id","providerInstanceRowId","githubRepositoryId","namespaceEpoch","secretName","databaseRecoveryWitness","status")
       SELECT 'namespace-reuse-proof', ${quoteLiteral(provider.id)}, ${quoteLiteral(provider.githubRepositoryId)},
         max("namespaceEpoch") + 1, ${quoteLiteral(tombstone.secretName)}, ${quoteLiteral(tombstone.databaseRecoveryWitness)}, 'dispatch_authorized'
       FROM "CodexOAuthSecretNamespace" WHERE "providerInstanceRowId"=${quoteLiteral(provider.id)}`,
    ],
    false,
  );
  assert(
    recreate.status !== 0 &&
      `${recreate.stdout}${recreate.stderr}`.includes(
        "CodexOAuthSecretNamespace_secretName_key",
      ),
    "the exact production tombstone name was not rejected by the permanent uniqueness constraint",
  );
  const forbiddenMutations = [
    [
      `UPDATE "CodexOAuthProviderInstance" SET "activeSecretNamespaceId"=NULL WHERE "id"=${quoteLiteral(provider.id)}`,
      "codex_oauth_provider_mutation_fence_required",
    ],
    [
      `UPDATE "CodexOAuthProviderInstance" SET "activeSecretNamespaceEpoch"="activeSecretNamespaceEpoch"+1 WHERE "id"=${quoteLiteral(provider.id)}`,
      "codex_oauth_provider_mutation_fence_required",
    ],
    [
      `UPDATE "CodexOAuthProviderInstance" SET "activeSecretNamespaceName"=${quoteLiteral(tombstone.secretName)} WHERE "id"=${quoteLiteral(provider.id)}`,
      "codex_oauth_provider_mutation_fence_required",
    ],
    [
      `UPDATE "CodexOAuthProviderInstance" SET "activeAccountIdentityHash"=repeat('x',64) WHERE "id"=${quoteLiteral(provider.id)}`,
      "codex_oauth_provider_mutation_fence_required",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "manifestDigest"=repeat('f',64) WHERE "id"=${quoteLiteral(active.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "recoveryEpoch"="recoveryEpoch"+1 WHERE "id"=${quoteLiteral(active.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "installerDigest"=repeat('f',64) WHERE "id"=${quoteLiteral(active.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "databaseRecoveryWitness"=repeat('f',64) WHERE "id"=${quoteLiteral(active.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "confirmedAttemptId"=${quoteLiteral(tombstone.attemptId)} WHERE "id"=${quoteLiteral(active.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupDispatchAttempt" SET "dispatchExpiresAt"="dispatchExpiresAt"+interval '1 minute' WHERE "id"=${quoteLiteral(active.attemptId)}`,
      "codex_oauth_setup_attempt_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "workflowSourceBlobSha"=repeat('e',40) WHERE "id"=${quoteLiteral(active.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "workflowSourceSha256"=repeat('e',64) WHERE "id"=${quoteLiteral(active.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "workflowSemanticSha256"=repeat('e',64) WHERE "id"=${quoteLiteral(active.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "attestedRepositoryId"='900008' WHERE "id"=${quoteLiteral(active.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
  ];
  for (const [statement, expectedError] of forbiddenMutations) {
    const rejected = psql(url, ["-c", statement], false);
    assert(
      rejected.status !== 0 &&
        `${rejected.stdout}${rejected.stderr}`.includes(expectedError),
      `fence-critical mutation unexpectedly succeeded: ${statement}`,
    );
  }
  for (const [table, id, expectedError] of [
    [
      "CodexOAuthSecretNamespace",
      tombstone.namespaceId,
      "codex_oauth_secret_namespace_delete_forbidden",
    ],
    [
      "CodexOAuthSecretNamespace",
      evidence.ambiguous.namespaceId,
      "codex_oauth_secret_namespace_delete_forbidden",
    ],
    [
      "CodexOAuthSetupDispatchAttempt",
      active.attemptId,
      "codex_oauth_setup_attempt_delete_forbidden",
    ],
    [
      "CodexOAuthSetupPayloadClaim",
      active.claimId,
      "codex_oauth_setup_claim_delete_forbidden",
    ],
  ]) {
    const evidenceDeletion = psql(
      url,
      ["-c", `DELETE FROM "${table}" WHERE "id"=${quoteLiteral(id)}`],
      false,
    );
    assert(
      evidenceDeletion.status !== 0 &&
        `${evidenceDeletion.stdout}${evidenceDeletion.stderr}`.includes(
          expectedError,
        ),
      `${table} permanent evidence deletion must be rejected`,
    );
  }
  for (const [table, id] of [
    ["CodexOAuthProviderInstance", provider.id],
    ["RepositoryConnection", provider.repositoryId],
    ["Workspace", provider.workspaceId],
  ]) {
    const ownerDeletion = psql(
      url,
      ["-c", `DELETE FROM "${table}" WHERE "id"=${quoteLiteral(id)}`],
      false,
    );
    assert(ownerDeletion.status !== 0, `${table} cleanup must retain evidence`);
    assertVersionedNamespaceEvidenceRetained(url, evidence, table);
  }
  return evidence;
}

function assertVersionedNamespaceEvidenceRetained(
  url,
  evidence,
  attemptedTable,
) {
  const retained = psql(url, [
    "-Atc",
    `SELECT concat_ws(':',
      (SELECT count(*) FROM "CodexOAuthSetupPayloadClaim" WHERE "id"=${quoteLiteral(evidence.active.claimId)}),
      (SELECT count(*) FROM "CodexOAuthSetupDispatchAttempt" WHERE "id"=${quoteLiteral(evidence.active.attemptId)}),
      (SELECT count(*) FROM "CodexOAuthSecretNamespace" WHERE "id"=${quoteLiteral(evidence.tombstone.namespaceId)} AND "permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthSecretNamespace" WHERE "id"=${quoteLiteral(evidence.ambiguous.namespaceId)} AND "permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthSecretNamespace" WHERE "id"=${quoteLiteral(evidence.active.namespaceId)} AND "status"='active'),
      (SELECT count(*) FROM "CodexOAuthProviderInstance" WHERE "id"=${quoteLiteral(evidence.provider.id)}
        AND "activeSecretNamespaceId"=${quoteLiteral(evidence.active.namespaceId)}
        AND "activeSecretNamespaceEpoch"=${quoteLiteral(evidence.active.namespaceEpoch)}::bigint
        AND "activeSecretNamespaceName"=${quoteLiteral(evidence.active.secretName)})
    )`,
  ]).stdout.trim();
  assert(
    retained === "1:1:1:1:1:1",
    `${attemptedTable} cleanup changed the exact runtime evidence chain (${retained})`,
  );
}

function provePrismaCleanupRetention(url, evidence) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(root, "scripts/prove-codex-rotating-evidence-prisma.ts"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL: url.toString(),
        REVIEW_ROUTER_PRISMA_EVIDENCE_IDENTITIES: JSON.stringify({
          claimId: evidence.active.claimId,
          attemptId: evidence.active.attemptId,
          namespaceId: evidence.tombstone.namespaceId,
          providerId: evidence.provider.id,
          repositoryId: evidence.provider.repositoryId,
          workspaceId: evidence.provider.workspaceId,
        }),
      },
      encoding: "utf8",
    },
  );
  assert(
    result.status === 0,
    `Prisma evidence cleanup proof failed (${result.status}): ${result.stderr || result.stdout}`,
  );
}

function proveRuntimeVersionedWriteback(url) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(root, "scripts/prove-codex-runtime-versioned-writeback-prisma.ts"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL: url.toString(),
      },
      encoding: "utf8",
    },
  );
  assert(
    result.status === 0,
    `runtime versioned Prisma proof failed (${result.status}): ${result.stderr || result.stdout}`,
  );
}

function proveExactProductionCatalogContract(url) {
  const observation = JSON.parse(
    psql(url, [
      "-Atc",
      codexRotatingProductionWriterBaseObservationSql,
    ]).stdout.trim(),
  );
  const result = verifyCodexRotatingDatabaseCatalog(observation.catalog, {
    verifyPrivileges: false,
  });
  assert(
    result.ok,
    `production catalog verifier rejected the PostgreSQL 17 rehearsal: ${result.failures.join(", ")}`,
  );
}

function proveDatabasePrivileges(url) {
  psql(url, [
    "-c",
    String.raw`
      DO $$
      DECLARE function_count INTEGER;
      DECLARE unsafe_function_count INTEGER;
      DECLARE table_count INTEGER;
      DECLARE unsafe_table_count INTEGER;
      BEGIN
        SELECT count(*), count(*) FILTER (
          WHERE has_function_privilege('public', p.oid, 'EXECUTE')
        ) INTO function_count, unsafe_function_count
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname LIKE 'codex_oauth_%';
        IF function_count <> 18 OR unsafe_function_count <> 0 THEN
          RAISE EXCEPTION 'Codex OAuth function privilege mismatch: %, %', function_count, unsafe_function_count;
        END IF;

        SELECT count(*), count(*) FILTER (
          WHERE has_table_privilege(
            'public', c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
        ) INTO table_count, unsafe_table_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND c.relname IN (
            'CodexOAuthChildIdentityQuarantine',
            'CodexOAuthDatabaseAuthorityKey',
            'CodexOAuthDatabaseAuthorityReceipt',
            'CodexOAuthProviderIdentityQuarantine',
            'CodexOAuthSecretNamespace',
            'CodexOAuthSetupDispatchAttempt',
            'CodexOAuthSetupPayloadClaim',
            'CodexOAuthSetupRecoveryRequest'
          );
        IF table_count <> 8 OR unsafe_table_count <> 0 THEN
          RAISE EXCEPTION 'Codex OAuth table privilege mismatch: %, %', table_count, unsafe_table_count;
        END IF;
      END $$;
    `,
  ]);
}

function ensureRuntimeRoles(url) {
  psql(url, [
    "-c",
    String.raw`DO $$
      DECLARE role_name text;
      BEGIN
        FOREACH role_name IN ARRAY ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', role_name);
          END IF;
        END LOOP;
      END $$;`,
  ]);
}

function convergeRuntimePrivileges(url) {
  psql(url, [
    "-c",
    String.raw`DO $$
      DECLARE role_name text;
      BEGIN
        FOREACH role_name IN ARRAY ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker'] LOOP
          EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
          EXECUTE format('GRANT SELECT ON TABLE "Workspace", "RepositoryConnection" TO %I', role_name);
          EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE "CodexOAuthChildIdentityQuarantine", "CodexOAuthLease", "CodexOAuthProviderIdentityQuarantine", "CodexOAuthProviderInstance", "CodexOAuthSecretNamespace", "CodexOAuthSetupDispatchAttempt", "CodexOAuthSetupManifest", "CodexOAuthSetupPayloadClaim", "CodexOAuthSetupRecoveryRequest", "CodexOAuthWritebackIntent" TO %I',
            role_name
          );
          EXECUTE format('REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityReceipt" FROM %I', role_name);
          EXECUTE format('REVOKE ALL ON TABLE "CodexOAuthDatabaseAuthorityKey" FROM %I', role_name);
        END LOOP;
      END $$;`,
  ]);
}

function proveSequentialFabricationDeniedForEveryRuntimeRole(url) {
  for (const [ordinal, role] of [
    [1, "reviewrouter_api"],
    [2, "reviewrouter_web"],
    [3, "reviewrouter_worker"],
  ]) {
    const signer = psql(
      url,
      [
        "-c",
        `BEGIN; SET LOCAL ROLE ${quoteIdentifier(role)}; SELECT "codex_oauth_sign_database_authority"('forged'); COMMIT;`,
      ],
      false,
    );
    assert(
      signer.status !== 0 &&
        `${signer.stdout}${signer.stderr}`.includes(
          "permission denied for function codex_oauth_sign_database_authority",
        ),
      `${role} could invoke the isolated database effect signer`,
    );
    const setup = psql(
      url,
      [
        "-c",
        String.raw`BEGIN;
          SET LOCAL ROLE ${quoteIdentifier(role)};
          UPDATE "CodexOAuthProviderInstance"
          SET "mutationEpoch" = "mutationEpoch" + 1,
              "mutationOwner" = 'setup',
              "mutationOwnerId" = 'fabricated-manifest-${ordinal}',
              "state" = 'setup_pending', "updatedAt" = now()
          WHERE "id" = 'p-clean';
          INSERT INTO "CodexOAuthSetupManifest" (
            "id", "workspaceId", "repositoryId", "providerInstanceRowId",
            "providerInstanceId", "setupNonce", "manifestJson", "status",
            "expiresAt", "mutationEpoch", "databaseRecoveryWitness"
          ) VALUES (
            'fabricated-manifest-${ordinal}', 'ws-proof', 'repo-7', 'p-clean',
            'codex-rotating:900007', 'fabricated-nonce-${ordinal}', '{}', 'issued',
            now() + interval '1 hour',
            (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'),
            repeat('a',64)
          );
          UPDATE "CodexOAuthSetupManifest"
          SET "status"='fetched', "lastFetchedAt"=now(),
              "recoveryExpiresAt"=now()+interval '1 hour'
          WHERE "id"='fabricated-manifest-${ordinal}';
          INSERT INTO "CodexOAuthSetupPayloadClaim" (
            "id", "providerInstanceRowId", "workspaceId", "repositoryId", "githubRepositoryId",
            "manifestId", "manifestDigest", "recoveryEpoch", "operationId", "payloadVersion",
            "canonicalizationVersion", "generationHash", "accountIdentityHash", "accountIdentityAlgorithm",
            "authByteSize", "installerVersion", "installerDigest", "databaseIncarnation",
            "databaseRecoveryWitness", "status", "prepareReplayExpiresAt", "recoveryExpiresAt", "updatedAt"
          ) VALUES (
            'fabricated-claim-${ordinal}', 'p-clean', 'ws-proof', 'repo-7', '900007',
            'fabricated-manifest-${ordinal}', repeat('b',64),
            (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'),
            'fabricated-operation-${ordinal}', 2, 1, repeat('g',43), repeat('i',43),
            'provider_issuer_subject_account_v1', 100, 'proof', repeat('e',64),
            '7612345678901234567', repeat('a',64), 'prepared', now(), now()+interval '1 hour', now()
          );
          INSERT INTO "CodexOAuthSecretNamespace" (
            "id", "providerInstanceRowId", "githubRepositoryId", "namespaceEpoch",
            "secretName", "databaseRecoveryWitness", "status"
          ) VALUES (
            'fabricated-namespace-${ordinal}', 'p-clean', '900007', ${100 + ordinal},
            'REVIEWROUTER_CODEX_AUTH_JSON_R900007_P0123456789abcdef_E${100 + ordinal}_${String(ordinal).repeat(32)}',
            repeat('a',64), 'dispatch_authorized'
          );
          INSERT INTO "CodexOAuthSetupDispatchAttempt" (
            "id", "claimId", "namespaceId", "ordinal", "idempotencyKey", "status",
            "authorizedAt", "dispatchExpiresAt", "updatedAt"
          ) VALUES (
            'fabricated-attempt-${ordinal}', 'fabricated-claim-${ordinal}', 'fabricated-namespace-${ordinal}',
            1, 'fabricated-key-${ordinal}', 'dispatch_authorized', now(), now()+interval '1 hour', now()
          );
          SELECT "codex_oauth_database_authority_challenge"(
            'setup_confirmation', 'fabricated-attempt-${ordinal}', 204
          );
          SELECT "codex_oauth_authorize_setup_confirmation"(
            'fabricated-attempt-${ordinal}', 204, repeat('0',64)
          );
          UPDATE "CodexOAuthSetupDispatchAttempt"
          SET "status"='confirmed', "definiteResponseCode"=204,
              "confirmedAt"=now(), "updatedAt"=now()
          WHERE "id"='fabricated-attempt-${ordinal}';
          COMMIT;`,
      ],
      false,
    );
    assert(
      setup.status !== 0 &&
        /(codex_oauth_database_authority_signature_invalid|permission denied for function codex_oauth_authorize_setup_confirmation)/u.test(
          `${setup.stdout}${setup.stderr}`,
        ),
      `${role} fabricated setup sequence did not fail on database authority`,
    );

    const runtime = psql(
      url,
      [
        "-c",
        String.raw`BEGIN;
          SET LOCAL ROLE ${quoteIdentifier(role)};
          UPDATE "CodexOAuthProviderInstance"
          SET "mutationEpoch" = "mutationEpoch" + 1,
              "mutationOwner" = 'runtime',
              "mutationOwnerId" = 'fabricated-lease-${ordinal}',
              "state" = 'active', "updatedAt" = now()
          WHERE "id" = 'p-clean';
          INSERT INTO "CodexOAuthLease" (
            "id", "providerInstanceRowId", "providerInstanceId", "workspaceId", "repositoryId",
            "githubRunId", "githubRunAttempt", "leaseKey", "status", "expiresAt", "mutationEpoch"
          ) VALUES (
            'fabricated-lease-${ordinal}', 'p-clean', 'codex-rotating:900007', 'ws-proof', 'repo-7',
            'fabricated-run-${ordinal}', '1', 'fabricated-lease-key-${ordinal}', 'preleased',
            now()+interval '1 hour',
            (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean')
          );
          UPDATE "CodexOAuthProviderInstance"
          SET "activeLeaseId"='fabricated-lease-${ordinal}',
              "activeLeaseExpiresAt"=now()+interval '1 hour', "updatedAt"=now()
          WHERE "id"='p-clean';
          UPDATE "CodexOAuthLease"
          SET "status"='finalized', "nextGeneration"=2, "restoredGenerationHash"='old',
              "writebackPreflightKeyId"='kid', "writebackPreflightedAt"=now(), "finalizedAt"=now()
          WHERE "id"='fabricated-lease-${ordinal}';
          INSERT INTO "CodexOAuthSecretNamespace" (
            "id", "providerInstanceRowId", "githubRepositoryId", "namespaceEpoch",
            "secretName", "databaseRecoveryWitness", "status"
          ) VALUES (
            'fabricated-runtime-namespace-${ordinal}', 'p-clean', '900007', ${200 + ordinal},
            'REVIEWROUTER_CODEX_AUTH_JSON_R900007_P0123456789abcdef_E${200 + ordinal}_${String(ordinal + 3).repeat(32)}',
            repeat('a',64), 'dispatch_authorized'
          );
          INSERT INTO "CodexOAuthWritebackIntent" (
            "id", "providerInstanceRowId", "leaseId", "providerInstanceId", "idempotencyKey",
            "generation", "latestGenerationHash", "encryptedPayloadDigest", "keyId", "status",
            "safeErrorCode", "mutationEpoch", "dispatchAttemptId", "secretNamespaceId",
            "dispatchAuthorizedAt", "databaseIncarnation", "databaseRecoveryWitness",
            "accountIdentityHash", "accountIdentityAlgorithm", "executorOwner", "executorLeaseExpiresAt", "updatedAt"
          ) VALUES (
            'fabricated-intent-${ordinal}', 'p-clean', 'fabricated-lease-${ordinal}', 'codex-rotating:900007',
            'fabricated-intent-key-${ordinal}', 2, 'new', 'digest', 'kid', 'pending',
            'versioned_dispatch_authorized_v1',
            (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'),
            'fabricated-runtime-attempt-${ordinal}', 'fabricated-runtime-namespace-${ordinal}', now(),
            '7612345678901234567', repeat('a',64), repeat('i',43),
            'provider_issuer_subject_account_v1', 'fabricated-executor-${ordinal}', now()+interval '1 hour', now()
          );
          SELECT "codex_oauth_database_authority_challenge"(
            'runtime_confirmation', 'fabricated-intent-${ordinal}', 204
          );
          SELECT "codex_oauth_authorize_runtime_confirmation"(
            'fabricated-intent-${ordinal}', 'fabricated-executor-${ordinal}',
            204, repeat('0',64)
          );
          UPDATE "CodexOAuthWritebackIntent"
          SET "providerResponseCode"=204, "providerConfirmedAt"=now(),
              "safeErrorCode"='versioned_provider_confirmed_v1', "updatedAt"=now()
          WHERE "id"='fabricated-intent-${ordinal}';
          UPDATE "CodexOAuthSecretNamespace"
          SET "status"='confirmed_candidate', "confirmedAt"=now()
          WHERE "id"='fabricated-runtime-namespace-${ordinal}';
          UPDATE "CodexOAuthSecretNamespace"
          SET "status"='active',
              "workflowPath"='.github/workflows/reviewrouter-codex.yml',
              "workflowSourceCommitSha"=repeat('a',40),
              "workflowSourceBlobSha"=repeat('b',40),
              "workflowSourceSha256"=repeat('c',64),
              "workflowSemanticSha256"=repeat('d',64),
              "workflowSourceTrust"='trusted_default_branch_revision',
              "attestedRepositoryId"='900007', "activatedAt"=now()
          WHERE "id"='fabricated-runtime-namespace-${ordinal}';
          UPDATE "CodexOAuthProviderInstance"
          SET "activeSecretNamespaceId"='fabricated-runtime-namespace-${ordinal}',
              "activeSecretNamespaceEpoch"=${200 + ordinal},
              "activeSecretNamespaceName"=
                'REVIEWROUTER_CODEX_AUTH_JSON_R900007_P0123456789abcdef_E${200 + ordinal}_${String(ordinal + 3).repeat(32)}',
              "latestGeneration"=2, "latestGenerationHash"='new',
              "activeAccountIdentityHash"=repeat('i',43),
              "state"='active', "activeLeaseId"=NULL,
              "activeLeaseExpiresAt"=NULL,
              "mutationEpoch"="mutationEpoch"+1, "updatedAt"=now()
          WHERE "id"='p-clean';
          UPDATE "CodexOAuthProviderInstance"
          SET "mutationOwner"=NULL, "mutationOwnerId"=NULL, "updatedAt"=now()
          WHERE "id"='p-clean';
          UPDATE "CodexOAuthLease"
          SET "status"='completed', "completedAt"=now(),
              "secretNamespaceId"='fabricated-runtime-namespace-${ordinal}',
              "secretNamespaceEpoch"=${200 + ordinal}
          WHERE "id"='fabricated-lease-${ordinal}';
          UPDATE "CodexOAuthWritebackIntent"
          SET "status"='completed', "completedAt"=now(), "updatedAt"=now()
          WHERE "id"='fabricated-intent-${ordinal}';
          COMMIT;`,
      ],
      false,
    );
    assert(
      runtime.status !== 0 &&
        /(codex_oauth_database_authority_signature_invalid|permission denied for function codex_oauth_authorize_runtime_confirmation)/u.test(
          `${runtime.stdout}${runtime.stderr}`,
        ),
      `${role} fabricated runtime sequence did not fail on database authority`,
    );
  }
}

function proveTerminalInsertGuards(url) {
  const fabricatedSetupRows = [
    {
      error: "codex_oauth_secret_namespace_initial_state_invalid",
      sql: String.raw`
        INSERT INTO "CodexOAuthSecretNamespace" (
          "id", "providerInstanceRowId", "githubRepositoryId", "namespaceEpoch",
          "secretName", "databaseRecoveryWitness", "status", "confirmedAt", "activatedAt",
          "workflowPath", "workflowSourceCommitSha", "workflowSourceBlobSha",
          "workflowSourceSha256", "workflowSemanticSha256", "workflowSourceTrust", "attestedRepositoryId"
        ) VALUES (
          'namespace-fabricated-active', 'p-clean', '900007', 99,
          'REVIEWROUTER_CODEX_AUTH_JSON_R900007_P0123456789abcdef_E99_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          repeat('a',64), 'active', now(), now(), '.github/workflows/reviewrouter-codex.yml',
          repeat('a',40), repeat('b',40), repeat('c',64), repeat('d',64),
          'trusted_default_branch_revision', '900007'
        )`,
    },
    {
      error: "codex_oauth_setup_claim_initial_state_invalid",
      sql: String.raw`
        INSERT INTO "CodexOAuthSetupPayloadClaim" (
          "id", "providerInstanceRowId", "workspaceId", "repositoryId", "githubRepositoryId",
          "manifestId", "manifestDigest", "recoveryEpoch", "operationId", "payloadVersion",
          "canonicalizationVersion", "generationHash", "accountIdentityHash", "accountIdentityAlgorithm",
          "authByteSize", "installerVersion", "installerDigest", "databaseIncarnation",
          "databaseRecoveryWitness", "status", "prepareReplayExpiresAt", "recoveryExpiresAt",
          "confirmedAttemptId", "confirmedAt"
        ) VALUES (
          'claim-fabricated-confirmed', 'p-clean', 'ws-proof', 'repo-7', '900007',
          'fetched-recovery', repeat('a',64), 2, 'operation:fabricated', 2, 1,
          repeat('g',43), repeat('i',43), 'provider_issuer_subject_account_v1', 100,
          'proof', repeat('e',64), '7612345678901234567', repeat('a',64),
          'confirmed_candidate', now(), now() + interval '1 hour', 'attempt-fabricated', now()
        )`,
    },
    {
      error: "codex_oauth_setup_attempt_initial_state_invalid",
      sql: String.raw`
        INSERT INTO "CodexOAuthSetupDispatchAttempt" (
          "id", "claimId", "namespaceId", "ordinal", "idempotencyKey", "status",
          "authorizedAt", "dispatchExpiresAt", "definiteResponseCode", "confirmedAt"
        ) VALUES (
          'attempt-fabricated', 'claim-fabricated', 'namespace-fabricated', 1,
          'dispatch:fabricated', 'confirmed', now(), now() + interval '1 minute', 204, now()
        )`,
    },
    {
      error: "codex_oauth_setup_manifest_initial_state_invalid",
      sql: String.raw`
        INSERT INTO "CodexOAuthSetupManifest" (
          "id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId",
          "setupNonce", "manifestJson", "status", "expiresAt", "consumedAt", "mutationEpoch"
        ) VALUES (
          'manifest-fabricated-consumed', 'ws-proof', 'repo-7', 'p-clean',
          'codex-rotating:900007', 'nonce-fabricated-consumed', '{}', 'consumed',
          now() + interval '1 hour', now(), 1
        )`,
    },
  ];
  for (const fabricated of fabricatedSetupRows) {
    const rejected = psql(url, ["-c", fabricated.sql], false);
    assert(
      rejected.status !== 0 &&
        `${rejected.stdout}${rejected.stderr}`.includes(fabricated.error),
      `raw SQL terminal setup insert did not hit ${fabricated.error}`,
    );
  }
  const fabricatedRecovery = psql(
    url,
    [
      "-c",
      String.raw`
        INSERT INTO "CodexOAuthSetupRecoveryRequest" (
          "id", "providerInstanceRowId", "recoveryRequestId", "actor",
          "acknowledgement", "mutationEpoch", "mode", "state", "updatedAt"
        ) VALUES (
          'recovery-fabricated-terminal', 'p-clean', 'request:fabricated-terminal', 'proof',
          'all_prior_installers_and_writers_are_stopped',
          (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'),
          'forced_reseed', 'completed', now()
        )`,
    ],
    false,
  );
  assert(
    fabricatedRecovery.status !== 0 &&
      `${fabricatedRecovery.stdout}${fabricatedRecovery.stderr}`.includes(
        "codex_oauth_setup_recovery_initial_state_invalid",
      ),
    "raw SQL must not insert fabricated terminal recovery evidence",
  );

  const fabricatedWriteback = psql(
    url,
    [
      "-c",
      String.raw`
        INSERT INTO "CodexOAuthWritebackIntent" (
          "id", "providerInstanceRowId", "leaseId", "providerInstanceId",
          "idempotencyKey", "generation", "latestGenerationHash",
          "encryptedPayloadDigest", "keyId", "status", "updatedAt"
        ) VALUES (
          'intent-fabricated-terminal', 'p-pending', 'lease-pending',
          'codex-rotating:900005', 'fabricated-terminal', 3, 'hash', 'digest',
          'kid', 'completed', now()
        )`,
    ],
    false,
  );
  assert(
    fabricatedWriteback.status !== 0 &&
      `${fabricatedWriteback.stdout}${fabricatedWriteback.stderr}`.includes(
        "codex_oauth_runtime_writeback_initial_state_invalid",
      ),
    "raw SQL must not insert fabricated terminal runtime evidence",
  );
}

function proveAccountSwitchRecoveryContract(url) {
  psql(url, [
    "-c",
    String.raw`
      UPDATE "CodexOAuthProviderInstance"
      SET "mutationEpoch" = "mutationEpoch" + 1,
          "mutationOwner" = 'recovery',
          "mutationOwnerId" = 'setup-recovery:request:account-switch-proof',
          "updatedAt" = now()
      WHERE "id" = 'p-clean';
      INSERT INTO "CodexOAuthSetupRecoveryRequest" (
        "id", "providerInstanceRowId", "recoveryRequestId", "actor",
        "acknowledgement", "mutationEpoch", "mode", "state", "updatedAt"
      ) VALUES (
        'recovery-account-switch-proof', 'p-clean', 'request:account-switch-proof', 'proof',
        'all_prior_installers_and_writers_are_stopped_and_account_switch_is_intended',
        (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'),
        'forced_reseed_account_switch', 'active', now()
      );
    `,
  ]);
  const inferredSwitch = psql(
    url,
    [
      "-c",
      String.raw`
        INSERT INTO "CodexOAuthSetupRecoveryRequest" (
          "id", "providerInstanceRowId", "recoveryRequestId", "actor",
          "acknowledgement", "mutationEpoch", "mode", "state", "updatedAt"
        ) VALUES (
          'recovery-account-switch-invalid', 'p-issued', 'request:account-switch-invalid', 'proof',
          'all_prior_installers_and_writers_are_stopped',
          1, 'forced_reseed_account_switch', 'active', now()
        );
      `,
    ],
    false,
  );
  assert(
    inferredSwitch.status !== 0,
    "ordinary recovery acknowledgement must not authorize an account-switch epoch",
  );
  const recoveryDeletion = psql(
    url,
    [
      "-c",
      `DELETE FROM "CodexOAuthSetupRecoveryRequest" WHERE "id"='recovery-account-switch-proof'`,
    ],
    false,
  );
  assert(
    recoveryDeletion.status !== 0,
    "account-switch recovery authority must remain permanent evidence",
  );
}

function proveCompletedRecoveryEvidenceRetention(url) {
  for (const statement of [
    `UPDATE "CodexOAuthSetupRecoveryRequest" SET "state"='completed', "latestManifestId"='fetched-recovery', "completedAt"=now(), "updatedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
    `UPDATE "CodexOAuthSetupRecoveryRequest" SET "state"='manifest_issued', "latestManifestId"='fetched-recovery', "updatedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
  ]) {
    const rejected = psql(url, ["-c", statement], false);
    assert(
      rejected.status !== 0,
      "recovery terminal evidence must reject skipped lifecycle/cross-provider authority",
    );
  }
  psql(url, [
    "-c",
    String.raw`
      UPDATE "CodexOAuthProviderInstance"
      SET "mutationEpoch" = "mutationEpoch" + 1,
          "mutationOwner" = 'setup',
          "mutationOwnerId" = 'manifest-completed-recovery-proof',
          "updatedAt" = now()
      WHERE "id" = 'p-clean';
      INSERT INTO "CodexOAuthSetupManifest" (
        "id", "workspaceId", "repositoryId", "providerInstanceRowId",
        "providerInstanceId", "setupNonce", "manifestJson", "status",
        "expiresAt", "createdAt", "mutationEpoch", "databaseRecoveryWitness"
      ) VALUES (
        'manifest-completed-recovery-proof', 'ws-proof', 'repo-7', 'p-clean',
        'codex-rotating:900007', 'nonce-completed-recovery-proof', '{}',
        'issued', now() + interval '1 hour', now(),
        (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'),
        NULL
      );
    `,
  ]);
  const skippedManifestIssued = psql(
    url,
    [
      "-c",
      `UPDATE "CodexOAuthSetupRecoveryRequest" SET "state"='completed', "latestManifestId"='manifest-completed-recovery-proof', "completedAt"=now(), "updatedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
    ],
    false,
  );
  assert(
    skippedManifestIssued.status !== 0,
    "recovery completion must not skip manifest_issued",
  );
  psql(url, [
    "-c",
    String.raw`
      UPDATE "CodexOAuthSetupRecoveryRequest"
      SET "state" = 'manifest_issued',
          "latestManifestId" = 'manifest-completed-recovery-proof',
          "updatedAt" = now()
      WHERE "id" = 'recovery-account-switch-proof';
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM "CodexOAuthSetupRecoveryRequest"
          WHERE "id" = 'recovery-account-switch-proof'
            AND "state" = 'manifest_issued'
            AND "latestManifestId" = 'manifest-completed-recovery-proof'
            AND "completedAt" IS NULL
        ) THEN RAISE EXCEPTION 'manifest-issued recovery evidence was not retained'; END IF;
      END $$;
    `,
  ]);
  const fabricatedCompletion = psql(
    url,
    [
      "-c",
      `UPDATE "CodexOAuthSetupRecoveryRequest" SET "state"='completed', "completedAt"=now(), "updatedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
    ],
    false,
  );
  assert(
    fabricatedCompletion.status !== 0,
    "issued manifest alone must not complete recovery without its exact consumed active evidence chain",
  );
  for (const statement of [
    `UPDATE "CodexOAuthSetupRecoveryRequest" SET "latestManifestId"=NULL WHERE "id"='recovery-account-switch-proof'`,
    `UPDATE "CodexOAuthSetupRecoveryRequest" SET "completedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
    `DELETE FROM "CodexOAuthSetupManifest" WHERE "id"='manifest-completed-recovery-proof'`,
  ]) {
    const rejected = psql(url, ["-c", statement], false);
    assert(
      rejected.status !== 0,
      "completed recovery evidence mutation/deletion must be rejected",
    );
  }
}

function proveLegacyChildWritesRejected(url) {
  const setup = psql(
    url,
    [
      "-c",
      `UPDATE "CodexOAuthSetupManifest" SET "confirmationJson" = '{"legacy":true}'::jsonb WHERE id = 'fetched-recovery'`,
    ],
    false,
  );
  assert(
    setup.status !== 0,
    "legacy setup mutation on a stale active epoch must fail",
  );
  assert(
    `${setup.stdout}${setup.stderr}`.includes(
      "codex_oauth_child_mutation_epoch_mismatch",
    ),
    "legacy setup rejection must identify the epoch fence",
  );
  const lease = psql(
    url,
    [
      "-c",
      `UPDATE "CodexOAuthLease" SET "githubRunAttempt" = '2' WHERE id = 'lease-recovery'`,
    ],
    false,
  );
  assert(
    lease.status !== 0,
    "legacy lease mutation on a stale active epoch must fail",
  );
  assert(
    `${lease.stdout}${lease.stderr}`.includes(
      "codex_oauth_child_mutation_epoch_mismatch",
    ),
    "legacy lease rejection must identify the epoch fence",
  );
  psql(url, [
    "-c",
    String.raw`DO $$ BEGIN
      IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id='fetched-recovery') <> 'fetched'
        OR (SELECT status FROM "CodexOAuthLease" WHERE id='lease-recovery') <> 'preleased'
      THEN RAISE EXCEPTION 'rejected legacy child write changed data'; END IF;
    END $$;`,
  ]);
}

function proveParentIdentityWriteRejected(url) {
  const parent = psql(
    url,
    [
      "-c",
      `UPDATE "RepositoryConnection" SET "githubRepositoryId" = 990001, "externalRepositoryId" = '990001' WHERE id = 'repo-1'`,
    ],
    false,
  );
  assert(parent.status !== 0, "bound repository identity update must fail");
  assert(
    `${parent.stdout}${parent.stderr}`.includes(
      "codex_oauth_repository_identity_bound",
    ),
    "parent identity rejection must identify the rotating binding",
  );
  assert(
    psql(url, [
      "-Atc",
      `SELECT "githubRepositoryId" FROM "RepositoryConnection" WHERE id='repo-1'`,
    ]).stdout.trim() === "900001",
    "rejected parent identity update changed the repository",
  );
  const externalIdentity = psql(
    url,
    [
      "-c",
      `UPDATE "RepositoryConnection" SET "externalRepositoryId" = 'drifted-external-id' WHERE id = 'repo-1'`,
    ],
    false,
  );
  assert(
    externalIdentity.status !== 0,
    "bound repository external identity update must fail",
  );
  assert(
    `${externalIdentity.stdout}${externalIdentity.stderr}`.includes(
      "codex_oauth_repository_identity_bound",
    ),
    "external repository identity rejection must identify the rotating binding",
  );
}

function proveQuarantineCleanupPath(url) {
  psql(url, [
    "-c",
    String.raw`
      SELECT codex_oauth_repair_quarantined_provider('p-quarantine');
      SELECT codex_oauth_repair_quarantined_provider('p-parent-dirty',900012);
      SELECT codex_oauth_repair_quarantined_provider('p-parent-external-dirty');
      SELECT codex_oauth_repair_quarantined_child('lease','lease-provider-dirty');
      SELECT codex_oauth_repair_quarantined_child('setup_manifest','manifest-dirty');
      SELECT codex_oauth_repair_quarantined_child('lease','lease-dirty');
      SELECT codex_oauth_repair_quarantined_child('writeback_intent','intent-dirty','lease-dirty');
      DO $$ BEGIN
        IF (SELECT "providerInstanceId" FROM "CodexOAuthProviderInstance" WHERE id='p-quarantine') <> 'codex-rotating:900006'
          OR (SELECT "resolvedAt" FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId"='p-quarantine') IS NULL
          OR (SELECT "resolvedAt" FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId"='p-parent-dirty') IS NULL
          OR (SELECT "provider"::text FROM "RepositoryConnection" WHERE id='repo-12') <> 'github'
          OR (SELECT "githubRepositoryId" FROM "RepositoryConnection" WHERE id='repo-12') <> 900012
          OR (SELECT "providerInstanceId" FROM "CodexOAuthProviderInstance" WHERE id='p-parent-dirty') <> 'codex-rotating:900012'
          OR (SELECT "resolvedAt" FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId"='p-parent-external-dirty') IS NULL
          OR (SELECT "externalRepositoryId" FROM "RepositoryConnection" WHERE id='repo-13') <> '900013'
          OR (SELECT "resolvedAt" FROM "CodexOAuthChildIdentityQuarantine" WHERE "childKind"='lease' AND "childId"='lease-provider-dirty') IS NULL
          OR (SELECT "providerInstanceId" FROM "CodexOAuthLease" WHERE id='lease-provider-dirty') <> 'codex-rotating:900006'
          OR (SELECT count(*) FROM "CodexOAuthChildIdentityQuarantine" WHERE "providerInstanceRowId"='p-dirty-child' AND "resolvedAt" IS NULL) <> 0
          OR (SELECT count(*) FROM "CodexOAuthChildIdentityQuarantine" WHERE "providerInstanceRowId"='p-dirty-child' AND "evidenceJson" IS NOT NULL) <> 3
          OR (SELECT "providerInstanceId" FROM "CodexOAuthSetupManifest" WHERE id='manifest-dirty') <> 'codex-rotating:900010'
          OR (SELECT "repositoryId" FROM "CodexOAuthSetupManifest" WHERE id='manifest-dirty') <> 'repo-10'
          OR (SELECT "providerInstanceId" FROM "CodexOAuthLease" WHERE id='lease-dirty') <> 'codex-rotating:900010'
          OR (SELECT "repositoryId" FROM "CodexOAuthLease" WHERE id='lease-dirty') <> 'repo-10'
          OR (SELECT "providerInstanceId" FROM "CodexOAuthWritebackIntent" WHERE id='intent-dirty') <> 'codex-rotating:900010'
        THEN RAISE EXCEPTION 'quarantine cleanup did not repair identities while preserving evidence'; END IF;
      END $$;
    `,
  ]);
}

function proveMigrateDeployNoOp(url) {
  const before = psql(url, [
    "-Atc",
    String.raw`SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY migration_name, started_at)::text)
      FROM "_prisma_migrations" m
      WHERE migration_name IN ('000060_codex_oauth_setup_serialization','000061_codex_oauth_provider_mutation_fence','000062_codex_oauth_remote_outcome_unknown','000063_codex_oauth_setup_payload_claim','000064_codex_oauth_versioned_secret_namespaces')`,
  ]).stdout.trim();
  const rerun = migrateDeploy(url);
  const after = psql(url, [
    "-Atc",
    String.raw`SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY migration_name, started_at)::text)
      FROM "_prisma_migrations" m
      WHERE migration_name IN ('000060_codex_oauth_setup_serialization','000061_codex_oauth_provider_mutation_fence','000062_codex_oauth_remote_outcome_unknown','000063_codex_oauth_setup_payload_claim','000064_codex_oauth_versioned_secret_namespaces')`,
  ]).stdout.trim();
  assert(
    before === after,
    "post-success migrate deploy changed migration history",
  );
  assert(
    `${rerun.stdout}${rerun.stderr}`
      .toLowerCase()
      .includes("no pending migrations"),
    "post-success migrate deploy did not report a no-op",
  );
  proveMigrationRunnerHistory(url, migration60Name, true);
  proveMigrationRunnerHistory(url, migration61Name, true);
  proveMigrationRunnerHistory(url, migration62Name, true);
  proveMigrationRunnerHistory(url, migration63Name, true);
  proveMigrationRunnerHistory(url, migration64Name, true);
}

function collectObservation(url) {
  const history = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_agg(x ORDER BY migration_name) FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS current, applied_steps_count FROM "_prisma_migrations" WHERE migration_name IN ('000060_codex_oauth_setup_serialization','000061_codex_oauth_provider_mutation_fence','000062_codex_oauth_remote_outcome_unknown','000063_codex_oauth_setup_payload_claim','000064_codex_oauth_versioned_secret_namespaces')) x`,
    ]).stdout,
  );
  const catalog = JSON.parse(
    psql(url, ["-Atc", codexRotatingProductionWriterBaseObservationSql]).stdout,
  ).catalog;
  const unsafeWork = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_build_object(
        'activeManifestsWithoutPositiveEpoch', (SELECT count(*) FROM "CodexOAuthSetupManifest" WHERE status IN ('issued','fetched') AND COALESCE("mutationEpoch",0) <= 0),
        'activeLeasesWithoutPositiveEpoch', (SELECT count(*) FROM "CodexOAuthLease" WHERE status IN ('preleased','finalized') AND COALESCE("mutationEpoch",0) <= 0),
        'pendingIntentsWithoutPositiveEpoch', (SELECT count(*) FROM "CodexOAuthWritebackIntent" WHERE status = 'pending' AND COALESCE("mutationEpoch",0) <= 0),
        'pendingIntents', (SELECT count(*) FROM "CodexOAuthWritebackIntent" WHERE status = 'pending')
      )`,
    ]).stdout,
  );
  return {
    observationVersion: 2,
    postgresVersion: psql(url, ["-Atc", "SHOW server_version"]).stdout.trim(),
    migrationSources: [
      migration60,
      migration61,
      migration62,
      migration63,
      migration64,
    ].map((path, index) => ({
      id: [
        migration60Name,
        migration61Name,
        migration62Name,
        migration63Name,
        migration64Name,
      ][index],
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    })),
    history,
    catalog,
    unsafeWork,
    fetchedRecoveryOwner: psql(url, [
      "-Atc",
      `SELECT "mutationOwner" || ':' || "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched'`,
    ]).stdout.trim(),
  };
}

function proveMigrationRunnerHistory(url, name, successful) {
  const row = psql(url, [
    "-Atc",
    `SELECT count(*) || ':' || count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) FROM "_prisma_migrations" WHERE migration_name = ${quoteLiteral(name)}`,
  ]).stdout.trim();
  const [total, current] = row.split(":").map(Number);
  assert(
    total >= 1 && current === (successful ? 1 : 0),
    `${name} runner history does not prove expected state (${row})`,
  );
}

function databaseFingerprintBefore61(url) {
  return psql(url, [
    "-Atc",
    String.raw`SELECT md5(jsonb_build_object(
      'providers',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "CodexOAuthProviderInstance" p),
      'manifests',(SELECT jsonb_agg(to_jsonb(m) - 'confirmationJson' ORDER BY id) FROM "CodexOAuthSetupManifest" m),
      'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM "CodexOAuthLease" l),
      'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM "CodexOAuthWritebackIntent" i),
      'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,column_name) FROM information_schema.columns c WHERE table_schema='public' AND table_name IN ('CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent')),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,contype,convalidated,pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid IN ('"CodexOAuthProviderInstance"'::regclass,'"CodexOAuthSetupManifest"'::regclass,'"CodexOAuthLease"'::regclass,'"CodexOAuthWritebackIntent"'::regclass)),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(indexname,indexdef) ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND tablename IN ('CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent')),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,c.relname,p.proname,t.tgtype) ORDER BY t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND c.relname IN ('RepositoryConnection','CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent')),
      'guardFunctions',(SELECT jsonb_agg(jsonb_build_array(proname,pg_get_functiondef(oid)) ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'codex_oauth%guard' OR proname LIKE 'codex_oauth_repair_quarantined%'))
    )::text)`,
  ]).stdout.trim();
}

async function waitForLock(url, applicationName, relation) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = Number(
      psql(url, [
        "-Atc",
        `SELECT count(*) FROM pg_locks WHERE relation = ${quoteLiteral(relation)}::regclass AND granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name = ${quoteLiteral(applicationName)})`,
      ]).stdout,
    );
    if (count > 0) return;
    await delay(25);
  }
  throw new Error("held-lock fixture did not become ready");
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

function migrateDeploy(url, requireSuccess = true) {
  return prisma(
    url,
    ["migrate", "deploy", "--config", "prisma.config.ts"],
    requireSuccess,
  );
}

function migrateResolve(url, resolution, name) {
  prisma(url, [
    "migrate",
    "resolve",
    resolution,
    name,
    "--config",
    "prisma.config.ts",
  ]);
}

function prisma(url, args, requireSuccess = true) {
  const command = process.env.npm_execpath
    ? {
        executable: process.execPath,
        args: [process.env.npm_execpath, "exec", "prisma", ...args],
      }
    : { executable: "pnpm", args: ["exec", "prisma", ...args] };
  const result = spawnSync(command.executable, command.args, {
    cwd: dbDirectory,
    env: { ...process.env, DATABASE_URL: url.toString() },
    encoding: "utf8",
  });
  if (requireSuccess && result.status !== 0)
    throw new Error(
      `Prisma migration runner failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result;
}

function requireLocalPostgres(value) {
  if (!value)
    throw new Error(
      "set REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL to a disposable local PostgreSQL 17 server",
    );
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "::1"].includes(host)
  )
    throw new Error("migration rehearsal only accepts loopback PostgreSQL");
  return url;
}

function requirePostgres17() {
  const candidates = [
    process.env.REVIEW_ROUTER_PSQL_BINARY,
    "/usr/lib/postgresql/17/bin/psql",
    "psql",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && /\b17\.\d+/u.test(result.stdout))
      return candidate;
  }
  throw new Error(
    "PostgreSQL 17 psql is required; the rehearsal never skips or falls back to another major",
  );
}

function psql(url, args, requireSuccess = true) {
  const result = spawnSync(
    psqlBinary,
    [url.toString(), "-X", "-v", "ON_ERROR_STOP=1", ...args],
    { encoding: "utf8" },
  );
  if (requireSuccess && result.status !== 0)
    throw new Error(
      `psql failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result;
}

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.search = "";
  return url;
}
function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
