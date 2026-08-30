#!/usr/bin/env node
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  isSanitizedDiagnosticError,
  sanitizedDiagnosticError,
} from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import {
  assembleTrustedRolloutEvidence,
  assertPromotionAllowed,
  beginCompensation,
  completeCompensation,
  createReleaseRollout,
  createReleaseMigrationTransition,
  ReleaseApprovalMode,
  ReleaseRolloutUseCases,
  AuthenticatedRunnerLedgerAdapter,
  HttpProviderAuthorityDecisionAdapter,
  RolloutStep,
  TransactionalServiceCutover,
  environmentKeysSha256,
  environmentSha256,
  normalizedServicePostconditionSha256,
  sha256Canonical,
  targetMigrationReceiptEvidence,
  fromRenderSourceRecoveryManifestV1,
  renderSourceRecoveryManifestSha256,
  renderSourceServiceContractSha256,
  releaseAuthoritySchemaVersion,
  targetServiceConfigurationSha256,
  transitionFailure,
  draftEffectivePrincipalPolicy,
  effectivePrincipalInventorySql,
  evaluateEffectivePrincipalInventory,
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyDigests,
  canonicalActivationCatalogPolicyTrustRootReadiness,
  assertCanonicalActivationCatalogPolicyTrustRootReady,
  authorizeCanonicalActivationCatalogPolicies,
} from "../packages/features/release-rollout/src/index.ts";
import { createPrismaClient } from "../packages/platform/db/src/index.ts";
import { createReleaseControlApp } from "../apps/api/src/release-control-composition.ts";
import { observeReleaseAuthorityDatabaseReadiness } from "../apps/api/src/release-authority/adapters/postgres-readiness.ts";
import { releaseAuthoritySchemaIsReady } from "../apps/api/src/release-authority/application/readiness.ts";
import { RoutineTargetActivationReceiptReaderAdapter } from "../apps/api/src/release-authority/adapters/target-receipt.ts";
import { targetActivationIdentityMatches } from "../apps/api/src/release-authority/application/target-activation-invariant.ts";
import { PostgresCleanupObservationAdapter } from "../apps/api/src/release-witness-adapters.ts";
import {
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
  activationAuthorityProvisioningSql,
  activationRoutineBodyTrustRoots,
  canonicalActivationCatalogPolicyCandidateSql,
  roleProvisioningSql,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";
import { parsePrivatePg17ActivationCatalogPolicyCandidate } from "./capture-private-pg17-activation-catalog-policy.mjs";

function rehearsalLegacyAmbiguityReceipt({
  rollout,
  fence,
  inventory,
  firstObservedAt,
  eligibilityCutoff,
}) {
  const inventorySha256 =
    "sha256:" +
    createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  const unsigned = {
    schemaVersion: 1,
    rolloutId: rollout.rolloutId,
    sourceSystemIdentifier: rollout.source.systemIdentifier,
    sourceDatabaseName: rollout.source.databaseName,
    sourceRecoveryWitnessSha256: rollout.source.recoveryWitnessSha256,
    authorityPrincipal: fence.authorityPrincipal,
    fenceId: fence.fenceId,
    fenceEstablishedAt: fence.observedAt,
    fencedInventorySha256: fence.fencedInventorySha256,
    inventorySha256,
    ...inventory,
    observations: [
      { observedAt: firstObservedAt, inventorySha256 },
      { observedAt: eligibilityCutoff, inventorySha256 },
    ],
    eligibilityCutoff,
    stable: true,
  };
  return Object.freeze({
    ...unsigned,
    receiptSha256: "sha256:" + sha256Canonical(unsigned),
  });
}

function rehearsalSqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function persistRehearsalSourceOwnedReceipt(sql, source, evidence) {
  sql(
    source,
    `CREATE SCHEMA IF NOT EXISTS release_authority;
CREATE TABLE release_authority.source_database_fence (
  fence_id text PRIMARY KEY,
  rollout_id text NOT NULL UNIQUE,
  source_system_identifier text NOT NULL,
  authority_principal text NOT NULL,
  before_inventory_sha256 text NOT NULL,
  before_policy_sha256 text NOT NULL,
  fenced_inventory_sha256 text NOT NULL,
  fenced_policy_sha256 text NOT NULL,
  prior_connect_acl jsonb NOT NULL,
  lifecycle text NOT NULL,
  established_at timestamptz NOT NULL
);
CREATE TABLE release_authority.source_legacy_ambiguity_receipt (
  rollout_id text PRIMARY KEY,
  fence_id text NOT NULL,
  source_system_identifier text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT
    date_trunc('milliseconds', clock_timestamp())
);
CREATE FUNCTION release_authority.source_receipt_canonical_json(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog
AS $canonical$
SELECT CASE jsonb_typeof(value)
  WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||
    release_authority.source_receipt_canonical_json(item),',' ORDER BY key COLLATE "C")
    FROM jsonb_each(value) entry(key,item)),'')||'}'
  WHEN 'array' THEN '['||coalesce((SELECT string_agg(
    release_authority.source_receipt_canonical_json(item),',' ORDER BY ordinal)
    FROM jsonb_array_elements(value) WITH ORDINALITY entry(item,ordinal)),'')||']'
  ELSE value::text
END
$canonical$;
CREATE FUNCTION release_authority.source_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $immutable$
BEGIN RAISE EXCEPTION 'source legacy ambiguity receipt is immutable'; END
$immutable$;
CREATE TRIGGER source_legacy_ambiguity_receipt_immutable_guard
BEFORE UPDATE OR DELETE ON release_authority.source_legacy_ambiguity_receipt
FOR EACH ROW EXECUTE FUNCTION release_authority.source_receipt_immutable();
INSERT INTO release_authority.source_database_fence (
  fence_id, rollout_id, source_system_identifier, authority_principal,
  before_inventory_sha256, before_policy_sha256,
  fenced_inventory_sha256, fenced_policy_sha256, prior_connect_acl,
  lifecycle, established_at
) VALUES (
  ${rehearsalSqlLiteral(evidence.fenceId)},
  ${rehearsalSqlLiteral(evidence.rolloutId)},
  ${rehearsalSqlLiteral(evidence.sourceSystemIdentifier)},
  ${rehearsalSqlLiteral(evidence.authorityPrincipal)},
  ${rehearsalSqlLiteral(evidence.fencedInventorySha256)},
  ${rehearsalSqlLiteral(evidence.fencedInventorySha256)},
  ${rehearsalSqlLiteral(evidence.fencedInventorySha256)},
  ${rehearsalSqlLiteral(evidence.fencedInventorySha256)},
  '{}'::jsonb,
  'active',
  ${rehearsalSqlLiteral(evidence.fenceEstablishedAt)}::timestamptz
);
INSERT INTO release_authority.source_legacy_ambiguity_receipt (
  rollout_id, fence_id, source_system_identifier, evidence
) VALUES (
  ${rehearsalSqlLiteral(evidence.rolloutId)},
  ${rehearsalSqlLiteral(evidence.fenceId)},
  ${rehearsalSqlLiteral(evidence.sourceSystemIdentifier)},
  ${rehearsalSqlLiteral(JSON.stringify(evidence))}::jsonb
);
REVOKE ALL ON SCHEMA release_authority FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA release_authority FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA release_authority FROM PUBLIC;`,
  );
}

export const rehearsalActivationCatalogPolicyAuthorization = Object.freeze({
  preactivationCatalogPolicySha256:
    "sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b",
  activatedCatalogPolicySha256:
    "sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b",
});
if (
  rehearsalActivationCatalogPolicyAuthorization.preactivationCatalogPolicySha256 !==
    canonicalActivationCatalogPolicyDigests.preactivationCatalogPolicySha256 ||
  rehearsalActivationCatalogPolicyAuthorization.activatedCatalogPolicySha256 !==
    canonicalActivationCatalogPolicyDigests.activatedCatalogPolicySha256
)
  throw new Error("rehearsal_activation_catalog_policy_authorization_drift");
export const rehearsalReadinessPolicy = Object.freeze({
  poolWaitMilliseconds: 5_000,
  lockTimeoutMilliseconds: 5_000,
  statementTimeoutMilliseconds: 45_000,
  transactionTimeoutMilliseconds: 50_000,
  observationDeadlineMilliseconds: 60_000,
  leaseMilliseconds: 900_000,
  refreshAfterMilliseconds: 600_000,
});

const authorityReadinessBooleanFields = Object.freeze([
  "catalogExact",
  "defaultAclExact",
  "finalAclExact",
  "controlRoutine",
  "providerRoutine",
  "externalEffectProtocol",
  "sourceFreezeProtocol",
  "selectiveRecoveryProtocol",
  "lateRunnerEffectProtocol",
  "recoveryEffectProtocol",
  "compensationCheckpointDefinition",
  "runnerProviderBoundary",
  "cleanupWitnessTemporalSemantics",
  "requiredTriggers",
  "authorityOwnershipExact",
  "authorityAclExact",
  "publicAuthorityRevoked",
  "authorityTablesRevoked",
  "authorityRoleTopologyExact",
]);

export function summarizeAuthorityReadinessMismatch(readiness) {
  return Object.freeze({
    roleName: readiness.roleName,
    systemIdentifier: readiness.systemIdentifier,
    databaseIdentity: readiness.databaseIdentity,
    postgresMajor: readiness.postgresMajor,
    schemaVersion: readiness.schemaVersion,
    catalogVerifier: readiness.catalogVerifier,
    catalogFingerprintMatches:
      readiness.catalogFingerprint === readiness.expectedCatalogFingerprint,
    falseChecks: authorityReadinessBooleanFields.filter(
      (field) => readiness[field] === false,
    ),
    migrationManifest: readiness.migrationManifest.map((entry) => ({
      migrationName: entry.migrationName,
      byteVariant: entry.byteVariant,
    })),
  });
}
import {
  releaseAuthorityBootstrapPreparationSql,
  releaseAuthorityBootstrapProvisioningSql,
  releaseAuthorityBootstrapRelinquishSql,
  releaseAuthorityBootstrapCleanupSql,
  releaseAuthorityBootstrapTerminalSql,
  releaseAuthorityMigrationBundle,
  releaseAuthorityProviderRootProbeSql,
} from "./install-release-authority-db.mjs";
import { executePrivateGenerationActivation } from "./activate-private-pg17-generation.mjs";
import { createSecureCanonicalRun } from "./private-pg17-secure-canonical.ts";
import {
  createDatabaseCredentialBoundary,
  createSecretSafePostgresInvocation,
  normalizeSecretSafePostgresArguments,
} from "./lib/secret-safe-command-boundary.mjs";

const imagePattern =
  /^postgres:(16\.13|17(?:\.[0-9]+)?)-bookworm@sha256:[a-f0-9]{64}$/u;

const preReleaseMigrationBoundary = Object.freeze({
  excluded: Object.freeze([
    "000060_codex_oauth_setup_serialization",
    "000061_codex_oauth_provider_mutation_fence",
    "000062_codex_oauth_remote_outcome_unknown",
    "000063_codex_oauth_setup_payload_claim",
    "000064_codex_oauth_versioned_secret_namespaces",
    "000065_codex_oauth_authority_acl_hardening",
    "000066_codex_oauth_rotating_cascade_authority",
    "000069_release_rollout_ledger",
    "000070_runtime_generation_witness_proof",
    "000071_transactional_service_transition",
    "000072_retire_superseded_codex_setup_claims",
    "000072_runtime_canary_challenge",
    "000073_codex_oauth_active_namespace_refresh",
  ]),
  retained: Object.freeze([
    "000067_review_live_progress",
    "000068_validate_review_assignment_manifest",
    "000074_hosted_codex_account_pool",
    "000075_hosted_codex_security_certification",
    "000076_hosted_codex_terminalization_restore_invariants",
    "000077_hosted_codex_r57_security_race_remediation",
    "000078_review_investigation_maintenance_checkpoint",
    "000079_hosted_codex_output_limits",
    "000079_remove_account_wide_provider_lane_serialization",
    "000080_hosted_codex_attempt_generation",
    "000081_hosted_codex_runtime_gate",
    "000082_validate_hosted_codex_output_limits",
    "000083_hosted_codex_comment_token_mint_protocol",
    "000084_harden_comment_token_custody",
    "000085_comment_token_gate_lock_result",
    "000086_comment_token_custody_r18_remediation",
  ]),
});

export function resolvePreReleaseMigrationExclusions(migrationNames) {
  const actualBoundary = migrationNames
    .filter((name) => /^\d{6}_[a-z0-9_]+$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 6), 10) >= 60)
    .sort();
  const expectedBoundary = [
    ...preReleaseMigrationBoundary.excluded,
    ...preReleaseMigrationBoundary.retained,
  ].sort();
  if (
    actualBoundary.length !== expectedBoundary.length ||
    actualBoundary.some((name, index) => name !== expectedBoundary[index])
  )
    throw new Error("private_pg17_rehearsal_migration_boundary_unclassified");
  return preReleaseMigrationBoundary.excluded;
}

export function disposableTargetPublicTableAclCanonicalizationSql() {
  return `ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_role_bootstrap IN SCHEMA public
REVOKE SELECT ON TABLES FROM PUBLIC;
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM PUBLIC;`;
}

/** Capture-only cleanup for artifacts created solely by this rehearsal. */
export function captureOnlyRehearsalFixtureCleanupSql() {
  return `\\set ON_ERROR_STOP on
BEGIN;
DO $capture_fixture_role_precondition$
BEGIN
  IF to_regrole('rehearsal_writer') IS NOT NULL THEN
    RAISE EXCEPTION 'capture-only rehearsal role unexpectedly present';
  END IF;
END
$capture_fixture_role_precondition$;
DROP TABLE IF EXISTS public.rehearsal_items CASCADE;
DROP SCHEMA IF EXISTS app_private CASCADE;
DO $capture_fixture_cleanup$
BEGIN
  IF to_regclass('public.rehearsal_items') IS NOT NULL
     OR to_regnamespace('app_private') IS NOT NULL
     OR to_regrole('rehearsal_writer') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='public'
         AND relation.relkind='S'
         AND relation.relname LIKE 'rehearsal_items%')
     OR EXISTS (SELECT 1 FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='public'
         AND relation.relkind='i'
         AND relation.relname LIKE 'rehearsal_items%')
     OR EXISTS (SELECT 1 FROM pg_type object_type
       JOIN pg_namespace namespace ON namespace.oid=object_type.typnamespace
       WHERE namespace.nspname='public'
         AND object_type.typname LIKE 'rehearsal_items%') THEN
    RAISE EXCEPTION 'capture-only rehearsal fixture cleanup incomplete';
  END IF;
END
$capture_fixture_cleanup$;
COMMIT;`;
}

export function cleanupCaptureOnlyRehearsalFixtures({ executeSql }) {
  return executeSql(captureOnlyRehearsalFixtureCleanupSql());
}

export function validateRehearsalConfiguration(env) {
  if (env.REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL !== "1")
    throw new Error("private_pg17_rehearsal_explicit_opt_in_required");
  const sourceImage = env.REVIEW_ROUTER_REHEARSAL_PG16_IMAGE;
  const targetImage = env.REVIEW_ROUTER_REHEARSAL_PG17_IMAGE;
  if (
    !imagePattern.test(sourceImage ?? "") ||
    !imagePattern.test(targetImage ?? "")
  )
    throw new Error("private_pg17_rehearsal_immutable_images_required");
  if (
    !sourceImage.startsWith("postgres:16.13-") ||
    !targetImage.startsWith("postgres:17")
  )
    throw new Error("private_pg17_rehearsal_versions_invalid");
  return Object.freeze({ sourceImage, targetImage });
}

export function resolveRehearsalCaptureOnlyConfiguration(env) {
  if (
    env.REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY !==
    "1"
  )
    return undefined;
  const disposableDatabaseIdentity =
    env.REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY ?? "";
  if (
    !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
      disposableDatabaseIdentity,
    )
  )
    throw new Error(
      "activation_catalog_policy_candidate_disposable_identity_required",
    );
  return Object.freeze({ disposableDatabaseIdentity });
}

export function assertDisposableCaptureTarget({
  createdContainers,
  sourceContainer,
  targetContainer,
}) {
  if (
    !Array.isArray(createdContainers) ||
    typeof sourceContainer !== "string" ||
    typeof targetContainer !== "string" ||
    !createdContainers.includes(targetContainer) ||
    targetContainer === sourceContainer
  )
    throw new Error(
      "activation_catalog_policy_candidate_disposable_attestation_required",
    );
}

export async function routeRehearsalAfterReleaseMigration({
  captureOnly,
  captureCandidate,
  stageTargetServices,
}) {
  if (captureOnly)
    return Object.freeze({
      mode: "capture-only",
      candidate: await captureCandidate(),
    });
  return Object.freeze({
    mode: "rollout",
    rollout: await stageTargetServices(),
  });
}

export async function runRehearsalReleaseMigration({
  captureOnly,
  runStage,
  runReleaseMigration,
  captureCandidate,
  stageTargetServices,
}) {
  const migratedRollout = await runStage(
    "run_release_migration",
    runReleaseMigration,
  );
  const migrationReceipt = migratedRollout.receipts.at(-1);
  if (
    migratedRollout.targetManifestPhase !== "post_migration" ||
    migrationReceipt?.step !== RolloutStep.RunReleaseMigration ||
    migrationReceipt.transitionSha256 !==
      migratedRollout.migrationTransition.transitionSha256 ||
    migrationReceipt.migrationArtifactDigest !==
      migratedRollout.migrationTransition.migrationArtifactDigest ||
    migrationReceipt.postManifestIdentity !==
      migratedRollout.migrationTransition.postManifestIdentity ||
    migrationReceipt.migrationChecksum !==
      migratedRollout.migrationTransition.postManifestIdentity ||
    migrationReceipt.postCatalogDigest !==
      migratedRollout.migrationTransition.postCatalogDigest
  )
    throw new Error("private_pg17_rehearsal_phase_transition_unproven");
  if (captureOnly) {
    const policyCandidate = await runStage(
      "capture_activation_catalog_policy",
      captureCandidate,
    );
    if (
      policyCandidate?.kind !==
        "reviewrouter-activation-catalog-policy-artifact-candidate" ||
      policyCandidate.version !== 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(migrationReceipt.postCatalogDigest)
    )
      throw new Error(
        "activation_catalog_policy_candidate_migration_binding_invalid",
      );
    return Object.freeze({
      mode: "capture-only",
      candidate: Object.freeze({
        ...policyCandidate,
        version: 2,
        liveCatalogDigest: migrationReceipt.postCatalogDigest,
      }),
    });
  }
  return routeRehearsalAfterReleaseMigration({
    captureOnly: undefined,
    captureCandidate,
    stageTargetServices: () => stageTargetServices(migratedRollout),
  });
}

