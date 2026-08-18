#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  reviewV2ForeignKeyValuesSql,
  reviewV2ExpandGuardStep,
  reviewV2MigrationDirectories,
  reviewV2MigrationVersion,
  reviewV2LegacyAuthorityFenceBackfillStep,
  reviewV2ReadyDisabledStep,
  reviewV2RepositoryBackfillDefaultPageSize,
  reviewV2RepositoryBackfillMaximumPageSize,
  reviewV2RepositoryBackfillStep,
  reviewV2ValidateConstraintsStep,
} from "./lib/review-v2-migration-contract.mjs";
import { psqlConnectionUrl } from "./lib/psql-connection-url.mjs";
import { runSecretSafePostgresCommand } from "./lib/secret-safe-command-boundary.mjs";

const databaseUrl = process.env.REVIEW_ROUTER_DATABASE_URL_FILE
  ? readFileSync(process.env.REVIEW_ROUTER_DATABASE_URL_FILE, "utf8").trim()
  : process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required");
const psqlDatabaseUrl = normalizePsqlConnectionUrl(databaseUrl);

const args = new Set(process.argv.slice(2));
const migrationVersion = reviewV2MigrationVersion;
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

if (args.has("--status")) {
  runPsql(`
    SELECT "migrationVersion", "stepName", "status", "schemaDigest",
           "startedAt", "updatedAt", "completedAt", "lastErrorCode"
    FROM "ReviewV2MigrationLedger"
    WHERE "migrationVersion" = '${migrationVersion}'
    ORDER BY "stepName";

    SELECT count(*) AS unresolved_quarantine
    FROM "ReviewV2MigrationQuarantine"
    WHERE "migrationVersion" = '${migrationVersion}'
      AND "resolvedAt" IS NULL;

    WITH expected(
      table_name, constraint_name, source_columns, target_table_name,
      target_columns, on_delete_code, on_update_code, is_deferrable,
      is_initially_deferred
    ) AS (VALUES ${foreignKeyValuesSql})
    SELECT count(*) AS review_v2_unvalidated_foreign_keys
    FROM expected e
    JOIN pg_class source_table ON source_table.relname = e.table_name
    JOIN pg_namespace source_schema
      ON source_schema.oid = source_table.relnamespace
     AND source_schema.nspname = 'public'
    JOIN pg_constraint constraint_row
      ON constraint_row.conrelid = source_table.oid
     AND constraint_row.conname = e.constraint_name
    WHERE NOT constraint_row.convalidated;

    WITH expected(
      table_name, constraint_name, source_columns, target_table_name,
      target_columns, on_delete_code, on_update_code, is_deferrable,
      is_initially_deferred
    ) AS (VALUES ${foreignKeyValuesSql})
    SELECT count(*) AS unrelated_unvalidated_foreign_keys
    FROM pg_constraint constraint_row
    JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
    WHERE source_schema.nspname = 'public'
      AND constraint_row.contype = 'f'
      AND NOT constraint_row.convalidated
      AND NOT EXISTS (
        SELECT 1
        FROM expected e
        WHERE e.table_name = source_table.relname
          AND e.constraint_name = constraint_row.conname
      );

    SELECT "stopped", "reason", "updatedAt"
    FROM "ReviewSafetyEmergencyControl"
    WHERE "emergencyControlId" = 'global-review-v2';
  `);
  process.exit(0);
}

if (!args.has("--apply")) fail("Use --status or --apply");

const actorArgument = process.argv.find((argument) =>
  argument.startsWith("--actor="),
);
const actor = actorArgument?.slice("--actor=".length) ?? "unknown-operator";
if (!/^[a-zA-Z0-9_.:@/-]{1,120}$/.test(actor)) {
  fail("--actor contains unsupported characters");
}
const backfillPageSize = integerArgument(
  "--backfill-page-size=",
  reviewV2RepositoryBackfillDefaultPageSize,
  1,
  reviewV2RepositoryBackfillMaximumPageSize,
);
const stopAfterBackfillPages = optionalIntegerArgument(
  "--stop-after-backfill-pages=",
  1,
  1_000_000,
);

runStep(
  reviewV2ExpandGuardStep,
  `
    ${initialEmergencyStopGuardSql(
      reviewV2ExpandGuardStep,
      "review_v2_global_emergency_stop_required",
    )}

    DO $guard$
    BEGIN
      IF to_regclass('public."ReviewExecutionV2"') IS NULL
         OR to_regclass('public."ReviewPublicationAttemptV2"') IS NULL
         OR to_regclass('public."ReviewCompletionProcess"') IS NULL THEN
        RAISE EXCEPTION 'review_v2_expand_schema_missing';
      END IF;
      IF (
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'ReviewExecutionV2_one_planned_per_scope',
          'ReviewInvocationLeaseV2_one_active_provider_invocation',
          'ReviewInvocationLeaseV2_one_active_work_slot',
          'ReviewPublicationClaimTermV2_one_active_claim',
          'ReviewPublicationExternalEffectV2_owned_object_unique'
        )
      ) <> 5 THEN
        RAISE EXCEPTION 'review_v2_required_partial_index_missing';
      END IF;
    END
    $guard$;

    ${foreignKeyDefinitionGuardSql()}
    ${preparedManifestSchemaGuardSql()}
    ${publicationWorkerSafetySchemaGuardSql()}
    ${releaseArtifactSchemaGuardSql()}
  `,
);

runRepositoryIdentityBackfill();

