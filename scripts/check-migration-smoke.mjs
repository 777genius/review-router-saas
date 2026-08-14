#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import { sanitizedDiagnosticError } from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import {
  createDatabaseCredentialBoundary,
  runSecretSafePostgresCommand,
} from "./lib/secret-safe-command-boundary.mjs";

if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: false });
}
if (existsSync(".env")) {
  dotenv.config({ path: ".env", override: false });
}

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const requireCommand = (command) => {
  const result = spawnSync(
    "sh",
    ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    {
      stdio: "ignore",
    },
  );
  if (result.status !== 0) fail(`Missing required command: ${command}`);
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? "ignore",
    env: options.env,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sanitizedDiagnosticError({
      code: "release_migration_step_failed",
      phase: "release_migration",
      exitCode: result.status,
      signal: result.signal,
      timedOut: result.error?.code === "ETIMEDOUT",
    });
  }
  return result;
};

const quoteIdentifier = (identifier) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    fail(`Unsafe database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const baseUrlValue = process.env.DATABASE_URL;
if (!baseUrlValue) fail("DATABASE_URL is required for migration smoke test");

const baseUrl = new URL(baseUrlValue);
const sourceDbName = decodeURIComponent(baseUrl.pathname.replace(/^\//, ""));
if (!sourceDbName) fail("DATABASE_URL must include a database name");

requireCommand("psql");
requireCommand("pnpm");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const smokeDbName = `review_router_migration_smoke_${suffix}`;
const rollbackDbName = `review_router_dispatch_rollback_${suffix}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const smokeUrl = new URL(baseUrl);
smokeUrl.pathname = `/${smokeDbName}`;
smokeUrl.search = "";
const rollbackUrl = new URL(baseUrl);
rollbackUrl.pathname = `/${rollbackDbName}`;
rollbackUrl.search = "";
const smokeCredential = createDatabaseCredentialBoundary(smokeUrl);

const psql = (
  sql,
  url = adminUrl.toString(),
  stdio = "ignore",
  extraArgs = [],
) =>
  runSecretSafePostgresCommand({
    databaseUrl: url,
    args: ["-v", "ON_ERROR_STOP=1", ...extraArgs, "-c", sql],
  });

const prismaRoot = resolve("packages/platform/db/prisma");
const dispatchMigrationName = "000034_review_request_dispatch_reconciliation";
let created = false;
let rollbackCreated = false;
try {
  console.log("Creating migration smoke database...");
  psql(`CREATE DATABASE ${quoteIdentifier(smokeDbName)}`);
  created = true;

  console.log("Applying Prisma migrations to fresh database...");
  run("pnpm", ["--filter", "@reviewrouter/platform-db", "db:migrate:deploy"], {
    env: smokeCredential.environment,
  });

  console.log("Verifying migrated schema invariants...");
  const invariantSql = `
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Workspace') AS workspace_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ActionRunHealthReport') AS health_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'RateLimitBucket') AS rate_limit_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'DistributedLock') AS distributed_lock_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ActionOidcReplayNonce') AS replay_nonce_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ReviewSnapshot') AS review_snapshot_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ReviewExecutionCheckpoint') AS review_execution_checkpoint_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ReviewExecutionBatchResult') AS review_execution_batch_result_table,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ReviewExecutionCheckpoint' AND column_name = 'acceptedFindings' AND is_nullable = 'NO') AS review_execution_checkpoint_findings_counter,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CodexOAuthLease' AND column_name = 'workspaceId' AND is_nullable = 'NO') AS lease_workspace_scope,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CodexOAuthLease' AND column_name = 'repositoryId' AND is_nullable = 'NO') AS lease_repository_scope,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CodexOAuthLease' AND column_name = 'pullRequestNumber') AS lease_pull_request_scope,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ActionRunHealthReport' AND indexname = 'ActionRunHealthReport_repositoryId_githubRunId_githubRunAtt_key') AS health_unique_index,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ReviewSnapshot' AND indexname = 'ReviewSnapshot_workspaceId_repositoryId_pullRequestNumber_key') AS review_snapshot_unique_index,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ReviewExecutionCheckpoint' AND indexname = 'ReviewExecutionCheckpoint_workspaceId_repositoryId_pullRequestNumber_key') AS review_execution_checkpoint_unique_index,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ReviewExecutionBatchResult' AND indexname = 'ReviewExecutionBatchResult_checkpointId_workKey_key') AS review_execution_batch_result_unique_index,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CodexOAuthLease' AND indexname = 'CodexOAuthLease_repositoryId_status_idx') AS lease_repository_scope_index,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'OutboxEvent' AND column_name IN ('claimId', 'claimVersion', 'claimOwnerHash', 'claimUntil')) AS outbox_claim_columns,
      (SELECT count(*) FROM pg_class WHERE relkind = 'S' AND relname = 'OutboxEvent_claimVersion_seq') AS outbox_claim_sequence,
      (SELECT count(*) FROM information_schema.triggers WHERE event_object_schema = 'public' AND event_object_table = 'OutboxEvent' AND trigger_name = 'OutboxEvent_claim_transition_guard') AS outbox_claim_guard,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'OutboxFencingControl') AS outbox_fencing_control,
      (SELECT count(*) FROM "OutboxFencingControl" WHERE "id" = 1 AND "enabled" = false) AS outbox_fencing_initially_disabled,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations') AS migrations_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (
        'ReviewProtocolLimitsV2', 'ReviewOperationalSloProfileV2', 'ProducerRelease',
        'ScmRepositoryIdentity', 'ReviewMutationAuthority', 'ReviewSafetyPolicy',
        'ReviewSafetyPolicySelector', 'ReviewSafetyEmergencyControl', 'ReviewRunAuthorization',
        'ReviewEvidenceObservation', 'ReviewRequestedIntent', 'ReviewExecutionStreamV2',
        'ReviewExecutionV2', 'ReviewExecutionWorkSlotV2', 'ReviewInvocationLeaseV2',
        'ReviewExecutionObservationRefV2', 'FinalizedReviewProjectionArtifactV2',
        'ReviewSnapshotCommitReceiptV2', 'ReviewPublicationAttemptV2',
        'ReviewPublicationClaimTermV2', 'ReviewPublicationOperationV2',
        'ReviewPublicationOperationAttemptV2', 'ReviewPublicationExternalEffectV2',
        'ReviewPublicationReceiptV2', 'ReviewPublicationAuditTombstoneV2',
        'ReviewPublicationOutcomeCorrectionV2', 'ReviewCompletionProcess'
      )) AS review_v2_core_tables,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ReviewSnapshot' AND column_name IN (
        'scmRepositoryIdentityId', 'sourceExecutionId', 'sourceExecutionGeneration',
        'sourceArtifactHash', 'sourceReviewRevisionHash', 'publicationReceiptSetHash'
      )) AS review_snapshot_v2_columns,
      (SELECT count(*) FROM pg_class WHERE relkind = 'S' AND relname IN (
        'ReviewRequestedIntent_claimFencingToken_seq', 'ReviewInvocationLeaseV2_fencingToken_seq',
        'ReviewPublicationClaimTermV2_fencingToken_seq', 'ReviewCompletionProcess_claimFencingToken_seq'
      )) AS review_v2_fencing_sequences,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
        'ReviewExecutionV2_one_planned_per_scope',
        'ReviewInvocationLeaseV2_one_active_provider_invocation',
        'ReviewInvocationLeaseV2_one_active_work_slot',
        'ReviewPublicationClaimTermV2_one_active_claim',
        'ReviewPublicationExternalEffectV2_owned_object_unique'
      )) AS review_v2_partial_owner_indexes,
      (SELECT count(*) FROM "ReviewSafetyEmergencyControl" WHERE "policyScope" = 'global' AND "stopped" = true) AS review_v2_global_stop,
      (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'Review%_fkey' AND NOT convalidated) AS review_v2_pending_fk_validation,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (
        'ReviewContextGatewaySession', 'ReviewContextDependencyAttestation',
        'ReviewContextReplayMaterial', 'ReviewContextTargetReplayProof'
      )) AS review_context_attestation_tables,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ReviewEvidenceObservation' AND column_name IN (
        'contextDependencyAttestationId', 'contextDependencyAttestationHash'
      )) AS review_context_evidence_columns,
      (SELECT count(*) FROM pg_constraint WHERE conname = 'ReviewEvidenceObservation_context_dependency_pair' AND convalidated) AS review_context_evidence_pair_guard,
      (SELECT count(*) FROM pg_constraint WHERE conname IN (
        'ReviewContextDependencyAttestation_sessionId_fkey',
        'ReviewEvidenceObservation_contextDependencyAttestationId_fkey',
        'ReviewContextReplayMaterial_sessionId_fkey',
        'ReviewContextReplayMaterial_attestationId_fkey',
        'ReviewContextTargetReplayProof_sourceAttestationId_fkey'
      ) AND convalidated) AS review_context_attestation_fks,
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
       AND table_name = 'ReviewRequestedIntent'
       AND column_name IN (
         'admissionState', 'admissionChangedLines', 'admissionMaxChangedLines',
         'admissionPolicySnapshotId', 'admissionDecisionHash', 'admissionCheckedAt'
       )) AS review_request_admission_columns,
      (SELECT count(*) FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'ReviewRequestAdmissionStateV2'
       AND pg_enum.enumlabel IN ('not_evaluated', 'admitted', 'rejected'))
       AS review_request_admission_states,
      (SELECT count(*) FROM pg_constraint
       WHERE conname IN (
         'ReviewRequestedIntent_admission_shape_check',
         'ReviewRequestedIntent_admission_verdict_check'
       ) AND convalidated) AS review_request_admission_guards,
      (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public'
       AND indexname =
         'ReviewRequestedIntent_source_run_identity_key')
       AS review_request_source_run_identity_guard,
      (SELECT count(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (
         'ReviewExecutionProgressV1', 'ReviewProgressPublicationV1',
         'ReviewProgressInstallationBudgetV1'
       )) AS review_progress_tables,
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ReviewExecutionV2'
       AND column_name IN (
         'assignmentManifestVersion', 'assignmentManifestHash',
         'assignmentManifestJson'
       )) AS review_assignment_manifest_columns,
      (SELECT count(*) FROM pg_constraint
       WHERE conname IN (
         'ReviewExecutionV2_assignment_manifest_all_or_none',
         'ReviewExecutionProgressV1_counts_non_negative',
         'ReviewExecutionProgressV1_coverage_all_or_none',
         'ReviewProgressPublicationV1_claim_all_or_none',
         'ReviewProgressPublicationV1_version_order',
         'ReviewProgressPublicationV1_non_negative'
       ) AND convalidated) AS review_progress_guards,
      (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public'
       AND indexname = 'ReviewProgressPublicationV1_due_partial_idx')
       AS review_progress_due_index;
  `;
  const result = psql(invariantSql, smokeUrl.toString(), "pipe", ["-At"]);
  const output = result.stdout.trim();
  if (
    output !==
    "1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|4|1|1|1|1|1|27|6|4|5|1|43|4|2|1|5|6|3|2|1|3|3|6|1"
  ) {
    fail("Migrated schema invariants failed");
  }

  console.log("Verifying dispatch migration preflight rollback...");
  psql(`CREATE DATABASE ${quoteIdentifier(rollbackDbName)}`);
  rollbackCreated = true;
  for (const entry of readdirSync(join(prismaRoot, "migrations")).sort()) {
    if (!/^\d{6}_/.test(entry) || entry >= dispatchMigrationName) continue;
    runSecretSafePostgresCommand({
      databaseUrl: rollbackUrl,
      args: [
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        join(prismaRoot, "migrations", entry, "migration.sql"),
      ],
    });
  }
  const hash = "a".repeat(64);
  const sha = "b".repeat(40);
  psql(
    `
      SET session_replication_role = replica;
      INSERT INTO "ReviewRequestedIntent" (
        "requestId", "workspaceId", "repositoryConnectionId",
        "scmRepositoryIdentityId", "pullRequestNumber", "baseSha",
        "mergeBaseSha", "headSha", "reviewRevisionHash", "triggerKind",
        "deliveryIdentityHash", "canonicalRequestHash", "state", "notBefore",
        "claimId", "claimOwnerIdHash", "claimFencingToken", "claimedAt",
        "claimUntil", "createdAt", "updatedAt", "retainUntil"
      ) VALUES (
        'dispatch-rollback-fixture', 'workspace', 'repository', 'identity', 42,
        '${sha}', '${sha}', '${sha}', '${hash}', 'manual_command', '${hash}',
        '${hash}', 'dispatching', now(), 'claim', '${hash}', 1, now(),
        now() + interval '5 minutes', now(), now(), now() + interval '1 day'
      );
      SET session_replication_role = origin;
    `,
    rollbackUrl.toString(),
  );
  runSecretSafePostgresCommand({
    databaseUrl: rollbackUrl,
    args: [
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      join(prismaRoot, "migrations", dispatchMigrationName, "migration.sql"),
    ],
    expectFailureContaining: "review_requested_dispatching_migration_preflight",
  });
  const rollbackInvariantSql = `
    SELECT
      (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
       FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE typname = 'ReviewRequestedIntentStateV2') AS states,
      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
        'ReviewRequestedIntent_state_notBefore_requestId_idx',
        'ReviewRequestedIntent_workspaceId_repositoryConnectionId_sc_idx',
        'ReviewRequestedIntent_one_pending_per_scope',
        'ReviewRequestedIntent_one_pending_scope'
      )) AS old_indexes,
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ReviewRequestedIntent'
       AND column_name IN ('submissionStartedAt', 'nextResolutionAt', 'resolutionDeadlineAt', 'terminalReason')) AS new_columns,
      (SELECT count(*) FROM pg_type WHERE typname IN (
        'ReviewRequestedIntentStateV2_old',
        'ReviewRequestedIntentTerminalReasonV2'
      )) AS leaked_types,
      (SELECT count(*) FROM "ReviewRequestedIntent"
       WHERE "requestId" = 'dispatch-rollback-fixture' AND "state" = 'dispatching') AS fixture;
  `;
  const rollbackResult = psql(
    rollbackInvariantSql,
    rollbackUrl.toString(),
    "pipe",
    ["-At"],
  );
  if (
    rollbackResult.stdout.trim() !==
    "pending_dispatch,dispatching,awaiting_authorization,dispatched,superseded|4|0|0|1"
  ) {
    fail("Dispatch migration preflight did not roll back atomically");
  }

  console.log("Migration smoke test passed.");
} finally {
  if (rollbackCreated) {
    try {
      psql(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(rollbackDbName)} WITH (FORCE)`,
      );
    } catch {}
  }
  if (created) {
    console.log("Dropping migration smoke database...");
    try {
      psql(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(smokeDbName)} WITH (FORCE)`,
      );
    } catch {
      try {
        psql(`DROP DATABASE IF EXISTS ${quoteIdentifier(smokeDbName)}`);
      } catch {}
    }
  }
  smokeCredential.cleanup();
}