export async function cleanupDisposableRehearsalResources({
  releaseControl,
  prismaClients,
  createdContainers,
  networkCreated,
  network,
  directory,
  docker,
  removeDirectory = (path) => rmSync(path, { force: true, recursive: true }),
}) {
  let cleanupError;
  try {
    if (releaseControl) await releaseControl.close();
  } catch (error) {
    cleanupError ??= error;
  }
  const disconnects = await Promise.allSettled(
    prismaClients.map((client) => client?.$disconnect()),
  );
  for (const result of disconnects)
    if (result.status === "rejected") cleanupError ??= result.reason;
  for (const name of [...createdContainers].reverse()) {
    try {
      docker("rm", "--force", name);
    } catch (error) {
      if (
        !/No such container|removal of container .* is already in progress/u.test(
          String(error),
        )
      )
        cleanupError ??= error;
    }
  }
  if (networkCreated) {
    try {
      docker("network", "rm", network);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    removeDirectory(directory);
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

export function createRehearsalRunnerJobBinding({
  identity,
  observation,
  lifecycle,
  provisioningIntentId,
  providerCreationNotBefore,
}) {
  return Object.freeze({
    rolloutId: "disposable-rehearsal",
    serviceId: identity.baseServiceId,
    jobId: identity.renderJobId,
    observedAt: observation.observedAt,
    providerCreationNotBefore,
    cleanupCanary: identity.cleanupCanary,
    lifecycle,
    provisioningIntentId,
  });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function redactedErrorChain(error) {
  const safe = isSanitizedDiagnosticError(error)
    ? error
    : sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
      });
  return JSON.stringify(safe);
}

export function safeRehearsalStageErrorCode(error) {
  const message = error instanceof Error ? error.message : "";
  return /^(?:(?:private_pg17_rehearsal|release_rollout|runner_ledger|trusted_rollout)_[a-z0-9_]{2,160}|activation_catalog_policy_candidate_invalid:(?:preactivation|activated):(?:policy|roles|role-(?:shape|name|login|inherit|superuser|bypass-rls|replication|create-database|create-role|connection-limit|valid-until)|memberships|membership|reachability|row-security|row-security-policy|row-security-policy-order|row-security-order|extension|extension-order|grant|grant-order|effective-permissions|permission|permission-order|rehearsal-resource|unknown))$/u.test(
    message,
  )
    ? message
    : undefined;
}

async function cleanupDisposableRehearsalResourcesWithDiagnostics(options) {
  process.stderr.write("rehearsal_cleanup_started\n");
  try {
    await cleanupDisposableRehearsalResources(options);
    process.stderr.write("rehearsal_cleanup_completed\n");
  } catch (error) {
    process.stderr.write(
      `rehearsal_cleanup_failed:${safeRehearsalStageErrorCode(error) ?? redactedErrorChain(error)}\n`,
    );
    throw error;
  }
}

const safeReleaseMigrationInvariantMessages = Object.freeze([
  "release migration target permit invalid",
  "release migration target permit binding conflict",
  "release migration target permit caller invalid",
  "release migration target permit unavailable",
  "release migration target completion invalid",
  "release migration target completion binding conflict",
  "release migration target live completion mismatch:manifest_identity_observed",
  "release migration target live completion mismatch:catalog_digest_observed",
  "release migration target live completion mismatch:effect_fingerprint",
  "release migration target live completion mismatch:unfinished_migration",
  "release migration target live completion mismatch:active_lease",
  "release migration target live completion mismatch:fetched_setup_manifest",
  "release migration target live completion mismatch:unresolved_writeback_intent",
  "release migration target completion state conflict",
  "release migration target terminalization invalid",
  "release migration target terminalization binding conflict",
  "release migration target completion missing",
  "release migration target quarantine conflict",
  "release migration target receipt caller invalid",
  "release migration target receipt unavailable",
  "release migration database delegation is non-canonical",
  "release migration executor caller invalid",
  "release migration executor ACL gate mode invalid",
  "release migration executor replay ACL gate mode conflict",
  "release migration executor permit invalid",
  "release migration executor runtime CONNECT gate mismatch",
  "release migration executor runtime write gate mismatch",
  "release migration post manifest mismatch",
  "release migration unresolved history",
  "release migration V72 catalog postcondition missing",
  "release migration V72 routine security invalid",
  "release migration V70-V73 live catalog digest mismatch",
]);

const safeReleaseAuthorityInvariantMessages = Object.freeze([
  "release migration source evidence invalid",
  "release migration source evidence timestamp invalid",
  "release migration source evidence ordering invalid",
  "release migration source evidence digest invalid",
  "release migration source receipt digest invalid",
  "release migration begin shape invalid",
  "release migration begin binding conflict",
  "release migration begin phase conflict",
]);

export function safeReleaseAuthorityErrorClassification(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["message", "originalMessage"]) {
      const message = current[key];
      if (typeof message !== "string") continue;
      if (key === "message" && /^[a-z][a-z0-9_]{2,160}$/u.test(message))
        return message;
      const classification = safeReleaseAuthorityInvariantMessages.find(
        (candidate) => message.includes(candidate),
      );
      if (classification) return classification;
      if (
        key === "originalMessage" &&
        current.originalCode === "P0001" &&
        /^release (?:migration|rollout|authority) [a-z0-9 _:-]{1,160}$/u.test(
          message,
        )
      )
        return message;
      if (
        key === "originalMessage" &&
        current.originalCode === "42501" &&
        /^permission denied for (?:schema release_authority|(?:table|relation) source_legacy_ambiguity_receipt)$/u.test(
          message,
        )
      )
        return message;
    }
    for (const key of ["cause", "meta", "driverAdapterError"])
      if (current[key] && typeof current[key] === "object")
        pending.push(current[key]);
  }
  return undefined;
}

export function summarizeErrorShape(error) {
  const pending = [{ path: "error", value: error, depth: 0 }];
  const seen = new Set();
  const objects = [];
  while (pending.length > 0 && objects.length < 32) {
    const current = pending.shift();
    if (
      !current?.value ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    )
      continue;
    seen.add(current.value);
    const keys = Object.getOwnPropertyNames(current.value).sort();
    objects.push({
      path: current.path,
      constructor: current.value.constructor?.name ?? "Object",
      keys,
    });
    if (current.depth >= 5) continue;
    for (const key of keys) {
      const child = current.value[key];
      if (child && typeof child === "object")
        pending.push({
          path: `${current.path}.${key}`,
          value: child,
          depth: current.depth + 1,
        });
    }
  }
  return Object.freeze(objects);
}

export function safePostgresErrorClassification(stderr) {
  const sqlState = stderr?.match(/ERROR:\s*([0-9A-Z]{5}):/u)?.[1];
  const normalizedStderr = stderr?.replace(
    /ERROR:\s*[0-9A-Z]{5}:\s*/gu,
    "ERROR: ",
  );
  const prismaCode = sqlState
    ? undefined
    : stderr?.match(/\b(P[0-9]{4})\b/u)?.[1];
  if (prismaCode) {
    const migration = stderr?.match(
      /Migration name:\s*([0-9]{6}_[a-z0-9_]+)/u,
    )?.[1];
    return migration
      ? `prisma ${prismaCode} migration ${migration}`
      : `prisma ${prismaCode}`;
  }
  if (/Error loading config file|Failed to load config/u.test(stderr ?? ""))
    return "prisma configuration load failed";
  const missingRoutine = normalizedStderr?.match(
    /ERROR:\s*function\s+((?:public|reviewrouter_[a-z_]+)\.(?:"[a-z0-9_]+"|[a-z0-9_]+))\([^\n]*\) does not exist/iu,
  )?.[1];
  if (missingRoutine) return `function ${missingRoutine} does not exist`;
  const deniedObject = normalizedStderr?.match(
    /ERROR:\s*permission denied for (table|schema|function|procedure|sequence|relation) ([A-Za-z_][A-Za-z0-9_$.-]*)/iu,
  );
  if (deniedObject)
    return `permission denied for ${deniedObject[1]?.toLowerCase()} ${deniedObject[2]}`;
  if (/ERROR:\s*permission denied/iu.test(normalizedStderr ?? ""))
    return "permission denied";
  const namedInvariant = normalizedStderr?.match(
    /ERROR:\s*((?:codex_oauth|reviewrouter|runtime|release)_[a-z0-9_]{2,160})(?:\n|$)/iu,
  )?.[1];
  if (namedInvariant) return namedInvariant.toLowerCase();
  const missingObject = normalizedStderr?.match(
    /ERROR:\s*((?:relation|role|schema|function|procedure) "[A-Za-z][A-Za-z0-9_.]{0,127}" does not exist)(?:\n|$)/iu,
  )?.[1];
  if (missingObject) return missingObject.toLowerCase();
  const staticInvariant = normalizedStderr?.match(
    /ERROR:\s*([a-z][a-z0-9 -]{2,100})(?:\n|$)/iu,
  )?.[1];
  if (staticInvariant) {
    const normalizedInvariant = staticInvariant.toLowerCase();
    const digestEvidence =
      normalizedInvariant === "activation catalog policy mismatch"
        ? stderr?.match(
            /DETAIL:\s*sections=([A-Za-z,]+) expected=(sha256:[a-f0-9]{64}) observed=(sha256:[a-f0-9]{64})(?:\n|$)/u,
          )
        : undefined;
    return digestEvidence
      ? `${normalizedInvariant}:sections=${digestEvidence[1]}:expected=${digestEvidence[2]}:observed=${digestEvidence[3]}`
      : normalizedInvariant;
  }
  const releaseInvariant = safeReleaseMigrationInvariantMessages.find(
    (message) => normalizedStderr?.includes(message),
  );
  if (releaseInvariant) {
    const digestEvidence =
      releaseInvariant ===
      "release migration target live completion mismatch:catalog_digest_observed"
        ? stderr?.match(
            /DETAIL:\s*expected=(sha256:[a-f0-9]{64}) observed=(sha256:[a-f0-9]{64})(?:\n|$)/u,
          )
        : undefined;
    return digestEvidence
      ? `${releaseInvariant.toLowerCase()}:expected=${digestEvidence[1]}:observed=${digestEvidence[2]}`
      : releaseInvariant.toLowerCase();
  }
  if (/ERROR:\s*release migration/iu.test(normalizedStderr ?? ""))
    return "release migration invariant rejected";
  if (sqlState) return `postgres sqlstate ${sqlState}`;
  if (/ERROR:/u.test(normalizedStderr ?? "")) return "postgres error";
  return undefined;
}

export const disposableSqlConfiguration = () => ({
  releaseUrl:
    "postgresql://reviewrouter_release_migration:disposable-release@127.0.0.1:5432/review_router",
  roles: [
    { role: "api", username: "reviewrouter_api", password: "disposable-api" },
    { role: "web", username: "reviewrouter_web", password: "disposable-web" },
    {
      role: "worker",
      username: "reviewrouter_worker",
      password: "disposable-worker",
    },
    {
      role: "comment-token-custody",
      username: "reviewrouter_comment_token_custody",
      password: "disposable-custody",
    },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
      password: "disposable-effect",
    },
  ],
  releasePassword: "disposable-release",
});

/**
 * The pre-release source models an already provisioned SaaS database. Some
 * retained migrations deliberately choose a baseline/self-hosted path only
 * when both release-authority roles are absent, so those roles must exist
 * before Prisma applies the retained baseline. Target role bootstrap remains
 * a separate, post-copy operation.
 */
export function disposablePg16SourceAuthorityRoleFoundationSql() {
  return `CREATE ROLE reviewrouter_release_migration LOGIN PASSWORD 'disposable-release'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE reviewrouter_release_schema_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`;
}

export function assertDisposablePreReleaseAuthorityTopologySql() {
  return `DO $assert_live_authority_topology$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'reviewrouter_release_migration'
      AND rolcanlogin AND rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
      AND rolconnlimit = -1 AND rolvaliduntil IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'reviewrouter_release_schema_owner'
      AND NOT rolcanlogin AND rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
      AND rolconnlimit = -1 AND rolvaliduntil IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ReviewProviderScopeConcurrencyControl_baseline_closed'
  ) OR to_regprocedure(
    'public.reviewrouter_provider_scope_concurrency_snapshot()'
  ) IS NULL OR (
    SELECT owner.rolname
    FROM pg_proc routine
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE routine.oid = to_regprocedure(
      'public.reviewrouter_provider_scope_concurrency_snapshot()'
    )
  ) IS DISTINCT FROM 'reviewrouter_release_schema_owner' THEN
    RAISE EXCEPTION
      'private_pg17_rehearsal_source_authority_topology_drift';
  END IF;
END
$assert_live_authority_topology$;`;
}

export function assertDisposableProviderScopeConcurrencyAuthoritySql() {
  return `DO $assert_provider_scope_concurrency_authority$
DECLARE denied_role text;
DECLARE routine_count integer;
DECLARE canonical_count integer;
DECLARE explicit_execute_count integer;
DECLARE owner_execute_count integer;
DECLARE release_execute_count integer;
DECLARE canonical_execute_count integer;
BEGIN
  SELECT count(*), count(*) FILTER (
    WHERE owner.rolname = 'reviewrouter_release_schema_owner'
      AND routine.prosecdef
      AND routine.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
  )
  INTO routine_count, canonical_count
  FROM pg_proc routine
  JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
  JOIN pg_roles owner ON owner.oid = routine.proowner
  WHERE namespace.nspname = 'public'
    AND routine.pronargs = 0
    AND routine.proname = ANY (ARRAY[
      'reviewrouter_provider_scope_concurrency_snapshot',
      'reviewrouter_provider_scope_concurrency_status',
      'reviewrouter_provider_scope_concurrency_activate',
      'reviewrouter_provider_scope_concurrency_close_for_rollback',
      'reviewrouter_provider_scope_concurrency_verify_rollback'
    ]);
  SELECT count(*),
         count(*) FILTER (
           WHERE acl.grantee = routine.proowner
         ),
         count(*) FILTER (
           WHERE acl.grantee = 'reviewrouter_release_migration'::regrole
         ),
         count(*) FILTER (
           WHERE (
             acl.grantee = routine.proowner
             AND acl.grantor = routine.proowner
             AND NOT acl.is_grantable
           ) OR (
             acl.grantee = 'reviewrouter_release_migration'::regrole
             AND routine.proname <>
               'reviewrouter_provider_scope_concurrency_snapshot'
             AND acl.grantor = routine.proowner
             AND NOT acl.is_grantable
           )
         )
  INTO explicit_execute_count, owner_execute_count, release_execute_count,
       canonical_execute_count
  FROM pg_proc routine
  JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(routine.proacl, acldefault('f', routine.proowner))
  ) acl
  WHERE namespace.nspname = 'public'
    AND routine.pronargs = 0
    AND routine.proname = ANY (ARRAY[
      'reviewrouter_provider_scope_concurrency_snapshot',
      'reviewrouter_provider_scope_concurrency_status',
      'reviewrouter_provider_scope_concurrency_activate',
      'reviewrouter_provider_scope_concurrency_close_for_rollback',
      'reviewrouter_provider_scope_concurrency_verify_rollback'
    ])
    AND acl.privilege_type = 'EXECUTE';
  IF routine_count <> 5 OR canonical_count <> 5
     OR explicit_execute_count <> 9
     OR owner_execute_count <> 5
     OR release_execute_count <> 4
     OR canonical_execute_count <> 9
     OR has_function_privilege(
       'reviewrouter_release_migration',
       'public.reviewrouter_provider_scope_concurrency_snapshot()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'private_pg17_rehearsal_provider_scope_concurrency_authority_failed';
  END IF;
  FOREACH denied_role IN ARRAY ARRAY[
    'reviewrouter_api', 'reviewrouter_web', 'reviewrouter_worker',
    'reviewrouter_comment_token_custody',
    'reviewrouter_codex_effect_authority',
    'reviewrouter_activation_permit_installer',
    'reviewrouter_activation_receipt_reader',
    'reviewrouter_role_bootstrap'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'public'
        AND routine.pronargs = 0
        AND routine.proname = ANY (ARRAY[
          'reviewrouter_provider_scope_concurrency_snapshot',
          'reviewrouter_provider_scope_concurrency_status',
          'reviewrouter_provider_scope_concurrency_activate',
          'reviewrouter_provider_scope_concurrency_close_for_rollback',
          'reviewrouter_provider_scope_concurrency_verify_rollback'
        ])
        AND has_function_privilege(denied_role, routine.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION
        'private_pg17_rehearsal_provider_scope_concurrency_denied_role:%',
        denied_role;
    END IF;
  END LOOP;
END
$assert_provider_scope_concurrency_authority$;`;
}