runStep(
  reviewV2LegacyAuthorityFenceBackfillStep,
  `
    INSERT INTO "ReviewMutationAuthority" (
      "scmRepositoryIdentityId", "laneKind", "version", "epoch", "mode",
      "initializedAt"
    )
    SELECT
      identity."scmRepositoryIdentityId",
      'hosted_reviewrouter_app'::"ReviewMutationLaneKindV2",
      1,
      0,
      'v1_open'::"ReviewMutationModeV2",
      statement_timestamp()
    FROM "ScmRepositoryIdentity" identity
    WHERE identity."currentRepositoryConnectionId" IS NOT NULL
      AND identity."currentWorkspaceId" IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "ReviewV2MigrationLedger" ledger
        WHERE ledger."migrationVersion" = '${migrationVersion}'
          AND ledger."stepName" =
                '${reviewV2LegacyAuthorityFenceBackfillStep}'
          AND ledger."status" = 'running'
      )
    ON CONFLICT ("scmRepositoryIdentityId", "laneKind") DO NOTHING;

    DO $guard$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM "ReviewV2MigrationLedger" ledger
        WHERE ledger."migrationVersion" = '${migrationVersion}'
          AND ledger."stepName" =
                '${reviewV2LegacyAuthorityFenceBackfillStep}'
          AND ledger."status" = 'running'
      ) AND EXISTS (
        SELECT 1
        FROM "ScmRepositoryIdentity" identity
        WHERE identity."currentRepositoryConnectionId" IS NOT NULL
          AND identity."currentWorkspaceId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "ReviewMutationAuthority" authority
            WHERE authority."scmRepositoryIdentityId" =
                    identity."scmRepositoryIdentityId"
              AND authority."laneKind" =
                    'hosted_reviewrouter_app'::"ReviewMutationLaneKindV2"
          )
      ) THEN
        RAISE EXCEPTION 'review_v2_legacy_authority_fence_backfill_incomplete';
      END IF;
    END
    $guard$;
  `,
);

runStep(
  reviewV2ValidateConstraintsStep,
  `
    ${foreignKeyDefinitionGuardSql()}
    ${foreignKeyValidationSql()}
  `,
);

runStep(
  reviewV2ReadyDisabledStep,
  `
    ${initialEmergencyStopGuardSql(
      reviewV2ReadyDisabledStep,
      "review_v2_must_remain_disabled_after_migration",
    )}
  `,
);

console.log(
  `Review v2 migration ${migrationVersion} applied or verified by ${actor}; the current emergency-control state was preserved.`,
);

function runRepositoryIdentityBackfill() {
  let pagesThisRun = 0;
  while (true) {
    const page = parseJsonResult(
      queryScalar(repositoryIdentityBackfillPageSql()),
      "repository_identity_backfill_page_result_invalid",
    );
    const processedThisPage = Number(page.processedThisPage ?? 0);
    if (processedThisPage > 0) {
      pagesThisRun += 1;
      console.log(
        `Review v2 repository identity backfill page ${page.pagesCompleted}: ${processedThisPage} scanned, ${page.boundThisPage} bound, ${page.quarantinedThisPage} quarantined.`,
      );
      if (
        stopAfterBackfillPages !== null &&
        pagesThisRun >= stopAfterBackfillPages
      ) {
        console.error(
          `Review v2 repository identity backfill stopped after ${pagesThisRun} committed pages; rerun the same command to resume.`,
        );
        process.exit(75);
      }
    }
    if (page.status === "completed") return;
    if (page.scanComplete !== true) continue;

    const finish = parseJsonResult(
      queryScalar(finishRepositoryIdentityBackfillSql()),
      "repository_identity_backfill_finish_result_invalid",
    );
    if (finish.status === "completed") return;
    if (finish.status === "failed") {
      fail(
        "Repository identity backfill has unresolved collisions; repair and resolve the quarantine before rerunning",
      );
    }
  }
}

