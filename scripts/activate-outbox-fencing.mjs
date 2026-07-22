#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required");

const actorArgument = process.argv.find((argument) =>
  argument.startsWith("--actor="),
);
const actor = actorArgument?.slice("--actor=".length) ?? "unknown-operator";
if (!/^[a-zA-Z0-9_.:@/-]{1,120}$/.test(actor)) {
  fail("--actor contains unsupported characters");
}

if (args.has("--status")) {
  runPsql(`
    SELECT "enabled", "activatedAt", "activatedBy", "updatedAt"
    FROM "OutboxFencingControl"
    WHERE "id" = 1;

    SELECT
      count(*) FILTER (WHERE "status" = 'processing') AS processing_total,
      count(*) FILTER (
        WHERE "status" = 'processing'
          AND ("claimId" IS NULL OR "claimVersion" IS NULL)
      ) AS legacy_processing;
  `);
  process.exit(0);
}

for (const required of [
  "--activate",
  "--confirm-workers-drained",
  "--confirm-waited-max-handler-duration",
]) {
  if (!args.has(required)) fail(`Activation requires ${required}`);
}

const resetLegacy = args.has("--reset-proven-abandoned-legacy-processing");
if (resetLegacy && !args.has("--confirm-legacy-processing-abandoned")) {
  fail("Resetting legacy rows requires --confirm-legacy-processing-abandoned");
}

runPsql(`
  BEGIN;
  SELECT pg_advisory_xact_lock(hashtext('reviewrouter:outbox-fencing-cutover'));

  DO $guard$
  BEGIN
    IF (SELECT "enabled" FROM "OutboxFencingControl" WHERE "id" = 1) THEN
      RAISE EXCEPTION 'outbox_fencing_already_enabled';
    END IF;
  END
  $guard$;

  ${
    resetLegacy
      ? `UPDATE "OutboxEvent"
         SET "status" = 'pending',
             "nextAttemptAt" = NULL,
             "claimId" = NULL,
             "claimVersion" = NULL,
             "claimOwnerHash" = NULL,
             "claimUntil" = NULL,
             "lastErrorCode" = 'legacy_processing_abandoned_at_fencing_cutover',
             "safeLastErrorSummary" = 'Operator-confirmed abandoned legacy processing row reset during outbox fencing cutover.',
             "updatedAt" = statement_timestamp()
         WHERE "status" = 'processing'
           AND ("claimId" IS NULL OR "claimVersion" IS NULL);`
      : ""
  }

  DO $guard$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM "OutboxEvent"
      WHERE "status" = 'processing'
        AND (
          "claimId" IS NULL
          OR "claimVersion" IS NULL
          OR "claimOwnerHash" IS NULL
          OR "claimUntil" IS NULL
        )
    ) THEN
      RAISE EXCEPTION 'outbox_legacy_processing_rows_require_disposition';
    END IF;
  END
  $guard$;

  UPDATE "OutboxFencingControl"
  SET "enabled" = true,
      "activatedAt" = statement_timestamp(),
      "activatedBy" = '${actor}',
      "updatedAt" = statement_timestamp()
  WHERE "id" = 1;

  COMMIT;
`);

console.log(
  "Outbox fencing guard enabled. Rollback to an unfenced worker is now forbidden.",
);

function runPsql(sql) {
  const result = spawnSync(
    "psql",
    [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-c", sql],
    { stdio: "inherit" },
  );
  if (result.error) fail(`Unable to start psql: ${result.error.message}`);
  if (result.status !== 0) fail(`psql exited with ${result.status}`);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
