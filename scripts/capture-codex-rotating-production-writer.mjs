#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkoutRoot = resolve(import.meta.dirname, "..");
const migrationFiles = [
  [
    "000060_codex_oauth_setup_serialization",
    "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
  ],
  [
    "000061_codex_oauth_provider_mutation_fence",
    "packages/platform/db/prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
  ],
  [
    "000062_codex_oauth_remote_outcome_unknown",
    "packages/platform/db/prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
  ],
  [
    "000063_codex_oauth_setup_payload_claim",
    "packages/platform/db/prisma/migrations/000063_codex_oauth_setup_payload_claim/migration.sql",
  ],
];

const baseObservationSql = String.raw`
SELECT jsonb_build_object(
  'databaseIdentity', jsonb_build_object(
    'currentDatabase', current_database(),
    'serverAddress', concat(coalesce(inet_server_addr()::text, 'local'), ':', inet_server_port()),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system())
  ),
  'postgresVersion', current_setting('server_version'),
  'databaseCaller', jsonb_build_object(
    'databaseRole', current_user,
    'sessionUser', session_user,
    'applicationName', current_setting('application_name')
  ),
  'unsafeWork', jsonb_build_object(
    'activeLeasesWithoutEpoch', (SELECT count(*)::int FROM "CodexOAuthLease" WHERE status IN ('preleased','finalized') AND "mutationEpoch" IS NULL),
    'activeManifestsWithoutEpoch', (SELECT count(*)::int FROM "CodexOAuthSetupManifest" WHERE status IN ('issued','fetched') AND "mutationEpoch" IS NULL),
    'pendingIntents', (SELECT count(*)::int FROM "CodexOAuthWritebackIntent" WHERE status = 'pending')
  ),
  'fetchedRecoveryOwner', (
    SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance"
    WHERE "mutationOwner" = 'recovery' AND "mutationOwnerId" LIKE 'setup:%'
    ORDER BY id LIMIT 1
  ),
  'history', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'migration_name', migration_name,
      'checksum', checksum,
      'finished', finished_at IS NOT NULL AND rolled_back_at IS NULL,
      'current', rolled_back_at IS NULL,
      'applied_steps_count', applied_steps_count
    ) ORDER BY started_at)
    FROM _prisma_migrations
    WHERE migration_name IN (
      '000060_codex_oauth_setup_serialization',
      '000061_codex_oauth_provider_mutation_fence'
      ,'000062_codex_oauth_remote_outcome_unknown'
      ,'000063_codex_oauth_setup_payload_claim'
    )
  ), '[]'::jsonb),
  'catalog', jsonb_build_object(
    'triggers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', t.tgname,
        'table', c.relname,
        'function', p.proname,
        'type', t.tgtype
      ) ORDER BY t.tgname)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND c.relname IN ('CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent','CodexOAuthSetupRecoveryRequest')
    ), '[]'::jsonb),
    'checks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', con.conname,
        'definition', pg_get_constraintdef(con.oid),
        'validated', con.convalidated
      ) ORDER BY con.conname)
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      WHERE con.contype = 'c'
        AND c.relname IN ('CodexOAuthProviderInstance','CodexOAuthSetupManifest','CodexOAuthLease','CodexOAuthWritebackIntent')
        AND con.conname IN (
          'CodexOAuthProviderInstance_mutation_fence_check',
          'CodexOAuthSetupManifest_epoch_check',
          'CodexOAuthLease_epoch_check',
          'CodexOAuthWritebackIntent_epoch_check'
          ,'CodexOAuthSetupRecoveryRequest_epoch_check'
          ,'CodexOAuthSetupRecoveryRequest_contract_check'
          ,'CodexOAuthSetupManifest_payload_claim_complete_check'
          ,'CodexOAuthSetupManifest_recovery_expiry_check'
        )
    ), '[]'::jsonb),
    'indexes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', index_class.relname,
        'definition', pg_get_indexdef(index_class.oid),
        'predicate', coalesce(pg_get_expr(i.indpred, i.indrelid), ''),
        'unique', i.indisunique,
        'valid', i.indisvalid,
        'ready', i.indisready
      ) ORDER BY index_class.relname)
      FROM pg_index i
      JOIN pg_class index_class ON index_class.oid = i.indexrelid
      WHERE index_class.relname IN (
        'CodexOAuthLease_provider_epoch_idx',
        'CodexOAuthProviderInstance_mutation_owner_idx',
        'CodexOAuthSetupManifest_one_active_provider_key',
        'CodexOAuthSetupManifest_provider_epoch_idx',
        'CodexOAuthWritebackIntent_provider_epoch_idx'
        ,'CodexOAuthSetupRecoveryRequest_provider_request_key'
        ,'CodexOAuthSetupRecoveryRequest_latestManifestId_key'
        ,'CodexOAuthSetupRecoveryRequest_provider_state_idx'
        ,'CodexOAuthSetupRecoveryRequest_one_active_provider_key'
        ,'CodexOAuthSetupManifest_recovery_expiry_idx'
      )
    ), '[]'::jsonb),
    'foreignKeys', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', con.conname,
        'definition', pg_get_constraintdef(con.oid),
        'validated', con.convalidated
      ) ORDER BY con.conname)
      FROM pg_constraint con
      WHERE con.conname IN (
        'CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey',
        'CodexOAuthSetupRecoveryRequest_latestManifestId_fkey'
      )
    ), '[]'::jsonb)
  )
)::text;
`;