function repositoryIdentityBackfillPageSql() {
  return `
    BEGIN;
    DO $ledger_guard$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('reviewrouter:review-v2-migrate', 0));
      IF EXISTS (
        SELECT 1 FROM "ReviewV2MigrationLedger"
        WHERE "migrationVersion" = '${migrationVersion}'
          AND "stepName" = '${reviewV2RepositoryBackfillStep}'
          AND "schemaDigest" <> '${schemaDigest}'
      ) THEN
        RAISE EXCEPTION 'review_v2_migration_schema_digest_mismatch';
      END IF;
    END
    $ledger_guard$;

    INSERT INTO "ReviewV2MigrationLedger" (
      "migrationVersion", "stepName", "status", "schemaDigest",
      "checkpoint", "startedAt", "updatedAt", "completedAt", "lastErrorCode"
    ) VALUES (
      '${migrationVersion}', '${reviewV2RepositoryBackfillStep}', 'running',
      '${schemaDigest}',
      jsonb_build_object(
        'actor', '${actor}',
        'pageSize', ${backfillPageSize},
        'pass', 1,
        'lastRepositoryConnectionId', NULL,
        'upperBoundRepositoryConnectionId', NULL,
        'pagesCompleted', 0,
        'processedCount', 0,
        'boundCount', 0,
        'quarantinedCount', 0,
        'lastPageProcessed', 0,
        'lastPageBound', 0,
        'lastPageQuarantined', 0,
        'scanComplete', FALSE
      ),
      statement_timestamp(), statement_timestamp(), NULL, NULL
    )
    ON CONFLICT ("migrationVersion", "stepName") DO NOTHING;

    UPDATE "ReviewV2MigrationLedger"
    SET "status" = 'running',
        "checkpoint" = COALESCE("checkpoint", '{}'::jsonb) || jsonb_build_object(
          'actor', '${actor}',
          'pageSize', ${backfillPageSize},
          'lastPageProcessed', 0,
          'lastPageBound', 0,
          'lastPageQuarantined', 0
        ),
        "updatedAt" = statement_timestamp(),
        "completedAt" = NULL,
        "lastErrorCode" = NULL
    WHERE "migrationVersion" = '${migrationVersion}'
      AND "stepName" = '${reviewV2RepositoryBackfillStep}'
      AND "status" <> 'completed';

    UPDATE "ReviewV2MigrationLedger" ledger
    SET "status" = 'running',
        "checkpoint" = jsonb_build_object(
          'actor', '${actor}',
          'pageSize', ${backfillPageSize},
          'pass', COALESCE((ledger."checkpoint"->>'pass')::integer, 0) + 1,
          'lastRepositoryConnectionId', NULL,
          'upperBoundRepositoryConnectionId', (
            SELECT max(repository."id")
            FROM "RepositoryConnection" repository
            WHERE repository."scmRepositoryIdentityId" IS NULL
          ),
          'pagesCompleted', COALESCE((ledger."checkpoint"->>'pagesCompleted')::bigint, 0),
          'processedCount', COALESCE((ledger."checkpoint"->>'processedCount')::bigint, 0),
          'boundCount', COALESCE((ledger."checkpoint"->>'boundCount')::bigint, 0),
          'quarantinedCount', COALESCE((ledger."checkpoint"->>'quarantinedCount')::bigint, 0),
          'lastPageProcessed', 0,
          'lastPageBound', 0,
          'lastPageQuarantined', 0,
          'scanComplete', FALSE
        ),
        "updatedAt" = statement_timestamp(),
        "completedAt" = NULL,
        "lastErrorCode" = NULL
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND ledger."status" = 'completed'
      AND EXISTS (
        SELECT 1 FROM "RepositoryConnection" repository
        WHERE repository."scmRepositoryIdentityId" IS NULL
      );

    UPDATE "ReviewV2MigrationLedger" ledger
    SET "checkpoint" = ledger."checkpoint" || jsonb_build_object(
          'pass', COALESCE((ledger."checkpoint"->>'pass')::integer, 0) + 1,
          'lastRepositoryConnectionId', NULL,
          'upperBoundRepositoryConnectionId', (
            SELECT max(repository."id")
            FROM "RepositoryConnection" repository
            WHERE repository."scmRepositoryIdentityId" IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "ReviewV2MigrationQuarantine" quarantine
                WHERE quarantine."migrationVersion" = '${migrationVersion}'
                  AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
                  AND quarantine."repositoryConnectionId" = repository."id"
                  AND quarantine."resolvedAt" IS NULL
              )
          ),
          'scanComplete', FALSE
        ),
        "updatedAt" = statement_timestamp()
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND ledger."status" = 'running'
      AND COALESCE((ledger."checkpoint"->>'scanComplete')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
        FROM "RepositoryConnection" repository
        WHERE repository."scmRepositoryIdentityId" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "ReviewV2MigrationQuarantine" quarantine
            WHERE quarantine."migrationVersion" = '${migrationVersion}'
              AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
              AND quarantine."repositoryConnectionId" = repository."id"
              AND quarantine."resolvedAt" IS NULL
          )
      );

    UPDATE "ReviewV2MigrationLedger" ledger
    SET "checkpoint" = ledger."checkpoint" || jsonb_build_object(
          'upperBoundRepositoryConnectionId', (
            SELECT max(repository."id")
            FROM "RepositoryConnection" repository
            WHERE repository."scmRepositoryIdentityId" IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "ReviewV2MigrationQuarantine" quarantine
                WHERE quarantine."migrationVersion" = '${migrationVersion}'
                  AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
                  AND quarantine."repositoryConnectionId" = repository."id"
                  AND quarantine."resolvedAt" IS NULL
              )
          )
        ),
        "updatedAt" = statement_timestamp()
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND ledger."status" = 'running'
      AND NOT COALESCE((ledger."checkpoint"->>'scanComplete')::boolean, FALSE)
      AND ledger."checkpoint"->>'upperBoundRepositoryConnectionId' IS NULL;

    CREATE TEMP TABLE "_review_v2_repository_backfill_page" ON COMMIT DROP AS
    SELECT
      repository."id",
      repository."workspaceId",
      repository."provider",
      repository."sourceBaseUrl",
      regexp_replace(lower(repository."sourceBaseUrl"), '/+$', '') AS "normalizedSourceBaseUrl",
      repository."externalRepositoryId"
    FROM "RepositoryConnection" repository
    CROSS JOIN "ReviewV2MigrationLedger" ledger
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND ledger."status" = 'running'
      AND NOT COALESCE((ledger."checkpoint"->>'scanComplete')::boolean, FALSE)
      AND ledger."checkpoint"->>'upperBoundRepositoryConnectionId' IS NOT NULL
      AND repository."scmRepositoryIdentityId" IS NULL
      AND (
        ledger."checkpoint"->>'lastRepositoryConnectionId' IS NULL
        OR repository."id" > ledger."checkpoint"->>'lastRepositoryConnectionId'
      )
      AND repository."id" <= ledger."checkpoint"->>'upperBoundRepositoryConnectionId'
      AND NOT EXISTS (
        SELECT 1
        FROM "ReviewV2MigrationQuarantine" quarantine
        WHERE quarantine."migrationVersion" = '${migrationVersion}'
          AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
          AND quarantine."repositoryConnectionId" = repository."id"
          AND quarantine."resolvedAt" IS NULL
      )
    ORDER BY repository."id"
    LIMIT ${backfillPageSize};

    WITH winners AS (
      SELECT DISTINCT ON (
        page."provider", page."normalizedSourceBaseUrl", page."externalRepositoryId"
      ) page.*
      FROM "_review_v2_repository_backfill_page" page
      ORDER BY
        page."provider", page."normalizedSourceBaseUrl",
        page."externalRepositoryId", page."id"
    )
    INSERT INTO "ScmRepositoryIdentity" (
      "scmRepositoryIdentityId", "provider", "normalizedSourceBaseUrl",
      "externalRepositoryId", "version", "currentWorkspaceId",
      "currentRepositoryConnectionId", "createdAt", "boundAt"
    )
    SELECT
      'scm_mig_' || md5(
        winner."provider"::text || chr(31) ||
        winner."normalizedSourceBaseUrl" || chr(31) ||
        winner."externalRepositoryId"
      ),
      winner."provider",
      winner."normalizedSourceBaseUrl",
      winner."externalRepositoryId",
      1,
      winner."workspaceId",
      winner."id",
      statement_timestamp(),
      statement_timestamp()
    FROM winners winner
    ON CONFLICT ("provider", "normalizedSourceBaseUrl", "externalRepositoryId")
    DO NOTHING;

    WITH binding_candidates AS (
      SELECT DISTINCT ON (identity."scmRepositoryIdentityId")
        identity."scmRepositoryIdentityId",
        page."workspaceId",
        page."id" AS "repositoryConnectionId"
      FROM "_review_v2_repository_backfill_page" page
      JOIN "ScmRepositoryIdentity" identity
        ON identity."provider" = page."provider"
       AND identity."normalizedSourceBaseUrl" = page."normalizedSourceBaseUrl"
       AND identity."externalRepositoryId" = page."externalRepositoryId"
      WHERE identity."currentRepositoryConnectionId" IS NULL
        AND identity."currentWorkspaceId" IS NULL
      ORDER BY identity."scmRepositoryIdentityId", page."id"
    )
    UPDATE "ScmRepositoryIdentity" identity
    SET "currentWorkspaceId" = candidate."workspaceId",
        "currentRepositoryConnectionId" = candidate."repositoryConnectionId",
        "version" = identity."version" + 1,
        "boundAt" = statement_timestamp(),
        "unboundAt" = NULL
    FROM binding_candidates candidate
    WHERE identity."scmRepositoryIdentityId" = candidate."scmRepositoryIdentityId"
      AND identity."currentRepositoryConnectionId" IS NULL
      AND identity."currentWorkspaceId" IS NULL;

    INSERT INTO "ReviewV2MigrationQuarantine" (
      "migrationVersion", "stepName", "repositoryConnectionId", "safeReason", "evidence"
    )
    SELECT
      '${migrationVersion}',
      '${reviewV2RepositoryBackfillStep}',
      page."id",
      'scm_identity_already_bound_to_other_connection',
      jsonb_build_object(
        'provider', page."provider"::text,
        'sourceBaseUrl', page."sourceBaseUrl",
        'externalRepositoryId', page."externalRepositoryId",
        'existingIdentityId', identity."scmRepositoryIdentityId",
        'existingConnectionId', identity."currentRepositoryConnectionId",
        'existingWorkspaceId', identity."currentWorkspaceId"
      )
    FROM "_review_v2_repository_backfill_page" page
    JOIN "ScmRepositoryIdentity" identity
      ON identity."provider" = page."provider"
     AND identity."normalizedSourceBaseUrl" = page."normalizedSourceBaseUrl"
     AND identity."externalRepositoryId" = page."externalRepositoryId"
    WHERE identity."currentRepositoryConnectionId" IS DISTINCT FROM page."id"
       OR identity."currentWorkspaceId" IS DISTINCT FROM page."workspaceId"
    ON CONFLICT ("migrationVersion", "stepName", "repositoryConnectionId")
    DO UPDATE SET
      "safeReason" = EXCLUDED."safeReason",
      "evidence" = EXCLUDED."evidence",
      "createdAt" = statement_timestamp(),
      "resolvedAt" = NULL,
      "resolvedBy" = NULL;

    UPDATE "RepositoryConnection" repository
    SET "scmRepositoryIdentityId" = identity."scmRepositoryIdentityId"
    FROM "_review_v2_repository_backfill_page" page
    JOIN "ScmRepositoryIdentity" identity
      ON identity."provider" = page."provider"
     AND identity."normalizedSourceBaseUrl" = page."normalizedSourceBaseUrl"
     AND identity."externalRepositoryId" = page."externalRepositoryId"
     AND identity."currentWorkspaceId" = page."workspaceId"
     AND identity."currentRepositoryConnectionId" = page."id"
    WHERE repository."id" = page."id"
      AND repository."scmRepositoryIdentityId" IS NULL;

    WITH page_stats AS (
      SELECT
        count(*)::bigint AS processed,
        max(page."id") AS last_id,
        count(*) FILTER (
          WHERE repository."scmRepositoryIdentityId" IS NOT NULL
        )::bigint AS bound,
        count(*) FILTER (
          WHERE quarantine."quarantineId" IS NOT NULL
            AND quarantine."resolvedAt" IS NULL
        )::bigint AS quarantined
      FROM "_review_v2_repository_backfill_page" page
      JOIN "RepositoryConnection" repository ON repository."id" = page."id"
      LEFT JOIN "ReviewV2MigrationQuarantine" quarantine
        ON quarantine."migrationVersion" = '${migrationVersion}'
       AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
       AND quarantine."repositoryConnectionId" = page."id"
    )
    UPDATE "ReviewV2MigrationLedger" ledger
    SET "checkpoint" = ledger."checkpoint" || jsonb_build_object(
          'lastRepositoryConnectionId', stats.last_id,
          'pagesCompleted', COALESCE((ledger."checkpoint"->>'pagesCompleted')::bigint, 0) + 1,
          'processedCount', COALESCE((ledger."checkpoint"->>'processedCount')::bigint, 0) + stats.processed,
          'boundCount', COALESCE((ledger."checkpoint"->>'boundCount')::bigint, 0) + stats.bound,
          'quarantinedCount', COALESCE((ledger."checkpoint"->>'quarantinedCount')::bigint, 0) + stats.quarantined,
          'lastPageProcessed', stats.processed,
          'lastPageBound', stats.bound,
          'lastPageQuarantined', stats.quarantined
        ),
        "updatedAt" = statement_timestamp()
    FROM page_stats stats
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND stats.processed > 0;

    UPDATE "ReviewV2MigrationLedger" ledger
    SET "checkpoint" = ledger."checkpoint" || jsonb_build_object(
          'pass', COALESCE((ledger."checkpoint"->>'pass')::integer, 0) + 1,
          'lastRepositoryConnectionId', NULL,
          'upperBoundRepositoryConnectionId', (
            SELECT max(repository."id")
            FROM "RepositoryConnection" repository
            WHERE repository."scmRepositoryIdentityId" IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "ReviewV2MigrationQuarantine" quarantine
                WHERE quarantine."migrationVersion" = '${migrationVersion}'
                  AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
                  AND quarantine."repositoryConnectionId" = repository."id"
                  AND quarantine."resolvedAt" IS NULL
              )
          ),
          'scanComplete', FALSE
        ),
        "updatedAt" = statement_timestamp()
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND NOT EXISTS (SELECT 1 FROM "_review_v2_repository_backfill_page")
      AND EXISTS (
        SELECT 1
        FROM "RepositoryConnection" repository
        WHERE repository."scmRepositoryIdentityId" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "ReviewV2MigrationQuarantine" quarantine
            WHERE quarantine."migrationVersion" = '${migrationVersion}'
              AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
              AND quarantine."repositoryConnectionId" = repository."id"
              AND quarantine."resolvedAt" IS NULL
          )
      );

    UPDATE "ReviewV2MigrationLedger" ledger
    SET "checkpoint" = ledger."checkpoint" || jsonb_build_object('scanComplete', TRUE),
        "updatedAt" = statement_timestamp()
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}'
      AND ledger."status" <> 'completed'
      AND NOT EXISTS (SELECT 1 FROM "_review_v2_repository_backfill_page")
      AND NOT EXISTS (
        SELECT 1
        FROM "RepositoryConnection" repository
        WHERE repository."scmRepositoryIdentityId" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "ReviewV2MigrationQuarantine" quarantine
            WHERE quarantine."migrationVersion" = '${migrationVersion}'
              AND quarantine."stepName" = '${reviewV2RepositoryBackfillStep}'
              AND quarantine."repositoryConnectionId" = repository."id"
              AND quarantine."resolvedAt" IS NULL
          )
      );

    COMMIT;
    SELECT jsonb_build_object(
      'status', ledger."status",
      'scanComplete', COALESCE((ledger."checkpoint"->>'scanComplete')::boolean, FALSE),
      'pagesCompleted', COALESCE((ledger."checkpoint"->>'pagesCompleted')::bigint, 0),
      'processedThisPage', CASE WHEN ledger."status" = 'completed' THEN 0 ELSE COALESCE((ledger."checkpoint"->>'lastPageProcessed')::bigint, 0) END,
      'boundThisPage', CASE WHEN ledger."status" = 'completed' THEN 0 ELSE COALESCE((ledger."checkpoint"->>'lastPageBound')::bigint, 0) END,
      'quarantinedThisPage', CASE WHEN ledger."status" = 'completed' THEN 0 ELSE COALESCE((ledger."checkpoint"->>'lastPageQuarantined')::bigint, 0) END
    )::text
    FROM "ReviewV2MigrationLedger" ledger
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}';
  `;
}