export function disposableProviderScopeConcurrencyAdversarialAclSql() {
  return `GRANT EXECUTE ON FUNCTION
  public.reviewrouter_provider_scope_concurrency_snapshot(),
  public.reviewrouter_provider_scope_concurrency_status()
TO reviewrouter_provider_administrator WITH GRANT OPTION;
SET ROLE reviewrouter_provider_administrator;
GRANT EXECUTE ON FUNCTION
  public.reviewrouter_provider_scope_concurrency_snapshot(),
  public.reviewrouter_provider_scope_concurrency_status()
TO reviewrouter_api;
RESET ROLE;
DO $assert_adversarial_provider_scope_concurrency_acl$
BEGIN
  IF (SELECT count(*)
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(
        coalesce(routine.proacl, acldefault('f', routine.proowner))
      ) acl
      WHERE namespace.nspname = 'public'
        AND routine.pronargs = 0
        AND routine.proname IN (
          'reviewrouter_provider_scope_concurrency_snapshot',
          'reviewrouter_provider_scope_concurrency_status'
        )
        AND acl.grantee = 'reviewrouter_provider_administrator'::regrole
        AND acl.grantor = routine.proowner
        AND acl.privilege_type = 'EXECUTE'
        AND acl.is_grantable) <> 2
     OR (SELECT count(*)
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         CROSS JOIN LATERAL aclexplode(
           coalesce(routine.proacl, acldefault('f', routine.proowner))
         ) acl
         WHERE namespace.nspname = 'public'
           AND routine.pronargs = 0
           AND routine.proname IN (
             'reviewrouter_provider_scope_concurrency_snapshot',
             'reviewrouter_provider_scope_concurrency_status'
           )
           AND acl.grantee = 'reviewrouter_api'::regrole
           AND acl.grantor =
             'reviewrouter_provider_administrator'::regrole
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable) <> 2 THEN
    RAISE EXCEPTION
      'private_pg17_rehearsal_adversarial_operator_acl_setup_failed';
  END IF;
END
$assert_adversarial_provider_scope_concurrency_acl$;`;
}

export function disposableProviderScopeConcurrencyExerciseSql() {
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT public.reviewrouter_provider_scope_concurrency_status();
SELECT public.reviewrouter_provider_scope_concurrency_activate();
SELECT public.reviewrouter_provider_scope_concurrency_close_for_rollback();
SELECT public.reviewrouter_provider_scope_concurrency_verify_rollback();
ROLLBACK;`;
}

export function disposablePg17TargetRoleFoundationSql({
  providerAdminUsername = "reviewrouter_provider_administrator",
  demoteProvider = true,
} = {}) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(providerAdminUsername))
    throw new Error("private_pg17_rehearsal_provider_role_invalid");
  return `CREATE ROLE reviewrouter_role_bootstrap LOGIN PASSWORD 'disposable-bootstrap' SUPERUSER CREATEROLE;
CREATE ROLE reviewrouter_api LOGIN PASSWORD 'disposable-api';
CREATE ROLE reviewrouter_web LOGIN PASSWORD 'disposable-web';
CREATE ROLE reviewrouter_worker LOGIN PASSWORD 'disposable-worker';
CREATE ROLE reviewrouter_comment_token_custody LOGIN PASSWORD 'disposable-custody';
CREATE ROLE reviewrouter_codex_effect_authority LOGIN PASSWORD 'disposable-effect';
CREATE ROLE reviewrouter_release_migration LOGIN PASSWORD 'disposable-release';
CREATE ROLE reviewrouter_release_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN;
CREATE ROLE reviewrouter_activation_permit_installer LOGIN PASSWORD 'disposable-installer';
CREATE ROLE reviewrouter_activation_receipt_reader LOGIN PASSWORD 'disposable-receipt-reader';
DO $remove_pg17_provider_memberships$
DECLARE edge record;
BEGIN
  FOR edge IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member
    WHERE granted.rolname='${providerAdminUsername}'
       OR member.rolname='${providerAdminUsername}'
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I GRANTED BY CURRENT_ROLE',
      edge.granted_name,edge.member_name
    );
  END LOOP;
END
$remove_pg17_provider_memberships$;
ALTER DATABASE review_router OWNER TO reviewrouter_role_bootstrap;
ALTER SCHEMA public OWNER TO reviewrouter_role_bootstrap;
GRANT reviewrouter_api TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT reviewrouter_web TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT reviewrouter_worker TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT reviewrouter_comment_token_custody TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT reviewrouter_codex_effect_authority TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SET ROLE reviewrouter_role_bootstrap;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
RESET ROLE;
DO $provider_extension_owners$ DECLARE item record; BEGIN
  FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgcrypto' AND p.proowner='${providerAdminUsername}'::regrole LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap', item.oid::regprocedure);
  END LOOP;
  FOR item IN SELECT t.typname, t.typtype FROM pg_type t JOIN pg_depend d ON d.classid='pg_type'::regclass AND d.objid=t.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgcrypto' AND t.typowner='${providerAdminUsername}'::regrole AND t.typtype IN ('d','e','m','r') LOOP
    EXECUTE CASE WHEN item.typtype='d' THEN format('ALTER DOMAIN public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) ELSE format('ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) END;
  END LOOP;
