#!/usr/bin/env node
import pg from "pg";

const args = new Set(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required");

const operationCount = [
  "--status",
  "--activate",
  "--close-for-rollback",
  "--verify-rollback-ready",
].filter((operation) => args.has(operation)).length;
if (operationCount !== 1) {
  fail(
    "Choose exactly one of --status, --activate, --close-for-rollback, or --verify-rollback-ready",
  );
}
if (args.has("--activate") && !args.has("--confirm-old-replicas-drained")) {
  fail("Activation requires --confirm-old-replicas-drained");
}
if (
  args.has("--close-for-rollback") &&
  !args.has("--confirm-no-old-replica-started")
) {
  fail("Closing requires --confirm-no-old-replica-started");
}

const client = new pg.Client({ connectionString: databaseUrl });
const legacyProviderVoteIndexName =
  "ReviewInvocationLeaseV2_one_active_provider_vote_lane";
const legacyProviderVoteIndexDefinition =
  'CREATE UNIQUE INDEX "ReviewInvocationLeaseV2_one_active_provider_vote_lane" ON public."ReviewInvocationLeaseV2" USING btree ("providerVoteIdentityHash") WHERE ((state = \'active\'::"ReviewInvocationLeaseStateV2") AND (purpose = \'provider_execution\'::"ReviewInvocationLeasePurposeV2"))';
await client.connect();
try {
  if (args.has("--status")) {
    await printStatus();
  } else if (args.has("--activate")) {
    await withSessionFleetFence(async () => {
      await client.query(`
        DROP INDEX CONCURRENTLY IF EXISTS "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
      `);
      await inTransaction(async () => {
        await client.query(`
          UPDATE "ReviewProviderScopeConcurrencyControl"
          SET "activated" = true, "updatedAt" = statement_timestamp()
          WHERE "singleton" = true
        `);
      });
    });
    console.log("Scoped provider concurrency activated after old-fleet drain.");
  } else if (args.has("--close-for-rollback")) {
    await withFleetFence(async () => {
      await client.query(`
        UPDATE "ReviewProviderScopeConcurrencyControl"
        SET "activated" = false, "updatedAt" = statement_timestamp()
        WHERE "singleton" = true
      `);
    });
    console.log(
      "Scoped provider concurrency is closed. Drain duplicate active vote lanes and run --verify-rollback-ready before starting any old replica.",
    );
    await printStatus();
  } else {
    await withSessionFleetFence(async () => {
      await inTransaction(async () => {
        const control = await client.query(`
          SELECT "activated"
          FROM "ReviewProviderScopeConcurrencyControl"
          WHERE "singleton" = true
          FOR UPDATE
        `);
        if (control.rows[0]?.activated !== false) {
          throw new Error("provider_scope_concurrency_must_be_closed");
        }
        const duplicates = await duplicateVoteLaneCount();
        if (duplicates !== 0) {
          throw new Error(
            `provider_scope_concurrency_rollback_requires_drain:${duplicates}`,
          );
        }
      });
      await repairLegacyProviderVoteIndex();
    });
    console.log(
      "Rollback fence is closed and old-binary global reads are safe.",
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.end();
}

async function withFleetFence(operation) {
  return withSessionFleetFence(() => inTransaction(operation));
}

async function withSessionFleetFence(operation) {
  await client.query("SELECT pg_advisory_lock(1381126735, 1381192279)");
  try {
    return await operation();
  } finally {
    await client.query("SELECT pg_advisory_unlock(1381126735, 1381192279)");
  }
}

async function inTransaction(operation) {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function duplicateVoteLaneCount() {
  const result = await client.query(`
    SELECT count(*)::integer AS count
    FROM (
      SELECT "providerVoteIdentityHash"
      FROM "ReviewInvocationLeaseV2"
      WHERE "purpose" = 'provider_execution' AND "state" = 'active'
      GROUP BY "providerVoteIdentityHash"
      HAVING count(*) > 1
    ) duplicate
  `);
  return result.rows[0]?.count ?? 0;
}

async function readLegacyProviderVoteIndex() {
  const result = await client.query(
    `
      SELECT
        index_catalog.indisvalid,
        index_catalog.indisready,
        index_catalog.indisunique,
        pg_get_indexdef(index_catalog.indexrelid) AS definition
      FROM pg_catalog.pg_index index_catalog
      JOIN pg_catalog.pg_class index_relation
        ON index_relation.oid = index_catalog.indexrelid
      JOIN pg_catalog.pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_catalog.pg_class table_relation
        ON table_relation.oid = index_catalog.indrelid
      JOIN pg_catalog.pg_namespace table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      WHERE index_namespace.nspname = 'public'
        AND index_relation.relname = $1
        AND table_namespace.nspname = 'public'
        AND table_relation.relname = 'ReviewInvocationLeaseV2'
    `,
    [legacyProviderVoteIndexName],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) {
    throw new Error("provider_scope_concurrency_legacy_index_ambiguous");
  }
  return result.rows[0];
}

function isExactLegacyProviderVoteIndex(index) {
  return (
    index !== null &&
    index.indisvalid === true &&
    index.indisready === true &&
    index.indisunique === true &&
    index.definition === legacyProviderVoteIndexDefinition
  );
}

async function repairLegacyProviderVoteIndex() {
  const before = await readLegacyProviderVoteIndex();
  if (isExactLegacyProviderVoteIndex(before)) return;
  if (before !== null) {
    await client.query(`
      DROP INDEX CONCURRENTLY "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
    `);
  }
  await client.query(`
    CREATE UNIQUE INDEX CONCURRENTLY "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
    ON "ReviewInvocationLeaseV2" ("providerVoteIdentityHash")
    WHERE "state" = 'active' AND "purpose" = 'provider_execution'
  `);
  const repaired = await readLegacyProviderVoteIndex();
  if (!isExactLegacyProviderVoteIndex(repaired)) {
    throw new Error("provider_scope_concurrency_legacy_index_repair_failed");
  }
}

async function printStatus() {
  const control = await client.query(`
    SELECT "activated", "updatedAt"
    FROM "ReviewProviderScopeConcurrencyControl"
    WHERE "singleton" = true
  `);
  console.log(
    JSON.stringify({
      ...control.rows[0],
      duplicateActiveVoteLanes: await duplicateVoteLaneCount(),
      legacyProviderVoteIndex: await readLegacyProviderVoteIndex(),
    }),
  );
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