function finishRepositoryIdentityBackfillSql() {
  return `
    BEGIN;
    DO $lock$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('reviewrouter:review-v2-migrate', 0));
    END
    $lock$;
    LOCK TABLE "RepositoryConnection" IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE "ReviewV2MigrationQuarantine" IN SHARE ROW EXCLUSIVE MODE;

    CREATE TEMP TABLE "_review_v2_repository_backfill_finish" ON COMMIT DROP AS
    SELECT
      (SELECT count(*) FROM "RepositoryConnection"
       WHERE "scmRepositoryIdentityId" IS NULL)::bigint AS unbound_count,
      (SELECT count(*) FROM "ReviewV2MigrationQuarantine"
       WHERE "migrationVersion" = '${migrationVersion}'
         AND "stepName" = '${reviewV2RepositoryBackfillStep}'
         AND "resolvedAt" IS NULL)::bigint AS unresolved_quarantine_count;

    UPDATE "ReviewV2MigrationLedger" ledger
    SET "status" = CASE
          WHEN finish.unresolved_quarantine_count > 0 THEN 'failed'
          WHEN finish.unbound_count > 0 THEN 'running'
          ELSE 'completed'
        END,
        "checkpoint" = CASE
          WHEN finish.unresolved_quarantine_count = 0 AND finish.unbound_count > 0
            THEN ledger."checkpoint" || jsonb_build_object(
              'pass', COALESCE((ledger."checkpoint"->>'pass')::integer, 0) + 1,
              'lastRepositoryConnectionId', NULL,
              'upperBoundRepositoryConnectionId', (
                SELECT max(repository."id")
                FROM "RepositoryConnection" repository
                WHERE repository."scmRepositoryIdentityId" IS NULL
              ),
              'scanComplete', FALSE
            )
          ELSE ledger."checkpoint"
        END || jsonb_build_object(
          'finishUnboundCount', finish.unbound_count,
          'finishUnresolvedQuarantineCount', finish.unresolved_quarantine_count
        ),
        "updatedAt" = statement_timestamp(),
        "completedAt" = CASE
          WHEN finish.unresolved_quarantine_count = 0 AND finish.unbound_count = 0
            THEN statement_timestamp()
          ELSE NULL
        END,
        "lastErrorCode" = CASE
          WHEN finish.unresolved_quarantine_count > 0
            THEN 'repository_identity_collision_quarantined'
          ELSE NULL
        END
    FROM "_review_v2_repository_backfill_finish" finish
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}';

    COMMIT;
    SELECT jsonb_build_object(
      'status', ledger."status",
      'unboundCount', COALESCE((ledger."checkpoint"->>'finishUnboundCount')::bigint, 0),
      'unresolvedQuarantineCount', COALESCE((ledger."checkpoint"->>'finishUnresolvedQuarantineCount')::bigint, 0)
    )::text
    FROM "ReviewV2MigrationLedger" ledger
    WHERE ledger."migrationVersion" = '${migrationVersion}'
      AND ledger."stepName" = '${reviewV2RepositoryBackfillStep}';
  `;
}

