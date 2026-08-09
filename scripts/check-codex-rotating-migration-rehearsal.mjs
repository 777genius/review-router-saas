import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const dbDirectory = join(root, "packages/platform/db");
const migrationsDirectory = join(dbDirectory, "prisma/migrations");
const migration60Name = "000060_codex_oauth_setup_serialization";
const migration61Name = "000061_codex_oauth_provider_mutation_fence";
const migration62Name = "000062_codex_oauth_remote_outcome_unknown";
const migration63Name = "000063_codex_oauth_setup_payload_claim";
const migration60 = join(migrationsDirectory, migration60Name, "migration.sql");
const migration61 = join(migrationsDirectory, migration61Name, "migration.sql");
const migration62 = join(migrationsDirectory, migration62Name, "migration.sql");
const migration63 = join(migrationsDirectory, migration63Name, "migration.sql");
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

  proveSuccessfulCombinedRelease(rehearsalUrl);
  proveLegacyChildWritesRejected(rehearsalUrl);
  proveParentIdentityWriteRejected(rehearsalUrl);
  proveQuarantineCleanupPath(rehearsalUrl);
  proveMigrateDeployNoOp(rehearsalUrl);
  const observation = collectObservation(rehearsalUrl);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
  process.stderr.write(
    "Codex rotating PostgreSQL 17 combined 000060+000061+000062+000063 rehearsal passed.\n",
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
      IF (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched') <> 'setup'
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched') <> 'fetched-new'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-new') <> 1
      THEN RAISE EXCEPTION 'fetched ambiguity did not pin setup recovery ownership'; END IF;
      IF (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-issued') <> 'issued-new'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-new') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-active') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-expired') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-pending') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-stray') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-recovery') <> 1
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-recovery') <> 'recovery'
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-stray-lease') <> 'lease-stray'
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-clean') IS NOT NULL
      THEN RAISE EXCEPTION 'setup/lease/clean-provider backfills are wrong'; END IF;
      IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') <> 'expired'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') IS NOT NULL
        OR (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') <> 0
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') IS NOT NULL
      THEN RAISE EXCEPTION '000061 did not re-expire the TTL-crossing issued manifest safely'; END IF;
      IF (SELECT status FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 'failed'
        OR (SELECT "safeErrorCode" FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 'legacy_ambiguous_recovery'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 1
      THEN RAISE EXCEPTION 'pending intent recovery backfill is wrong'; END IF;
      IF NOT EXISTS (SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId" = 'p-quarantine' AND reason = 'canonical_id_mismatch')
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-quarantine') <> 'recovery'
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
      expected := ARRAY['CodexOAuthLease_identity_fence_guard','CodexOAuthProviderInstance_identity_guard','CodexOAuthProviderInstance_mutation_transition_guard','CodexOAuthSetupManifest_identity_fence_guard','CodexOAuthWritebackIntent_identity_fence_guard','RepositoryConnection_codex_oauth_identity_guard'];
      IF actual <> expected THEN RAISE EXCEPTION 'trigger catalog mismatch: %', actual; END IF;
      IF EXISTS (
        SELECT 1 FROM (VALUES
          ('CodexOAuthProviderInstance_identity_guard','CodexOAuthProviderInstance','codex_oauth_provider_identity_guard',23::smallint),
          ('CodexOAuthProviderInstance_mutation_transition_guard','CodexOAuthProviderInstance','codex_oauth_provider_mutation_transition_guard',19::smallint),
          ('CodexOAuthSetupManifest_identity_fence_guard','CodexOAuthSetupManifest','codex_oauth_child_identity_fence_guard',23::smallint),
          ('CodexOAuthLease_identity_fence_guard','CodexOAuthLease','codex_oauth_child_identity_fence_guard',23::smallint),
          ('CodexOAuthWritebackIntent_identity_fence_guard','CodexOAuthWritebackIntent','codex_oauth_child_identity_fence_guard',23::smallint),
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
}

function proveLegacyChildWritesRejected(url) {
  const setup = psql(
    url,
    [
      "-c",
      `UPDATE "CodexOAuthSetupManifest" SET status = 'consumed', "consumedAt" = now() WHERE id = 'fetched-recovery'`,
    ],
    false,
  );
  assert(
    setup.status !== 0,
    "legacy setup transition under recovery ownership must fail",
  );
  assert(
    `${setup.stdout}${setup.stderr}`.includes(
      "codex_oauth_child_mutation_owner_mismatch",
    ),
    "legacy setup rejection must identify the owner fence",
  );
  const lease = psql(
    url,
    [
      "-c",
      `UPDATE "CodexOAuthLease" SET status = 'finalized' WHERE id = 'lease-recovery'`,
    ],
    false,
  );
  assert(
    lease.status !== 0,
    "legacy lease transition under recovery ownership must fail",
  );
  assert(
    `${lease.stdout}${lease.stderr}`.includes(
      "codex_oauth_child_mutation_owner_mismatch",
    ),
    "legacy lease rejection must identify the owner fence",
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
      WHERE migration_name IN ('000060_codex_oauth_setup_serialization','000061_codex_oauth_provider_mutation_fence','000062_codex_oauth_remote_outcome_unknown','000063_codex_oauth_setup_payload_claim')`,
  ]).stdout.trim();
  const rerun = migrateDeploy(url);
  const after = psql(url, [
    "-Atc",
    String.raw`SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY migration_name, started_at)::text)
      FROM "_prisma_migrations" m
      WHERE migration_name IN ('000060_codex_oauth_setup_serialization','000061_codex_oauth_provider_mutation_fence','000062_codex_oauth_remote_outcome_unknown','000063_codex_oauth_setup_payload_claim')`,
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
}

function collectObservation(url) {
  const history = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_agg(x ORDER BY migration_name) FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS current, applied_steps_count FROM "_prisma_migrations" WHERE migration_name IN ('000060_codex_oauth_setup_serialization','000061_codex_oauth_provider_mutation_fence','000062_codex_oauth_remote_outcome_unknown','000063_codex_oauth_setup_payload_claim')) x`,
    ]).stdout,
  );
  const catalog = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_build_object(
    'triggers',(SELECT json_agg(json_build_object('name',t.tgname,'table',c.relname,'function',p.proname,'type',t.tgtype) ORDER BY t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND (t.tgname LIKE 'CodexOAuth%guard' OR t.tgname='RepositoryConnection_codex_oauth_identity_guard')),
    'checks',(SELECT json_agg(json_build_object('name',conname,'definition',pg_get_constraintdef(oid),'validated',convalidated) ORDER BY conname) FROM pg_constraint WHERE conname LIKE 'CodexOAuth%epoch_check' OR conname IN ('CodexOAuthProviderInstance_mutation_fence_check','CodexOAuthSetupRecoveryRequest_contract_check','CodexOAuthSetupManifest_payload_claim_complete_check','CodexOAuthSetupManifest_recovery_expiry_check')),
    'indexes',(SELECT json_agg(json_build_object('name',ci.relname,'definition',pg_get_indexdef(i.indexrelid),'predicate',pg_get_expr(i.indpred,i.indrelid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE ci.relname LIKE 'CodexOAuth%epoch_idx' OR ci.relname IN ('CodexOAuthSetupManifest_one_active_provider_key','CodexOAuthProviderInstance_mutation_owner_idx','CodexOAuthChildIdentityQuarantine_provider_idx','CodexOAuthSetupRecoveryRequest_provider_request_key','CodexOAuthSetupRecoveryRequest_latestManifestId_key','CodexOAuthSetupRecoveryRequest_provider_state_idx','CodexOAuthSetupRecoveryRequest_one_active_provider_key','CodexOAuthSetupManifest_recovery_expiry_idx')),
    'foreignKeys',(SELECT json_agg(json_build_object('name',conname,'definition',pg_get_constraintdef(oid),'validated',convalidated) ORDER BY conname) FROM pg_constraint WHERE conname IN ('CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey','CodexOAuthSetupRecoveryRequest_latestManifestId_fkey'))
  )`,
    ]).stdout,
  );
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
    migrationSources: [migration60, migration61, migration62, migration63].map(
      (path, index) => ({
        id: [
          migration60Name,
          migration61Name,
          migration62Name,
          migration63Name,
        ][index],
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      }),
    ),
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
