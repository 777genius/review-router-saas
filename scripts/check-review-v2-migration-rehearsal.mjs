#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import {
  reviewV2ForeignKeyValuesSql,
  reviewV2MigrationDirectories,
  reviewV2MigrationVersion,
  reviewV2RepositoryBackfillStep,
} from "./lib/review-v2-migration-contract.mjs";

if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: false });
}
if (existsSync(".env")) {
  dotenv.config({ path: ".env", override: false });
}

const baseUrlValue = process.env.DATABASE_URL;
if (!baseUrlValue) fail("DATABASE_URL is required");
const baseUrl = new URL(baseUrlValue);
const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const databaseName = `review_router_v2_rehearsal_${suffix}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const databaseUrl = new URL(baseUrl);
databaseUrl.pathname = `/${databaseName}`;
databaseUrl.search = "";
const migrationPaths = reviewV2MigrationDirectories.map((directory) =>
  fileURLToPath(
    new URL(
      `../packages/platform/db/prisma/migrations/${directory}/migration.sql`,
      import.meta.url,
    ),
  ),
);
const schemaDigestHash = createHash("sha256");
for (const migrationPath of migrationPaths) {
  schemaDigestHash.update(readFileSync(migrationPath));
  schemaDigestHash.update("\0");
}
const schemaDigest = schemaDigestHash.digest("hex");
const foreignKeyValuesSql = reviewV2ForeignKeyValuesSql();
const repositoryCount = 2_500;
const totalRepositoryCount = repositoryCount + 2;
const pageSize = 113;
const interruptedPageCount = 3;

let created = false;
try {
  psql(adminUrl, `CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  created = true;
  run("pnpm", ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"], {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
  });
  psql(
    databaseUrl,
    `
      INSERT INTO "Workspace" (id, slug, name, "createdAt", "updatedAt")
      VALUES ('ws-rehearsal', 'ws-rehearsal', 'Rehearsal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO "RepositoryConnection" (
        id, "workspaceId", provider, "sourceBaseUrl", "externalRepositoryId",
        owner, name, "fullName", "defaultBranch", visibility, "setupStatus",
        "createdAt", "updatedAt"
      )
      SELECT
        'repo-' || lpad(series::text, 6, '0'),
        'ws-rehearsal',
        'github',
        CASE WHEN series % 2 = 0 THEN 'HTTPS://GITHUB.COM/' ELSE 'https://github.com' END,
        'rehearsal-' || series,
        'owner',
        'repo-' || series,
        'owner/repo-' || series,
        'main',
        'private',
        'not_configured',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM generate_series(1, ${repositoryCount}) series;

      INSERT INTO "RepositoryConnection" (
        id, "workspaceId", provider, "sourceBaseUrl", "externalRepositoryId",
        owner, name, "fullName", "defaultBranch", visibility, "setupStatus",
        "createdAt", "updatedAt"
      ) VALUES
        (
          'repo-collision-holder', 'ws-rehearsal', 'github', 'https://github.com',
          'collision-holder', 'owner', 'collision-holder', 'owner/collision-holder',
          'main', 'private', 'not_configured', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ),
        (
          'repo-collision-target', 'ws-rehearsal', 'github', 'https://github.com',
          'collision-target', 'owner', 'collision-target', 'owner/collision-target',
          'main', 'private', 'not_configured', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );

      ALTER TABLE "ScmRepositoryIdentity"
        DROP CONSTRAINT "ScmRepositoryIdentity_current_binding_fkey";

      INSERT INTO "ScmRepositoryIdentity" (
        "scmRepositoryIdentityId", provider, "normalizedSourceBaseUrl",
        "externalRepositoryId", version, "currentWorkspaceId",
        "currentRepositoryConnectionId", "createdAt", "boundAt"
      ) VALUES (
        'scm-rehearsal-collision', 'github', 'https://github.com',
        'collision-target', 1, 'ws-rehearsal', 'repo-collision-holder',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      UPDATE "RepositoryConnection"
      SET "scmRepositoryIdentityId" = 'scm-rehearsal-collision'
      WHERE id = 'repo-collision-holder';

      ALTER TABLE "ScmRepositoryIdentity"
        ADD CONSTRAINT "ScmRepositoryIdentity_current_binding_fkey"
        FOREIGN KEY (
          "currentRepositoryConnectionId", "currentWorkspaceId", "scmRepositoryIdentityId"
        ) REFERENCES "RepositoryConnection"("id", "workspaceId", "scmRepositoryIdentityId")
        ON DELETE RESTRICT ON UPDATE CASCADE
        DEFERRABLE INITIALLY DEFERRED NOT VALID;

      CREATE TABLE "UnrelatedMigrationParent" (id TEXT PRIMARY KEY);
      CREATE TABLE "UnrelatedMigrationChild" (id TEXT PRIMARY KEY, "parentId" TEXT NOT NULL);
      INSERT INTO "UnrelatedMigrationChild" (id, "parentId") VALUES ('orphan', 'missing');
      ALTER TABLE "UnrelatedMigrationChild"
        ADD CONSTRAINT "UnrelatedMigrationChild_parentId_fkey"
        FOREIGN KEY ("parentId") REFERENCES "UnrelatedMigrationParent"(id) NOT VALID;
    `,
  );

  psql(databaseUrl, 'DROP INDEX "ReviewExecutionV2_one_planned_per_scope";');
  runExpectFailure(
    "node",
    ["scripts/review-v2-migrate.mjs", "--apply", "--actor=rehearsal-invalid"],
    { ...process.env, DATABASE_URL: databaseUrl.toString() },
  );
  psql(
    databaseUrl,
    `
      CREATE UNIQUE INDEX "ReviewExecutionV2_one_planned_per_scope"
      ON "ReviewExecutionV2" (
        "workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber"
      ) WHERE "state" = 'planned';
    `,
  );

  psql(
    databaseUrl,
    'DROP INDEX "ReviewPublicationOperationV2_state_nextEligibleAt_publicationOperationId_idx";',
  );
  runExpectFailure(
    "node",
    [
      "scripts/review-v2-migrate.mjs",
      "--apply",
      "--actor=rehearsal-worker-safety-index",
    ],
    { ...process.env, DATABASE_URL: databaseUrl.toString() },
  );
  psql(
    databaseUrl,
    `
      CREATE INDEX "ReviewPublicationOperationV2_state_nextEligibleAt_publicationOperationId_idx"
      ON "ReviewPublicationOperationV2"("state", "nextEligibleAt", "publicationOperationId");
    `,
  );

  psql(
    databaseUrl,
    `
      ALTER TABLE "ReviewRunAuthorizationRenewalReceipt"
        DROP CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_authorizationId_fkey";
      ALTER TABLE "ReviewRunAuthorizationRenewalReceipt"
        ADD CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_authorizationId_fkey"
        FOREIGN KEY ("authorizationId") REFERENCES "Workspace"(id)
        ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
    `,
  );
  runExpectFailure(
    "node",
    ["scripts/review-v2-migrate.mjs", "--apply", "--actor=rehearsal-wrong-fk"],
    { ...process.env, DATABASE_URL: databaseUrl.toString() },
  );
  psql(
    databaseUrl,
    `
      ALTER TABLE "ReviewRunAuthorizationRenewalReceipt"
        DROP CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_authorizationId_fkey";
      ALTER TABLE "ReviewRunAuthorizationRenewalReceipt"
        ADD CONSTRAINT "ReviewRunAuthorizationRenewalReceipt_authorizationId_fkey"
        FOREIGN KEY ("authorizationId") REFERENCES "ReviewRunAuthorization"("authorizationId")
        ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
    `,
  );

  runExpectExitCode(
    "node",
    [
      "scripts/review-v2-migrate.mjs",
      "--apply",
      "--actor=rehearsal-interrupted",
      `--backfill-page-size=${pageSize}`,
      `--stop-after-backfill-pages=${interruptedPageCount}`,
    ],
    { ...process.env, DATABASE_URL: databaseUrl.toString() },
    75,
  );

  const interruptedState = psql(
    databaseUrl,
    `
      SELECT concat_ws('|',
        status,
        checkpoint->>'pagesCompleted',
        checkpoint->>'processedCount',
        checkpoint->>'scanComplete',
        CASE WHEN "schemaDigest" = '${schemaDigest}' THEN 'match' ELSE 'mismatch' END,
        CASE WHEN checkpoint->>'lastRepositoryConnectionId' IS NULL THEN 'missing' ELSE 'present' END,
        CASE WHEN checkpoint->>'upperBoundRepositoryConnectionId' IS NULL THEN 'missing' ELSE 'present' END
      )
      FROM "ReviewV2MigrationLedger"
      WHERE "migrationVersion" = '${reviewV2MigrationVersion}'
        AND "stepName" = '${reviewV2RepositoryBackfillStep}';
    `,
    true,
  );
  const expectedInterruptedState = `running|${interruptedPageCount}|${pageSize * interruptedPageCount}|false|match|present|present`;
  if (interruptedState !== expectedInterruptedState) {
    fail(`Unexpected interrupted checkpoint: ${interruptedState}`);
  }

  runExpectFailure(
    "node",
    [
      "scripts/review-v2-migrate.mjs",
      "--apply",
      "--actor=rehearsal-collision",
      `--backfill-page-size=${pageSize}`,
    ],
    { ...process.env, DATABASE_URL: databaseUrl.toString() },
  );

  const collisionState = psql(
    databaseUrl,
    `
      SELECT concat_ws('|',
        ledger.status,
        ledger."lastErrorCode",
        ledger.checkpoint->>'processedCount',
        ledger.checkpoint->>'quarantinedCount',
        (SELECT count(*) FROM "ReviewV2MigrationQuarantine" quarantine
         WHERE quarantine."migrationVersion" = '${reviewV2MigrationVersion}'
           AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
           AND quarantine."resolvedAt" IS NULL)
      )
      FROM "ReviewV2MigrationLedger" ledger
      WHERE ledger."migrationVersion" = '${reviewV2MigrationVersion}'
        AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}';
    `,
    true,
  );
  if (
    collisionState !==
    `failed|repository_identity_collision_quarantined|${totalRepositoryCount - 1}|1|1`
  ) {
    fail(`Unexpected collision checkpoint: ${collisionState}`);
  }

  psql(
    databaseUrl,
    `
      UPDATE "ScmRepositoryIdentity"
      SET "currentWorkspaceId" = NULL,
          "currentRepositoryConnectionId" = NULL,
          version = version + 1,
          "unboundAt" = CURRENT_TIMESTAMP
      WHERE "scmRepositoryIdentityId" = 'scm-rehearsal-collision';

      UPDATE "RepositoryConnection"
      SET "scmRepositoryIdentityId" = NULL
      WHERE id = 'repo-collision-holder';

      UPDATE "ReviewV2MigrationQuarantine"
      SET "resolvedAt" = CURRENT_TIMESTAMP,
          "resolvedBy" = 'rehearsal-repair'
      WHERE "migrationVersion" = '${reviewV2MigrationVersion}'
        AND "stepName" = '${reviewV2RepositoryBackfillStep}'
        AND "repositoryConnectionId" = 'repo-collision-target';
    `,
  );

  for (const actor of ["rehearsal-resume", "rehearsal-idempotent-retry"]) {
    run(
      "node",
      [
        "scripts/review-v2-migrate.mjs",
        "--apply",
        `--actor=${actor}`,
        `--backfill-page-size=${pageSize}`,
      ],
      { ...process.env, DATABASE_URL: databaseUrl.toString() },
    );
  }

  const result = psql(
    databaseUrl,
    `
      WITH expected(
        table_name, constraint_name, source_columns, target_table_name,
        target_columns, on_delete_code, on_update_code, is_deferrable,
        is_initially_deferred
      ) AS (VALUES ${foreignKeyValuesSql})
      SELECT concat_ws('|',
        (SELECT count(*) FROM "RepositoryConnection" WHERE "scmRepositoryIdentityId" IS NOT NULL),
        (SELECT count(*) FROM "ScmRepositoryIdentity" WHERE "currentRepositoryConnectionId" IS NOT NULL),
        (SELECT count(*) FROM "ReviewV2MigrationLedger"
         WHERE "migrationVersion" = '${reviewV2MigrationVersion}' AND status = 'completed'),
        (SELECT count(*)
         FROM expected
         JOIN pg_class source_table ON source_table.relname = expected.table_name
         JOIN pg_namespace source_schema
           ON source_schema.oid = source_table.relnamespace AND source_schema.nspname = 'public'
         JOIN pg_constraint constraint_row
           ON constraint_row.conrelid = source_table.oid
          AND constraint_row.conname = expected.constraint_name
         WHERE NOT constraint_row.convalidated),
        (SELECT count(*) FROM pg_constraint constraint_row
         JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
         WHERE source_table.relname = 'UnrelatedMigrationChild'
           AND constraint_row.conname = 'UnrelatedMigrationChild_parentId_fkey'
           AND NOT constraint_row.convalidated),
        (SELECT count(*) FROM "ReviewV2MigrationQuarantine" WHERE "resolvedAt" IS NULL),
        (SELECT count(*) FROM "ReviewSafetyEmergencyControl" WHERE "policyScope" = 'global' AND stopped = true),
        (SELECT checkpoint->>'processedCount' FROM "ReviewV2MigrationLedger"
         WHERE "migrationVersion" = '${reviewV2MigrationVersion}'
           AND "stepName" = '${reviewV2RepositoryBackfillStep}'),
        (SELECT checkpoint->>'quarantinedCount' FROM "ReviewV2MigrationLedger"
         WHERE "migrationVersion" = '${reviewV2MigrationVersion}'
           AND "stepName" = '${reviewV2RepositoryBackfillStep}')
      )
      FROM expected
      LIMIT 1;
    `,
    true,
  );
  if (
    result !==
    `${totalRepositoryCount}|${totalRepositoryCount}|4|0|1|0|1|${totalRepositoryCount + 1}|1`
  ) {
    fail(`Unexpected rehearsal state: ${result}`);
  }
  console.log(
    `Review v2 migration rehearsal passed for ${totalRepositoryCount} repositories; checkpoint resume, collision quarantine, FK definition validation, and unrelated NOT VALID isolation were verified.`,
  );
} finally {
  if (created) {
    psql(
      adminUrl,
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
  }
}

function psql(url, sql, capture = false) {
  const result = spawnSync(
    "psql",
    [url.toString(), "-v", "ON_ERROR_STOP=1", "-X", "-At", "-c", sql],
    capture
      ? { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
      : { stdio: "inherit" },
  );
  if (result.error) fail(`Unable to start psql: ${result.error.message}`);
  if (result.status !== 0) fail(`psql exited with ${result.status}`);
  return capture ? result.stdout.trim() : "";
}

function run(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) fail(`Unable to start ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with ${result.status}`);
}

function runExpectFailure(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: "ignore" });
  if (result.error) fail(`Unable to start ${command}: ${result.error.message}`);
  if (result.status === 0) fail(`${command} unexpectedly succeeded`);
}

function runExpectExitCode(command, args, env, expectedExitCode) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) fail(`Unable to start ${command}: ${result.error.message}`);
  if (result.status !== expectedExitCode) {
    fail(
      `${command} exited with ${result.status}; expected ${expectedExitCode}`,
    );
  }
}

function quoteIdentifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    fail(`Unsafe database identifier: ${value}`);
  }
  return `"${value}"`;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