function foreignKeyDefinitionGuardSql() {
  return `
    DO $review_v2_fk_definition_guard$
    DECLARE
      mismatches text;
    BEGIN
      WITH expected(
        table_name, constraint_name, source_columns, target_table_name,
        target_columns, on_delete_code, on_update_code, is_deferrable,
        is_initially_deferred
      ) AS (VALUES ${foreignKeyValuesSql}),
      actual AS (
        SELECT
          source_table.relname AS table_name,
          constraint_row.conname AS constraint_name,
          target_schema.nspname AS target_schema_name,
          target_table.relname AS target_table_name,
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, position)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_row.conrelid
             AND attribute.attnum = key_column.attnum
            ORDER BY key_column.position
          ) AS source_columns,
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_row.confkey) WITH ORDINALITY key_column(attnum, position)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_row.confrelid
             AND attribute.attnum = key_column.attnum
            ORDER BY key_column.position
          ) AS target_columns,
          constraint_row.confdeltype::text AS on_delete_code,
          constraint_row.confupdtype::text AS on_update_code,
          constraint_row.condeferrable AS is_deferrable,
          constraint_row.condeferred AS is_initially_deferred
        FROM pg_constraint constraint_row
        JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
        JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
        JOIN pg_class target_table ON target_table.oid = constraint_row.confrelid
        JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
        WHERE source_schema.nspname = 'public'
          AND constraint_row.contype = 'f'
      )
      SELECT string_agg(
        format('%I.%I', expected.table_name, expected.constraint_name),
        ', ' ORDER BY expected.table_name, expected.constraint_name
      )
      INTO mismatches
      FROM expected
      LEFT JOIN actual
        ON actual.table_name = expected.table_name
       AND actual.constraint_name = expected.constraint_name
      WHERE actual.constraint_name IS NULL
         OR actual.target_schema_name IS DISTINCT FROM 'public'
         OR actual.target_table_name IS DISTINCT FROM expected.target_table_name
         OR actual.source_columns IS DISTINCT FROM expected.source_columns
         OR actual.target_columns IS DISTINCT FROM expected.target_columns
         OR actual.on_delete_code IS DISTINCT FROM expected.on_delete_code
         OR actual.on_update_code IS DISTINCT FROM expected.on_update_code
         OR actual.is_deferrable IS DISTINCT FROM expected.is_deferrable
         OR actual.is_initially_deferred IS DISTINCT FROM expected.is_initially_deferred;

      IF mismatches IS NOT NULL THEN
        RAISE EXCEPTION USING
          MESSAGE = 'review_v2_foreign_key_definition_mismatch',
          DETAIL = mismatches;
      END IF;
    END
    $review_v2_fk_definition_guard$;
  `;
}