END $provider_extension_owners$;
${
  demoteProvider
    ? `UPDATE pg_catalog.pg_authid
SET rolsuper=false, rolcanlogin=false, rolcreatedb=false,
    rolcreaterole=false, rolreplication=false, rolbypassrls=false
WHERE rolname='${providerAdminUsername}';`
    : ""
}`;
}

export function disposablePg17CanonicalRoleBootstrapSetupSql() {
  // These are pre-provisioning preparations. roleProvisioningSql owns the
  // bootstrap's atomic self-demotion at the end of its trusted transaction.
  return Object.freeze({
    publicTableAclCanonicalization:
      disposableTargetPublicTableAclCanonicalizationSql(),
    activationAuthorityProvisioning: activationAuthorityProvisioningSql(),
  });
}

export function normalizeRehearsalDockerInvocation(args, input) {
  const safeArgs = [...args];
  let safeInput = input;
  const psqlIndex = safeArgs.indexOf("psql");
  if (psqlIndex >= 0) {
    for (let index = psqlIndex + 1; index < safeArgs.length; index += 1) {
      const arg = safeArgs[index];
      if (arg === "-c" || /^-[A-Za-z]*c$/u.test(arg)) {
        if (safeInput !== undefined || index + 1 >= safeArgs.length)
          throw sanitizedDiagnosticError({
            code: "private_pg17_rehearsal_command_failed",
            phase: "process_boundary",
          });
        safeInput = safeArgs[index + 1];
        safeArgs.splice(index, 2);
        if (arg !== "-c") {
          const remaining = arg.slice(0, -1);
          if (remaining !== "-") safeArgs.splice(index, 0, remaining);
        }
        break;
      }
    }
    const execIndex = safeArgs.lastIndexOf("exec", psqlIndex);
    if (
      safeInput !== undefined &&
      execIndex >= 0 &&
      !safeArgs
        .slice(execIndex + 1, psqlIndex)
        .some((arg) => arg === "-i" || arg === "--interactive")
    ) {
      safeArgs.splice(execIndex + 1, 0, "--interactive");
    }
  }
  if (
    safeArgs.some(
      (arg) =>
        arg.startsWith("postgres://") ||
        arg.startsWith("postgresql://") ||
        /(?:password|token|private[_-]?key)=/iu.test(arg),
    )
  )
    throw sanitizedDiagnosticError({
      code: "private_pg17_rehearsal_command_failed",
      phase: "process_boundary",
    });
  return Object.freeze({ args: Object.freeze(safeArgs), input: safeInput });
}

export function waitForFinalPostgresServer(
  execute,
  container,
  { maxAttempts = 30, username = "postgres" } = {},
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const output = execute(
        [
          "exec",
          container,
          "psql",
          "--host",
          "127.0.0.1",
          "--username",
          username,
          "--dbname",
          "review_router",
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--quiet",
        ],
        { input: "SELECT 1;\n", timeout: 2_000 },
      );
      if (output.trim() === "1") return;
    } catch {
      // The official image's temporary init server is deliberately ignored:
      // only the final server accepts this loopback TCP connection.
    }
    if (attempt + 1 < maxAttempts) {
      try {
        execute(["exec", container, "sleep", "1"], { timeout: 2_000 });
      } catch {
        // Preserve the bounded readiness retry and its secret-safe diagnostic.
      }
    }
  }
  throw new Error("private_pg17_rehearsal_database_timeout");
}

export async function waitForRehearsalControlReady(
  probe,
  {
    maxAttempts = 900,
    intervalMilliseconds = 100,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (
    typeof probe !== "function" ||
    typeof sleep !== "function" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(intervalMilliseconds) ||
    intervalMilliseconds < 1
  )
    throw new Error("private_pg17_rehearsal_control_readiness_invalid");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if ((await probe()) === 200) return;
    } catch {
      // The initial attestation is deliberately asynchronous and fail-closed.
    }
    if (attempt + 1 < maxAttempts) await sleep(intervalMilliseconds);
  }
  throw new Error("private_pg17_rehearsal_control_readiness_timeout");
}

export async function executeDisposableRehearsal(
  env = process.env,
  execute = (args, options = {}) => {
    const invocation = normalizeRehearsalDockerInvocation(args, options.input);
    const result = spawnSync("docker", invocation.args, {
      encoding: options.encoding ?? "utf8",
      input: invocation.input,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
    });
    if (result.status !== 0 || result.error)
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
    return result.stdout;
  },
) {
  const images = validateRehearsalConfiguration(env);
  const captureOnly = resolveRehearsalCaptureOnlyConfiguration(env);
  if (!captureOnly) {
    try {
      assertCanonicalActivationCatalogPolicyTrustRootReady();
    } catch {
      throw new Error(
        `private_pg17_rehearsal_activation_catalog_policy_trust_root_blocked:${canonicalActivationCatalogPolicyTrustRootReadiness.reason}`,
      );
    }
  }
  const suffix = randomBytes(6).toString("hex");
  const source = `rr-pg16-${suffix}`;
  const target = `rr-pg17-${suffix}`;
  const authority = `rr-authority-pg17-${suffix}`;
  const network = `rr-pg-cutover-${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), "reviewrouter-pg17-rehearsal-"));
  const dumpPath = join(directory, "source.dump");
  const password = "disposable-reviewrouter-only";
  const postgresEnvFile = join(directory, "postgres.env");
  const targetPostgresEnvFile = join(directory, "target-postgres.env");
  writeFileSync(
    postgresEnvFile,
    `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=review_router\n`,
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    targetPostgresEnvFile,
    `POSTGRES_USER=reviewrouter_provider_administrator\nPOSTGRES_PASSWORD=disposable-provider-administrator\nPOSTGRES_DB=review_router\n`,
    { mode: 0o600, flag: "wx" },
  );
  let networkCreated = false;
  let releaseControl;
  let controlPrisma;
  let providerAuthorityPrisma;
  let permitInstallerPrisma;
  let targetReceiptReaderPrisma;
  let witnessPrisma;
  let targetAdministrativeRole = "reviewrouter_provider_administrator";
  const authorityBootstrapRole = "reviewrouter_rehearsal_authority_bootstrap";
  const createdContainers = [];
  const docker = (...args) => execute(args);
  const sql = (container, statement) =>
    docker(
      "exec",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      container === target ? targetAdministrativeRole : "postgres",
      "-d",
      "review_router",
      "-Atqc",
      statement,
    ).trim();
  const authoritySql = (username, input, { capture = false } = {}) =>
    execute(
      [
        "exec",
        "--interactive",
        authority,
        "psql",
        "--no-psqlrc",
        "--quiet",
        ...(capture ? ["--tuples-only", "--no-align"] : []),
        "-U",
        username,
        "-d",
        "review_router",
      ],
      { input },
    ).trim();
  try {
    docker("network", "create", network);
    networkCreated = true;
    for (const [name, image] of [
      [source, images.sourceImage],
      [target, images.targetImage],
      [authority, images.targetImage],
    ]) {
      docker(
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        network,
        "--network-alias",
        name,
        "--publish",
        "127.0.0.1::5432",
        "--env-file",
        name === target ? targetPostgresEnvFile : postgresEnvFile,
        image,
      );
      createdContainers.push(name);
    }
    for (const name of [source, target, authority]) {
      waitForFinalPostgresServer(execute, name, {
        username: name === target ? targetAdministrativeRole : "postgres",
      });
    }
    if (
      !sql(source, "SHOW server_version_num").startsWith("160") ||
      !sql(target, "SHOW server_version_num").startsWith("170") ||
      !sql(authority, "SHOW server_version_num").startsWith("170")
    )
      throw new Error("private_pg17_rehearsal_server_version_mismatch");
    // Model a managed provider: its native bootstrap role becomes inaccessible,
    // while the application bootstrap retains the exact trusted
    // SUPERUSER+CREATEROLE authority until role provisioning self-demotes it.
    sql(target, disposablePg17TargetRoleFoundationSql());
    targetAdministrativeRole = "reviewrouter_role_bootstrap";
    const publishedPort = (container) => {
      const port = docker("port", container, "5432/tcp")
        .trim()
        .split(":")
        .at(-1);
      if (!port || !/^[1-9][0-9]*$/u.test(port))
        throw new Error("private_pg17_rehearsal_published_port_invalid");
      return port;
    };
    const sourcePort = publishedPort(source);
    const targetPort = publishedPort(target);
    const authorityPort = publishedPort(authority);
    sql(
      authority,
      "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE ROLE reviewrouter_release_control LOGIN PASSWORD 'disposable-control'; CREATE ROLE reviewrouter_provider_authority LOGIN PASSWORD 'disposable-provider'; CREATE ROLE reviewrouter_release_witness LOGIN PASSWORD 'disposable-witness'; CREATE ROLE reviewrouter_migration_issuer LOGIN PASSWORD 'disposable-issuer'; CREATE ROLE reviewrouter_bootstrap_administrator LOGIN PASSWORD 'disposable-bootstrap-admin' NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1; GRANT pg_signal_backend TO reviewrouter_bootstrap_administrator",
    );
    authoritySql(
      "reviewrouter_bootstrap_administrator",
      `SET createrole_self_grant=''; CREATE ROLE ${authorityBootstrapRole} LOGIN PASSWORD 'disposable-authority-bootstrap' NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;`,
    );
    sql(
      authority,
      `ALTER DATABASE review_router OWNER TO ${authorityBootstrapRole}`,
    );
    const authorityProviderRoot = JSON.parse(
      authoritySql(
        "reviewrouter_bootstrap_administrator",
        releaseAuthorityProviderRootProbeSql(
          `rr_root_probe_${randomBytes(16).toString("hex")}`,
        ),
        { capture: true },
      ),
    );
    authoritySql(
      authorityBootstrapRole,
      releaseAuthorityBootstrapPreparationSql(
        authorityBootstrapRole,
        authorityProviderRoot,
      ),
    );
    try {
      authoritySql(
        "reviewrouter_bootstrap_administrator",
        releaseAuthorityBootstrapProvisioningSql(
          authorityBootstrapRole,
          "disposable-authority-bootstrap",
          authorityProviderRoot,
          "fresh",
        ),
      );
    } finally {
      authoritySql(
        authorityBootstrapRole,
        releaseAuthorityBootstrapRelinquishSql(authorityBootstrapRole),
      );
    }
    authoritySql(
      authorityBootstrapRole,
      releaseAuthorityMigrationBundle("fresh-install", process.cwd()),
    );
    authoritySql(
      "reviewrouter_bootstrap_administrator",
      releaseAuthorityBootstrapCleanupSql(
        authorityBootstrapRole,
        authorityProviderRoot,
      ),
    );
    const authorityTerminalState = authoritySql(
      "reviewrouter_bootstrap_administrator",
      releaseAuthorityBootstrapTerminalSql(
        authorityBootstrapRole,
        authorityProviderRoot,
      ),
      { capture: true },
    );
    if (authorityTerminalState !== "terminal")
      throw new Error(
        "private_pg17_rehearsal_authority_terminal_state_unproven",
      );
    const authorityMigrationPostcondition = JSON.parse(
      authoritySql(
        "reviewrouter_release_control",
        `SELECT json_build_object(
          'schemaPresent', to_regnamespace('release_authority') IS NOT NULL,
          'schemaVersion', coalesce(
            (SELECT (obj_description(namespace.oid, 'pg_namespace')::jsonb
              ->> 'schemaVersion')::integer
             FROM pg_namespace namespace
             WHERE namespace.nspname='release_authority'),
            0
          ),
          'databaseOwner', (
            SELECT pg_get_userbyid(datdba)
            FROM pg_database WHERE datname=current_database()
          )
        )`,
        { capture: true },
      ),
    );
    if (
      authorityMigrationPostcondition.schemaPresent !== true ||
      authorityMigrationPostcondition.schemaVersion !==
        releaseAuthoritySchemaVersion ||
      authorityMigrationPostcondition.databaseOwner !==
        "reviewrouter_authority_owner"
    ) {
      process.stderr.write(
        `rehearsal_authority_migration_postcondition_mismatch:${JSON.stringify(authorityMigrationPostcondition)}\n`,
      );
      throw new Error(
        "private_pg17_rehearsal_authority_migration_postcondition_unproven",
      );
    }
    const preReleasePrisma = join(directory, "pre-release-prisma");
    cpSync(
      join(process.cwd(), "packages/platform/db/prisma"),
      preReleasePrisma,
      {
        recursive: true,
      },
    );
    const migrationNames = readdirSync(join(preReleasePrisma, "migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const migration of resolvePreReleaseMigrationExclusions(
      migrationNames,
    ))
      rmSync(join(preReleasePrisma, "migrations", migration), {
        recursive: true,
      });
    const preReleasePrismaConfig = join(directory, "prisma.config.mjs");
    const sourceDatabaseCredential = join(directory, "source-database-url");
    writeFileSync(
      sourceDatabaseCredential,
      `postgresql://postgres:${password}@127.0.0.1:${sourcePort}/review_router?sslmode=disable`,
      { mode: 0o600, flag: "wx" },
    );
    writeFileSync(
      preReleasePrismaConfig,
      `import { readFileSync } from "node:fs"; export default { schema: ${JSON.stringify(join(preReleasePrisma, "schema.prisma"))}, migrations: { path: ${JSON.stringify(join(preReleasePrisma, "migrations"))} }, datasource: { url: readFileSync(process.env.REVIEW_ROUTER_DATABASE_URL_FILE, "utf8").trim() } };\n`,
      { mode: 0o600 },
    );
    // Retained migrations observe the live SaaS authority pair. Provision it
    // before migration deployment so the disposable source cannot silently
    // take a baseline/self-hosted branch that production would never take.
    sql(source, disposablePg16SourceAuthorityRoleFoundationSql());
    const sourceMigration = spawnSync(
      "pnpm",
      [
        "--filter",
        "@reviewrouter/platform-db",
        "exec",
        "prisma",
        "migrate",
        "deploy",
        "--config",
        preReleasePrismaConfig,
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          REVIEW_ROUTER_DATABASE_URL_FILE: sourceDatabaseCredential,
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 600_000,
      },
    );
    if (sourceMigration.status !== 0 || sourceMigration.error)
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
        exitCode: sourceMigration.status,
        signal: sourceMigration.signal,
        timedOut: sourceMigration.error?.code === "ETIMEDOUT",
      });
    // Prove the retained baseline selected the SaaS authority branch. Merely
    // creating both role names is insufficient if a future migration changes
    // the branch predicate or ownership handoff.
    sql(source, assertDisposablePreReleaseAuthorityTopologySql());
    sql(
      source,
      `COMMENT ON DATABASE review_router IS '{"recoveryWitnessSha256":"${"a".repeat(64)}"}'; CREATE ROLE rehearsal_writer LOGIN; GRANT CONNECT ON DATABASE review_router TO rehearsal_writer; CREATE TABLE rehearsal_items(id bigserial PRIMARY KEY, value text NOT NULL UNIQUE); INSERT INTO rehearsal_items(value) VALUES ('one'),('two'),('three'); CREATE SCHEMA app_private; CREATE TABLE app_private.rehearsal_private(id integer PRIMARY KEY, value text); INSERT INTO app_private.rehearsal_private VALUES (1,'private'); CREATE SEQUENCE app_private.called_sequence; SELECT nextval('app_private.called_sequence'); CREATE SEQUENCE app_private.uncalled_sequence; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;`,
    );
    sql(
      target,
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC",
    );
    const baselinePrincipalInventory = JSON.parse(
      sql(source, effectivePrincipalInventorySql),
    );
    if (
      !baselinePrincipalInventory.grants.some(
        (grant) =>
          grant.principal === "PUBLIC" &&
          grant.capability === "table:read" &&
          grant.resource === "default:postgres:r:public",
      )
    )
      throw new Error(
        "private_pg17_rehearsal_pg16_default_acl_projection_failed",
      );
    const baselinePrincipalPolicy = draftEffectivePrincipalPolicy(
      baselinePrincipalInventory,
    );
    const targetPrincipalInventory = JSON.parse(
      sql(target, effectivePrincipalInventorySql),
    );
    if (
      !targetPrincipalInventory.grants.some(
        (grant) =>
          grant.principal === "PUBLIC" &&
          grant.capability === "table:read" &&
          grant.resource === "default:reviewrouter_role_bootstrap:r:public",
      )
    )
      throw new Error(
        "private_pg17_rehearsal_pg17_default_acl_projection_failed",
      );
    const targetPrincipalDecision = evaluateEffectivePrincipalInventory(
      targetPrincipalInventory,
      draftEffectivePrincipalPolicy(targetPrincipalInventory),
    );
    if (!targetPrincipalDecision.accepted)
      throw new Error(
        "private_pg17_rehearsal_target_principal_inventory_failed",
      );
    const attackedPrincipalInventory = JSON.parse(
      sql(
        source,
        `BEGIN;
CREATE ROLE rr_direct LOGIN;
GRANT CONNECT ON DATABASE review_router TO rr_direct;
GRANT UPDATE ON rehearsal_items TO rr_direct;
CREATE ROLE rr_parent NOLOGIN;
GRANT UPDATE ON rehearsal_items TO rr_parent;
CREATE ROLE rr_inherited LOGIN;
GRANT rr_parent TO rr_inherited;
CREATE ROLE rr_set_parent NOLOGIN;
GRANT DELETE ON rehearsal_items TO rr_set_parent;
CREATE ROLE rr_set_child LOGIN NOINHERIT;
GRANT rr_set_parent TO rr_set_child WITH INHERIT FALSE, SET TRUE;
CREATE ROLE rr_owner LOGIN;
CREATE TABLE rr_owned(value text);
ALTER TABLE rr_owned OWNER TO rr_owner;
CREATE ROLE rr_super LOGIN SUPERUSER;
CREATE ROLE rr_bypass LOGIN BYPASSRLS;
CREATE ROLE rr_column LOGIN;
GRANT UPDATE(value) ON rehearsal_items TO rr_column;
CREATE ROLE rr_sequence LOGIN;
GRANT USAGE ON SEQUENCE rehearsal_items_id_seq TO rr_sequence;
CREATE ROLE rr_routine LOGIN;
CREATE FUNCTION public.rr_attack_write() RETURNS void LANGUAGE sql
  AS $attack$ INSERT INTO rehearsal_items(value) VALUES ('attack') $attack$;
GRANT EXECUTE ON FUNCTION public.rr_attack_write() TO rr_routine;
CREATE ROLE "quoted writer" LOGIN;
GRANT UPDATE ON rehearsal_items TO "quoted writer";
GRANT UPDATE ON rehearsal_items TO PUBLIC;
${effectivePrincipalInventorySql};
ROLLBACK;`,
      ),
    );
    const adversarialPrincipalDecision = evaluateEffectivePrincipalInventory(
      attackedPrincipalInventory,
      baselinePrincipalPolicy,
    );
    const adversarialPrincipalViolations =
      adversarialPrincipalDecision.violations.join("\n");
    for (const expected of [
      "unexpected_login:rr_direct",
      "unexpected_permission:rr_inherited:table:update",
      "unexpected_permission:rr_set_child:table:delete",
      "unexpected_effective_principal:rr_owner",
      "unexpected_permission:rr_super:admin:superuser",
      "unexpected_permission:rr_bypass:admin:bypassrls",
      "unexpected_permission:rr_column:column:update",
      "unexpected_permission:rr_sequence:sequence:usage",
      "unexpected_permission:rr_routine:routine:execute",
      "unexpected_login:quoted writer",
      "unexpected_public_permission:table:update",
    ])
      if (!adversarialPrincipalViolations.includes(expected))
        throw new Error(
          `private_pg17_rehearsal_principal_attack_not_rejected:${expected}`,
        );
    sql(
      target,
      `COMMENT ON DATABASE review_router IS '{"recoveryWitnessSha256":"${"c".repeat(64)}"}'`,
    );
    sql(
      source,
      "BEGIN; REVOKE CONNECT ON DATABASE review_router FROM PUBLIC; REVOKE CONNECT ON DATABASE review_router FROM rehearsal_writer; COMMIT; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();",
    );
    const zeroSeries = [0, 1, 2].map(() =>
      Number(
        sql(
          source,
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
        ),
      ),
    );
    if (zeroSeries.some((value) => value !== 0))
      throw new Error("private_pg17_rehearsal_session_stabilization_failed");
    let reconnectDenied = false;
    try {
      docker(
        "exec",
        source,
        "psql",
        "-U",
        "rehearsal_writer",
        "-d",
        "review_router",
        "-Atqc",
        "SELECT 1",
      );
    } catch {
      reconnectDenied = true;
    }
    if (!reconnectDenied)
      throw new Error("private_pg17_rehearsal_reconnect_denial_failed");
    // Exercise the reversible side before activation, then quiesce again.
    sql(source, "GRANT CONNECT ON DATABASE review_router TO rehearsal_writer");
    docker(
      "exec",
      source,
      "psql",
      "-U",
      "rehearsal_writer",
      "-d",
      "review_router",
      "-Atqc",
      "SELECT 1",
    );
    sql(
      source,
      "REVOKE CONNECT ON DATABASE review_router FROM rehearsal_writer",
    );
    const snapshotSql = `SELECT json_build_object('rows',(SELECT count(*) FROM rehearsal_items),'hash',(SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM rehearsal_items t),'sequence',(SELECT json_build_object('lastValue',last_value,'isCalled',is_called) FROM rehearsal_items_id_seq),'privateRows',(SELECT json_agg(row_to_json(t) ORDER BY id) FROM app_private.rehearsal_private t),'calledSequence',(SELECT json_build_object('lastValue',last_value,'isCalled',is_called) FROM app_private.called_sequence),'uncalledSequence',(SELECT json_build_object('lastValue',last_value,'isCalled',is_called) FROM app_private.uncalled_sequence),'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),'migrations',(SELECT json_agg(m ORDER BY migration_name) FROM "_prisma_migrations" m))`;
    const sourceSnapshot = sql(source, snapshotSql);
    const sourceSystemIdentifier = sql(
      source,
      "SELECT system_identifier::text FROM pg_control_system()",
    );
    const sourceLegacyAmbiguity = rehearsalLegacyAmbiguityReceipt({
      rollout: {
        rolloutId: "disposable-rehearsal",
        source: {
          systemIdentifier: sourceSystemIdentifier,
          databaseName: "review_router",
          recoveryWitnessSha256: "a".repeat(64),
        },
      },
      fence: {
        fenceId: "source-fence:disposable-rehearsal",
        authorityPrincipal: "fence_authority",
        fencedInventorySha256: sha256(sourceSnapshot),
        observedAt: "2026-08-12T00:00:02.000Z",
      },
      inventory: {
        activeLeaseIds: [],
        fetchedSetupIds: [],
        pendingIntentIds: [],
        intentStatuses: [],
      },
      firstObservedAt: "2026-08-12T00:00:02.100Z",
      eligibilityCutoff: "2026-08-12T00:00:02.300Z",
    });
    persistRehearsalSourceOwnedReceipt(sql, source, sourceLegacyAmbiguity);
    const dump = execute(
      [
        "exec",
        source,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "review_router",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ],
      { encoding: "buffer" },
    );
    writeFileSync(dumpPath, dump);
    docker("cp", dumpPath, `${target}:/tmp/source.dump`);
    docker(
      "exec",
      target,
      "pg_restore",
      "-U",
      targetAdministrativeRole,
      "-d",
      "review_router",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "/tmp/source.dump",
    );
    const targetSnapshot = sql(target, snapshotSql);
    if (sourceSnapshot !== targetSnapshot)
      throw new Error("private_pg17_rehearsal_equivalence_failed");
    sql(source, "DROP SCHEMA app_private CASCADE");
    sql(target, "DROP SCHEMA app_private CASCADE");
    if (captureOnly) sql(source, "DROP TABLE public.rehearsal_items CASCADE");
    // Equivalence is already proven. The target must now match the reviewed
    // production catalog instead of carrying a rehearsal-only relation into
    // permit installation and activation.
    sql(target, "DROP TABLE public.rehearsal_items CASCADE");
    const configuration = disposableSqlConfiguration();
    const canonicalRoleBootstrapSetup =
      disposablePg17CanonicalRoleBootstrapSetupSql();
    sql(
      target,
      `ALTER DATABASE review_router OWNER TO reviewrouter_role_bootstrap;
       DO $transfer$ DECLARE item record; BEGIN
         FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=to_regrole('postgres') LOOP
           EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap', item.oid::regprocedure);
         END LOOP;
         FOR item IN SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner=to_regrole('postgres') AND t.typtype IN ('d','e','m','r') LOOP
           EXECUTE CASE WHEN item.typtype='d' THEN format('ALTER DOMAIN public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) ELSE format('ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) END;
         END LOOP;
       END $transfer$;
       ALTER SCHEMA public OWNER TO reviewrouter_role_bootstrap;
       SET ROLE reviewrouter_role_bootstrap;
       CREATE EXTENSION IF NOT EXISTS pgcrypto;
       RESET ROLE;
       DO $extension_owners$ DECLARE item record; BEGIN
         FOR item IN SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=to_regrole('postgres') AND c.relkind IN ('r','p','v','m','S','f') AND (c.relkind <> 'S' OR NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_class'::regclass AND dependency.objid=c.oid AND dependency.refclassid='pg_class'::regclass AND dependency.deptype IN ('a','i'))) LOOP
           EXECUTE CASE item.relkind WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) WHEN 'v' THEN format('ALTER VIEW %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) ELSE format('ALTER TABLE %s OWNER TO reviewrouter_role_bootstrap',item.oid::regclass) END;
         END LOOP;
         FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=to_regrole('postgres') LOOP
           EXECUTE format('ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap', item.oid::regprocedure);
         END LOOP;
         FOR item IN SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typowner=to_regrole('postgres') AND t.typtype IN ('d','e','m','r') LOOP
           EXECUTE CASE WHEN item.typtype='d' THEN format('ALTER DOMAIN public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) ELSE format('ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap',item.typname) END;
         END LOOP;
       END $extension_owners$;
       DO $generation$ DECLARE binding jsonb; BEGIN
         binding := jsonb_build_object(
           'version', 1,
           'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
           'recoveryWitnessSha256', '${"c".repeat(64)}'
         );
         EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
       END $generation$;`,
    );
    const disposableProviderRoles = JSON.parse(
      sql(
        target,
        `SELECT json_build_object(
           'bootstrapSuperuser', (
             SELECT rolsuper FROM pg_roles
             WHERE rolname='reviewrouter_role_bootstrap'
           ),
           'bootstrapCreateRole', (
             SELECT rolcreaterole FROM pg_roles
             WHERE rolname='reviewrouter_role_bootstrap'
           ),
           'providerAdministratorInert', (
             SELECT NOT rolsuper AND NOT rolcanlogin AND NOT rolcreatedb
               AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
               AND NOT EXISTS (
                 SELECT 1 FROM pg_auth_members membership
                 WHERE membership.member=provider_role.oid
                    OR membership.roleid=provider_role.oid
               )
             FROM pg_roles provider_role
             WHERE provider_role.rolname='reviewrouter_provider_administrator'
           ),
           'postgresAbsent', NOT EXISTS (
             SELECT 1 FROM pg_roles WHERE rolname='postgres'
           )
         )`,
      ),
    );
    if (
      disposableProviderRoles.bootstrapSuperuser !== true ||
      disposableProviderRoles.bootstrapCreateRole !== true ||
      disposableProviderRoles.providerAdministratorInert !== true ||
      disposableProviderRoles.postgresAbsent !== true
    )
      throw new Error(
        "private_pg17_rehearsal_provider_administrator_convergence_failed",
      );
    const url = (username, password) =>
      `postgresql://${username}:${password}@target.internal:${targetPort}/review_router?sslmode=disable`;
    const canonicalEnv = {
      REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL: url(
        "reviewrouter_role_bootstrap",
        "disposable-bootstrap",
      ),
      REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL: url(
        "reviewrouter_release_migration",
        configuration.releasePassword,
      ),
      REVIEW_ROUTER_API_DATABASE_URL: url(
        "reviewrouter_api",
        configuration.roles[0].password,
      ),
      REVIEW_ROUTER_WEB_DATABASE_URL: url(
        "reviewrouter_web",
        configuration.roles[1].password,
      ),
      REVIEW_ROUTER_WORKER_DATABASE_URL: url(
        "reviewrouter_worker",
        configuration.roles[2].password,
      ),
      REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL: url(
        "reviewrouter_comment_token_custody",
        configuration.roles[3].password,
      ),
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL: url(
        "reviewrouter_codex_effect_authority",
        configuration.roles[4].password,
      ),
      REVIEW_ROUTER_RELEASE_COMMIT_SHA: "d".repeat(40),
      REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: sha256(sourceSnapshot),
      REVIEW_ROUTER_ROLLOUT_ID: "disposable-rehearsal",
      REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER: sourceSystemIdentifier,
      REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER: sql(
        target,
        "SELECT system_identifier::text FROM pg_control_system()",
      ),
      REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256: "c".repeat(64),
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      REVIEW_ROUTER_CUTOVER_WORKFLOW_JOB_ID: "11",
    };
    const publicTableReadDrift = JSON.parse(
      sql(
        target,
        `SELECT json_build_object(
         'defaultAcl', EXISTS (
           SELECT 1
           FROM pg_default_acl default_acl
           CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) acl
           WHERE default_acl.defaclrole = 'reviewrouter_role_bootstrap'::regrole
             AND default_acl.defaclnamespace = 'public'::regnamespace
             AND default_acl.defaclobjtype = 'r'
             AND acl.grantee = 0
             AND acl.privilege_type = 'SELECT'
         ),
         'existingTableAcl', EXISTS (
           SELECT 1
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           CROSS JOIN LATERAL aclexplode(
             coalesce(relation.relacl, acldefault('r', relation.relowner))
           ) acl
           WHERE namespace.nspname = 'public'
             AND relation.relkind IN ('r','p','v','m','f')
             AND acl.grantee = 0
             AND acl.privilege_type = 'SELECT'
         )
       )`,
      ),
    );
    if (
      publicTableReadDrift.defaultAcl !== true ||
      publicTableReadDrift.existingTableAcl !== true
    )
      throw new Error("private_pg17_rehearsal_public_acl_drift_unproven");
    sql(target, canonicalRoleBootstrapSetup.publicTableAclCanonicalization);
    const remainingPublicTableReadAcl = sql(
      target,
      `SELECT EXISTS (
         SELECT 1
         FROM pg_default_acl default_acl
         CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) acl
         WHERE default_acl.defaclrole = 'reviewrouter_role_bootstrap'::regrole
           AND default_acl.defaclnamespace = 'public'::regnamespace
           AND default_acl.defaclobjtype = 'r'
           AND acl.grantee = 0
           AND acl.privilege_type = 'SELECT'
       ) OR EXISTS (
         SELECT 1
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN LATERAL aclexplode(
           coalesce(relation.relacl, acldefault('r', relation.relowner))
         ) acl
         WHERE namespace.nspname = 'public'
           AND relation.relkind IN ('r','p','v','m','f')
           AND acl.grantee = 0
           AND acl.privilege_type = 'SELECT'
       )`,
    );
    if (remainingPublicTableReadAcl !== "f")
      throw new Error("private_pg17_rehearsal_public_acl_cleanup_failed");
    execute(
      [
        "exec",
        "--interactive",
        target,
        "psql",
        "-U",
        targetAdministrativeRole,
        "-d",
        "review_router",
      ],
      { input: canonicalRoleBootstrapSetup.activationAuthorityProvisioning },
    );
    const assertCanonicalBootstrapPrivileged = () => {
      if (
        sql(
          target,
          `SELECT rolcanlogin AND rolsuper AND NOT rolcreatedb
             AND rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
           FROM pg_roles WHERE rolname='reviewrouter_role_bootstrap'`,
        ) !== "t"
      )
        throw new Error("private_pg17_rehearsal_bootstrap_privilege_failed");
    };
    const assertCanonicalBootstrapDemoted = () => {
      if (
        sql(
          target,
          `SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
             AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
           FROM pg_roles WHERE rolname='reviewrouter_role_bootstrap'`,
        ) !== "t"
      )
        throw new Error("private_pg17_rehearsal_bootstrap_demotion_failed");
    };
    const assertCanonicalPgcryptoAcl = () => {
      const pgcryptoAclObservation = JSON.parse(
        sql(
          target,
          `SELECT json_build_object(
           'routineNames', coalesce(json_agg(DISTINCT routine.proname), '[]'::json),
           'readerExecuteCount', count(*) FILTER (WHERE has_function_privilege(
             'reviewrouter_activation_receipt_reader', routine.oid, 'EXECUTE'
           )),
           'publicExecuteCount', count(*) FILTER (WHERE EXISTS (
             SELECT 1
             FROM aclexplode(coalesce(
               routine.proacl, acldefault('f', routine.proowner)
             )) acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ))
         )
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         JOIN pg_depend dependency
           ON dependency.classid = 'pg_proc'::regclass
          AND dependency.objid = routine.oid
          AND dependency.refclassid = 'pg_extension'::regclass
          AND dependency.deptype = 'e'
         JOIN pg_extension extension ON extension.oid = dependency.refobjid
         WHERE namespace.nspname = 'public'
           AND extension.extname = 'pgcrypto'`,
        ),
      );
      if (
        !["armor", "crypt", "digest"].every((routineName) =>
          pgcryptoAclObservation.routineNames?.includes(routineName),
        ) ||
        pgcryptoAclObservation.readerExecuteCount !== 0 ||
        pgcryptoAclObservation.publicExecuteCount !== 0
      )
        throw new Error("private_pg17_rehearsal_pgcrypto_acl_failed");
    };
    assertCanonicalPgcryptoAcl();
    sql(
      target,
      "GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_role_bootstrap",
    );
    const activationTrustRoots = activationRoutineBodyTrustRoots();
    const trustedDatabaseIdentity = {
      authorityDatabaseIdentity: {
        serverIdentity: sql(
          authority,
          "SELECT system_identifier::text FROM pg_control_system()",
        ),
        databaseIdentity: sql(
          authority,
          "SELECT oid::text FROM pg_database WHERE datname=current_database()",
        ),
        databaseName: "review_router",
      },
      targetDatabaseIdentity: {
        serverIdentity:
          canonicalEnv.REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER,
        databaseIdentity: sql(
          target,
          "SELECT oid::text FROM pg_database WHERE datname=current_database()",
        ),
        databaseName: "review_router",
      },
      authorityOwnerRoleName: sql(
        authority,
        "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='release_authority'",
      ),
      activationGuardRoleName: "reviewrouter_activation_receipt_guard",
      installerRoutineBodySha256:
        activationTrustRoots.installerRoutineBodySha256,
      readerRoutineBodySha256: activationTrustRoots.readerRoutineBodySha256,
    };
    const controlToken = randomBytes(32).toString("hex");
    const providerAuthorityToken = randomBytes(32).toString("hex");
    const authorityUrl = `postgresql://reviewrouter_release_control:disposable-control@127.0.0.1:${authorityPort}/review_router?sslmode=disable`;
    const providerAuthorityUrl = `postgresql://reviewrouter_provider_authority:disposable-provider@127.0.0.1:${authorityPort}/review_router?sslmode=disable`;
    const installerUrl = `postgresql://reviewrouter_activation_permit_installer:disposable-installer@127.0.0.1:${targetPort}/review_router?sslmode=disable`;
    const receiptReaderUrl = `postgresql://reviewrouter_activation_receipt_reader:disposable-receipt-reader@127.0.0.1:${targetPort}/review_router?sslmode=disable`;
    const witnessUrl = `postgresql://reviewrouter_release_witness:disposable-witness@127.0.0.1:${authorityPort}/review_router?sslmode=disable`;
    controlPrisma = createPrismaClient({
      databaseUrl: authorityUrl,
      poolMax: 2,
    });
    providerAuthorityPrisma = createPrismaClient({
      databaseUrl: providerAuthorityUrl,
      poolMax: 1,
    });
    permitInstallerPrisma = createPrismaClient({
      databaseUrl: installerUrl,
      poolMax: 1,
    });
    targetReceiptReaderPrisma = createPrismaClient({
      databaseUrl: receiptReaderUrl,
      poolMax: 1,
    });
    witnessPrisma = createPrismaClient({ databaseUrl: witnessUrl, poolMax: 1 });
    for (const [roleName, prisma] of [
      ["reviewrouter_release_control", controlPrisma],
      ["reviewrouter_provider_authority", providerAuthorityPrisma],
    ]) {
      const authorityReadiness =
        await observeReleaseAuthorityDatabaseReadiness(prisma);
      if (!releaseAuthoritySchemaIsReady(authorityReadiness)) {
        process.stderr.write(
          `rehearsal_authority_readiness_mismatch:${JSON.stringify({
            observed: summarizeAuthorityReadinessMismatch(authorityReadiness),
            expectedDatabaseIdentity:
              trustedDatabaseIdentity.authorityDatabaseIdentity,
          })}\n`,
        );
        throw new Error(
          `private_pg17_rehearsal_authority_readiness_unproven:${roleName}`,
        );
      }
    }
    const activationAttestation =
      await observeReleaseAuthorityDatabaseReadiness(permitInstallerPrisma);
    process.stderr.write(
      `rehearsal_target_readiness:pre_migration:permit_boundary=${activationAttestation.preMigrationPermitBoundaryExact}:full_guard=${activationAttestation.activationGuardExact}:runtime_privileges=${activationAttestation.activationRuntimePrivilegesExact}\n`,
    );
    if (
      !activationAttestation.preMigrationPermitBoundaryExact ||
      activationAttestation.activationGuardExact ||
      !activationAttestation.activationRuntimePrivilegesExact
    )
      throw new Error(
        "private_pg17_rehearsal_pre_migration_readiness_unproven",
      );
    process.stderr.write("rehearsal_control_stage_started:create_app\n");
    releaseControl = await createReleaseControlApp({
      controlPrisma,
      providerAuthorityPrisma,
      permitInstallerPrisma,
      targetReceiptReaderPrisma,
      credentials: {
        controlTokenSha256: createHash("sha256")
          .update(controlToken)
          .digest("hex"),
        providerAuthorityTokenSha256: createHash("sha256")
          .update(providerAuthorityToken)
          .digest("hex"),
      },
      deploymentRevision: canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA,
      artifactDigest: canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST,
      trustedDatabaseIdentity: {
        ...trustedDatabaseIdentity,
        targetMigrationManifestIdentity:
          activationAttestation.applicationMigrationManifestIdentity,
        activationNamespaceFingerprint:
          activationAttestation.activationNamespaceFingerprint,
      },
      trustedActivationCatalogPolicies: captureOnly
        ? canonicalActivationCatalogPolicies
        : authorizeCanonicalActivationCatalogPolicies(
            rehearsalActivationCatalogPolicyAuthorization,
          ),
      readinessPolicy: rehearsalReadinessPolicy,
    });
    process.stderr.write("rehearsal_control_stage_completed:create_app\n");
    releaseControl.addHook("onError", async (_request, _reply, error) => {
      const authorityClassification =
        safeReleaseAuthorityErrorClassification(error);
      if (authorityClassification)
        process.stderr.write(
          `rehearsal_control_authority_error:${authorityClassification}\n`,
        );
      else
        process.stderr.write(
          `rehearsal_control_error_shape:${JSON.stringify(summarizeErrorShape(error))}\n`,
        );
      process.stderr.write(
        `rehearsal_control_error:${redactedErrorChain(error)}\n`,
      );
    });
    process.stderr.write("rehearsal_control_stage_started:app_ready\n");
    await releaseControl.ready();
    process.stderr.write("rehearsal_control_stage_completed:app_ready\n");
    process.stderr.write("rehearsal_control_stage_started:health_ready\n");
    await waitForRehearsalControlReady(async () => {
      const status = (
        await releaseControl.inject({ method: "GET", url: "/health" })
      ).statusCode;
      if (status !== 200)
        process.stderr.write(
          `rehearsal_control_health_not_ready:status=${status}\n`,
        );
      return status;
    });
    process.stderr.write("rehearsal_control_stage_completed:health_ready\n");
    const controlFetch = async (input, init) => {
      const requestUrl = new URL(String(input));
      const response = await releaseControl.inject({
        method: init?.method ?? "GET",
        url: `${requestUrl.pathname}${requestUrl.search}`,
        headers: init?.headers,
        payload: init?.body,
      });
      if (response.statusCode >= 500) {
        let code = "unknown";
        const known = [
          "release rollout receipt replay conflict",
          "release rollout receipt transition invalid",
          "release rollout compensation transition invalid",
          "release rollout pre-activation step out of order",
          "release runner terminal cleanup witness unproven",
          "release runner terminal cas failed",
        ];
        code = known.find((value) => response.body.includes(value)) ?? code;
        let step = "unknown";
        try {
          const requestBody = JSON.parse(String(init?.body ?? "{}"));
          if (/^[a-z_]{1,80}$/u.test(String(requestBody.step ?? "")))
            step = requestBody.step;
        } catch {
          step = "unparseable";
        }
        process.stderr.write(
          `rehearsal_control_request_failed:${init?.method ?? "GET"}:${requestUrl.pathname}:${response.statusCode}:${code}:${step}\n`,
        );
      }
      return new globalThis.Response(
        response.statusCode === 204 ? null : response.body,
        {
          status: response.statusCode,
          headers: response.headers,
        },
      );
    };
    const authorityOrigin = "https://disposable-release-authority.invalid";
    const ledger = new AuthenticatedRunnerLedgerAdapter(
      authorityOrigin,
      controlToken,
      controlFetch,
    );
    const providerAuthority = new HttpProviderAuthorityDecisionAdapter(
      authorityOrigin,
      providerAuthorityToken,
      controlFetch,
    );
    const productionPath = await verifyProductionPathRehearsal({
      dumpSha256: sha256(dump),
      equivalenceSha256: sha256(sourceSnapshot),
      sourceSystemIdentifier,
      sourceLegacyAmbiguity,
      targetSystemIdentifier: sql(
        target,
        "SELECT system_identifier::text FROM pg_control_system()",
      ),
      canonicalEnv,
      targetPort,
      rehearsalDirectory: directory,
      ledger,
      providerAuthority,
      controlFetch,
      authorityOrigin,
      controlToken,
      providerAuthorityToken,
      controlPrisma,
      providerAuthorityPrisma,
      permitInstallerPrisma,
      targetReceiptReaderPrisma,
      witnessPrisma,
      authorityContainer: authority,
      sourceContainer: source,
      targetContainer: target,
      sql,
      assertCanonicalBootstrapPrivileged,
      assertCanonicalBootstrapDemoted,
      assertCanonicalPgcryptoAcl,
      createdContainers,
      captureOnly,
    });
    if (captureOnly) return productionPath;
    process.stderr.write(
      "rehearsal_postcondition_started:activation_receipt\n",
    );
    const durableActivationReceipt =
      await new RoutineTargetActivationReceiptReaderAdapter(
        targetReceiptReaderPrisma,
      ).read("disposable-rehearsal");
    process.stderr.write(
      "rehearsal_postcondition_completed:activation_receipt\n",
    );
    process.stderr.write("rehearsal_postcondition_started:api_privilege\n");
    const apiInsertPrivilege = sql(
      target,
      `SELECT has_table_privilege(
        'reviewrouter_api','public."AuditEvent"','INSERT'
      )`,
    );
    process.stderr.write("rehearsal_postcondition_completed:api_privilege\n");
    if (!durableActivationReceipt || apiInsertPrivilege !== "t")
      throw new Error("private_pg17_rehearsal_activation_failed");
    if (!productionPath.activationReplayStable)
      throw new Error("private_pg17_rehearsal_activation_replay_unstable");
    return Object.freeze({
      schemaVersion: 1,
      disposable: true,
      sourceMajor: 16,
      targetMajor: 17,
      dumpSha256: sha256(dump),
      equivalenceSha256: sha256(sourceSnapshot),
      aclGateBeforeActivation: "closed",
      activationReceipt: "disposable-rehearsal",
      activationReplayStable: true,
      authorityDatabaseMajor: 17,
      authorityDatabaseSeparate: true,
      productionPath,
    });
  } finally {
    // The disposable rehearsal must fail when resource cleanup is incomplete.
    await cleanupDisposableRehearsalResourcesWithDiagnostics({
      releaseControl,
      prismaClients: [
        controlPrisma,
        providerAuthorityPrisma,
        permitInstallerPrisma,
        targetReceiptReaderPrisma,
        witnessPrisma,
      ],
      createdContainers,
      networkCreated,
      network,
      directory,
      docker,
    });
  }
}

