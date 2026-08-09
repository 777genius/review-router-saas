import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const migrationsDirectory = join(
  root,
  "packages/platform/db/prisma/migrations",
);
const migration60 = join(
  migrationsDirectory,
  "000060_codex_oauth_setup_serialization/migration.sql",
);
const baseUrl = requireLocalPostgres(
  process.env.REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL ??
    process.env.REVIEW_ROUTER_TEST_DATABASE_URL ??
    "",
);
requirePsql();

const databaseName = `rr_codex_setup_${process.pid}_${Date.now()}`;
const adminUrl = databaseUrl(baseUrl, "postgres");
const rehearsalUrl = databaseUrl(baseUrl, databaseName);

try {
  psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(databaseName)}`]);
  for (const directory of readdirSync(migrationsDirectory).sort()) {
    const number = Number.parseInt(directory.slice(0, 6), 10);
    if (!Number.isInteger(number) || number > 59) continue;
    psql(rehearsalUrl, [
      "-f",
      join(migrationsDirectory, directory, "migration.sql"),
    ]);
  }

  seedDirtyFixtures(rehearsalUrl);
  const dirtyStatusBaseline = manifestStatusSnapshot(rehearsalUrl);
  proveInjectedRollback(rehearsalUrl, dirtyStatusBaseline);
  await proveHeldLockTimeout(rehearsalUrl, dirtyStatusBaseline);
  psql(rehearsalUrl, ["-f", migration60]);
  proveSuccessfulCleanup(rehearsalUrl);
  process.stdout.write(
    "Codex rotating migration rehearsal passed (cleanup, atomic rollback, bounded lock failure, and rerun).\n",
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

function seedDirtyFixtures(url) {
  psql(url, [
    "-c",
    String.raw`
      INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt")
      VALUES ('ws-proof', 'ws-proof', 'migration proof', CURRENT_TIMESTAMP);
      INSERT INTO "RepositoryConnection" (
        "id", "workspaceId", "githubRepositoryId", "externalRepositoryId",
        "owner", "name", "fullName", "defaultBranch", "visibility", "updatedAt"
      ) VALUES
        ('repo-proof', 'ws-proof', 900001, '900001', 'local', 'proof', 'local/proof', 'main', 'private', CURRENT_TIMESTAMP);
      INSERT INTO "CodexOAuthProviderInstance" (
        "id", "workspaceId", "repositoryId", "providerInstanceId", "authMode",
        "secretName", "generationHashSalt", "accountFingerprintSalt", "updatedAt"
      ) VALUES
        ('p-expiry', 'ws-proof', 'repo-proof', 'proof:expiry', 'proof-expiry', 'S', 'salt', 'salt', CURRENT_TIMESTAMP),
        ('p-status', 'ws-proof', 'repo-proof', 'proof:status', 'proof-status', 'S', 'salt', 'salt', CURRENT_TIMESTAMP),
        ('p-created', 'ws-proof', 'repo-proof', 'proof:created', 'proof-created', 'S', 'salt', 'salt', CURRENT_TIMESTAMP),
        ('p-id', 'ws-proof', 'repo-proof', 'proof:id', 'proof-id', 'S', 'salt', 'salt', CURRENT_TIMESTAMP),
        ('p-history', 'ws-proof', 'repo-proof', 'proof:history', 'proof-history', 'S', 'salt', 'salt', CURRENT_TIMESTAMP);
      INSERT INTO "CodexOAuthSetupManifest" (
        "id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId",
        "setupNonce", "manifestJson", "status", "expiresAt", "createdAt", "consumedAt"
      ) VALUES
        ('expiry-issued', 'ws-proof', 'repo-proof', 'p-expiry', 'proof:expiry', 'nonce-expiry-issued', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-01 00:00:00', NULL),
        ('expiry-fetched-expired', 'ws-proof', 'repo-proof', 'p-expiry', 'proof:expiry', 'nonce-expiry-fetched', '{}', 'fetched', CURRENT_TIMESTAMP - interval '1 second', '2026-01-02 00:00:00', NULL),
        ('status-issued-newer', 'ws-proof', 'repo-proof', 'p-status', 'proof:status', 'nonce-status-issued', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-03 00:00:00', NULL),
        ('status-fetched-older', 'ws-proof', 'repo-proof', 'p-status', 'proof:status', 'nonce-status-fetched', '{}', 'fetched', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-01 00:00:00', NULL),
        ('created-old', 'ws-proof', 'repo-proof', 'p-created', 'proof:created', 'nonce-created-old', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-01 00:00:00', NULL),
        ('created-new', 'ws-proof', 'repo-proof', 'p-created', 'proof:created', 'nonce-created-new', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-02 00:00:00', NULL),
        ('id-a', 'ws-proof', 'repo-proof', 'p-id', 'proof:id', 'nonce-id-a', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-01 00:00:00', NULL),
        ('id-z', 'ws-proof', 'repo-proof', 'p-id', 'proof:id', 'nonce-id-z', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour', '2026-01-01 00:00:00', NULL),
        ('history-a', 'ws-proof', 'repo-proof', 'p-history', 'proof:history', 'nonce-history-a', '{}', 'consumed', CURRENT_TIMESTAMP - interval '1 day', '2025-01-01 00:00:00', '2025-01-01 00:01:00'),
        ('history-b', 'ws-proof', 'repo-proof', 'p-history', 'proof:history', 'nonce-history-b', '{}', 'consumed', CURRENT_TIMESTAMP - interval '1 day', '2025-01-02 00:00:00', '2025-01-02 00:01:00'),
        ('history-expired', 'ws-proof', 'repo-proof', 'p-history', 'proof:history', 'nonce-history-expired', '{}', 'expired', CURRENT_TIMESTAMP - interval '1 day', '2025-01-03 00:00:00', NULL);
    `,
  ]);
}

function proveInjectedRollback(url, dirtyStatusBaseline) {
  psql(url, [
    "-c",
    'CREATE INDEX "CodexOAuthSetupManifest_one_active_provider_key" ON "CodexOAuthSetupManifest"("id")',
  ]);
  const failed = psql(url, ["-f", migration60], false);
  assert(failed.status !== 0, "decoy target index must make exact 000060 fail");
  assert(
    `${failed.stderr}`.includes("already exists"),
    "injected failure must occur at target index creation",
  );
  assert(
    manifestStatusSnapshot(url) === dirtyStatusBaseline,
    "manifest statuses drifted after injected rollback",
  );
  psql(url, [
    "-c",
    String.raw`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'CodexOAuthSetupManifest'
            AND column_name = 'confirmationJson'
        ) THEN RAISE EXCEPTION 'confirmationJson leaked from failed transaction'; END IF;
        IF (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'expiry-fetched-expired') <> 'fetched'
          OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'status-issued-newer') <> 'issued'
        THEN RAISE EXCEPTION 'status cleanup leaked from failed transaction'; END IF;
        IF (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
              AND indexname = 'CodexOAuthSetupManifest_one_active_provider_key')
             LIKE '%WHERE%'
        THEN RAISE EXCEPTION 'partial target index leaked from failed transaction'; END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM pg_index AS index_row
          JOIN pg_class AS index_relation
            ON index_relation.oid = index_row.indexrelid
          JOIN pg_attribute AS indexed_attribute
            ON indexed_attribute.attrelid = index_row.indrelid
           AND indexed_attribute.attnum = index_row.indkey[0]
          WHERE index_relation.relname = 'CodexOAuthSetupManifest_one_active_provider_key'
            AND NOT index_row.indisunique
            AND index_row.indnkeyatts = 1
            AND index_row.indpred IS NULL
            AND indexed_attribute.attname = 'id'
        )
        THEN RAISE EXCEPTION 'decoy index was replaced or mutated'; END IF;
      END $$;
      DROP INDEX "CodexOAuthSetupManifest_one_active_provider_key";
    `,
  ]);
}

async function proveHeldLockTimeout(url, dirtyStatusBaseline) {
  const holderApplicationName = `rr_codex_lock_holder_${process.pid}`;
  const holder = spawn(
    "psql",
    [
      url,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      'BEGIN; LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS SHARE MODE; SELECT pg_sleep(40);',
    ],
    {
      stdio: "ignore",
      env: { ...process.env, PGAPPNAME: holderApplicationName },
    },
  );
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      const lockCount = psql(url, [
        "-Atc",
        String.raw`SELECT count(*) FROM pg_locks WHERE relation = '"CodexOAuthSetupManifest"'::regclass AND mode = 'AccessShareLock' AND granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name = ${quoteLiteral(holderApplicationName)})`,
      ]).stdout.trim();
      if (Number(lockCount) > 0) break;
      if (Date.now() >= deadline)
        throw new Error("held-lock fixture did not become ready");
      await delay(25);
    }
    const startedAt = Date.now();
    const failed = psql(url, ["-f", migration60], false);
    const elapsedMs = Date.now() - startedAt;
    assert(failed.status !== 0, "held lock must reject exact 000060");
    assert(
      `${failed.stderr}`.includes("lock timeout"),
      "held lock must fail with lock timeout",
    );
    assert(
      elapsedMs >= 14_000 && elapsedMs < 25_000,
      `lock failure was not bounded near 15s (${elapsedMs}ms)`,
    );
    psql(url, [
      "-c",
      String.raw`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CodexOAuthSetupManifest' AND column_name = 'confirmationJson')
        THEN RAISE EXCEPTION 'held-lock failure mutated schema'; END IF;
        IF to_regclass('public."CodexOAuthSetupManifest_one_active_provider_key"') IS NOT NULL
        THEN RAISE EXCEPTION 'held-lock failure leaked target index'; END IF;
      END $$`,
    ]);
    assert(
      manifestStatusSnapshot(url) === dirtyStatusBaseline,
      "manifest statuses drifted after held-lock failure",
    );
  } finally {
    await terminateChild(holder);
    psql(
      url,
      [
        "-Atc",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${quoteLiteral(holderApplicationName)}`,
      ],
      false,
    );
    const cleanupDeadline = Date.now() + 2_000;
    while (true) {
      const remaining = Number(
        psql(url, [
          "-Atc",
          `SELECT count(*) FROM pg_stat_activity WHERE application_name = ${quoteLiteral(holderApplicationName)}`,
        ]).stdout.trim(),
      );
      if (remaining === 0) break;
      if (Date.now() >= cleanupDeadline) {
        throw new Error("held-lock database backend did not terminate");
      }
      await delay(25);
    }
  }
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const gracefulExit = waitForChildExit(child, 2_000);
  child.kill("SIGTERM");
  if (await gracefulExit) return;

  const forcedExit = waitForChildExit(child, 2_000);
  child.kill("SIGKILL");
  assert(await forcedExit, "held-lock fixture did not terminate");
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function proveSuccessfulCleanup(url) {
  psql(url, [
    "-c",
    String.raw`
      DO $$ DECLARE
        definition text;
        predicate text;
        is_unique boolean;
        is_valid boolean;
        is_ready boolean;
        key_name text;
      BEGIN
        IF (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'expiry-fetched-expired') <> 'expired'
          OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'expiry-issued') <> 'issued'
        THEN RAISE EXCEPTION 'expiry was not applied before ranking'; END IF;
        IF (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'status-fetched-older') <> 'fetched'
          OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'status-issued-newer') <> 'superseded'
        THEN RAISE EXCEPTION 'fetched did not outrank issued'; END IF;
        IF (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'created-new') <> 'issued'
          OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'created-old') <> 'superseded'
          OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'id-z') <> 'issued'
          OR (SELECT "status" FROM "CodexOAuthSetupManifest" WHERE "id" = 'id-a') <> 'superseded'
        THEN RAISE EXCEPTION 'createdAt/id winner is not deterministic'; END IF;
        IF EXISTS (
          SELECT 1 FROM "CodexOAuthSetupManifest" WHERE "status" IN ('issued', 'fetched')
          GROUP BY "providerInstanceRowId" HAVING count(*) <> 1
        ) THEN RAISE EXCEPTION 'provider has other than one active row'; END IF;
        IF (SELECT count(*) FROM "CodexOAuthSetupManifest" WHERE "status" IN ('issued', 'fetched')) <> 4
        THEN RAISE EXCEPTION 'expected exactly four deterministic active winners'; END IF;
        SELECT
          pg_get_indexdef(index_row.indexrelid),
          pg_get_expr(index_row.indpred, index_row.indrelid),
          index_row.indisunique,
          index_row.indisvalid,
          index_row.indisready,
          indexed_attribute.attname
          INTO definition, predicate, is_unique, is_valid, is_ready, key_name
          FROM pg_index AS index_row
          JOIN pg_attribute AS indexed_attribute
            ON indexed_attribute.attrelid = index_row.indrelid
           AND indexed_attribute.attnum = index_row.indkey[0]
          WHERE index_row.indexrelid = '"CodexOAuthSetupManifest_one_active_provider_key"'::regclass
            AND index_row.indnkeyatts = 1;
        IF definition IS NULL
          OR NOT is_unique
          OR NOT is_valid
          OR NOT is_ready
          OR key_name <> 'providerInstanceRowId'
          OR predicate NOT LIKE '%status%'
          OR predicate NOT LIKE '%''issued''%'
          OR predicate NOT LIKE '%''fetched''%'
          OR predicate LIKE '%''consumed''%'
        THEN RAISE EXCEPTION 'partial unique index definition/predicate is invalid: % / %', definition, predicate; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name = 'CodexOAuthSetupManifest' AND column_name = 'confirmationJson'
            AND data_type = 'jsonb' AND is_nullable = 'YES'
        ) THEN RAISE EXCEPTION 'confirmationJson shape is invalid'; END IF;
      END $$;
      UPDATE "CodexOAuthSetupManifest"
      SET "confirmationJson" = '{
        "protocolVersion": 1,
        "repositoryId": "900001",
        "providerInstanceId": "proof:history",
        "setupNonce": "nonce-history-a",
        "secretName": "REVIEWROUTER_CODEX_AUTH_JSON",
        "generationHash": "ggggggggggggggggggggggggggggggggggggggggggg",
        "accountFingerprint": "fffffffffffffffffffffffffffffffffffffffffff",
        "authByteSizeBucket": "0-4KiB",
        "installerVersion": "migration-proof"
      }'::jsonb
      WHERE "id" = 'history-a';
      INSERT INTO "CodexOAuthSetupManifest" (
        "id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId",
        "setupNonce", "manifestJson", "status", "expiresAt", "consumedAt"
      ) VALUES (
        'history-c', 'ws-proof', 'repo-proof', 'p-history', 'proof:history',
        'nonce-history-c', '{}', 'consumed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      DO $$ BEGIN
        IF (SELECT "confirmationJson" FROM "CodexOAuthSetupManifest" WHERE "id" = 'history-a')
          <> '{
            "protocolVersion": 1,
            "repositoryId": "900001",
            "providerInstanceId": "proof:history",
            "setupNonce": "nonce-history-a",
            "secretName": "REVIEWROUTER_CODEX_AUTH_JSON",
            "generationHash": "ggggggggggggggggggggggggggggggggggggggggggg",
            "accountFingerprint": "fffffffffffffffffffffffffffffffffffffffffff",
            "authByteSizeBucket": "0-4KiB",
            "installerVersion": "migration-proof"
          }'::jsonb
        THEN RAISE EXCEPTION 'confirmationJson did not preserve JSON shape'; END IF;
        IF (SELECT count(*) FROM "CodexOAuthSetupManifest" WHERE "providerInstanceRowId" = 'p-history' AND "status" = 'consumed') <> 3
        THEN RAISE EXCEPTION 'consumed history was not preserved'; END IF;
      END $$;
    `,
  ]);
  const uniqueViolation = psql(
    url,
    [
      "-v",
      "VERBOSITY=verbose",
      "-c",
      String.raw`INSERT INTO "CodexOAuthSetupManifest" ("id", "workspaceId", "repositoryId", "providerInstanceRowId", "providerInstanceId", "setupNonce", "manifestJson", "status", "expiresAt") VALUES ('duplicate-active', 'ws-proof', 'repo-proof', 'p-status', 'proof:status', 'nonce-duplicate-active', '{}', 'issued', CURRENT_TIMESTAMP + interval '1 hour')`,
    ],
    false,
  );
  assert(uniqueViolation.status !== 0, "duplicate active insert must fail");
  assert(
    `${uniqueViolation.stderr}`.includes("23505"),
    "duplicate active insert must report SQLSTATE 23505",
  );
}

function requireLocalPostgres(value) {
  if (!value)
    throw new Error(
      "set REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL to a disposable local PostgreSQL server",
    );
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("migration rehearsal requires PostgreSQL");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host))
    throw new Error("migration rehearsal only accepts loopback PostgreSQL");
  return url;
}

function manifestStatusSnapshot(url) {
  return psql(url, [
    "-Atc",
    String.raw`SELECT jsonb_object_agg("id", "status" ORDER BY "id")::text FROM "CodexOAuthSetupManifest"`,
  ]).stdout.trim();
}

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.search = "";
  return url.toString();
}

function requirePsql() {
  if (spawnSync("psql", ["--version"], { stdio: "ignore" }).status !== 0)
    throw new Error("psql is required");
}

function psql(url, args, requireSuccess = true) {
  const result = spawnSync(
    "psql",
    [url, "-X", "-v", "ON_ERROR_STOP=1", ...args],
    { encoding: "utf8" },
  );
  if (requireSuccess && result.status !== 0) {
    throw new Error(
      `psql failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
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