function preparedManifestSchemaGuardSql() {
  return `
    DO $review_v2_prepared_manifest$
    DECLARE
      purpose_definition TEXT;
    BEGIN
      IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReviewInvocationLeaseV2'
          AND column_name IN (
            'preparedManifestCanonicalJson',
            'preparedManifestKey',
            'providerVoteIdentityHash'
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'review_invocation_prepared_manifest_columns_missing';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReviewInvocationLeaseV2'
          AND column_name = 'providerVoteIdentityHash'
          AND is_nullable = 'NO'
      ) THEN
        RAISE EXCEPTION 'review_invocation_provider_vote_identity_nullable';
      END IF;
      SELECT pg_get_constraintdef(constraint_row.oid, TRUE)
      INTO purpose_definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
      WHERE schema_row.nspname = 'public'
        AND table_row.relname = 'ReviewInvocationLeaseV2'
        AND constraint_row.conname = 'ReviewInvocationLeaseV2_valid_purpose'
        AND constraint_row.contype = 'c';
      IF purpose_definition IS NULL
         OR position('preparedManifestCanonicalJson' IN purpose_definition) = 0
         OR position('preparedManifestKey' IN purpose_definition) = 0
         OR position('provider_execution' IN purpose_definition) = 0
         OR position('observation_adoption' IN purpose_definition) = 0 THEN
        RAISE EXCEPTION 'review_invocation_prepared_manifest_constraint_invalid';
      END IF;
    END
    $review_v2_prepared_manifest$;
  `;
}