async function verifyProductionPathRehearsal(facts) {
  const digest = facts.equivalenceSha256;
  const assertTargetActivationReadiness = async (stage, expectedFullGuard) => {
    const readiness = await observeReleaseAuthorityDatabaseReadiness(
      facts.permitInstallerPrisma,
    );
    process.stderr.write(
      `rehearsal_target_readiness:${stage}:permit_boundary=${readiness.preMigrationPermitBoundaryExact}:full_guard=${readiness.activationGuardExact}:runtime_privileges=${readiness.activationRuntimePrivilegesExact}\n`,
    );
    if (
      !readiness.preMigrationPermitBoundaryExact ||
      !readiness.activationRuntimePrivilegesExact ||
      readiness.activationGuardExact !== expectedFullGuard
    )
      throw new Error(`private_pg17_rehearsal_${stage}_readiness_unproven`);
  };
  const redirect = (value) =>
    typeof value === "string"
      ? value.replace(
          `target.internal:${facts.targetPort}`,
          `127.0.0.1:${facts.targetPort}`,
        )
      : value;
  const connectCanonicalRun = createSecureCanonicalRun(
    () => "127.0.0.1",
    (step) => {
      process.stderr.write(`rehearsal_canonical_step_failed:${step}\n`);
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
      });
    },
  );
  const canonicalProcessRun = (step, command, args, options = {}) => {
    if (command !== "psql")
      return connectCanonicalRun(step, command, args, options);
    const urlIndex = args.findIndex(
      (arg) => arg.startsWith("postgres://") || arg.startsWith("postgresql://"),
    );
    if (urlIndex < 0) {
      const hostIndex = args.indexOf("--host");
      if (hostIndex < 0 || args[hostIndex + 1] !== "target.internal")
        throw new Error("rehearsal_psql_target_invalid");
      const normalized = normalizeSecretSafePostgresArguments(
        [...args, "--set=VERBOSITY=verbose"],
        options.input,
      );
      const allowedEnvironment = Object.fromEntries(
        Object.entries(options.env ?? {}).filter(([key]) =>
          ["PGPASSFILE", "PGAPPNAME", "PGCONNECT_TIMEOUT"].includes(key),
        ),
      );
      const result = spawnSync("psql", [...normalized.args], {
        encoding: "utf8",
        env: {
          ...allowedEnvironment,
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PGHOSTADDR: "127.0.0.1",
          PGSSLMODE: "disable",
        },
        input: normalized.input,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 600_000,
      });
      if (result.status !== 0 || result.error) {
        process.stderr.write(`rehearsal_canonical_step_failed:${step}\n`);
        const classification = safePostgresErrorClassification(result.stderr);
        if (classification)
          process.stderr.write(
            `rehearsal_canonical_postgres_error:${step}:${classification}\n`,
          );
        throw sanitizedDiagnosticError({
          code: "private_pg17_rehearsal_command_failed",
          phase: "rehearsal",
          exitCode: result.status,
          signal: result.signal,
          timedOut: result.error?.code === "ETIMEDOUT",
        });
      }
      return result.stdout;
    }
    const invocation = createSecretSafePostgresInvocation({
      databaseUrl: args[urlIndex],
      args: [
        ...args.filter((_, index) => index !== urlIndex),
        "--set=VERBOSITY=verbose",
      ],
      input: options.input,
      pgHostAddress: "127.0.0.1",
    });
    const credential = createDatabaseCredentialBoundary(
      redirect(args[urlIndex]),
    );
    try {
      const result = spawnSync("psql", invocation.args, {
        encoding: "utf8",
        env: {
          ...invocation.environment,
          ...credential.environment,
          PGSSLMODE: "disable",
        },
        input: invocation.input,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 600_000,
      });
      if (result.status !== 0 || result.error) {
        process.stderr.write(`rehearsal_canonical_step_failed:${step}\n`);
        const classification = safePostgresErrorClassification(result.stderr);
        if (classification)
          process.stderr.write(
            `rehearsal_canonical_postgres_error:${step}:${classification}\n`,
          );
        throw sanitizedDiagnosticError({
          code: "private_pg17_rehearsal_command_failed",
          phase: "rehearsal",
          exitCode: result.status,
          signal: result.signal,
          timedOut: result.error?.code === "ETIMEDOUT",
        });
      }
      return result.stdout;
    } finally {
      invocation.cleanup();
      credential.cleanup();
    }
  };
  const canonicalRun = (step, command, args, options = {}) =>
    canonicalProcessRun(step, command, args, {
      ...options,
      ...(options.env
        ? {
            env: Object.fromEntries(
              Object.entries(options.env).map(([key, value]) => [
                key,
                redirect(value),
              ]),
            ),
          }
        : {}),
    });
  const activationCommands = {
    execute(command, args, options) {
      return {
        stdout: canonicalProcessRun("activation", command, args, options),
      };
    },
  };
  const execution = {
    organization: "disposable-control",
    controlRepository: "disposable-control/releases",
    workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
    workflowRef: "refs/heads/main",
    event: "workflow_dispatch",
    actor: "rehearsal",
    runId: "1",
    runAttempt: 1,
    roleJobName: "private-role-job",
    cutoverJobName: "private-cutover-job",
  };
  let rollout = createReleaseRollout({
    rolloutId: "disposable-rehearsal",
    expectedCommitSha: "d".repeat(40),
    execution,
    source: {
      renderResourceId: "dpg-disposable-source",
      internalHostname: "source.internal",
      databaseName: "review_router",
      systemIdentifier: facts.sourceSystemIdentifier,
      majorVersion: 16,
      recoveryWitnessSha256: "a".repeat(64),
    },
    target: {
      renderResourceId: "dpg-disposable-target",
      internalHostname: "target.internal",
      databaseName: "review_router",
      systemIdentifier: facts.targetSystemIdentifier,
      majorVersion: 17,
      recoveryWitnessSha256: "c".repeat(64),
    },
    migrationTransition: createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: facts.canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST,
    }),
  });
  const runner = (lifecycle, job) => ({
    organization: execution.organization,
    repository: execution.controlRepository,
    workflowPath: execution.workflowPath,
    workflowRef: execution.workflowRef,
    event: execution.event,
    actor: execution.actor,
    runId: execution.runId,
    runAttempt: 1,
    workflowJobId: lifecycle === "role" ? "10" : "11",
    workflowJobName:
      lifecycle === "role" ? execution.roleJobName : execution.cutoverJobName,
    commitSha: "d".repeat(40),
    runnerName: `rr-${lifecycle}`,
    cleanupCanary: `rr-cleanup:disposable-rehearsal:rr-${lifecycle}`,
    renderJobId: job,
    baseServiceId: "srv-disposable",
    runnerGroupId: 1,
    runnerGroupName: "private-pg17",
    uniqueRunnerLabel: `rr-${lifecycle}`,
    workFolder: `_work/rr-${lifecycle}`,
    provenance: { kind: "image", deployId: "dep-disposable", imageSha: digest },
    imageAttestation: {
      subjectDigest: digest,
      sourceCommitSha: "d".repeat(40),
      statementSha256: digest,
      builderId: "disposable-rehearsal-builder",
    },
  });
  const roleRunner = runner("role", "job-role");
  const cutoverRunner = runner("cutover", "job-cutover");
  let tick = 0;
  const observed = (step, value = {}, provider) => ({
    step,
    observedAt: new Date(Date.UTC(2026, 7, 12, 0, 0, tick++)).toISOString(),
    facts: value,
    ...(provider ? { provider } : {}),
  });
  const sourceWitness = `source_rehearsal_${"w".repeat(48)}`;
  const targetWitness = `target_rehearsal_${"x".repeat(48)}`;
  const rawSha256 = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const serviceRoles = ["api", "web", "worker"];
  const sourceEnvironments = new Map();
  const protectedSourceEnvironment = {};
  const sourceServices = serviceRoles.map((role) => {
    const serviceId = `srv-target-${role}`;
    const protectedValues = {
      DATABASE_URL: `postgresql://source/${role}`,
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: sourceWitness,
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: rawSha256(sourceWitness),
      ...(["api", "web"].includes(role)
        ? {
            REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
              "postgresql://source/effect-authority",
          }
        : {}),
    };
    protectedSourceEnvironment[serviceId] = protectedValues;
    const environment = [
      ...Object.entries(protectedValues).map(([key, value]) => ({
        key,
        value,
      })),
      { key: "UNKNOWN_SECRET", value: `preserved-${role}` },
    ];
    sourceEnvironments.set(serviceId, environment);
    const value = {
      serviceId,
      ownerId: "tea-disposable",
      type: role === "worker" ? "background_worker" : "web_service",
      runtime: "node",
      repository: "https://github.com/777genius/review-router-saas",
      branch: "main",
      rootDir: "",
      sourceCommitSha: rollout.expectedCommitSha,
      buildCommand: "pnpm build",
      startCommand: `pnpm ${role}:start`,
      preDeployCommand: "",
      healthCheckPath: role === "worker" ? null : "/health",
      region: "frankfurt",
      plan: "starter",
      maxShutdownDelaySeconds: role === "worker" ? 120 : 60,
      autoDeploy: "no",
      databaseEnvKey: "DATABASE_URL",
      databaseRole: `reviewrouter_${role}`,
      sourceEnvSha256: environmentSha256(environment),
      sourceEnvKeysSha256: environmentKeysSha256(environment),
    };
    return {
      ...value,
      serviceContractSha256: renderSourceServiceContractSha256(value),
    };
  });
  const sourceManifestValue = {
    schemaVersion: "reviewrouter.render-source-recovery.v1",
    rolloutId: rollout.rolloutId,
    services: sourceServices,
  };
  const sourceManifest = fromRenderSourceRecoveryManifestV1({
    ...sourceManifestValue,
    manifestSha256: renderSourceRecoveryManifestSha256(sourceManifestValue),
  });
  const targetContracts = serviceRoles.map((role) => {
    const serviceId = `srv-target-${role}`;
    const environmentDelta = {
      DATABASE_URL: `postgresql://target/${role}`,
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: targetWitness,
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: rawSha256(targetWitness),
      ...(["api", "web"].includes(role)
        ? {
            REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
              "postgresql://target/effect-authority",
          }
        : {}),
      REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: rollout.expectedCommitSha,
      REVIEW_ROUTER_RUNTIME_ROLLOUT_ID: rollout.rolloutId,
      REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT: "2026-08-12T00:00:00.000Z",
      REVIEW_ROUTER_RUNTIME_SERVICE_ID: serviceId,
      REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE: digest.slice(-64),
    };
    const environment = [
      ...Object.entries(environmentDelta).map(([key, value]) => ({
        key,
        value,
      })),
      { key: "UNKNOWN_SECRET", value: `preserved-${role}` },
    ];
    const value = {
      serviceId,
      artifact: {
        kind: "container_image",
        reference: `ghcr.io/777genius/review-router-saas-runtime@${digest}`,
      },
      environmentDelta,
      removeKeys: [],
      environmentSha256: environmentSha256(environment),
    };
    return {
      ...value,
      configurationSha256: targetServiceConfigurationSha256(value),
    };
  });
  const targetServicePostcondition = (contract, suspended) => {
    const source = sourceManifest.services.find(
      (service) => service.serviceId === contract.serviceId,
    );
    const configuration = source?.configuration.payload;
    if (!source || !configuration)
      throw new Error("private_pg17_rehearsal_service_contract_missing");
    return Object.freeze({
      serviceId: contract.serviceId,
      ownerId: String(configuration.ownerId),
      serviceType: String(configuration.type),
      suspended,
      region: String(configuration.region),
      plan: String(configuration.plan),
      runtime: "image",
      image: contract.artifact.reference,
      repository: null,
      branch: null,
      rootDirectory: null,
      buildCommand: null,
      startCommand: null,
      preDeployCommand: String(configuration.preDeployCommand),
      healthPath:
        configuration.healthCheckPath === null
          ? null
          : String(configuration.healthCheckPath),
      automaticDeployments: false,
      automaticDeployTrigger: "off",
      shutdownDelaySeconds: Number(configuration.maxShutdownDelaySeconds),
      instanceCount: Number(configuration.numInstances ?? 1),
      environmentSha256: contract.environmentSha256,
    });
  };
  const stagedServices = new Map(
    sourceManifest.services.map((service) => [
      service.serviceId,
      {
        serviceId: service.serviceId,
        suspended: true,
        configurationSha256: service.configuration.sha256,
        environmentSha256: service.sourceEnvironmentSha256,
        provenance: {
          kind: "source_revision",
          revision: service.sourceRevision,
        },
      },
    ]),
  );
  const transactionalServices = new TransactionalServiceCutover(facts.ledger, {
    observe: async (serviceId) => stagedServices.get(serviceId),
    suspend: async (serviceId) => {
      stagedServices.get(serviceId).suspended = true;
    },
    resume: async (serviceId) => {
      stagedServices.get(serviceId).suspended = false;
    },
    configureTarget: async () => undefined,
    configureSource: async () => undefined,
    replaceEnvironment: async (serviceId) => {
      const contract = targetContracts.find(
        (item) => item.serviceId === serviceId,
      );
      const previousEnvironmentSha256 =
        stagedServices.get(serviceId).environmentSha256;
      stagedServices.get(serviceId).environmentSha256 =
        contract.environmentSha256;
      return {
        status: "applied",
        previousEnvironmentSha256,
        environmentSha256: contract.environmentSha256,
        environmentKeysSha256: environmentKeysSha256(
          sourceEnvironments.get(serviceId),
        ),
        replayed: false,
      };
    },
    deployArtifact: async (serviceId, reference) => {
      const contract = targetContracts.find(
        (item) => item.serviceId === serviceId,
      );
      const deployId = `dep-${serviceId}`;
      stagedServices.set(serviceId, {
        serviceId,
        suspended: true,
        configurationSha256: contract.configurationSha256,
        environmentSha256: contract.environmentSha256,
        provenance: {
          kind: "container_image",
          reference,
          deploymentId: deployId,
        },
        postcondition: targetServicePostcondition(contract, true),
      });
      return deployId;
    },
    deploySourceRevision: async () => {
      throw new Error("disposable_target_stage_commit_deploy_unexpected");
    },
    waitForDeployment: async () => undefined,
    reconcileSourceDeployment: async () => null,
    quiesceDeployments: async () => undefined,
  });
  const sqlConfiguration = disposableSqlConfiguration();
  const generated = {
    roleBootstrapSha256: `sha256:${sha256Canonical(roleProvisioningSql(sqlConfiguration))}`,
    migrationSha256: `sha256:${sha256Canonical(runtimeGrantSql(sqlConfiguration, { gateClosed: true }))}`,
  };
  let activationSqlSha256;
  const catalogSha256 = {
    sequences: digest,
    columnsDefaults: digest,
    constraintsIndexesTriggers: digest,
    policiesRls: digest,
    functionsViewsSchemas: digest,
    aclOwnershipDefaults: digest,
    migrationHistory: digest,
  };
  let provision = roleRunner;
  let cleanupStep = RolloutStep.CleanupRoleRunner;
  const ledger = facts.ledger;
  const witness = new PostgresCleanupObservationAdapter(facts.witnessPrisma);
  const providerCreationBoundaries = new Map();
  const persistRunnerBinding = async (identity, observation, lifecycle) => {
    const intentId = `rri-${createHash("sha256")
      .update(`disposable-rehearsal:${lifecycle}:${identity.workflowJobId}`)
      .digest("hex")}`;
    const rehearsalStartCommand = `node /runner/bootstrap.mjs --intent ${intentId}`;
    const startCommandSha256 = `sha256:${createHash("sha256")
      .update(rehearsalStartCommand)
      .digest("hex")}`;
    const creationLeaseOwner = `rrc-${lifecycle === "role" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002"}`;
    const providerCreationNotBefore = observation.observedAt;
    await ledger.persistProvisioningIntent({
      id: intentId,
      rolloutId: rollout.rolloutId,
      serviceId: identity.baseServiceId,
      lifecycle,
      workflowJobId: identity.workflowJobId,
      runnerName: identity.runnerName,
      createdAt: providerCreationNotBefore,
      startCommandSha256,
      creationLeaseOwner,
    });
    await ledger.acquireProviderDispatchPermit({
      intentId,
      claimantId: creationLeaseOwner,
      startCommandSha256,
      expectedEpoch: 0,
      leaseSeconds: 120,
    });
    await ledger.persistCreatedJob(
      createRehearsalRunnerJobBinding({
        identity,
        observation,
        lifecycle,
        provisioningIntentId: intentId,
        providerCreationNotBefore,
      }),
    );
    providerCreationBoundaries.set(
      identity.renderJobId,
      providerCreationNotBefore,
    );
    await ledger.persistValidatedIdentity(
      identity.renderJobId,
      identity,
      observation,
    );
    const response = await facts.controlFetch(
      `${facts.authorityOrigin}/v1/runner-jobs/registration`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${facts.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rolloutId: rollout.rolloutId,
          lifecycle,
          workflowJobId: identity.workflowJobId,
          registration: {
            runnerId: lifecycle === "role" ? 10 : 11,
            runnerGroupId: identity.runnerGroupId,
            labels: [identity.uniqueRunnerLabel],
            uniqueLabel: identity.uniqueRunnerLabel,
            workFolder: identity.workFolder,
          },
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `private_pg17_rehearsal_registration_failed:${response.status}`,
      );
  };
  let evidence;
  let legacyReconciliation;
  const sourceLegacyAmbiguity = facts.sourceLegacyAmbiguity;
  const runReleaseMigrationPort = async (_target, transition, permit) => {
    process.stderr.write(
      "rehearsal_migration_substep_started:canonical_migration\n",
    );
    const migration = executeCanonicalReleaseMigration(
      {
        ...facts.canonicalEnv,
        REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed",
        REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_SYSTEM_IDENTIFIER:
          permit.targetSystemIdentifier,
        REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_RECOVERY_WITNESS_SHA256:
          permit.targetRecoveryWitnessSha256,
        REVIEW_ROUTER_MIGRATION_PERMIT_TRANSITION_SHA256:
          permit.transitionSha256,
        REVIEW_ROUTER_MIGRATION_PERMIT_PREVIOUS_RECEIPT_SHA256:
          permit.expectedPreviousReceiptSha256,
        REVIEW_ROUTER_MIGRATION_PERMIT_EPOCH: String(permit.epoch),
        REVIEW_ROUTER_MIGRATION_PERMIT_NONCE: permit.nonce,
        REVIEW_ROUTER_MIGRATION_PERMIT_SOURCE_LEGACY_AMBIGUITY_BASE64URL:
          Buffer.from(JSON.stringify(permit.sourceLegacyAmbiguity)).toString(
            "base64url",
          ),
        REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF:
          permit.eligibilityCutoff,
      },
      canonicalRun,
    );
    process.stderr.write(
      "rehearsal_migration_substep_completed:canonical_migration\n",
    );
    legacyReconciliation = migration.legacyReconciliation;
    const targetReceiptEvidence = targetMigrationReceiptEvidence(
      migration.targetMigrationReceipt,
    );
    process.stderr.write(
      "rehearsal_migration_substep_started:migration_checksum\n",
    );
    const migrationChecksum = canonicalRun(
      "observe_migration_checksum",
      "psql",
      [
        facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        "SELECT 'sha256:' || encode(pg_catalog.sha256(convert_to(coalesce(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name), ''), 'UTF8')), 'hex') FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
      ],
      {
        env: {
          DATABASE_URL:
            facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
        },
      },
    ).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(migrationChecksum))
      throw new Error("private_pg17_rehearsal_migration_checksum_unproven");
    if (transition && migrationChecksum !== transition.postManifestIdentity)
      throw new Error("private_pg17_rehearsal_post_manifest_mismatch");
    process.stderr.write(
      "rehearsal_migration_substep_completed:migration_checksum\n",
    );
    process.stderr.write(
      "rehearsal_migration_substep_started:claim_migration_evidence\n",
    );
    canonicalRun(
      "claim_trusted_migration_evidence",
      "psql",
      [
        facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
        "--no-psqlrc",
        "--quiet",
      ],
      {
        env: {
          DATABASE_URL:
            facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
        },
        input: String.raw`\set ON_ERROR_STOP on
BEGIN;
SELECT reviewrouter_bootstrap.consume_migration_evidence(
  'sha256:${"e".repeat(64)}',
  '303',
  'disposable-rehearsal',
  '1',
  1,
  '11',
  '.github/workflows/codex-rotating-release-migration.yml',
  '${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA}',
  '${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST}',
  '${facts.targetSystemIdentifier}',
  '${facts.canonicalEnv.REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256}'
);
COMMIT;
`,
      },
    );
    process.stderr.write(
      "rehearsal_migration_substep_completed:claim_migration_evidence\n",
    );
    process.stderr.write(
      "rehearsal_migration_substep_started:verify_migration_evidence\n",
    );
    const evidenceClaimed = facts.sql(
      facts.targetContainer,
      `SELECT EXISTS (
         SELECT 1
         FROM pg_database database,
              LATERAL jsonb_array_elements(
                coalesce(
                  shobj_description(database.oid, 'pg_database')::jsonb
                    ->'consumedMigrationEvidence',
                  '[]'::jsonb
                )
              ) evidence
         WHERE database.datname = current_database()
           AND evidence->>'commit' = '${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA}'
           AND evidence->>'systemIdentifier' = '${facts.targetSystemIdentifier}'
       )`,
    );
    if (evidenceClaimed !== "t")
      throw new Error(
        "private_pg17_rehearsal_migration_evidence_claim_unproven",
      );
    process.stderr.write(
      "rehearsal_migration_substep_completed:verify_migration_evidence\n",
    );
    return observed(RolloutStep.RunReleaseMigration, {
      ...migration,
      legacyReconciliation,
      migrationChecksum,
      ...(transition && permit
        ? {
            transitionSha256: transition.transitionSha256,
            migrationArtifactDigest: transition.migrationArtifactDigest,
            migrationBundleSha256: transition.migrationBundleSha256,
            preManifestIdentity: transition.preManifestIdentity,
            postManifestIdentity: transition.postManifestIdentity,
            postCatalogDigest: transition.postCatalogDigest,
            permitEpoch: permit.epoch,
            permitNonce: permit.nonce,
            targetSystemIdentifier: permit.targetSystemIdentifier,
            targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
            ...targetReceiptEvidence,
          }
        : {}),
    });
  };
  const useCases = new ReleaseRolloutUseCases({
    authority: facts.providerAuthority,
    preflight: {
      observeProtectedEnvironment: async () =>
        observed(RolloutStep.VerifyProtectedEnvironment, {
          organization: execution.organization,
          repository: execution.controlRepository,
          workflowPath: execution.workflowPath,
          workflowRef: execution.workflowRef,
          sha: rollout.expectedCommitSha,
          event: execution.event,
          actor: execution.actor,
          runId: execution.runId,
          runAttempt: 1,
          approvalMode: ReleaseApprovalMode.SoloOwner,
          environments: [
            {
              name: "disposable-rehearsal",
              requiredReviewerCount: 1,
              preventSelfReview: true,
              protectedBranchesOnly: true,
            },
          ],
          runnerGroupId: 1,
          observationSha256: digest,
        }),
    },
    provider: {
      freezeAndObserve: async () =>
        observed(
          RolloutStep.FreezeProviderServices,
          {
            services: [
              {
                serviceId: "source-writer",
                suspended: true,
                observedAt: "2026-08-12T00:00:02.000Z",
                latestSuccessfulDeployId: "dep-source",
              },
            ],
            complete: true,
            discoveryScope: "provider_hint_only_database_fence_authoritative",
          },
          {
            renderServiceIds: ["source-writer"],
            renderDeployIds: ["dep-source"],
            renderMutatedServiceIds: ["source-writer"],
          },
        ),
      compensateAndObserve: async () =>
        observed(RolloutStep.CompleteCompensation, { resumed: true }),
    },
    runner: {
      provision: async () => {
        const lifecycle = provision === roleRunner ? "role" : "cutover";
        const observation = observed(
          provision === roleRunner
            ? RolloutStep.ProvisionRoleRunner
            : RolloutStep.ProvisionCutoverRunner,
          provision,
          {
            renderJobId: provision.renderJobId,
            renderDeployId: provision.provenance.deployId,
            githubWorkflowJobId: provision.workflowJobId,
          },
        );
        await persistRunnerBinding(provision, observation, lifecycle);
        return { identity: provision, observation };
      },
      cleanup: async () => {
        const providerCreatedAt = providerCreationBoundaries.get(
          provision.renderJobId,
        );
        if (!providerCreatedAt)
          throw new Error("private_pg17_rehearsal_provider_boundary_missing");
        const observedAt = new Date(
          Date.UTC(2026, 7, 12, 0, 0, tick++),
        ).toISOString();
        const observation = {
          step: cleanupStep,
          observedAt,
          facts: {
            provider: { id: provision.renderJobId, status: "succeeded" },
            runner: {
              listenerStopped: true,
              workspaceRemoved: true,
              credentialProcessGone: true,
              canary: provision.cleanupCanary,
              observedAt,
            },
          },
          provider: { renderJobId: provision.renderJobId },
        };
        await witness.persist(provision.renderJobId, {
          jobId: provision.renderJobId,
          canary: provision.cleanupCanary,
          providerStatus: "succeeded",
          containerTerminated: true,
          logSha256: digest,
          removedPaths: [`/runner/${provision.workFolder}`],
          remainingPaths: [],
          providerLogId: `log-${provision.renderJobId}`,
          providerCreatedAt,
          providerObservedAt: observedAt,
        });
        await ledger.markTerminal(provision.renderJobId, observation);
        return observation;
      },
      reconcileOrphans: async () => [],
    },
    database: {
      captureBackup: async () =>
        observed(RolloutStep.CaptureSourceBackup, {
          dumpSha256: facts.dumpSha256,
          backup: {
            renderResourceId: rollout.source.renderResourceId,
            internalHostname: rollout.source.internalHostname,
            databaseName: rollout.source.databaseName,
            systemIdentifier: rollout.source.systemIdentifier,
            lsn: "0/1",
            capturedAt: "2026-08-12T00:00:03.000Z",
            recoveryWindowStartsAt: "2026-08-11T00:00:00.000Z",
            recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
            dumpSha256: facts.dumpSha256,
            externalWitnessSha256: digest,
            recoveryStatus: "AVAILABLE",
          },
        }),
      quiesce: async () => {
        return observed(RolloutStep.QuiesceSource, {
          writerServices: [
            {
              serviceId: "source-writer",
              suspended: true,
              observedAt: "2026-08-12T00:00:02.000Z",
            },
          ],
          aclSha256: digest,
          stabilizationSeries: [0, 0, 0],
          reconnectDeniedRoles: [
            "reviewrouter_api",
            "reviewrouter_web",
            "reviewrouter_worker",
            "reviewrouter_comment_token_custody",
            "reviewrouter_codex_effect_authority",
          ],
          fence: {
            version: 1,
            fenceId: `source-fence:${rollout.rolloutId}`,
            rolloutId: rollout.rolloutId,
            sourceSystemIdentifier: rollout.source.systemIdentifier,
            authorityPrincipal: "fence_authority",
            beforeInventorySha256: digest,
            fencedInventorySha256: digest,
            beforePolicySha256: digest,
            fencedPolicySha256: digest,
            priorConnectAclSha256: digest,
            lifecycle: "active",
            observedAt: "2026-08-12T00:00:02.000Z",
          },
          legacyAmbiguity: sourceLegacyAmbiguity,
          complete: true,
        });
      },
      copy: async () =>
        observed(RolloutStep.CopyDatabaseGeneration, {
          dumpSha256: facts.dumpSha256,
          ownershipRestored: false,
          privilegesRestored: false,
        }),
      verifyEquivalence: async () =>
        observed(RolloutStep.VerifyDataEquivalence, {
          tables: [
            {
              table: "public.rehearsal_items",
              sourceRows: 3,
              targetRows: 3,
              sourceSha256: digest,
              targetSha256: digest,
            },
          ],
          catalogSha256,
          equivalent: true,
          streamingHash: true,
          maxProcessBufferBytes: 8 * 1024 * 1024,
          effectivePrincipals: {
            sourceInventorySha256: digest,
            sourcePolicySha256: digest,
            targetInventorySha256: digest,
            targetPolicySha256: digest,
            stable: true,
          },
        }),
      bootstrapTargetRoles: async () => {
        // Prove the bootstrap still has the exact trusted authority immediately
        // before roleProvisioningSql runs, then prove its transactional
        // self-demotion completed before any release migration or permit work.
        facts.assertCanonicalBootstrapPrivileged();
        // Seed an unrelated WITH GRANT OPTION root and a delegated child on the
        // restored routines. Canonical provisioning must remove both edges.
        facts.sql(
          facts.targetContainer,
          disposableProviderScopeConcurrencyAdversarialAclSql(),
        );
        const result = executeCanonicalRoleBootstrap(
          facts.canonicalEnv,
          canonicalRun,
        );
        facts.assertCanonicalBootstrapDemoted();
        facts.assertCanonicalPgcryptoAcl();
        facts.sql(
          facts.targetContainer,
          assertDisposableProviderScopeConcurrencyAuthoritySql(),
        );
        canonicalRun(
          "exercise_provider_scope_concurrency_authority",
          "psql",
          [
            facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
            "--no-psqlrc",
            "--quiet",
          ],
          {
            env: {
              DATABASE_URL:
                facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
            },
            input: disposableProviderScopeConcurrencyExerciseSql(),
          },
        );
        // The four calls exercise activation and rollback management together
        // but must leave the restored target at its pre-exercise state.
        facts.sql(
          facts.targetContainer,
          assertDisposableProviderScopeConcurrencyAuthoritySql(),
        );
        await assertTargetActivationReadiness("post_bootstrap", true);
        return observed(RolloutStep.BootstrapTargetRoles, result);
      },
      runReleaseMigration: runReleaseMigrationPort,
      activate: async (rolloutId) => {
        const activation = executePrivateGenerationActivation(
          { ...facts.canonicalEnv, REVIEW_ROUTER_ROLLOUT_ID: rolloutId },
          activationCommands,
          {
            captureActivationSqlSha256: (value) => {
              activationSqlSha256 = value;
            },
          },
        );
        return activation;
      },
      compensateSource: async () =>
        observed(RolloutStep.CompleteCompensation, { aclRestored: true }),
    },
    services: {
      stageTarget: async (fence) => {
        const deployIds = await transactionalServices.stage({
          source: sourceManifest,
          protectedEnvironment: protectedSourceEnvironment,
          target: targetContracts,
        });
        const checkpoints = await facts.ledger.read(rollout.rolloutId);
        const targetContractHash = checkpoints.at(-1)?.targetContractSha256;
        if (!targetContractHash)
          throw new Error("private_pg17_rehearsal_target_contract_missing");
        return observed(
          RolloutStep.StageTargetServices,
          targetContracts.map((contract, index) => ({
            serviceId: contract.serviceId,
            deployId: deployIds[index],
            provenance: { kind: "image", imageSha: digest },
            envSha256: contract.environmentSha256,
            recoveryWitnessSha256: rawSha256(targetWitness),
            suspended: true,
            servicePostcondition: stagedServices.get(contract.serviceId)
              .postcondition,
            targetSwitchFenceNonce: fence.nonce,
            targetSwitchFenceVersion: fence.version,
          })),
          {
            renderServiceIds: targetContracts.map((item) => item.serviceId),
            renderDeployIds: deployIds,
            targetSwitchFenceNonce: fence.nonce,
            targetSwitchFenceVersion: fence.version,
            serviceRecoveryManifestSha256: sourceManifest.manifestSha256,
            targetServiceContractSha256: targetContractHash,
          },
        );
      },
      resumeDeployAndObserve: async () => {
        const services = targetContracts.map((contract) => {
          const current = stagedServices.get(contract.serviceId);
          current.suspended = false;
          current.postcondition = Object.freeze({
            ...current.postcondition,
            suspended: false,
          });
          return {
            serviceId: contract.serviceId,
            deployId: current.provenance.deploymentId,
            resumed: true,
            servicePostcondition: current.postcondition,
          };
        });
        return observed(RolloutStep.ResumeTargetServices, services, {
          renderServiceIds: services.map((item) => item.serviceId),
          renderDeployIds: services.map((item) => item.deployId),
        });
      },
      verifyLiveCanary: async () => {
        const nonce = "a".repeat(48);
        const requestedAt = "2026-08-12T00:00:05.000Z";
        const observedAt = "2026-08-12T00:00:05.500Z";
        const serviceFacts = serviceRoles.map((runtimeRole, index) => {
          const contract = targetContracts[index];
          const current = stagedServices.get(contract.serviceId);
          return {
            runtimeRole,
            serviceId: contract.serviceId,
            deployId: current.provenance.deploymentId,
            deploymentProvenance: contract.artifact.reference.slice(-64),
            servicePostconditionSha256: normalizedServicePostconditionSha256(
              current.postcondition,
            ),
          };
        });
        return observed(RolloutStep.VerifyLiveCanary, {
          commitSha: rollout.expectedCommitSha,
          databaseSystemIdentifier: rollout.target.systemIdentifier,
          recoveryWitnessSha256: rawSha256(targetWitness),
          nonce,
          requestedAt,
          observedAt,
          expectedGeneration: {
            systemIdentifier: rollout.target.systemIdentifier,
            recoveryWitnessSha256: rawSha256(targetWitness),
          },
          serviceFacts,
          runtimeWitnessProofs: serviceRoles.map((runtimeRole, index) => ({
            runtimeRole,
            databaseRole: `reviewrouter_${runtimeRole}`,
            nonce,
            requestedAt,
            serviceId: serviceFacts[index].serviceId,
            deployId: serviceFacts[index].deployId,
            deploymentProvenance: serviceFacts[index].deploymentProvenance,
            servicePostconditionSha256:
              serviceFacts[index].servicePostconditionSha256,
            systemIdentifier: rollout.target.systemIdentifier,
            releaseCommitSha: rollout.expectedCommitSha,
            recoveryWitnessSha256: rawSha256(targetWitness),
            provedAt: observedAt,
          })),
          writeReadRoundTrip: true,
        });
      },
    },
    evidence: {
      assembleAndVerify: async (current) => {
        const assembledAt = new Date(
          Math.max(
            ...current.receipts.map((receipt) =>
              Date.parse(receipt.observedAt),
            ),
            Date.parse(current.activationReceipt.observedAt),
          ) + 1_000,
        ).toISOString();
        const trustedImagePolicy = {
          sourceRepository: current.execution.controlRepository,
          sourceRevision: current.expectedCommitSha,
          imageRepository: "ghcr.io/777genius/review-router-saas-runtime",
          verificationPolicySha256: `sha256:${"e".repeat(64)}`,
        };
        const witnessKeys = generateKeyPairSync("ed25519");
        const witnessPolicy = {
          keyId: "disposable-rehearsal-witness",
          publicKeyPem: witnessKeys.publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
          maximumAgeMilliseconds: 300_000,
        };
        const witnessObservedAt = new Date(
          Date.parse(assembledAt) - 1,
        ).toISOString();
        const witnessUnsigned = {
          schemaVersion: 3,
          rolloutId: current.rolloutId,
          deploymentRevision: current.expectedCommitSha,
          artifactDigest: facts.canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST,
          execution: {
            repository: current.execution.controlRepository,
            workflowPath: current.execution.workflowPath,
            workflowRef: current.execution.workflowRef,
            commitSha: current.expectedCommitSha,
            runId: current.execution.runId,
            runAttempt: current.execution.runAttempt,
          },
          sourceDatabaseIdentity: {
            serverIdentity: current.source.systemIdentifier,
            databaseIdentity: "16384",
            databaseName: current.source.databaseName,
          },
          authorityDatabaseIdentity: {
            serverIdentity: "300",
            databaseIdentity: "16385",
            databaseName: "release_authority",
          },
          targetDatabaseIdentity: {
            serverIdentity: current.target.systemIdentifier,
            databaseIdentity: "16386",
            databaseName: current.target.databaseName,
          },
          releaseAuthority: {
            schemaVersion: releaseAuthoritySchemaVersion,
            migrationManifestIdentity: digest,
            catalogFingerprint: digest,
            catalogVerifier: "disposable-rehearsal",
          },
          activation: {
            migrationManifestIdentity:
              current.activationReceipt.postManifestIdentity,
            namespaceFingerprint: digest,
            installerRoutineBodySha256: "a".repeat(64),
            readerRoutineBodySha256: "b".repeat(64),
            ...canonicalActivationCatalogPolicyDigests,
          },
          source: {
            renderResourceId: current.source.renderResourceId,
            databaseName: current.source.databaseName,
            systemIdentifier: current.source.systemIdentifier,
            majorVersion: current.source.majorVersion,
            recoveryWitnessSha256: current.source.recoveryWitnessSha256,
          },
          target: {
            renderResourceId: current.target.renderResourceId,
            databaseName: current.target.databaseName,
            systemIdentifier: current.target.systemIdentifier,
            majorVersion: current.target.majorVersion,
            recoveryWitnessSha256: current.target.recoveryWitnessSha256,
          },
          deployments: targetContracts.map((contract) => ({
            serviceId: contract.serviceId,
            deployId: stagedServices.get(contract.serviceId).provenance
              .deploymentId,
            revision: contract.artifact.reference.slice(
              contract.artifact.reference.indexOf("sha256:"),
            ),
          })),
          observedAt: witnessObservedAt,
          expiresAt: new Date(
            Date.parse(witnessObservedAt) +
              witnessPolicy.maximumAgeMilliseconds,
          ).toISOString(),
        };
        const witnessBindingSha256 = `sha256:${sha256Canonical(witnessUnsigned)}`;
        const releaseWitness = {
          ...witnessUnsigned,
          bindingSha256: witnessBindingSha256,
          signature: {
            algorithm: "Ed25519",
            keyId: witnessPolicy.keyId,
            value: sign(
              null,
              Buffer.from(witnessBindingSha256, "utf8"),
              witnessKeys.privateKey,
            ).toString("base64"),
          },
        };
        evidence = assembleTrustedRolloutEvidence(
          {
            rolloutId: current.rolloutId,
            releaseCommitSha: current.expectedCommitSha,
            releaseImageProvenance: (() => {
              const identity = {
                schemaVersion: "reviewrouter.hosted-runtime-image.v1",
                repository: current.execution.controlRepository,
                commit: current.expectedCommitSha,
                imageUrl: `ghcr.io/777genius/review-router-saas-runtime@${facts.canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST}`,
                imageDigest:
                  facts.canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST,
              };
              return {
                schemaVersion: "reviewrouter.release-image-provenance.v2",
                identity,
                claim: {
                  identitySha256: `sha256:${sha256Canonical(identity)}`,
                  sourceRepository: current.execution.controlRepository,
                  sourceRevision: current.expectedCommitSha,
                  imageRepository: trustedImagePolicy.imageRepository,
                  buildRunId: "1",
                  artifactId: "1",
                  artifactName: "hosted-runtime-image-v0.0.0-rehearsal",
                },
                verification: {
                  policySha256: trustedImagePolicy.verificationPolicySha256,
                  verifiedAt: "2026-08-12T00:00:00.000Z",
                },
              };
            })(),
            execution: current.execution,
            runners: [roleRunner, cutoverRunner],
            source: current.source,
            target: current.target,
            backup: {
              renderResourceId: current.source.renderResourceId,
              internalHostname: current.source.internalHostname,
              databaseName: current.source.databaseName,
              systemIdentifier: current.source.systemIdentifier,
              lsn: "0/1",
              capturedAt: "2026-08-12T00:00:02.000Z",
              recoveryWindowStartsAt: "2026-08-11T00:00:00.000Z",
              recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
              dumpSha256: facts.dumpSha256,
              externalWitnessSha256: digest,
              recoveryStatus: "AVAILABLE",
            },
            quiescence: {
              writerServices: [
                {
                  serviceId: "source-writer",
                  suspended: true,
                  observedAt: "2026-08-12T00:00:01.000Z",
                },
              ],
              aclSha256: digest,
              stabilizationSeries: [0, 0, 0],
              reconnectDeniedRoles: [
                "reviewrouter_api",
                "reviewrouter_web",
                "reviewrouter_worker",
                "reviewrouter_comment_token_custody",
                "reviewrouter_codex_effect_authority",
              ],
              fence: {
                version: 1,
                fenceId: `source-fence:${current.rolloutId}`,
                rolloutId: current.rolloutId,
                sourceSystemIdentifier: current.source.systemIdentifier,
                authorityPrincipal: "fence_authority",
                beforeInventorySha256: digest,
                fencedInventorySha256: digest,
                beforePolicySha256: digest,
                fencedPolicySha256: digest,
                priorConnectAclSha256: digest,
                lifecycle: "active",
                observedAt: "2026-08-12T00:00:02.000Z",
              },
              legacyAmbiguity: sourceLegacyAmbiguity,
              complete: true,
            },
            equivalence: {
              tables: [
                {
                  table: "public.rehearsal_items",
                  sourceRows: 3,
                  targetRows: 3,
                  sourceSha256: digest,
                  targetSha256: digest,
                },
              ],
              catalogSha256,
              equivalent: true,
              streamingHash: true,
              maxProcessBufferBytes: 8 * 1024 * 1024,
              effectivePrincipals: {
                sourceInventorySha256: digest,
                sourcePolicySha256: digest,
                targetInventorySha256: digest,
                targetPolicySha256: digest,
                stable: true,
              },
            },
            legacyReconciliation,
            protectedEnvironmentPreflightSha256: current.receipts.find(
              (receipt) =>
                receipt.step === RolloutStep.VerifyProtectedEnvironment,
            ).observationSha256,
            receipts: current.receipts,
            activation: current.activationReceipt,
            targetDeploys: targetContracts.map((contract) => ({
              serviceId: contract.serviceId,
              deployId: stagedServices.get(contract.serviceId).provenance
                .deploymentId,
              imageDigest: contract.artifact.reference.slice(
                contract.artifact.reference.indexOf("sha256:"),
              ),
            })),
            resumedTargetDeployIds: targetContracts.map(
              (contract) =>
                stagedServices.get(contract.serviceId).provenance.deploymentId,
            ),
            liveCanarySha256: current.receipts.find(
              (receipt) => receipt.step === RolloutStep.VerifyLiveCanary,
            ).observationSha256,
            releaseWitness,
            cleanups: [
              {
                renderJobId: roleRunner.renderJobId,
                providerStatus: "succeeded",
                listenerStopped: true,
                workspaceRemoved: true,
                credentialProcessGone: true,
                cleanupCanary: roleRunner.cleanupCanary,
                observedAt: current.receipts.find(
                  (receipt) => receipt.step === RolloutStep.CleanupRoleRunner,
                ).observedAt,
              },
              {
                renderJobId: cutoverRunner.renderJobId,
                providerStatus: "succeeded",
                listenerStopped: true,
                workspaceRemoved: true,
                credentialProcessGone: true,
                cleanupCanary: cutoverRunner.cleanupCanary,
                observedAt: current.receipts.find(
                  (receipt) =>
                    receipt.step === RolloutStep.CleanupCutoverRunner,
                ).observedAt,
              },
            ],
            assembledAt,
          },
          trustedImagePolicy,
          witnessPolicy,
        );
        return observed(RolloutStep.VerifyTrustedRollout, {
          evidenceSha256: evidence.evidenceSha256,
        });
      },
    },
    ledger,
  });
  const runStage = async (name, operation) => {
    const safeName = /^[a-z][a-z0-9_]{2,63}$/u.test(name) ? name : "unknown";
    process.stderr.write(`rehearsal_stage_started:${safeName}\n`);
    let timeout;
    try {
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error(`private_pg17_rehearsal_stage_timeout:${name}`)),
            120_000,
          );
          timeout.unref?.();
        }),
      ]);
      process.stderr.write(`rehearsal_stage_completed:${safeName}\n`);
      return result;
    } catch (error) {
      const safeError = safeRehearsalStageErrorCode(error);
      process.stderr.write(
        `rehearsal_stage_failed:${safeName}:${safeError ?? redactedErrorChain(error)}\n`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  await waitForRehearsalControlReady(
    async () =>
      (
        await facts.controlFetch(`${facts.authorityOrigin}/health`, {
          method: "GET",
        })
      ).status,
  );
  rollout = await runStage("claim_rollout", () =>
    useCases.claimRollout(rollout),
  );
  rollout = await runStage("verify_protected_environment", () =>
    useCases.verifyProtectedEnvironment(rollout),
  );
  rollout = await runStage("freeze_provider_services", () =>
    useCases.freezeProviderServices(rollout),
  );
  ({ rollout } = await runStage("provision_private_runner", () =>
    useCases.provisionPrivateRunner(rollout),
  ));
  rollout = await runStage("quiesce_source", () =>
    useCases.quiesceSource(rollout),
  );
  rollout = await runStage("capture_source_backup", () =>
    useCases.captureSourceBackup(rollout),
  );
  rollout = await runStage("copy_database_generation", () =>
    useCases.copyDatabaseGeneration(rollout),
  );
  rollout = await runStage("bootstrap_target_roles", () =>
    useCases.bootstrapTargetRoles(rollout),
  );
  rollout = await runStage("verify_data_equivalence", () =>
    useCases.verifyDataEquivalence(rollout),
  );
  rollout = await runStage("cleanup_role_runner", () =>
    useCases.cleanupRoleRunner(rollout, roleRunner),
  );
  provision = cutoverRunner;
  ({ rollout } = await runStage("provision_cutover_runner", () =>
    useCases.provisionCutoverRunner(rollout),
  ));
  const postMigration = await runRehearsalReleaseMigration({
    captureOnly: facts.captureOnly,
    rollout,
    runStage,
    runReleaseMigration: () => {
      if (!sourceLegacyAmbiguity)
        throw new Error(
          "private_pg17_rehearsal_source_legacy_ambiguity_missing",
        );
      return useCases.runReleaseMigration(rollout, sourceLegacyAmbiguity);
    },
    captureCandidate: () => {
      const identity = facts.captureOnly.disposableDatabaseIdentity;
      assertDisposableCaptureTarget({
        createdContainers: facts.createdContainers,
        sourceContainer: facts.sourceContainer,
        targetContainer: facts.targetContainer,
      });
      const attestationNonce = rawSha256(
        `${identity}:${facts.targetSystemIdentifier}:${facts.canonicalEnv.REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256}`,
      );
      process.stderr.write("rehearsal_capture_substep_started:cleanup\n");
      cleanupCaptureOnlyRehearsalFixtures({
        executeSql: (statement) => facts.sql(facts.targetContainer, statement),
      });
      process.stderr.write("rehearsal_capture_substep_completed:cleanup\n");
      process.stderr.write("rehearsal_capture_substep_started:attestation\n");
      canonicalRun(
        "mark_disposable_activation_catalog_database",
        "psql",
        [
          facts.canonicalEnv.REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL,
          "--no-psqlrc",
          "--quiet",
        ],
        {
          env: {
            DATABASE_URL:
              facts.canonicalEnv.REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL,
          },
          input: `DO $attest_disposable_capture_database$
DECLARE binding jsonb;
BEGIN
  SELECT shobj_description(oid,'pg_database')::jsonb INTO STRICT binding
  FROM pg_database WHERE datname=current_database();
  IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
     OR binding->>'systemIdentifier' IS DISTINCT FROM
       (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'systemIdentifier' IS DISTINCT FROM '${facts.targetSystemIdentifier}'
     OR binding->>'recoveryWitnessSha256' IS DISTINCT FROM
       '${facts.canonicalEnv.REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256}'
     OR binding ? 'disposableCaptureAttestation' THEN
    RAISE EXCEPTION 'disposable capture database attestation precondition failed';
  END IF;
  binding := jsonb_set(binding,'{disposableCaptureAttestation}',jsonb_build_object(
    'kind','reviewrouter-disposable-database-attestation-v1',
    'identity','${identity}',
    'systemIdentifier',binding->>'systemIdentifier',
    'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
    'recoveryWitnessSha256',binding->>'recoveryWitnessSha256',
    'nonce','${attestationNonce}'
  ));
  EXECUTE format('COMMENT ON DATABASE %I IS %L',current_database(),binding::text);
END
$attest_disposable_capture_database$;\n`,
        },
      );
      process.stderr.write("rehearsal_capture_substep_completed:attestation\n");
      process.stderr.write("rehearsal_capture_substep_started:projection\n");
      const stdout = canonicalRun(
        "capture_activation_catalog_policy_candidate",
        "psql",
        [
          facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
        ],
        {
          env: {
            DATABASE_URL:
              facts.canonicalEnv.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
          },
          input: canonicalActivationCatalogPolicyCandidateSql(
            disposableSqlConfiguration(),
            identity,
          ),
        },
      );
      process.stderr.write("rehearsal_capture_substep_completed:projection\n");
      process.stderr.write("rehearsal_capture_substep_started:validation\n");
      const candidate =
        parsePrivatePg17ActivationCatalogPolicyCandidate(stdout);
      process.stderr.write("rehearsal_capture_substep_completed:validation\n");
      return candidate;
    },
    stageTargetServices: (migratedRollout) =>
      runStage("stage_target_services", () =>
        useCases.stageTargetServices(migratedRollout),
      ),
  });
  await assertTargetActivationReadiness("post_migration", true);
  if (postMigration.mode === "capture-only") return postMigration.candidate;
  rollout = postMigration.rollout;
  rollout = await runStage("activate_target_generation", () =>
    useCases.activateTargetGeneration(rollout, cutoverRunner.workflowJobId),
  );
  cleanupStep = RolloutStep.CleanupCutoverRunner;
  rollout = await runStage("cleanup_cutover_runner", () =>
    useCases.cleanupCutoverRunner(rollout, cutoverRunner),
  );
  rollout = await runStage("resume_target_services", () =>
    useCases.resumeTargetServices(rollout),
  );
  rollout = await runStage("verify_live_canary", () =>
    useCases.verifyLiveCanary(rollout),
  );
  rollout = await runStage("verify_trusted_rollout", () =>
    useCases.verifyTrustedRollout(rollout),
  );
  const authorityState = await runStage("verify_durable_authority_state", () =>
    ledger.observeActivationState({
      rolloutId: rollout.rolloutId,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
    }),
  );
  if (authorityState !== "activated")
    throw new Error("private_pg17_rehearsal_durable_ledger_unproven");
  const activationReplayStable = await runStage(
    "verify_activation_replay",
    async () => {
      const replayedActivation = executePrivateGenerationActivation(
        facts.canonicalEnv,
        activationCommands,
      );
      const activationReceipt = rollout.activationReceipt;
      const durableActivation =
        await new RoutineTargetActivationReceiptReaderAdapter(
          facts.targetReceiptReaderPrisma,
        ).read(rollout.rolloutId);
      return (
        activationReceipt !== undefined &&
        durableActivation !== null &&
        replayedActivation.facts.firstWriteReceiptSha256 ===
          durableActivation.firstWriteReceiptSha256 &&
        targetActivationIdentityMatches({
          target: durableActivation,
          authorization: {
            rolloutId: activationReceipt.rolloutId,
            expectedCommitSha: activationReceipt.expectedCommitSha,
            postgresMajor: activationReceipt.postgresMajor,
            migrationChecksum: activationReceipt.migrationChecksum,
            transitionSha256: activationReceipt.transitionSha256,
            postManifestIdentity: activationReceipt.postManifestIdentity,
            epoch: activationReceipt.permitEpoch,
            nonce: activationReceipt.permitNonce,
            sourceSystemIdentifier: activationReceipt.sourceSystemIdentifier,
            targetSystemIdentifier: activationReceipt.targetSystemIdentifier,
            previousReceiptSha256: activationReceipt.previousReceiptSha256,
            targetDeployIds: activationReceipt.targetDeployIds,
            authorizedAt: activationReceipt.observedAt,
          },
          proposedReceipt: activationReceipt,
          expectedReceiptSha256: activationReceipt.receiptSha256,
        })
      );
    },
  );
  const sourceBanProven = await runStage("verify_source_ban", () => {
    const uncertain = transitionFailure(rollout, "activation_uncertain");
    try {
      assertPromotionAllowed(uncertain, uncertain.source.systemIdentifier);
      return false;
    } catch {
      return true;
    }
  });
  if (!sourceBanProven)
    throw new Error("private_pg17_rehearsal_source_ban_unproven");
  const adversarial = await runStage("verify_authority_adversarial", () =>
    verifyAuthorityAdversarialChecks(facts, rollout),
  );
  const compensated = completeCompensation(
    beginCompensation(
      transitionFailure(
        createReleaseRollout({
          rolloutId: "disposable-compensation",
          expectedCommitSha: "e".repeat(40),
          execution: { ...execution, runId: "2" },
          source: rollout.source,
          target: rollout.target,
          migrationTransition: createReleaseMigrationTransition({
            commitSha: "e".repeat(40),
            releaseImageDigest: rollout.migrationTransition.releaseImageDigest,
          }),
        }),
        "definite_pre_activation",
      ),
    ),
  );
  return {
    phase: rollout.phase,
    generated: {
      roleBootstrapSha256: generated.roleBootstrapSha256,
      migrationSha256: generated.migrationSha256,
      activationSqlSha256,
      canonicalPrivilegesSha256:
        rollout.activationReceipt?.canonicalPrivilegesSha256,
    },
    receiptCount: rollout.receipts.length,
    sourceBanProven,
    compensationProven: compensated.phase === "recovery_compensated",
    activationReplayStable,
    adversarial,
    evidenceSha256: evidence.evidenceSha256,
  };
}

async function verifyAuthorityAdversarialChecks(facts, rollout) {
  const request = async (path, body, token = facts.controlToken) =>
    facts.controlFetch(`${facts.authorityOrigin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const requestIdempotentReplay = async (path, body) => {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await request(path, body);
      if (response.status !== 503) return response;
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
    return response;
  };
  const [controlReadiness, providerReadiness] = await Promise.all([
    observeReleaseAuthorityDatabaseReadiness(facts.controlPrisma),
    observeReleaseAuthorityDatabaseReadiness(facts.providerAuthorityPrisma),
  ]);
  if (
    !releaseAuthoritySchemaIsReady(controlReadiness) ||
    !releaseAuthoritySchemaIsReady(providerReadiness)
  )
    throw new Error(
      "private_pg17_rehearsal_post_activation_authority_readiness_unproven",
    );
  const binding = {
    rolloutId: rollout.rolloutId,
    expectedCommitSha: rollout.expectedCommitSha,
    runId: rollout.execution.runId,
    runAttempt: rollout.execution.runAttempt,
    sourceSystemIdentifier: rollout.source.systemIdentifier,
    targetSystemIdentifier: rollout.target.systemIdentifier,
    targetRecoveryWitnessSha256: rollout.target.recoveryWitnessSha256,
    migrationTransition: rollout.migrationTransition,
  };
  const replay = await requestIdempotentReplay("/v1/rollouts/claim", binding);
  if (replay.status !== 200 || (await replay.json()).result !== "duplicate")
    throw new Error("private_pg17_rehearsal_authority_replay_unproven");
  const conflict = await request("/v1/rollouts/claim", {
    ...binding,
    expectedCommitSha: "f".repeat(40),
  });
  if (conflict.status < 400)
    throw new Error("private_pg17_rehearsal_authority_conflict_unproven");
  const unauthorized = await request(
    "/v1/rollouts/claim",
    binding,
    "wrong-token",
  );
  if (unauthorized.status !== 401)
    throw new Error("private_pg17_rehearsal_authority_auth_unproven");
  const deployAfterActivation = await request(
    "/v1/provider-authority/decisions",
    {
      rolloutId: rollout.rolloutId,
      operation: "deploy_target",
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      expectedReceiptSha256: rollout.receipts.at(-1).receiptSha256,
      activationBoundary: "before",
    },
    facts.providerAuthorityToken,
  );
  if (deployAfterActivation.status !== 409)
    throw new Error("private_pg17_rehearsal_provider_conflict_unproven");
  const outageAuthority = new HttpProviderAuthorityDecisionAdapter(
    facts.authorityOrigin,
    facts.providerAuthorityToken,
    async () => {
      throw new Error("disposable_authority_outage");
    },
  );
  let outageRejected = false;
  try {
    await outageAuthority.decide({
      rolloutId: rollout.rolloutId,
      operation: "resume_target",
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      expectedReceiptSha256: rollout.receipts.at(-1).receiptSha256,
      activationBoundary: "activated",
    });
  } catch {
    outageRejected = true;
  }
  if (!outageRejected)
    throw new Error("private_pg17_rehearsal_authority_outage_unproven");
  const authorityHasTargetState = facts.sql(
    facts.authorityContainer,
    "SELECT to_regclass('reviewrouter_activation.activation_permit') IS NOT NULL",
  );
  const targetHasAuthorityState = facts.sql(
    facts.targetContainer,
    "SELECT to_regclass('release_authority.rollout') IS NOT NULL",
  );
  if (authorityHasTargetState !== "f" || targetHasAuthorityState !== "f")
    throw new Error(
      "private_pg17_rehearsal_authority_database_isolation_unproven",
    );
  return Object.freeze({
    replayRejected: true,
    conflictRejected: true,
    unauthorizedRejected: true,
    providerConflictRejected: true,
    outageRejected: true,
    credentialStoresIsolated: true,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.includes("--check-only"))
      validateRehearsalConfiguration(process.env);
    else
      process.stdout.write(
        `${JSON.stringify(await executeDisposableRehearsal())}\n`,
      );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? redactedErrorChain(error) : "private_pg17_rehearsal_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