const drainObservationSql = String.raw`
SELECT jsonb_build_object(
  'activeLeases', (SELECT count(*)::int FROM "CodexOAuthLease" WHERE status IN ('preleased','finalized')),
  'fetchedSetups', (SELECT count(*)::int FROM "CodexOAuthSetupManifest" WHERE status = 'fetched'),
  'pendingIntents', (SELECT count(*)::int FROM "CodexOAuthWritebackIntent" WHERE status = 'pending'),
  'writerInFlight', (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND classid = 1381126735 AND objid = 1129271119 AND mode = 'ShareLock' AND granted),
  'observedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)::text;
`;

export function assertProductionWriterCaptureConfiguration(env) {
  if (env.REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION !== "1") {
    throw new Error(
      "production writer observation acknowledgement is required",
    );
  }
  const databaseUrl = env.REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("production writer database URL is required");
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("production writer database URL must use PostgreSQL");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(
      "production writer observation cannot use a loopback database",
    );
  }
  const commit = env.REVIEW_ROUTER_RELEASE_COMMIT_SHA;
  const imageDigest = env.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST;
  if (!/^[a-f0-9]{40}$/u.test(commit ?? "")) {
    throw new Error("release commit must be an exact lowercase SHA");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "")) {
    throw new Error("release image must be an exact sha256 digest");
  }
  return { databaseUrl, commit, imageDigest };
}

function queryJson(databaseUrl, sql) {
  try {
    const stdout = execFileSync(
      "psql",
      [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error("production writer observation query failed");
  }
}

export async function captureProductionWriterObservation(
  env,
  {
    query = queryJson,
    sleep = (delayMs) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  } = {},
) {
  const configuration = assertProductionWriterCaptureConfiguration(env);
  const intervalMs = Number(
    env.REVIEW_ROUTER_DRAIN_OBSERVATION_INTERVAL_MS ?? 60_000,
  );
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000) {
    throw new Error("drain observation interval must be at least 15000ms");
  }
  const base = query(configuration.databaseUrl, baseObservationSql);
  if (
    base?.databaseCaller?.applicationName !== "reviewrouter-release-migration"
  ) {
    throw new Error("database caller is not the release-migration session");
  }
  const firstDrain = query(configuration.databaseUrl, drainObservationSql);
  await sleep(intervalMs);
  const secondDrain = query(configuration.databaseUrl, drainObservationSql);
  return {
    observationVersion: 2,
    source: "production-postgresql-writer",
    captureKind: "database-query",
    rehearsal: false,
    databaseIdentity: base.databaseIdentity,
    callerIdentity: {
      id: "release-migration",
      kind: "immutable-release-migration",
      commit: configuration.commit,
      imageDigest: configuration.imageDigest,
      ...base.databaseCaller,
    },
    postgresVersion: base.postgresVersion,
    unsafeWork: base.unsafeWork,
    fetchedRecoveryOwner: base.fetchedRecoveryOwner,
    migrationSources: migrationFiles.map(([id, sourceFile]) => ({
      id,
      sha256: sha256(readFileSync(resolve(checkoutRoot, sourceFile))),
    })),
    history: base.history,
    catalog: base.catalog,
    drainObservations: [firstDrain, secondDrain],
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function main(env = process.env, stdout = process.stdout) {
  const observation = await captureProductionWriterObservation(env);
  stdout.write(`${JSON.stringify(observation)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "production writer observation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