function publicationWorkerSafetySchemaGuardSql() {
  return `
    DO $worker_safety_guard$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_enum enum_value
        JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
        JOIN pg_namespace enum_namespace ON enum_namespace.oid = enum_type.typnamespace
        WHERE enum_namespace.nspname = 'public'
          AND enum_type.typname = 'ReviewPublicationOperationStateV2'
          AND enum_value.enumlabel IN (
            'superseded_no_effect',
            'failed_no_effect',
            'stale_compensated',
            'stale_visible'
          )
      ) <> 4 THEN
        RAISE EXCEPTION 'review_v2_publication_worker_terminal_states_missing';
      END IF;

      IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReviewPublicationOperationV2'
          AND column_name IN ('retryCount', 'nextEligibleAt', 'lastErrorCode')
      ) <> 3 THEN
        RAISE EXCEPTION 'review_v2_publication_worker_retry_columns_missing';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ReviewPublicationExternalEffectV2'
          AND column_name = 'observedObjectHash'
          AND is_nullable = 'NO'
      ) THEN
        RAISE EXCEPTION 'review_v2_publication_worker_observed_object_hash_missing';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'ReviewPublicationOperationV2_state_nextEligibleAt_publicationOperationId_idx'
      ) THEN
        RAISE EXCEPTION 'review_v2_publication_worker_schedule_index_missing';
      END IF;
    END
    $worker_safety_guard$;
  `;
}

function releaseArtifactSchemaGuardSql() {
  return `
    DO $review_v2_release_artifact_guard$
    DECLARE
      artifact_constraint_validated BOOLEAN;
      artifact_constraint_definition TEXT;
      immutable_index_columns TEXT[];
      immutable_index_nulls_not_distinct BOOLEAN;
      immutable_index_valid BOOLEAN;
      immutable_index_ready BOOLEAN;
    BEGIN
      IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ProducerRelease'
          AND column_name IN (
            'contextGatewayPolicyVersion',
            'contextGatewayEntrypointDigest'
          )
      ) <> 2 THEN
        RAISE EXCEPTION 'review_v2_release_gateway_columns_missing';
      END IF;

      SELECT
        constraint_row.convalidated,
        pg_get_constraintdef(constraint_row.oid, TRUE)
      INTO artifact_constraint_validated, artifact_constraint_definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
      WHERE schema_row.nspname = 'public'
        AND table_row.relname = 'ProducerRelease'
        AND constraint_row.conname = 'ProducerRelease_contextGatewayArtifact_complete'
        AND constraint_row.contype = 'c';
      IF artifact_constraint_validated IS DISTINCT FROM TRUE
         OR artifact_constraint_definition IS DISTINCT FROM
           'CHECK (("contextGatewayPolicyVersion" IS NULL) = ("contextGatewayEntrypointDigest" IS NULL))' THEN
        RAISE EXCEPTION 'review_v2_release_gateway_pair_constraint_invalid';
      END IF;

      SELECT
        array_agg(attribute.attname ORDER BY key_column.position),
        index_row.indnullsnotdistinct,
        index_row.indisvalid,
        index_row.indisready
      INTO
        immutable_index_columns,
        immutable_index_nulls_not_distinct,
        immutable_index_valid,
        immutable_index_ready
      FROM pg_index index_row
      JOIN pg_class table_row ON table_row.oid = index_row.indrelid
      JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
      JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
      JOIN unnest(index_row.indkey) WITH ORDINALITY
        key_column(attnum, position) ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_row.oid
       AND attribute.attnum = key_column.attnum
      WHERE schema_row.nspname = 'public'
        AND table_row.relname = 'ProducerRelease'
        AND index_class.relname =
          'ProducerRelease_distributionKind_actionCommitSha_runtimeCom_key'
        AND index_row.indisunique
      GROUP BY
        index_row.indnullsnotdistinct,
        index_row.indisvalid,
        index_row.indisready;
      IF immutable_index_columns IS DISTINCT FROM ARRAY[
           'distributionKind',
           'actionCommitSha',
           'runtimeCommitSha',
           'wrapperEntrypointDigest',
           'runtimeEntrypointDigest',
           'contextGatewayPolicyVersion',
           'contextGatewayEntrypointDigest',
           'reviewInvestigationCapability',
           'reviewInvestigationCoverageProfileHash',
           'reviewInvestigationPolicyHash',
           'schemaDigest',
           'capabilityProfile',
           'protocolLimitsProfileId',
           'operationalSloProfileId'
         ]::TEXT[]
         OR immutable_index_nulls_not_distinct IS DISTINCT FROM TRUE
         OR immutable_index_valid IS DISTINCT FROM TRUE
         OR immutable_index_ready IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'review_v2_release_immutable_index_invalid';
      END IF;
    END
    $review_v2_release_artifact_guard$;
  `;
}

function foreignKeyValidationSql() {
  return `
    DO $review_v2_fk_validation$
    DECLARE
      item record;
    BEGIN
      FOR item IN
        WITH expected(
          table_name, constraint_name, source_columns, target_table_name,
          target_columns, on_delete_code, on_update_code, is_deferrable,
          is_initially_deferred
        ) AS (VALUES ${foreignKeyValuesSql})
        SELECT source_schema.nspname AS schema_name,
               source_table.relname AS table_name,
               constraint_row.conname AS constraint_name
        FROM expected
        JOIN pg_class source_table ON source_table.relname = expected.table_name
        JOIN pg_namespace source_schema
          ON source_schema.oid = source_table.relnamespace
         AND source_schema.nspname = 'public'
        JOIN pg_constraint constraint_row
          ON constraint_row.conrelid = source_table.oid
         AND constraint_row.conname = expected.constraint_name
        WHERE NOT constraint_row.convalidated
        ORDER BY source_table.relname, constraint_row.conname
      LOOP
        EXECUTE format(
          'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
          item.schema_name,
          item.table_name,
          item.constraint_name
        );
      END LOOP;

      IF EXISTS (
        WITH expected(
          table_name, constraint_name, source_columns, target_table_name,
          target_columns, on_delete_code, on_update_code, is_deferrable,
          is_initially_deferred
        ) AS (VALUES ${foreignKeyValuesSql})
        SELECT 1
        FROM expected
        JOIN pg_class source_table ON source_table.relname = expected.table_name
        JOIN pg_namespace source_schema
          ON source_schema.oid = source_table.relnamespace
         AND source_schema.nspname = 'public'
        JOIN pg_constraint constraint_row
          ON constraint_row.conrelid = source_table.oid
         AND constraint_row.conname = expected.constraint_name
        WHERE NOT constraint_row.convalidated
      ) THEN
        RAISE EXCEPTION 'review_v2_foreign_key_validation_incomplete';
      END IF;
    END
    $review_v2_fk_validation$;
  `;
}

function runStep(stepName, body) {
  runPsql(`
    BEGIN;
    SELECT pg_advisory_xact_lock(hashtextextended('reviewrouter:review-v2-migrate', 0));

    DO $guard$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM "ReviewV2MigrationLedger"
        WHERE "migrationVersion" = '${migrationVersion}'
          AND "stepName" = '${stepName}'
          AND "schemaDigest" <> '${schemaDigest}'
      ) THEN
        RAISE EXCEPTION 'review_v2_migration_schema_digest_mismatch';
      END IF;
    END
    $guard$;

    INSERT INTO "ReviewV2MigrationLedger" (
      "migrationVersion", "stepName", "status", "schemaDigest",
      "checkpoint", "startedAt", "updatedAt", "completedAt", "lastErrorCode"
    ) VALUES (
      '${migrationVersion}', '${stepName}', 'running', '${schemaDigest}',
      jsonb_build_object('actor', '${actor}'), statement_timestamp(),
      statement_timestamp(), NULL, NULL
    )
    ON CONFLICT ("migrationVersion", "stepName") DO UPDATE
    SET "status" = 'running',
        "checkpoint" = EXCLUDED."checkpoint",
        "updatedAt" = statement_timestamp(),
        "completedAt" = NULL,
        "lastErrorCode" = NULL
    WHERE "ReviewV2MigrationLedger"."status" <> 'completed';

    ${body}

    UPDATE "ReviewV2MigrationLedger"
    SET "status" = 'completed',
        "updatedAt" = statement_timestamp(),
        "completedAt" = statement_timestamp(),
        "lastErrorCode" = NULL
    WHERE "migrationVersion" = '${migrationVersion}'
      AND "stepName" = '${stepName}'
      AND "status" = 'running';
    COMMIT;
  `);
}

function initialEmergencyStopGuardSql(stepName, errorCode) {
  return `
    DO $initial_emergency_stop_guard$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM "ReviewV2MigrationLedger"
        WHERE "migrationVersion" = '${migrationVersion}'
          AND "stepName" = '${stepName}'
          AND "status" = 'completed'
      ) AND NOT EXISTS (
        SELECT 1
        FROM "ReviewSafetyEmergencyControl"
        WHERE "emergencyControlId" = 'global-review-v2'
          AND "stopped" = true
      ) THEN
        RAISE EXCEPTION '${errorCode}';
      END IF;
    END
    $initial_emergency_stop_guard$;
  `;
}

function runPsql(sql) {
  runSecretSafePostgresCommand({
    databaseUrl: psqlDatabaseUrl,
    args: ["-v", "ON_ERROR_STOP=1", "-X", "-c", sql],
  });
}

function queryScalar(sql) {
  return runSecretSafePostgresCommand({
    databaseUrl: psqlDatabaseUrl,
    args: ["-v", "ON_ERROR_STOP=1", "-X", "-qAt", "-c", sql],
  }).stdout.trim();
}

function normalizePsqlConnectionUrl(value) {
  try {
    return psqlConnectionUrl(value);
  } catch {
    fail("DATABASE_URL is not a supported PostgreSQL connection URL");
  }
}

function integerArgument(prefix, defaultValue, minimum, maximum) {
  const value = optionalIntegerArgument(prefix, minimum, maximum);
  return value ?? defaultValue;
}

function optionalIntegerArgument(prefix, minimum, maximum) {
  const argument = process.argv.find((candidate) =>
    candidate.startsWith(prefix),
  );
  if (!argument) return null;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(
      `${prefix.slice(0, -1)} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function parseJsonResult(value, errorCode) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not_an_object");
    }
    return parsed;
  } catch {
    fail(errorCode);
  }
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
