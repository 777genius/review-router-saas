import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { codexRotatingProductionWriterBaseObservationSql } from "./capture-codex-rotating-production-writer.mjs";
import { codexRotatingTriggers } from "./codex-rotating-production-writer-schema.mjs";
import { createRehearsalAuthorityContext } from "./codex-rotating-rehearsal-authority-context.mjs";
import {
  assertRehearsalRoleObservation,
  rehearsalRoleObservationSql,
} from "./codex-rotating-rehearsal-role-provisioning.mjs";
import {
  activationAuthorityProvisioningSql,
  executeCanonicalReleaseMigration,
  liveV70V73CatalogDigestSha256,
  roleProvisioningSql,
  runtimeGrantStatements,
} from "./run-codex-rotating-release-migration.mjs";
import { legacyAmbiguityInventorySql } from "./reconcile-codex-rotating-legacy-ambiguity.mjs";
import { verifyCodexRotatingDatabaseCatalog } from "./verify-codex-rotating-rollout.mjs";
import {
  createSanitizedDiagnostic,
  sanitizedDiagnosticError,
} from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import { sha256Canonical } from "../packages/features/release-rollout/src/domain/canonical-json.ts";
import {
  createDatabaseCredentialBoundary,
  createSecretSafePostgresInvocation,
  runSecretSafePostgresCommand,
} from "./lib/secret-safe-command-boundary.mjs";

const root = resolve(import.meta.dirname, "..");
const dbDirectory = join(root, "packages/platform/db");
const migrationsDirectory = join(dbDirectory, "prisma/migrations");
const migration60Name = "000060_codex_oauth_setup_serialization";
const migration61Name = "000061_codex_oauth_provider_mutation_fence";
const migration62Name = "000062_codex_oauth_remote_outcome_unknown";
const migration63Name = "000063_codex_oauth_setup_payload_claim";
const migration64Name = "000064_codex_oauth_versioned_secret_namespaces";
const migration65Name = "000065_codex_oauth_authority_acl_hardening";
const migration66Name = "000066_codex_oauth_rotating_cascade_authority";
const migration67Name = "000067_review_live_progress";
const migration68Name = "000068_validate_review_assignment_manifest";
const migration69Name = "000069_release_rollout_ledger";
const migration70Name = "000070_runtime_generation_witness_proof";
const migration71Name = "000071_transactional_service_transition";
const migration72RetireName = "000072_retire_superseded_codex_setup_claims";
const migration72CanaryName = "000072_runtime_canary_challenge";
const rehearsalPreManifestIdentitySha256 =
  "sha256:dac2d257a6b60be214b96b0a809df0ee18cc7615ffae21520802fe568debf554";
const rehearsalPostManifestIdentitySha256 =
  "sha256:0d6bb8d32a70a0be50801fb6c2950e09e5f625180f431b4f3c07d67554458fda";
const migration73Name = "000073_codex_oauth_active_namespace_refresh";
const migration60 = join(migrationsDirectory, migration60Name, "migration.sql");
const migration61 = join(migrationsDirectory, migration61Name, "migration.sql");
const migration62 = join(migrationsDirectory, migration62Name, "migration.sql");
const migration63 = join(migrationsDirectory, migration63Name, "migration.sql");
const migration64 = join(migrationsDirectory, migration64Name, "migration.sql");
const migration65 = join(migrationsDirectory, migration65Name, "migration.sql");
const migration66 = join(migrationsDirectory, migration66Name, "migration.sql");
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
      migration65Name,
      migration66Name,
      migration67Name,
      migration68Name,
      migration69Name,
      migration70Name,
      migration71Name,
      migration72RetireName,
      migration72CanaryName,
      migration73Name,
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
const rehearsalProviderAdminUrl = databaseUrl(baseUrl, databaseName);
const rehearsalRoleMarker = `reviewrouter-rehearsal-managed:${process.pid}:${randomUUID()}`;
let rehearsalAuthority;

try {
  psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(databaseName)}`]);
  assert(
    psql(rehearsalProviderAdminUrl, ["-Atc", "SHOW server_version_num"])
      .stdout.trim()
      .startsWith("17"),
    "the rehearsal database server must be PostgreSQL 17",
  );
  await proveMigrationSpecificLegacyBehavior();
  proveCanonicalLegacyReconciliationNegativeCases();
  const rehearsalRelease = prepareCanonicalReleaseRoles(
    rehearsalProviderAdminUrl,
    applyCanonicalPreMigrationBaseline,
  );
  rehearsalAuthority = rehearsalRelease.authority;
  const providerAdmin = rehearsalAuthority.providerAdmin;
  const runtimeClients = rehearsalAuthority.runtime;
  seedDirtyFixtures(providerAdmin, { canonicalSuccess: true });
  const migrationPermitEnvironment =
    installRehearsalMigrationPermit(rehearsalAuthority);
  const releaseMigrationResult = executeCanonicalReleaseMigration(
    {
      ...rehearsalRelease.environment,
      ...migrationPermitEnvironment,
      REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "open",
    },
    runRehearsalReleaseSubprocess,
    loopbackRehearsalDatabaseIdentity,
  );
  assert(
    releaseMigrationResult.aclGateState === "open",
    "combined migration rehearsal must exercise the open runtime ACL state",
  );
  const targetMigrationReceipt = releaseMigrationResult.targetMigrationReceipt;
  const expectedEffectFingerprint = `sha256:${createHash("sha256")
    .update(
      [
        targetMigrationReceipt.rolloutId,
        targetMigrationReceipt.transitionSha256,
        targetMigrationReceipt.permitEpoch,
        targetMigrationReceipt.permitNonce,
        targetMigrationReceipt.sourceLegacyAmbiguity.inventorySha256,
        targetMigrationReceipt.eligibilityCutoff,
        targetMigrationReceipt.postManifestIdentity,
        targetMigrationReceipt.postCatalogDigest,
      ].join(":"),
    )
    .digest("hex")}`;
  assert(
    targetMigrationReceipt.effectFingerprint === expectedEffectFingerprint,
    "target migration effect fingerprint must match independently observed receipt facts",
  );
  const replayMigrationResult = executeCanonicalReleaseMigration(
    {
      ...rehearsalRelease.environment,
      ...migrationPermitEnvironment,
      REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "open",
    },
    runRehearsalReleaseSubprocess,
    loopbackRehearsalDatabaseIdentity,
  );
  assert(
    JSON.stringify(replayMigrationResult.targetMigrationReceipt) ===
      JSON.stringify(releaseMigrationResult.targetMigrationReceipt) &&
      JSON.stringify(replayMigrationResult.legacyReconciliation.inventory) ===
        JSON.stringify(releaseMigrationResult.legacyReconciliation.inventory),
    "canonical replay did not return the immutable original receipt",
  );

  proveSuccessfulCombinedRelease(providerAdmin);
  proveDatabasePrivileges(providerAdmin);
  proveRuntimeParentCascadesDenied(providerAdmin, runtimeClients);
  proveStaleAclProviderIdentityEscalationDenied(providerAdmin, runtimeClients);
  proveTerminalInsertGuards(providerAdmin);
  proveSequentialFabricationDeniedForEveryRuntimeRole(runtimeClients);
  proveRuntimeVersionedWriteback(providerAdmin, runtimeClients);
  proveAccountSwitchRecoveryContract(providerAdmin);
  proveCompletedRecoveryEvidenceRetention(providerAdmin);
  const versionedNamespaceEvidence =
    proveVersionedNamespaceLedger(providerAdmin);
  provePrismaCleanupRetention(providerAdmin, versionedNamespaceEvidence);
  proveLegacyChildWritesRejected(providerAdmin);
  proveParentIdentityWriteRejected(providerAdmin);
  await proveProviderRepairAuthorityV2(providerAdmin, runtimeClients);
  await proveQuarantineCleanupPathV2(providerAdmin, runtimeClients);
  proveExactProductionCatalogContract(providerAdmin);
  proveMigrateDeployNoOp(providerAdmin);
  proveLateMigrationRollbackAndReplayMatrix();
  proveReleaseAuthorityMarkerIsolation(providerAdmin);
  const observation = collectObservation(providerAdmin);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
  process.stderr.write(
    "Codex rotating PostgreSQL 17 combined 000060 through 000073 rehearsal passed.\n",
  );
} finally {
  const databaseDrop = psql(
    adminUrl,
    [
      "-c",
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    ],
    false,
  );
  assert(
    databaseDrop.status === 0 &&
      psql(adminUrl, [
        "-Atc",
        `SELECT count(*) FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
      ]).stdout.trim() === "0",
    "rehearsal_database_removal_not_proven_before_role_cleanup",
  );
  cleanupRuntimeRoles(adminUrl);
}

async function proveMigrationSpecificLegacyBehavior() {
  const name = `${databaseName}_legacy_migrations`;
  const url = databaseUrl(baseUrl, name);
  psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(name)}`]);
  try {
    const release = prepareCanonicalReleaseRoles(
      url,
      applyCanonicalPreMigrationBaseline,
    );
    const providerAdmin = release.authority.providerAdmin;
    seedDirtyFixtures(providerAdmin);
    await proveMigration60LockTimeout(providerAdmin, providerAdmin);
    migrateResolve(providerAdmin, "--rolled-back", migration60Name);
    await proveCombinedLockTimeout(providerAdmin, providerAdmin);
    proveMigrationRunnerHistory(providerAdmin, migration60Name, true);
    proveFetchedAmbiguityStillPresent(providerAdmin);
    await proveTtlCrossedAfter60(providerAdmin);
    proveStatementTimeoutConfiguration(providerAdmin);
    proveInjected61Rollback(providerAdmin);
    migrateResolve(providerAdmin, "--rolled-back", migration61Name);
    discardRehearsalOnlyRolledBackMigrationHistory(providerAdmin);
    psql(providerAdmin, ["-f", migration61]);
    psql(providerAdmin, ["-f", migration62]);
    psql(providerAdmin, [
      "-Atc",
      String.raw`DO $$ BEGIN
        IF (SELECT "status" FROM "CodexOAuthWritebackIntent"
            WHERE "id"='intent-pending') <> 'remote_outcome_unknown'
           OR (SELECT "safeErrorCode" FROM "CodexOAuthWritebackIntent"
               WHERE "id"='intent-pending') <> 'legacy_remote_outcome_unknown'
        THEN RAISE EXCEPTION 'pending-to-failed-to-remote-outcome-unknown proof failed';
        END IF;
        IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') <> 'expired'
          OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-crossing') IS NOT NULL
          OR (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') <> 0
          OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') IS NOT NULL
          OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') IS NOT NULL
        THEN RAISE EXCEPTION '000061 made a post-observation TTL crossing newly eligible for reconciliation';
        END IF;
      END $$;`,
    ]);
  } finally {
    psql(
      adminUrl,
      ["-c", `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`],
      false,
    );
    cleanupRuntimeRoles(adminUrl);
  }
}

function proveCanonicalLegacyReconciliationNegativeCases() {
  for (const testCase of [
    { name: "unresolved", options: { canonicalSuccess: false } },
    {
      name: "unexpired",
      options: { canonicalSuccess: true, retainUnexpiredLease: true },
    },
    {
      name: "inventory_race",
      options: { canonicalSuccess: true },
      injectInventoryRace: true,
    },
    {
      name: "ttl_crossing",
      options: { canonicalSuccess: true },
      injectTtlCrossing: true,
    },
    {
      name: "unknown_status",
      options: { canonicalSuccess: true },
      injectUnknownStatus: true,
    },
    {
      name: "forged_digest",
      options: { canonicalSuccess: true },
      transformSourceEvidence: (evidence) => ({
        ...evidence,
        inventorySha256: `sha256:${"0".repeat(64)}`,
        observations: evidence.observations.map((sample) => ({
          ...sample,
          inventorySha256: `sha256:${"0".repeat(64)}`,
        })),
      }),
    },
  ]) {
    const name = `${databaseName}_legacy_${testCase.name}`;
    const url = databaseUrl(baseUrl, name);
    psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(name)}`]);
    try {
      const release = prepareCanonicalReleaseRoles(
        url,
        applyCanonicalPreMigrationBaseline,
      );
      seedDirtyFixtures(release.authority.providerAdmin, testCase.options);
      if (testCase.injectUnknownStatus)
        psql(release.authority.providerAdmin, [
          "-c",
          `UPDATE "CodexOAuthWritebackIntent" SET "status"='new_state'
           WHERE "id"='intent-history'`,
        ]);
      const permit = installRehearsalMigrationPermit(release.authority, {
        transformSourceEvidence: testCase.transformSourceEvidence,
      });
      if (testCase.injectTtlCrossing) {
        const cutoff = permit.REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF;
        psql(release.authority.providerAdmin, [
          "-c",
          `UPDATE "CodexOAuthLease"
             SET "expiresAt"=${quoteLiteral(cutoff)}::timestamptz + interval '100 milliseconds'
           WHERE "id"='lease-active';
           UPDATE "CodexOAuthProviderInstance"
             SET "activeLeaseExpiresAt"=${quoteLiteral(cutoff)}::timestamptz + interval '100 milliseconds'
           WHERE "id"='p-active-lease';
           SELECT pg_sleep(0.2)`,
        ]);
      }
      let rejected = false;
      try {
        let inventoryRaceInjected = false;
        const releaseRun = (step, command, args, options) => {
          if (
            testCase.injectInventoryRace &&
            !inventoryRaceInjected &&
            step === "deploy_migrations_and_converge_grants"
          ) {
            inventoryRaceInjected = true;
            psql(release.authority.providerAdmin, [
              "-c",
              `UPDATE "CodexOAuthLease" SET status='expired' WHERE id='lease-expired'`,
            ]);
          }
          return runRehearsalReleaseSubprocess(step, command, args, options);
        };
        executeCanonicalReleaseMigration(
          {
            ...release.environment,
            ...permit,
            REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "open",
          },
          releaseRun,
          loopbackRehearsalDatabaseIdentity,
        );
      } catch {
        rejected = true;
      }
      assert(rejected, `canonical ${testCase.name} fixture was not rejected`);
      const rollback = JSON.parse(
        psql(release.authority.providerAdmin, [
          "-Atc",
          `SELECT json_build_object(
          'permitState',(SELECT state FROM reviewrouter_activation.migration_permit
            WHERE rollout_id='rehearsal-rollout-v1'),
          'targetReceipt',(SELECT target_receipt FROM reviewrouter_activation.migration_permit
            WHERE rollout_id='rehearsal-rollout-v1'),
          'committedTargetMigrations',(SELECT count(*) FROM public._prisma_migrations
            WHERE migration_name IN (${[
              migration60Name,
              migration61Name,
              migration62Name,
              migration63Name,
              migration64Name,
              migration65Name,
              migration66Name,
              migration69Name,
              migration70Name,
              migration71Name,
              migration72RetireName,
              migration72CanaryName,
              migration73Name,
            ]
              .map(quoteLiteral)
              .join(
                ",",
              )}) AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
        )`,
        ]).stdout.trim(),
      );
      assert(
        rollback.permitState === "installed" &&
          rollback.targetReceipt === null &&
          rollback.committedTargetMigrations === 0,
        `canonical ${testCase.name} rejection was not fully retryable`,
      );
    } finally {
      psql(
        adminUrl,
        ["-c", `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`],
        false,
      );
      cleanupRuntimeRoles(adminUrl);
    }
  }
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
      failureMarker: "CodexOAuthSetupManifest_recovery_expiry_idx",
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
      failureMarker: "CodexOAuthSecretNamespace_secretName_key",
      leaked:
        "SELECT count(*) FROM information_schema.tables WHERE table_name='CodexOAuthSecretNamespace'",
    },
    {
      name: migration65Name,
      source: migration65,
      prior: [
        [migration60Name, migration60],
        [migration61Name, migration61],
        [migration62Name, migration62],
        [migration63Name, migration63],
        [migration64Name, migration64],
      ],
      decoy:
        'CREATE FUNCTION "codex_oauth_database_authority_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      cleanup: 'DROP FUNCTION "codex_oauth_database_authority_receipt_guard"()',
      failureMarker: "codex_oauth_database_authority_receipt_guard",
      leaked:
        "SELECT count(*) FROM pg_proc WHERE proname='codex_oauth_authorize_provider_identity_repair'",
    },
    {
      name: migration66Name,
      source: migration66,
      prior: [
        [migration60Name, migration60],
        [migration61Name, migration61],
        [migration62Name, migration62],
        [migration63Name, migration63],
        [migration64Name, migration64],
        [migration65Name, migration65],
      ],
      decoy:
        'CREATE FUNCTION "codex_oauth_runtime_referential_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$',
      cleanup: 'DROP FUNCTION "codex_oauth_runtime_referential_action_guard"()',
      failureMarker: "codex_oauth_runtime_referential_action_guard",
      leaked:
        "SELECT count(*) FROM pg_proc WHERE proname='codex_oauth_provider_identity_repair_challenge'",
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const name = `${databaseName}_atomic_${index}`;
    const url = databaseUrl(baseUrl, name);
    psql(adminUrl, ["-c", `CREATE DATABASE ${quoteIdentifier(name)}`]);
    try {
      applyCanonicalPreMigrationBaseline(url);
      psql(url, ["-c", testCase.decoy]);
      const failed = migrateDeploy(url, false);
      assertPrismaMigrationFailureEnvelope(
        failed,
        testCase.failureMarker,
        `${testCase.name} injected failure did not report its decoy collision`,
      );
      for (const [migrationName] of testCase.prior) {
        proveMigrationRunnerHistory(url, migrationName, true);
      }
      proveMigrationRunnerHistory(url, testCase.name, false);
      const directFailure = psql(url, ["-f", testCase.source], false);
      assert(
        directFailure.status !== 0 &&
          `${directFailure.stdout}${directFailure.stderr}`.includes(
            testCase.failureMarker,
          ) &&
          `${directFailure.stdout}${directFailure.stderr}`
            .toLowerCase()
            .includes("already exists"),
        `${testCase.name} direct replay did not prove its decoy collision`,
      );
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

function proveReleaseAuthorityMarkerIsolation(url) {
  proveMigrationRunnerHistory(url, migration69Name, true);
  const forbiddenObjects = psql(url, [
    "-Atc",
    String.raw`
      SELECT count(*)
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'release_authority')
        AND (
          relation.relname LIKE 'release_rollout_%'
          OR relation.relname LIKE 'release_runner_%'
        )`,
  ]).stdout.trim();
  assert(
    forbiddenObjects === "0",
    "000069 no-op marker created release authority objects in the application database",
  );
  for (const role of [
    "reviewrouter_release_control",
    "reviewrouter_release_witness",
  ]) {
    assert(
      psql(url, [
        "-Atc",
        `SELECT count(*) FROM pg_roles WHERE rolname=${quoteLiteral(role)}`,
      ]).stdout.trim() === "0",
      `000069 no-op marker created external authority role ${role} in the application database`,
    );
  }
}

function applyCanonicalPreMigrationBaseline(url) {
  const applied = [];
  for (const directory of readdirSync(migrationsDirectory).sort()) {
    const number = Number.parseInt(directory.slice(0, 6), 10);
    const isCanonicalPreMigration =
      Number.isInteger(number) &&
      (number <= 59 ||
        directory === migration67Name ||
        directory === migration68Name);
    if (!isCanonicalPreMigration) continue;
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
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
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
  const manifestIdentity = `sha256:${createHash("sha256")
    .update(
      applied
        .map(({ name, checksum }) => `${name}:${checksum}`)
        .sort()
        .join(","),
    )
    .digest("hex")}`;
  assert(
    manifestIdentity === rehearsalPreManifestIdentitySha256,
    "rehearsal baseline must reproduce the trusted pre-migration manifest",
  );
}

function seedDirtyFixtures(
  url,
  { canonicalSuccess = false, retainUnexpiredLease = false } = {},
) {
  const activeLeaseExpiry =
    canonicalSuccess && !retainUnexpiredLease
      ? "now() - interval '10 minutes'"
      : "now() + interval '10 minutes'";
  const otherLeaseExpiry = canonicalSuccess
    ? "now() - interval '1 minute'"
    : "now() + interval '1 minute'";
  const intentRows = canonicalSuccess
    ? String.raw`('intent-pending', 'p-pending', 'lease-pending', 'codex-rotating:900005', 'intent-key', 2, 'hash', 'digest', 'kid', 'failed', 'canonical_fixture_terminal', now()),
        ('intent-history', 'p-pending', 'lease-pending', 'codex-rotating:900005', 'history-key', 1, 'hash', 'digest', 'kid', 'completed', NULL, now()),
        ('intent-dirty', 'p-dirty-child', 'lease-dirty', 'wrong-provider-id', 'dirty-key', 1, 'hash', 'digest', 'kid', 'failed', 'identity_quarantined', now())`
    : String.raw`('intent-pending', 'p-pending', 'lease-pending', 'codex-rotating:900005', 'intent-key', 2, 'hash', 'digest', 'kid', 'pending', NULL, now()),
        ('intent-history', 'p-pending', 'lease-pending', 'codex-rotating:900005', 'history-key', 1, 'hash', 'digest', 'kid', 'completed', NULL, now()),
        ('intent-dirty', 'p-dirty-child', 'lease-dirty', 'wrong-provider-id', 'dirty-key', 1, 'hash', 'digest', 'kid', 'pending', NULL, now())`;
  psql(url, [
    "-c",
    String.raw`
      INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt")
      VALUES ('ws-proof', 'ws-proof', 'migration proof', CURRENT_TIMESTAMP);
      INSERT INTO "GitHubInstallation" (
        "id", "workspaceId", "githubInstallationId", "accountLogin", "accountType",
        "repositorySelection", "updatedAt"
      ) VALUES (
        'installation-proof', 'ws-proof', 990001, 'proof', 'Organization', 'selected', now()
      );
      INSERT INTO "GitLabInstallation" (
        "id", "workspaceId", "sourceBaseUrl", "namespacePath", "sourceKind",
        "updatedAt"
      ) VALUES (
        'gitlab-installation-proof', 'ws-proof', 'https://gitlab.example',
        'proof', 'group', now()
      );
      INSERT INTO "RepositoryConnection" (
        "id", "workspaceId", "githubRepositoryId", "externalRepositoryId",
        "owner", "name", "fullName", "defaultBranch", "visibility", "updatedAt"
      )
      SELECT 'repo-' || n, 'ws-proof', 900000 + n, (900000 + n)::text,
        'local', 'proof-' || n, 'local/proof-' || n, 'main', 'private', CURRENT_TIMESTAMP
      FROM generate_series(1, 13) n;
      UPDATE "RepositoryConnection"
      SET "installationId" = 'installation-proof'
      WHERE "id" = 'repo-7';
      UPDATE "RepositoryConnection"
      SET "gitlabInstallationId" = 'gitlab-installation-proof'
      WHERE "id" = 'repo-8';
      INSERT INTO "ScmRepositoryIdentity" (
        "scmRepositoryIdentityId", "provider", "normalizedSourceBaseUrl",
        "externalRepositoryId", "createdAt"
      ) VALUES (
        'scm-identity-proof', 'github', 'https://github.com', '900007', now()
      );
      UPDATE "RepositoryConnection"
      SET "scmRepositoryIdentityId" = 'scm-identity-proof'
      WHERE "id" = 'repo-7';
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
        ('p-active-lease', 'ws-proof', 'repo-3', 'codex-rotating:900003', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', 'lease-active', ${activeLeaseExpiry}, now()),
        ('p-expired-lease', 'ws-proof', 'repo-4', 'codex-rotating:900004', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', 'lease-expired', now() - interval '1 minute', now()),
        ('p-pending', 'ws-proof', 'repo-5', 'codex-rotating:900005', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', NULL, NULL, now()),
        ('p-quarantine', 'ws-proof', 'repo-6', 'legacy-wrong-id', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', NULL, NULL, now()),
        ('p-clean', 'ws-proof', 'repo-7', 'codex-rotating:900007', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'active', 'salt', 'salt', NULL, NULL, now()),
        ('p-recovery', 'ws-proof', 'repo-8', 'codex-rotating:900008', 'codex_subscription_oauth_rotating', 'REVIEWROUTER_CODEX_AUTH_JSON', 'unknown_auth_state', 'salt', 'salt', 'lease-recovery', ${otherLeaseExpiry}, now());
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
        ('lease-active', 'p-active-lease', 'codex-rotating:900003', 'ws-proof', 'repo-3', 'run-3', '1', 'key-3', 'preleased', ${activeLeaseExpiry}),
        ('lease-expired', 'p-expired-lease', 'codex-rotating:900004', 'ws-proof', 'repo-4', 'run-4', '1', 'key-4', 'finalized', now() - interval '1 minute'),
        ('lease-pending', 'p-pending', 'codex-rotating:900005', 'ws-proof', 'repo-5', 'run-5', '1', 'key-5', 'preleased', ${otherLeaseExpiry}),
        ('lease-recovery', 'p-recovery', 'codex-rotating:900008', 'ws-proof', 'repo-8', 'run-8', '1', 'key-8', 'preleased', ${otherLeaseExpiry}),
        ('lease-stray', 'p-stray-lease', 'codex-rotating:900009', 'ws-proof', 'repo-9', 'run-9', '1', 'key-9', 'preleased', ${otherLeaseExpiry}),
        ('lease-provider-dirty', 'p-quarantine', 'legacy-wrong-id', 'ws-proof', 'repo-6', 'run-6', '1', 'key-6', 'preleased', ${otherLeaseExpiry}),
        ('lease-dirty', 'p-dirty-child', 'wrong-provider-id', 'ws-proof', 'repo-9', 'run-10', '1', 'key-10', 'preleased', ${otherLeaseExpiry});
      INSERT INTO "CodexOAuthWritebackIntent" (
        "id", "providerInstanceRowId", "leaseId", "providerInstanceId", "idempotencyKey",
        "generation", "latestGenerationHash", "encryptedPayloadDigest", "keyId", "status", "safeErrorCode", "updatedAt"
      ) VALUES
        ${intentRows};
    `,
  ]);
}

async function proveMigration60LockTimeout(url, fixtureAdminUrl) {
  const applicationName = `rr_setup_lock_${process.pid}`;
  const holderUrl = withApplicationName(fixtureAdminUrl, applicationName);
  const holderInvocation = createSecretSafePostgresInvocation({
    databaseUrl: holderUrl,
    args: [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      'BEGIN; LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS SHARE MODE; SELECT pg_sleep(60);',
    ],
  });
  const holder = spawn(psqlBinary, holderInvocation.args, {
    stdio: ["pipe", "ignore", "ignore"],
    env: holderInvocation.environment,
  });
  holder.stdin.end(holderInvocation.input);
  try {
    await waitForLock(
      fixtureAdminUrl,
      applicationName,
      '"CodexOAuthSetupManifest"',
    );
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
      "direct_000060_lock_timeout_not_observed",
    );
    assert(
      directElapsedMs >= 14_000 && directElapsedMs < 30_000,
      `direct 000060 lock timeout was not bounded near 15s (${directElapsedMs}ms)`,
    );

    const runnerStartedAt = Date.now();
    const runnerFailure = migrateDeploy(url, false);
    const runnerElapsedMs = Date.now() - runnerStartedAt;
    assert(
      runnerFailure.status !== 0,
      "held manifest lock must reject runner 000060",
    );
    assertPrismaLockTimeoutEnvelope(
      runnerFailure,
      "runner_000060_lock_timeout_not_observed",
    );
    assert(
      runnerElapsedMs >= 14_000 && runnerElapsedMs < 30_000,
      `prisma_000060_lock_timeout_unbounded:${runnerElapsedMs}`,
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
    holderInvocation.cleanup();
    psql(
      fixtureAdminUrl,
      [
        "-Atc",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${quoteLiteral(applicationName)}`,
      ],
      false,
    );
  }
}

async function proveCombinedLockTimeout(url, fixtureAdminUrl) {
  const applicationName = `rr_fence_lock_${process.pid}`;
  const holderUrl = withApplicationName(fixtureAdminUrl, applicationName);
  const holderInvocation = createSecretSafePostgresInvocation({
    databaseUrl: holderUrl,
    args: [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      'BEGIN; LOCK TABLE "CodexOAuthProviderInstance" IN ACCESS SHARE MODE; SELECT pg_sleep(60);',
    ],
  });
  const holder = spawn(psqlBinary, holderInvocation.args, {
    stdio: ["pipe", "ignore", "ignore"],
    env: holderInvocation.environment,
  });
  holder.stdin.end(holderInvocation.input);
  try {
    await waitForLock(
      fixtureAdminUrl,
      applicationName,
      '"CodexOAuthProviderInstance"',
    );
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
      "direct_000061_lock_timeout_not_observed",
    );
    assert(
      directElapsedMs >= 14_000 && directElapsedMs < 30_000,
      `direct 000061 lock timeout was not bounded near 15s (${directElapsedMs}ms)`,
    );

    const startedAt = Date.now();
    const failed = migrateDeploy(url, false);
    const elapsedMs = Date.now() - startedAt;
    assert(
      failed.status !== 0,
      "held provider lock must reject combined runner release",
    );
    assertPrismaLockTimeoutEnvelope(
      failed,
      "runner_000061_lock_timeout_not_observed",
    );
    assert(
      elapsedMs >= 14_000 && elapsedMs < 30_000,
      `prisma_000061_lock_timeout_unbounded:${elapsedMs}`,
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
    holderInvocation.cleanup();
    psql(
      fixtureAdminUrl,
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
    "direct_000061_injected_failure_not_observed",
  );
  assert(
    databaseFingerprintBefore61(url) === before,
    "direct 000061 transaction did not roll back atomically",
  );

  const failed = migrateDeploy(url, false);
  assertPrismaMigrationFailureEnvelope(
    failed,
    "CodexOAuthProviderInstance_mutation_owner_idx",
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
    "migration_000061_statement_timeout_not_observed",
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
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched') <> 'setup-recovery:legacy-cutover:rehearsal-rollout-v1:p-fetched'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE id = 'p-fetched') <> 3
        OR (SELECT status FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-new') <> 'recovered'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-new') <> 1
        OR (SELECT state FROM "CodexOAuthSetupRecoveryRequest"
            WHERE id = 'legacy-cutover:rehearsal-rollout-v1:p-fetched') <> 'superseded'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupRecoveryRequest"
            WHERE id = 'legacy-cutover:rehearsal-rollout-v1:p-fetched') <> 3
        OR (SELECT "databaseRecoveryWitness" FROM "CodexOAuthSetupRecoveryRequest"
            WHERE id = 'legacy-cutover:rehearsal-rollout-v1:p-fetched') <> repeat('f', 64)
        OR (SELECT "confirmationJson"->>'recoveryRequestId' FROM "CodexOAuthSetupManifest"
            WHERE id = 'fetched-new') <> 'legacy-cutover:rehearsal-rollout-v1:p-fetched'
        OR (SELECT "confirmationJson"->>'legacyInventorySha256' FROM "CodexOAuthSetupManifest"
            WHERE id = 'fetched-new') !~ '^sha256:[a-f0-9]{64}$'
      THEN RAISE EXCEPTION 'fetched ambiguity did not enter durable setup recovery ownership'; END IF;
      IF (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-issued') <> 'versioned-namespace-cutover:p-issued'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'issued-new') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-active') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-expired') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-pending') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthLease" WHERE id = 'lease-stray') <> 1
        OR (SELECT "mutationEpoch" FROM "CodexOAuthSetupManifest" WHERE id = 'fetched-recovery') <> 1
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-recovery') <> 'recovery'
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-recovery') <> 'setup-recovery:legacy-cutover:rehearsal-rollout-v1:p-recovery'
        OR (SELECT "mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE id = 'p-recovery') <> 3
        OR (SELECT "mutationOwnerId" FROM "CodexOAuthProviderInstance" WHERE id = 'p-stray-lease') <> 'versioned-namespace-cutover:p-stray-lease'
        OR (SELECT "mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-clean') <> 'recovery'
        OR EXISTS (
          SELECT 1 FROM "CodexOAuthProviderInstance" p
          WHERE p."activeSecretNamespaceId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "CodexOAuthProviderIdentityQuarantine" q WHERE q."providerInstanceRowId" = p.id AND q."resolvedAt" IS NULL)
            AND (p."state" <> 'unknown_auth_state' OR p."mutationOwner" <> 'recovery' OR NOT (
              p."mutationOwnerId" = 'versioned-namespace-cutover:' || p.id
              OR EXISTS (
                SELECT 1 FROM "CodexOAuthSetupRecoveryRequest" request
                WHERE request."providerInstanceRowId" = p.id
                  AND request.id = 'legacy-cutover:rehearsal-rollout-v1:' || p.id
                  AND request.state = 'superseded'
              )
            ))
        )
      THEN RAISE EXCEPTION 'setup/lease/provider versioned cutover backfills are wrong'; END IF;
      -- Canonical success starts with terminal evidence only. The dedicated
      -- migration proof above retains pending -> failed ->
      -- remote_outcome_unknown coverage without weakening the release gate.
      IF (SELECT status FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 'failed'
        OR (SELECT "safeErrorCode" FROM "CodexOAuthWritebackIntent" WHERE id = 'intent-pending') <> 'canonical_fixture_terminal'
        OR EXISTS (SELECT 1 FROM "CodexOAuthWritebackIntent"
          WHERE status IN ('pending','remote_outcome_unknown'))
      THEN RAISE EXCEPTION 'canonical success fixture retained unresolved intent evidence'; END IF;
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
      WHERE NOT tgisinternal
        AND (tgname LIKE 'CodexOAuth%guard' OR tgname LIKE 'RepositoryConnection%guard');
      expected := ARRAY[${[...codexRotatingTriggers]
        .sort()
        .map((name) => quoteLiteral(name))
        .join(",")}];
      IF actual <> expected THEN RAISE EXCEPTION 'trigger catalog mismatch: %', actual; END IF;
      IF EXISTS (
        SELECT 1 FROM (VALUES
          ('CodexOAuthDatabaseAuthorityReceipt_one_shot_guard','CodexOAuthDatabaseAuthorityReceipt','codex_oauth_database_authority_receipt_guard',27::smallint),
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
  proveMigrationRunnerHistory(url, migration65Name, true);
  proveMigrationRunnerHistory(url, migration66Name, true);
}

function proveVersionedNamespaceLedger(url) {
  const evidence = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_build_object(
        'initialSetupTombstone', (
          SELECT row_to_json(exact_initial_setup_tombstone) FROM (
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
          ) exact_initial_setup_tombstone
        ),
        'activeRecoverySetupNamespace', (
          SELECT row_to_json(exact_active_recovery_setup_namespace) FROM (
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
          ) exact_active_recovery_setup_namespace
        ),
        'definiteIntentOnRetiredInitialNamespace', (
          SELECT row_to_json(exact_definite_intent_on_retired_initial_namespace) FROM (
            SELECT intent."id" AS "intentId", namespace."id" AS "namespaceId",
              namespace."namespaceEpoch"::text AS "namespaceEpoch",
              namespace."status" AS "namespaceStatus", namespace."permanentlyRetired",
              intent."status" AS "intentStatus"
            FROM "CodexOAuthWritebackIntent" intent
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = intent."secretNamespaceId"
            WHERE intent."providerInstanceRowId" = 'p-clean'
              AND intent."idempotencyKey" = 'proof:definite'
          ) exact_definite_intent_on_retired_initial_namespace
        ),
        'recoveredAmbiguousIntentOnRetiredInitialNamespace', (
          SELECT row_to_json(exact_recovered_ambiguous_intent_on_retired_initial_namespace) FROM (
            SELECT intent."id" AS "intentId", namespace."id" AS "namespaceId",
              namespace."namespaceEpoch"::text AS "namespaceEpoch",
              namespace."status" AS "namespaceStatus", namespace."permanentlyRetired",
              intent."status" AS "intentStatus", intent."recoveryRequestRowId"
            FROM "CodexOAuthWritebackIntent" intent
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = intent."secretNamespaceId"
            WHERE intent."providerInstanceRowId" = 'p-clean'
              AND intent."idempotencyKey" = 'proof:ambiguous'
          ) exact_recovered_ambiguous_intent_on_retired_initial_namespace
        ),
        'completedIntentOnActiveRecoveryNamespace', (
          SELECT row_to_json(exact_completed_intent_on_active_recovery_namespace) FROM (
            SELECT intent."id" AS "intentId", namespace."id" AS "namespaceId",
              namespace."secretName", namespace."namespaceEpoch"::text AS "namespaceEpoch",
              intent."accountIdentityHash", intent."latestGenerationHash",
              intent."status" AS "intentStatus",
              namespace."status" AS "namespaceStatus", namespace."permanentlyRetired"
            FROM "CodexOAuthWritebackIntent" intent
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = intent."secretNamespaceId"
            WHERE intent."providerInstanceRowId" = 'p-clean'
              AND intent."idempotencyKey" = 'proof:rollback'
          ) exact_completed_intent_on_active_recovery_namespace
        ),
        'confirmedRestartUnknownIntentOnActiveRecoveryNamespace', (
          SELECT row_to_json(exact_confirmed_restart_unknown_intent_on_active_recovery_namespace) FROM (
            SELECT intent."id" AS "intentId", namespace."id" AS "namespaceId",
              namespace."namespaceEpoch"::text AS "namespaceEpoch",
              namespace."status" AS "namespaceStatus", namespace."permanentlyRetired",
              intent."status" AS "intentStatus"
            FROM "CodexOAuthWritebackIntent" intent
            JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = intent."secretNamespaceId"
            WHERE intent."providerInstanceRowId" = 'p-clean'
              AND intent."idempotencyKey" = 'proof:confirmed-restart'
          ) exact_confirmed_restart_unknown_intent_on_active_recovery_namespace
        ),
        'provider', (
          SELECT row_to_json(exact_provider) FROM (
            SELECT provider."id", provider."workspaceId", provider."repositoryId",
              repository."githubRepositoryId"::text AS "githubRepositoryId",
              provider."activeSecretNamespaceId",
              provider."activeSecretNamespaceEpoch"::text AS "activeSecretNamespaceEpoch",
              provider."activeSecretNamespaceName", provider."activeAccountIdentityHash",
              provider."latestGenerationHash"
            FROM "CodexOAuthProviderInstance" provider
            JOIN "RepositoryConnection" repository ON repository."id" = provider."repositoryId"
            WHERE provider."id" = 'p-clean'
          ) exact_provider
        )
      )`,
    ]).stdout.trim(),
  );
  assert(
    evidence.initialSetupTombstone?.claimStatus === "retired_active" &&
      evidence.initialSetupTombstone.attemptStatus === "retired_confirmed" &&
      evidence.initialSetupTombstone.namespaceStatus === "retired_superseded" &&
      evidence.initialSetupTombstone.permanentlyRetired === true,
    "runtime production path did not retain the exact initial setup namespace tombstone",
  );
  assert(
    evidence.activeRecoverySetupNamespace?.claimStatus === "active" &&
      evidence.activeRecoverySetupNamespace.attemptStatus === "confirmed" &&
      evidence.activeRecoverySetupNamespace.namespaceStatus === "active" &&
      evidence.activeRecoverySetupNamespace.permanentlyRetired === false &&
      evidence.activeRecoverySetupNamespace.namespaceId ===
        evidence.completedIntentOnActiveRecoveryNamespace?.namespaceId &&
      evidence.activeRecoverySetupNamespace.namespaceId ===
        evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace
          ?.namespaceId,
    "runtime production path did not retain the active recovery setup namespace",
  );
  assert(
    evidence.definiteIntentOnRetiredInitialNamespace?.intentStatus ===
      "completed" &&
      evidence.definiteIntentOnRetiredInitialNamespace.namespaceStatus ===
        "retired_superseded" &&
      evidence.definiteIntentOnRetiredInitialNamespace.permanentlyRetired ===
        true &&
      evidence.definiteIntentOnRetiredInitialNamespace.namespaceId ===
        evidence.initialSetupTombstone.namespaceId,
    "runtime production path did not retain the exact definite namespace tombstone",
  );
  assert(
    evidence.completedIntentOnActiveRecoveryNamespace?.intentStatus ===
      "completed" &&
      evidence.completedIntentOnActiveRecoveryNamespace.namespaceStatus ===
        "active" &&
      evidence.completedIntentOnActiveRecoveryNamespace.permanentlyRetired ===
        false &&
      evidence.provider?.activeSecretNamespaceId ===
        evidence.completedIntentOnActiveRecoveryNamespace.namespaceId &&
      evidence.provider.activeSecretNamespaceEpoch ===
        evidence.completedIntentOnActiveRecoveryNamespace.namespaceEpoch &&
      evidence.provider.activeSecretNamespaceName ===
        evidence.completedIntentOnActiveRecoveryNamespace.secretName &&
      evidence.provider.activeAccountIdentityHash ===
        evidence.completedIntentOnActiveRecoveryNamespace.accountIdentityHash &&
      evidence.provider.latestGenerationHash ===
        evidence.completedIntentOnActiveRecoveryNamespace.latestGenerationHash,
    "runtime production path exact proof:rollback namespace binding is incomplete",
  );
  assert(
    evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace
      ?.intentStatus === "remote_outcome_unknown" &&
      evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace
        .namespaceStatus === "active" &&
      evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace
        .permanentlyRetired === false,
    "runtime production path did not retain the confirmed-restart unknown intent on the active namespace",
  );
  assert(
    BigInt(evidence.initialSetupTombstone.namespaceEpoch) ===
      BigInt(evidence.definiteIntentOnRetiredInitialNamespace.namespaceEpoch) &&
      BigInt(
        evidence.definiteIntentOnRetiredInitialNamespace.namespaceEpoch,
      ) ===
        BigInt(
          evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace
            .namespaceEpoch,
        ) &&
      BigInt(
        evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace
          .namespaceEpoch,
      ) < BigInt(evidence.activeRecoverySetupNamespace.namespaceEpoch) &&
      BigInt(evidence.activeRecoverySetupNamespace.namespaceEpoch) ===
        BigInt(
          evidence.completedIntentOnActiveRecoveryNamespace.namespaceEpoch,
        ) &&
      BigInt(evidence.activeRecoverySetupNamespace.namespaceEpoch) ===
        BigInt(
          evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace
            .namespaceEpoch,
        ),
    "runtime production path namespace reuse epochs are inconsistent across the evidence chain",
  );
  assert(
    evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace
      ?.namespaceStatus === "retired_superseded" &&
      evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace
        .permanentlyRetired === true &&
      evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace
        .intentStatus === "remote_outcome_unknown" &&
      typeof evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace
        .recoveryRequestRowId === "string" &&
      evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace.namespaceId ===
        evidence.initialSetupTombstone.namespaceId,
    "runtime production path did not retain the recovered ambiguous intent on the retired initial namespace",
  );

  const initialSetupTombstone = evidence.initialSetupTombstone;
  const activeRecoverySetupNamespace = evidence.activeRecoverySetupNamespace;
  const completedIntentOnActiveRecoveryNamespace =
    evidence.completedIntentOnActiveRecoveryNamespace;
  const provider = evidence.provider;
  const recreate = psql(
    url,
    [
      "-c",
      `INSERT INTO "CodexOAuthSecretNamespace" ("id","providerInstanceRowId","githubRepositoryId","namespaceEpoch","secretName","databaseRecoveryWitness","status")
       SELECT 'namespace-reuse-proof', ${quoteLiteral(provider.id)}, ${quoteLiteral(provider.githubRepositoryId)},
         max("namespaceEpoch") + 1, ${quoteLiteral(initialSetupTombstone.secretName)}, ${quoteLiteral(initialSetupTombstone.databaseRecoveryWitness)}, 'dispatch_authorized'
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
      `UPDATE "CodexOAuthProviderInstance" SET "activeSecretNamespaceName"=${quoteLiteral(initialSetupTombstone.secretName)} WHERE "id"=${quoteLiteral(provider.id)}`,
      "codex_oauth_provider_mutation_fence_required",
    ],
    [
      `UPDATE "CodexOAuthProviderInstance" SET "activeAccountIdentityHash"=repeat('x',64) WHERE "id"=${quoteLiteral(provider.id)}`,
      "codex_oauth_provider_mutation_fence_required",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "manifestDigest"=repeat('f',64) WHERE "id"=${quoteLiteral(activeRecoverySetupNamespace.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "recoveryEpoch"="recoveryEpoch"+1 WHERE "id"=${quoteLiteral(activeRecoverySetupNamespace.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "installerDigest"=repeat('f',64) WHERE "id"=${quoteLiteral(activeRecoverySetupNamespace.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "databaseRecoveryWitness"=repeat('f',64) WHERE "id"=${quoteLiteral(activeRecoverySetupNamespace.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupPayloadClaim" SET "confirmedAttemptId"=${quoteLiteral(initialSetupTombstone.attemptId)} WHERE "id"=${quoteLiteral(activeRecoverySetupNamespace.claimId)}`,
      "codex_oauth_setup_claim_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupDispatchAttempt" SET "dispatchExpiresAt"="dispatchExpiresAt"+interval '1 minute' WHERE "id"=${quoteLiteral(activeRecoverySetupNamespace.attemptId)}`,
      "codex_oauth_setup_attempt_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "workflowSourceBlobSha"=repeat('e',40) WHERE "id"=${quoteLiteral(completedIntentOnActiveRecoveryNamespace.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "workflowSourceSha256"=repeat('e',64) WHERE "id"=${quoteLiteral(completedIntentOnActiveRecoveryNamespace.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "workflowSemanticSha256"=repeat('e',64) WHERE "id"=${quoteLiteral(completedIntentOnActiveRecoveryNamespace.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
    [
      `UPDATE "CodexOAuthSecretNamespace" SET "attestedRepositoryId"='900008' WHERE "id"=${quoteLiteral(completedIntentOnActiveRecoveryNamespace.namespaceId)}`,
      "codex_oauth_secret_namespace_identity_immutable",
    ],
  ];
  for (const [statement, expectedError] of forbiddenMutations) {
    const rejected = psql(url, ["-c", statement], false);
    assert(
      rejected.status !== 0 &&
        `${rejected.stdout}${rejected.stderr}`.includes(expectedError),
      "fence_critical_mutation_not_rejected",
    );
  }
  for (const [table, id, expectedError] of [
    [
      "CodexOAuthSecretNamespace",
      initialSetupTombstone.namespaceId,
      "codex_oauth_secret_namespace_delete_forbidden",
    ],
    [
      "CodexOAuthSecretNamespace",
      activeRecoverySetupNamespace.namespaceId,
      "codex_oauth_secret_namespace_delete_forbidden",
    ],
    [
      "CodexOAuthSetupDispatchAttempt",
      activeRecoverySetupNamespace.attemptId,
      "codex_oauth_setup_attempt_delete_forbidden",
    ],
    [
      "CodexOAuthSetupPayloadClaim",
      activeRecoverySetupNamespace.claimId,
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
  for (const [table, id, expectedReasons] of [
    [
      "CodexOAuthProviderInstance",
      provider.id,
      [
        "codex_oauth_setup_manifest_delete_forbidden",
        "CodexOAuthSetupPayloadClaim_provider_fkey",
        "CodexOAuthSecretNamespace_provider_fkey",
      ],
    ],
    [
      "RepositoryConnection",
      provider.repositoryId,
      [
        "codex_oauth_setup_manifest_delete_forbidden",
        "CodexOAuthSetupPayloadClaim_repository_fkey",
        "CodexOAuthSetupPayloadClaim_provider_fkey",
        "CodexOAuthSecretNamespace_provider_fkey",
      ],
    ],
    [
      "Workspace",
      provider.workspaceId,
      [
        "codex_oauth_setup_manifest_delete_forbidden",
        "CodexOAuthSetupPayloadClaim_workspace_fkey",
        "CodexOAuthSetupPayloadClaim_repository_fkey",
        "CodexOAuthSetupPayloadClaim_provider_fkey",
        "CodexOAuthSecretNamespace_provider_fkey",
      ],
    ],
  ]) {
    const ownerDeletion = psql(
      url,
      ["-c", `DELETE FROM "${table}" WHERE "id"=${quoteLiteral(id)}`],
      false,
    );
    assertPsqlFailedWithOneOfExactMessages(
      ownerDeletion,
      expectedReasons,
      `${table} cleanup must retain evidence through the expected constraint`,
    );
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
      (SELECT count(*) FROM "CodexOAuthSetupPayloadClaim"
        WHERE "id"=${quoteLiteral(evidence.activeRecoverySetupNamespace.claimId)}
          AND "confirmedAttemptId"=${quoteLiteral(evidence.activeRecoverySetupNamespace.attemptId)}
          AND "status"='active'),
      (SELECT count(*) FROM "CodexOAuthSetupDispatchAttempt"
        WHERE "id"=${quoteLiteral(evidence.activeRecoverySetupNamespace.attemptId)}
          AND "namespaceId"=${quoteLiteral(evidence.activeRecoverySetupNamespace.namespaceId)}
          AND "status"='confirmed'),
      (SELECT count(*) FROM "CodexOAuthSecretNamespace"
        WHERE "id"=${quoteLiteral(evidence.initialSetupTombstone.namespaceId)}
          AND "status"='retired_superseded' AND "permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthSecretNamespace"
        WHERE "id"=${quoteLiteral(evidence.activeRecoverySetupNamespace.namespaceId)}
          AND "status"='active' AND NOT "permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthWritebackIntent" intent
        JOIN "CodexOAuthSecretNamespace" namespace
          ON namespace."id"=intent."secretNamespaceId"
        WHERE intent."id"=${quoteLiteral(evidence.definiteIntentOnRetiredInitialNamespace.intentId)}
          AND intent."idempotencyKey"='proof:definite'
          AND intent."status"='completed'
          AND namespace."id"=${quoteLiteral(evidence.definiteIntentOnRetiredInitialNamespace.namespaceId)}
          AND namespace."status"='retired_superseded' AND namespace."permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthWritebackIntent" intent
        JOIN "CodexOAuthSecretNamespace" namespace
          ON namespace."id"=intent."secretNamespaceId"
        WHERE intent."id"=${quoteLiteral(evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace.intentId)}
          AND intent."idempotencyKey"='proof:ambiguous'
          AND intent."status"='remote_outcome_unknown'
          AND intent."recoveryRequestRowId" IS NOT NULL
          AND namespace."id"=${quoteLiteral(evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace.namespaceId)}
          AND namespace."status"='retired_superseded' AND namespace."permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthWritebackIntent" intent
        JOIN "CodexOAuthSecretNamespace" namespace
          ON namespace."id"=intent."secretNamespaceId"
        WHERE intent."id"=${quoteLiteral(evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace.intentId)}
          AND intent."idempotencyKey"='proof:confirmed-restart'
          AND intent."status"='remote_outcome_unknown'
          AND namespace."id"=${quoteLiteral(evidence.confirmedRestartUnknownIntentOnActiveRecoveryNamespace.namespaceId)}
          AND namespace."status"='active' AND NOT namespace."permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthWritebackIntent" intent
        JOIN "CodexOAuthSecretNamespace" namespace
          ON namespace."id"=intent."secretNamespaceId"
        WHERE intent."id"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.intentId)}
          AND intent."idempotencyKey"='proof:rollback'
          AND intent."status"='completed'
          AND namespace."id"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.namespaceId)}
          AND namespace."status"='active' AND NOT namespace."permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthSecretNamespace"
        WHERE "providerInstanceRowId"=${quoteLiteral(evidence.provider.id)}
          AND "status"='active' AND NOT "permanentlyRetired"),
      (SELECT count(*) FROM "CodexOAuthProviderInstance" WHERE "id"=${quoteLiteral(evidence.provider.id)}
        AND "activeSecretNamespaceId"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.namespaceId)}
        AND "activeSecretNamespaceEpoch"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.namespaceEpoch)}::bigint
        AND "activeSecretNamespaceName"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.secretName)}
        AND "activeAccountIdentityHash"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.accountIdentityHash)}
        AND "latestGenerationHash"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.latestGenerationHash)})
    )`,
  ]).stdout.trim();
  assert(
    retained === "1:1:1:1:1:1:1:1:1:1",
    `${attemptedTable}_cleanup_changed_runtime_evidence_chain`,
  );
}

function provePrismaCleanupRetention(url, evidence) {
  const credential = createDatabaseCredentialBoundary(url);
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "scripts/prove-codex-rotating-evidence-prisma.ts"),
      ],
      {
        cwd: root,
        env: {
          ...credential.environment,
          REVIEW_ROUTER_PRISMA_EVIDENCE_DATABASE_URL_FILE:
            credential.environment.REVIEW_ROUTER_DATABASE_URL_FILE,
          REVIEW_ROUTER_PRISMA_EVIDENCE_IDENTITIES: JSON.stringify({
            claimId: evidence.activeRecoverySetupNamespace.claimId,
            attemptId: evidence.activeRecoverySetupNamespace.attemptId,
            namespaceId: evidence.initialSetupTombstone.namespaceId,
            providerId: evidence.provider.id,
            repositoryId: evidence.provider.repositoryId,
            workspaceId: evidence.provider.workspaceId,
          }),
        },
        encoding: "utf8",
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } finally {
    credential.cleanup();
  }
  assert(
    result.status === 0,
    JSON.stringify(rehearsalProcessDiagnostic(result)),
  );
  assertVersionedNamespaceEvidenceRetained(url, evidence, "Prisma");
}

function proveRuntimeVersionedWriteback(providerAdminUrl, clients) {
  const credentials = {
    providerAdmin: createDatabaseCredentialBoundary(providerAdminUrl),
    api: createDatabaseCredentialBoundary(clients.api),
    web: createDatabaseCredentialBoundary(clients.web),
    effectAuthority: createDatabaseCredentialBoundary(clients.effectAuthority),
  };
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "scripts/prove-codex-runtime-versioned-writeback-prisma.ts"),
      ],
      {
        cwd: root,
        env: {
          ...credentials.providerAdmin.environment,
          REVIEW_ROUTER_PRISMA_EVIDENCE_PROVIDER_ADMIN_DATABASE_URL_FILE:
            credentials.providerAdmin.environment
              .REVIEW_ROUTER_DATABASE_URL_FILE,
          REVIEW_ROUTER_PRISMA_EVIDENCE_API_DATABASE_URL_FILE:
            credentials.api.environment.REVIEW_ROUTER_DATABASE_URL_FILE,
          REVIEW_ROUTER_PRISMA_EVIDENCE_WEB_DATABASE_URL_FILE:
            credentials.web.environment.REVIEW_ROUTER_DATABASE_URL_FILE,
          REVIEW_ROUTER_PRISMA_EVIDENCE_EFFECT_AUTHORITY_DATABASE_URL_FILE:
            credentials.effectAuthority.environment
              .REVIEW_ROUTER_DATABASE_URL_FILE,
        },
        encoding: "utf8",
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } finally {
    for (const credential of Object.values(credentials)) credential.cleanup();
  }
  assert(
    result.status === 0,
    JSON.stringify(rehearsalProcessDiagnostic(result)),
  );
  assert(
    !/already connected.*deprecated|deprecated.*already connected/iu.test(
      result.stderr,
    ),
    "runtime proof used a deprecated same-client nested connection",
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
    `production_catalog_verifier_rejected_rehearsal:${JSON.stringify(result)}`,
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
      DECLARE role_name TEXT;
      DECLARE membership_count INTEGER;
      DECLARE canonical_membership_count INTEGER;
      DECLARE membership_role_count INTEGER;
      DECLARE membership_grantor_count INTEGER;
      BEGIN
        SELECT count(*), count(*) FILTER (
          WHERE has_function_privilege('public', p.oid, 'EXECUTE')
        ) INTO function_count, unsafe_function_count
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname LIKE 'codex_oauth_%';
        IF function_count <> 22 OR unsafe_function_count <> 0 THEN
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

        IF NOT EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN pg_roles owner ON owner.oid = p.proowner
          WHERE p.oid = 'public.codex_oauth_provider_identity_guard()'::regprocedure
            AND p.prosecdef
            AND owner.rolname = 'reviewrouter_release_schema_owner'
            AND p.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            AND position(
              'FROM public."CodexOAuthProviderIdentityQuarantine"'
              IN pg_get_functiondef(p.oid)
            ) > 0
            AND position(
              '"CodexOAuthProviderIdentityQuarantine"'
              IN replace(
                pg_get_functiondef(p.oid),
                'public."CodexOAuthProviderIdentityQuarantine"',
                ''
              )
            ) = 0
            AND position(
              'FROM public."RepositoryConnection"'
              IN pg_get_functiondef(p.oid)
            ) > 0
            AND position(
              'public."codex_oauth_consume_database_authority"('
              IN pg_get_functiondef(p.oid)
            ) > 0
            AND position(
              '''provider_identity_repair_v2'', transition_key, 0'
              IN pg_get_functiondef(p.oid)
            ) > 0
            AND position(
              'FROM public."CodexOAuthDatabaseAuthorityReceipt"'
              IN pg_get_functiondef(p.oid)
            ) = 0
            AND position(
              'receipt."consumedAt" IS NOT NULL'
              IN pg_get_functiondef(p.oid)
            ) = 0
            AND position(
              '"RepositoryConnection"'
              IN replace(
                pg_get_functiondef(p.oid),
                'public."RepositoryConnection"',
                ''
              )
            ) = 0
        ) THEN
          RAISE EXCEPTION 'Codex OAuth provider identity guard execution contract mismatch';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_proc p
          WHERE p.oid = 'public.codex_oauth_child_identity_fence_guard()'::regprocedure
            AND NOT p.prosecdef
            AND p.proconfig IS NULL
        ) THEN
          RAISE EXCEPTION 'Codex OAuth child identity fence guard execution contract mismatch';
        END IF;

        -- Managed production objects are owned by the unreachable NOLOGIN
        -- schema owner. The release login is only a narrow procedure caller
        -- and evidence/history reader; it must never inherit owner authority.
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles
          WHERE rolname = 'reviewrouter_release_migration'
            AND rolcanlogin
            AND NOT rolsuper
            AND NOT rolcreatedb
            AND NOT rolcreaterole
            AND NOT rolreplication
            AND NOT rolbypassrls
        )
           OR NOT EXISTS (
             SELECT 1 FROM pg_roles
             WHERE rolname = 'reviewrouter_release_schema_owner'
               AND NOT rolcanlogin
               AND NOT rolsuper
               AND NOT rolcreatedb
               AND NOT rolcreaterole
               AND NOT rolreplication
               AND NOT rolbypassrls
           )
           OR EXISTS (
             SELECT 1 FROM pg_auth_members membership
             WHERE membership.roleid = 'reviewrouter_release_schema_owner'::regrole
                OR membership.member = 'reviewrouter_release_schema_owner'::regrole
                OR membership.grantor = 'reviewrouter_release_schema_owner'::regrole
           )
           OR (
             SELECT owner.rolname
             FROM pg_namespace namespace
             JOIN pg_roles owner ON owner.oid = namespace.nspowner
             WHERE namespace.nspname = 'public'
           ) <> 'reviewrouter_release_schema_owner'
           OR pg_has_role(
             'reviewrouter_release_migration',
             'reviewrouter_release_schema_owner',
             'SET'
           )
           OR EXISTS (
             SELECT 1
             FROM pg_auth_members membership
             WHERE membership.member = 'reviewrouter_release_migration'::regrole
           )
           OR has_database_privilege(
             'reviewrouter_release_migration', current_database(), 'CREATE'
           )
           OR NOT has_schema_privilege(
             'reviewrouter_release_migration', 'public', 'USAGE'
           )
           OR has_schema_privilege(
             'reviewrouter_release_migration', 'public', 'CREATE'
           )
           OR EXISTS (
             SELECT 1
             FROM pg_namespace namespace
             WHERE namespace.nspname NOT LIKE 'pg_temp_%'
               AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
               AND has_schema_privilege(
                 'reviewrouter_release_migration', namespace.oid, 'CREATE'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             JOIN pg_roles owner ON owner.oid = relation.relowner
             WHERE namespace.nspname = 'public'
               AND relation.relkind IN ('r','p','v','m','S','f')
               AND owner.rolname <> 'reviewrouter_release_schema_owner'
               AND NOT EXISTS (
                 SELECT 1 FROM pg_depend dependency
                 WHERE dependency.classid = 'pg_class'::regclass
                   AND dependency.objid = relation.oid
                   AND dependency.refclassid = 'pg_extension'::regclass
                   AND dependency.deptype = 'e'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_proc routine
             JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
             JOIN pg_roles owner ON owner.oid = routine.proowner
             WHERE namespace.nspname = 'public'
               AND owner.rolname <> 'reviewrouter_release_schema_owner'
               AND NOT EXISTS (
                 SELECT 1 FROM pg_depend dependency
                 WHERE dependency.classid = 'pg_proc'::regclass
                   AND dependency.objid = routine.oid
                   AND dependency.refclassid = 'pg_extension'::regclass
                   AND dependency.deptype = 'e'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_proc routine
             JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname = 'public'
               AND has_function_privilege(
                 'reviewrouter_release_migration', routine.oid, 'EXECUTE'
               )
               AND routine.oid <> 'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)'::regprocedure
           )
           OR NOT has_function_privilege(
             'reviewrouter_release_migration',
             'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)'::regprocedure,
             'EXECUTE'
           )
           OR NOT has_table_privilege(
             'reviewrouter_release_migration',
             'public."_prisma_migrations"',
             'SELECT'
           )
           OR EXISTS (
             SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relkind IN ('r','p','v','m','f')
               AND (
                 has_table_privilege(
                   'reviewrouter_release_migration', relation.oid,
                   'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                 )
                 OR has_any_column_privilege(
                   'reviewrouter_release_migration', relation.oid,
                   'INSERT,UPDATE,REFERENCES'
                 )
               )
           )
           OR EXISTS (
             WITH public_sequences AS MATERIALIZED (
               SELECT sequence.oid
               FROM pg_sequence sequence_metadata
               JOIN pg_class sequence ON sequence.oid = sequence_metadata.seqrelid
               JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
               WHERE namespace.nspname = 'public'
             )
             SELECT 1
             FROM public_sequences sequence
             WHERE has_sequence_privilege(
               'reviewrouter_release_migration', sequence.oid, 'USAGE,SELECT,UPDATE'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM information_schema.role_table_grants grant_row
             WHERE grant_row.grantee = 'reviewrouter_release_migration'
               AND grant_row.is_grantable = 'YES'
           )
           OR EXISTS (
             SELECT 1
             FROM information_schema.role_routine_grants grant_row
             WHERE grant_row.grantee = 'reviewrouter_release_migration'
               AND grant_row.is_grantable = 'YES'
           )
           OR EXISTS (
             SELECT 1
             FROM information_schema.column_privileges grant_row
             WHERE grant_row.grantee = 'reviewrouter_release_migration'
               AND grant_row.is_grantable = 'YES'
           )
           OR EXISTS (
             SELECT 1
             FROM pg_namespace namespace
             CROSS JOIN LATERAL aclexplode(
               coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
             ) grant_row
             WHERE grant_row.grantee = 'reviewrouter_release_migration'::regrole
               AND grant_row.is_grantable
           )
           OR EXISTS (
             SELECT 1
             FROM pg_database database
             CROSS JOIN LATERAL aclexplode(
               coalesce(database.datacl, acldefault('d', database.datdba))
             ) grant_row
             WHERE database.datname = current_database()
               AND grant_row.grantee = 'reviewrouter_release_migration'::regrole
               AND grant_row.is_grantable
           )
           OR EXISTS (
             SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname NOT IN (
                 '_prisma_migrations',
                 'CodexOAuthLease',
                 'CodexOAuthSetupManifest',
                 'CodexOAuthWritebackIntent'
               )
               AND has_table_privilege(
                 'reviewrouter_release_migration', relation.oid, 'SELECT'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_attribute attribute
             JOIN pg_class relation ON relation.oid = attribute.attrelid
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
               AND has_column_privilege(
                 'reviewrouter_release_migration',
                 attribute.attrelid,
                 attribute.attnum,
                 'SELECT'
               )
               AND NOT (
                 relation.relname = '_prisma_migrations'
                 OR (
                   relation.relname IN (
                     'CodexOAuthLease',
                     'CodexOAuthSetupManifest',
                     'CodexOAuthWritebackIntent'
                   )
                   AND attribute.attname IN ('id','status')
                 )
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_attribute attribute
             WHERE attribute.attrelid IN (
               'public."CodexOAuthLease"'::regclass,
               'public."CodexOAuthSetupManifest"'::regclass,
               'public."CodexOAuthWritebackIntent"'::regclass
             )
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
               AND has_column_privilege(
                 'reviewrouter_release_migration',
                 attribute.attrelid,
                 attribute.attnum,
                 'SELECT'
               ) IS DISTINCT FROM (attribute.attname IN ('id','status'))
           )
        THEN
          RAISE EXCEPTION 'Codex OAuth release migration privilege mismatch';
        END IF;

        FOREACH role_name IN ARRAY ARRAY['reviewrouter_api','reviewrouter_web','reviewrouter_worker'] LOOP
          IF NOT has_table_privilege(role_name, 'public."RepositoryConnection"', 'SELECT')
             OR has_table_privilege(role_name, 'public."RepositoryConnection"', 'INSERT')
             OR has_table_privilege(role_name, 'public."RepositoryConnection"', 'UPDATE')
             OR has_table_privilege(role_name, 'public."RepositoryConnection"', 'DELETE')
             OR has_table_privilege(role_name, 'public."RepositoryConnection"', 'REFERENCES')
             OR has_function_privilege(role_name, 'public.codex_oauth_provider_identity_guard()', 'EXECUTE')
             OR pg_has_role(role_name, 'reviewrouter_release_migration', 'SET')
             OR has_table_privilege(
               role_name,
               'public."_prisma_migrations"',
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
             )
             OR EXISTS (
               SELECT 1
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relkind IN ('r', 'p')
                 AND relation.relname NOT IN (
                   'RepositoryConnection',
                   '_prisma_migrations',
                   'RuntimeCanaryChallenge',
                   'RuntimeCanaryChallengeProof',
                   'RuntimeGenerationWitnessProof',
                   'CodexOAuthDatabaseAuthorityKey',
                   'CodexOAuthDatabaseAuthorityReceipt',
                   'CodexOAuthChildIdentityQuarantine',
                   'CodexOAuthLease',
                   'CodexOAuthProviderIdentityQuarantine',
                   'CodexOAuthProviderInstance',
                   'CodexOAuthSecretNamespace',
                   'CodexOAuthSetupDispatchAttempt',
                   'CodexOAuthSetupManifest',
                   'CodexOAuthSetupPayloadClaim',
                   'CodexOAuthSetupRecoveryRequest',
                   'CodexOAuthWritebackIntent'
                 )
                 AND NOT has_table_privilege(
                   role_name, relation.oid, 'SELECT,INSERT,UPDATE,DELETE'
                 )
             )
             OR EXISTS (
               SELECT 1
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relname IN (
                   'CodexOAuthLease',
                   'CodexOAuthSecretNamespace',
                   'CodexOAuthSetupDispatchAttempt',
                   'CodexOAuthSetupManifest',
                   'CodexOAuthSetupPayloadClaim',
                   'CodexOAuthSetupRecoveryRequest',
                   'CodexOAuthWritebackIntent'
                 )
                 AND (
                   NOT has_table_privilege(
                     role_name, relation.oid, 'SELECT,INSERT,UPDATE'
                   )
                   OR has_table_privilege(role_name, relation.oid, 'DELETE')
                 )
             )
             OR NOT has_table_privilege(
               role_name,
               'public."CodexOAuthProviderInstance"',
               'SELECT,INSERT'
             )
             OR has_table_privilege(
               role_name,
               'public."CodexOAuthProviderInstance"',
               'UPDATE,DELETE'
             )
             OR EXISTS (
               SELECT 1
               FROM pg_attribute attribute
               WHERE attribute.attrelid = 'public."CodexOAuthProviderInstance"'::regclass
                 AND attribute.attnum > 0
                 AND NOT attribute.attisdropped
                 AND has_column_privilege(
                   role_name, attribute.attrelid, attribute.attnum, 'UPDATE'
                 ) IS DISTINCT FROM (
                   attribute.attname IN (
                     'state','latestGeneration','latestGenerationHash',
                     'activeLeaseId','activeLeaseExpiresAt','mutationEpoch',
                     'mutationOwner','mutationOwnerId','activeSecretNamespaceId',
                     'activeSecretNamespaceEpoch','activeSecretNamespaceName',
                     'activeAccountIdentityHash','updatedAt'
                   )
                 )
             )
             OR EXISTS (
               SELECT 1
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relname IN (
                   'CodexOAuthChildIdentityQuarantine',
                   'CodexOAuthProviderIdentityQuarantine'
                 )
                 AND (
                   NOT has_table_privilege(role_name, relation.oid, 'SELECT')
                   OR has_table_privilege(
                     role_name, relation.oid, 'INSERT,UPDATE,DELETE'
                   )
                 )
             )
             OR EXISTS (
               SELECT 1
               FROM pg_class sequence
               JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
               WHERE namespace.nspname = 'public'
                 AND sequence.relkind = 'S'
                 AND NOT has_sequence_privilege(
                   role_name,
                   format('%I.%I', namespace.nspname, sequence.relname),
                   'USAGE'
                 )
             )
             OR EXISTS (
               SELECT 1
               FROM pg_class relation
               JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relname IN (
                   'CodexOAuthDatabaseAuthorityKey',
                   'CodexOAuthDatabaseAuthorityReceipt',
                   'RuntimeCanaryChallenge',
                   'RuntimeCanaryChallengeProof',
                   'RuntimeGenerationWitnessProof'
                 )
                 AND (
                   has_table_privilege(
                     role_name, relation.oid,
                     'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                   )
                   OR has_any_column_privilege(
                     role_name, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'
                   )
                 )
             )
             OR EXISTS (
               SELECT 1 FROM pg_attribute attribute
               WHERE attribute.attrelid = 'public."RepositoryConnection"'::regclass
                 AND attribute.attnum > 0 AND NOT attribute.attisdropped
                 AND (
                   NOT has_column_privilege(role_name, attribute.attrelid, attribute.attnum, 'SELECT')
                   OR has_column_privilege(role_name, attribute.attrelid, attribute.attnum, 'INSERT')
                   OR has_column_privilege(role_name, attribute.attrelid, attribute.attnum, 'UPDATE')
                   OR has_column_privilege(role_name, attribute.attrelid, attribute.attnum, 'REFERENCES')
                 )
             )
          THEN
            RAISE EXCEPTION 'Codex OAuth runtime least privilege mismatch: %', role_name;
          END IF;
        END LOOP;

        IF has_database_privilege('reviewrouter_codex_effect_authority', current_database(), 'CREATE')
           OR has_schema_privilege('reviewrouter_codex_effect_authority', 'public', 'CREATE')
           OR EXISTS (
             SELECT 1
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relkind IN ('r', 'p')
               AND (
                 has_table_privilege(
                   'reviewrouter_codex_effect_authority', relation.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                 )
                 OR has_any_column_privilege(
                   'reviewrouter_codex_effect_authority', relation.oid,
                   'SELECT,INSERT,UPDATE,REFERENCES'
                 )
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_class sequence
             JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
             WHERE namespace.nspname = 'public'
               AND sequence.relkind = 'S'
               AND (
                 has_sequence_privilege(
                   'reviewrouter_codex_effect_authority',
                   format('%I.%I', namespace.nspname, sequence.relname),
                   'USAGE'
                 )
                 OR has_sequence_privilege(
                   'reviewrouter_codex_effect_authority',
                   format('%I.%I', namespace.nspname, sequence.relname),
                   'SELECT'
                 )
                 OR has_sequence_privilege(
                   'reviewrouter_codex_effect_authority',
                   format('%I.%I', namespace.nspname, sequence.relname),
                   'UPDATE'
                 )
               )
           )
           OR EXISTS (
             SELECT 1
             FROM pg_proc function
             JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
             WHERE namespace.nspname = 'public'
               AND has_function_privilege(
                 'reviewrouter_codex_effect_authority', function.oid, 'EXECUTE'
               )
               AND function.oid <> 'public.codex_oauth_sign_database_authority(text)'::regprocedure
           )
        THEN
          RAISE EXCEPTION 'Codex OAuth effect authority isolation mismatch';
        END IF;

        SELECT count(*),
               count(*) FILTER (
                 WHERE granted.rolname IN ('reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority','reviewrouter_release_migration')
                   AND member.rolname = 'reviewrouter_role_bootstrap'
                   AND grantor.rolname NOT IN ('reviewrouter_role_bootstrap','reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority','reviewrouter_release_migration')
                   AND membership.admin_option
                   AND NOT membership.inherit_option
                   AND NOT membership.set_option
               ),
               count(DISTINCT granted.oid) FILTER (
                 WHERE granted.rolname IN ('reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority','reviewrouter_release_migration')
                   AND member.rolname = 'reviewrouter_role_bootstrap'
               ),
               count(DISTINCT grantor.oid)
        INTO membership_count, canonical_membership_count, membership_role_count, membership_grantor_count
        FROM pg_auth_members membership
        JOIN pg_roles granted ON granted.oid = membership.roleid
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles grantor ON grantor.oid = membership.grantor
        WHERE (
               granted.rolname IN ('reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority','reviewrouter_release_migration')
            OR member.rolname IN ('reviewrouter_api','reviewrouter_web','reviewrouter_worker','reviewrouter_codex_effect_authority','reviewrouter_release_migration')
            OR granted.rolname = 'reviewrouter_role_bootstrap'
            OR member.rolname = 'reviewrouter_role_bootstrap'
        )
          AND granted.rolname <> 'reviewrouter_activation_receipt_guard'
          AND member.rolname <> 'reviewrouter_activation_receipt_guard';
        IF membership_count <> 5
           OR canonical_membership_count <> 5
           OR membership_role_count <> 5
           OR membership_grantor_count <> 1 THEN
          RAISE EXCEPTION
            'Codex OAuth role membership authority mismatch: total %, canonical %, roles %, grantors %',
            membership_count, canonical_membership_count, membership_role_count, membership_grantor_count;
        END IF;
      END $$;
    `,
  ]);
}

function prepareCanonicalReleaseRoles(url, installHistoricalSchema) {
  if (typeof installHistoricalSchema !== "function")
    throw new Error("historical_schema_installer_required");
  const targetDatabaseName = decodeURIComponent(
    new URL(String(url)).pathname.slice(1),
  );
  if (!targetDatabaseName)
    throw new Error("rehearsal_target_database_name_required");
  const loginRoles = [
    ["reviewrouter_api", "rr-rehearsal-api"],
    ["reviewrouter_web", "rr-rehearsal-web"],
    ["reviewrouter_worker", "rr-rehearsal-worker"],
    ["reviewrouter_codex_effect_authority", "rr-rehearsal-effect-authority"],
    ["reviewrouter_release_migration", "rr-rehearsal-release"],
  ];
  const externalGuardRole = "reviewrouter_activation_receipt_guard";
  const externalInstallerRole = "reviewrouter_activation_permit_installer";
  const externalReceiptReaderRole = "reviewrouter_activation_receipt_reader";
  const schemaOwnerRole = "reviewrouter_release_schema_owner";
  const allRoles = [
    ...loginRoles.map(([role]) => role),
    schemaOwnerRole,
    externalGuardRole,
    externalInstallerRole,
    externalReceiptReaderRole,
  ];
  const passwords = new Map(
    loginRoles.map(([role]) => [role, `${randomUUID()}${randomUUID()}`]),
  );
  passwords.set(externalInstallerRole, `${randomUUID()}${randomUUID()}`);
  const bootstrapPassword = `${randomUUID()}${randomUUID()}`;
  const canonicalRoleLiterals = allRoles.map(quoteLiteral).join(",");
  const provisioningSql = `BEGIN;
    -- Canonical roles are cluster-global. Serialize the existence check and
    -- creation so a concurrent rehearsal cannot reuse, remark, or later drop
    -- roles owned by this rehearsal.
    SELECT pg_advisory_xact_lock(1919247474, 1869769573);
    DO $ownership$
    DECLARE existing_role text;
    BEGIN
      SELECT rolname INTO existing_role
      FROM pg_roles
      WHERE rolname IN (${canonicalRoleLiterals})
      ORDER BY rolname
      LIMIT 1;
      IF existing_role IS NOT NULL THEN
        RAISE EXCEPTION 'refusing to take over pre-existing canonical role %', existing_role;
      END IF;
    END $ownership$;
    CREATE ROLE reviewrouter_role_bootstrap LOGIN SUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(bootstrapPassword)};
    COMMENT ON ROLE reviewrouter_role_bootstrap IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(passwords.get("reviewrouter_api"))};
    COMMENT ON ROLE reviewrouter_api IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(passwords.get("reviewrouter_web"))};
    COMMENT ON ROLE reviewrouter_web IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(passwords.get("reviewrouter_worker"))};
    COMMENT ON ROLE reviewrouter_worker IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_codex_effect_authority LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(passwords.get("reviewrouter_codex_effect_authority"))};
    COMMENT ON ROLE reviewrouter_codex_effect_authority IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_release_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(passwords.get("reviewrouter_release_migration"))};
    COMMENT ON ROLE reviewrouter_release_migration IS ${quoteLiteral(rehearsalRoleMarker)};
    GRANT reviewrouter_api TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT reviewrouter_web TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT reviewrouter_worker TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT reviewrouter_codex_effect_authority TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE reviewrouter_activation_receipt_guard IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_activation_permit_installer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(passwords.get(externalInstallerRole))};
    COMMENT ON ROLE reviewrouter_activation_permit_installer IS ${quoteLiteral(rehearsalRoleMarker)};
    CREATE ROLE reviewrouter_activation_receipt_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(`${randomUUID()}${randomUUID()}`)};
    COMMENT ON ROLE reviewrouter_activation_receipt_reader IS ${quoteLiteral(rehearsalRoleMarker)};
    ALTER SCHEMA public OWNER TO reviewrouter_role_bootstrap;
    ALTER DATABASE ${quoteIdentifier(targetDatabaseName)} OWNER TO reviewrouter_role_bootstrap;
    DO $generation$
    DECLARE binding jsonb;
    BEGIN
      binding := jsonb_build_object(
        'version', 1,
        'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
        'recoveryWitnessSha256', repeat('f', 64)
      );
      EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
    END
    $generation$;
    COMMIT;`;
  psql(url, ["-c", provisioningSql]);

  const clientUrl = (role, applicationName) => {
    const client = databaseUrl(url, targetDatabaseName);
    client.username = role;
    client.password = passwords.get(role);
    client.searchParams.set("application_name", applicationName);
    return client;
  };
  const bootstrap = clientUrl(
    "reviewrouter_role_bootstrap",
    "rr-rehearsal-role-bootstrap",
  );
  bootstrap.password = bootstrapPassword;
  psql(bootstrap, ["-c", "CREATE EXTENSION IF NOT EXISTS pgcrypto"]);
  psql(bootstrap, [
    "-c",
    String.raw`
      CREATE TABLE IF NOT EXISTS public."_prisma_migrations" (
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
  // The hardened authority is installed over an existing historical schema,
  // matching a real upgrade. Bootstrap owns these objects temporarily so the
  // following canonical role transaction can transfer them atomically.
  installHistoricalSchema(bootstrap);
  runRehearsalReleaseSubprocess(
    "external_activation_authority_provisioning",
    "psql",
    [url.toString(), "--no-psqlrc", "--quiet"],
    { env: process.env, input: activationAuthorityProvisioningSql() },
  );
  psql(url, [
    "-c",
    `DO $extension_owners$
     DECLARE item record;
     BEGIN
       FOR item IN
         SELECT routine.oid
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname = 'public'
           AND routine.proowner = 'postgres'::regrole
       LOOP
         EXECUTE format(
           'ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap',
           item.oid::regprocedure
         );
       END LOOP;
       FOR item IN
         SELECT type.typname, type.typtype
         FROM pg_type type
         JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
         WHERE namespace.nspname = 'public'
           AND type.typowner = 'postgres'::regrole
           AND type.typtype IN ('d','e','m','r')
       LOOP
         EXECUTE CASE
           WHEN item.typtype = 'd' THEN format(
             'ALTER DOMAIN public.%I OWNER TO reviewrouter_role_bootstrap',
             item.typname
           )
           ELSE format(
             'ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap',
             item.typname
           )
         END;
       END LOOP;
     END
     $extension_owners$;`,
  ]);
  const release = clientUrl(
    "reviewrouter_release_migration",
    "rr-rehearsal-release-migration",
  );
  const permitInstaller = clientUrl(
    externalInstallerRole,
    "rr-rehearsal-permit-installer",
  );
  const runtime = {
    api: clientUrl("reviewrouter_api", "rr-rehearsal-api"),
    web: clientUrl("reviewrouter_web", "rr-rehearsal-web"),
    worker: clientUrl("reviewrouter_worker", "rr-rehearsal-worker"),
    effectAuthority: clientUrl(
      "reviewrouter_codex_effect_authority",
      "rr-rehearsal-effect-authority",
    ),
  };
  const environment = {
    ...process.env,
    REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL: bootstrap.toString(),
    REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL: release.toString(),
    REVIEW_ROUTER_API_DATABASE_URL: runtime.api.toString(),
    REVIEW_ROUTER_WEB_DATABASE_URL: runtime.web.toString(),
    REVIEW_ROUTER_WORKER_DATABASE_URL: runtime.worker.toString(),
    REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
      runtime.effectAuthority.toString(),
    REVIEW_ROUTER_RELEASE_COMMIT_SHA: "a".repeat(40),
    REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  };
  psql(bootstrap, [
    "-c",
    `CREATE TABLE public.rr_legacy_bootstrap_owned (id integer PRIMARY KEY);
     CREATE FUNCTION public.rr_legacy_bootstrap_owned_fn() RETURNS integer
       LANGUAGE sql IMMUTABLE AS 'SELECT 1';`,
  ]);
  const canonicalProvisioningSql = roleProvisioningSql({
    releasePassword: passwords.get("reviewrouter_release_migration"),
    roles: [
      {
        role: "api",
        username: "reviewrouter_api",
        password: passwords.get("reviewrouter_api"),
      },
      {
        role: "web",
        username: "reviewrouter_web",
        password: passwords.get("reviewrouter_web"),
      },
      {
        role: "worker",
        username: "reviewrouter_worker",
        password: passwords.get("reviewrouter_worker"),
      },
      {
        role: "effect-authority",
        username: "reviewrouter_codex_effect_authority",
        password: passwords.get("reviewrouter_codex_effect_authority"),
      },
    ],
  });
  for (const role of allRoles) {
    psql(url, [
      "-c",
      `COMMENT ON ROLE ${quoteIdentifier(role)} IS ${quoteLiteral(rehearsalRoleMarker)}`,
    ]);
  }
  const observeMembershipTopology = () =>
    psql(bootstrap, [
      "-Atc",
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
        'role', granted.rolname,
        'member', member.rolname,
        'grantor', grantor.rolname,
        'adminOption', membership.admin_option,
        'inheritOption', membership.inherit_option,
        'setOption', membership.set_option
      ) ORDER BY granted.rolname, member.rolname, grantor.rolname), '[]'::jsonb)::text
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname IN (${canonicalRoleLiterals})
         OR member.rolname IN (${canonicalRoleLiterals})
         OR granted.rolname = 'reviewrouter_role_bootstrap'
         OR member.rolname = 'reviewrouter_role_bootstrap'`,
    ]).stdout.trim();
  const foreignGrantor = "reviewrouter_rehearsal_foreign_grantor";
  const foreignGrantedRole = "reviewrouter_rehearsal_foreign_role";
  psql(url, [
    "-c",
    `CREATE ROLE ${foreignGrantedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     CREATE ROLE ${foreignGrantor} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     GRANT ${foreignGrantedRole} TO ${foreignGrantor} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
     SET ROLE ${foreignGrantor};
     GRANT ${foreignGrantedRole} TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
     RESET ROLE;`,
  ]);
  assert(
    psql(url, [
      "-Atc",
      `SELECT count(*) FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid=membership.roleid
       JOIN pg_roles member ON member.oid=membership.member
       JOIN pg_roles grantor ON grantor.oid=membership.grantor
       WHERE granted.rolname='${foreignGrantedRole}'
         AND (
           member.rolname='${foreignGrantor}'
           OR (
             member.rolname='reviewrouter_role_bootstrap'
             AND grantor.rolname='${foreignGrantor}'
           )
         )`,
    ]).stdout.trim() === "2",
    "independent adversarial membership chain was not installed",
  );
  let expectedFailure;
  try {
    expectedFailure = runSecretSafePostgresCommand({
      databaseUrl: bootstrap,
      binary: psqlBinary,
      args: ["-X", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"],
      input: canonicalProvisioningSql,
      kind: "rehearsal",
      expectFailureContaining:
        "refusing non-canonical role membership topology",
    });
  } finally {
    psql(url, [
      "-c",
      `REVOKE ${foreignGrantedRole} FROM reviewrouter_role_bootstrap GRANTED BY ${foreignGrantor};
       REVOKE ${foreignGrantedRole} FROM ${foreignGrantor};
       DROP ROLE ${foreignGrantor};
       DROP ROLE ${foreignGrantedRole};`,
    ]);
  }
  assert(
    expectedFailure?.expectedFailure === true,
    "role bootstrap did not reject an adversarial foreign membership grantor",
  );
  runRehearsalReleaseSubprocess(
    "initial_role_provisioning",
    "psql",
    [bootstrap.toString(), "--no-psqlrc", "--quiet"],
    {
      env: { ...environment, DATABASE_URL: bootstrap.toString() },
      input: canonicalProvisioningSql,
    },
  );
  const firstBootstrapTopology = observeMembershipTopology();
  const demotedReplay = runSecretSafePostgresCommand({
    databaseUrl: bootstrap,
    binary: psqlBinary,
    args: ["-X", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"],
    input: canonicalProvisioningSql,
    kind: "rehearsal",
    expectFailureContaining: "trusted role bootstrap authority is not exact",
  });
  assert(
    demotedReplay.expectedFailure === true,
    "demoted role bootstrap unexpectedly retained provisioning authority",
  );
  assert(
    observeMembershipTopology() === firstBootstrapTopology,
    "rejected role bootstrap replay changed the canonical membership topology",
  );
  assert(
    psql(url, [
      "-Atc",
      `SELECT count(*) FROM pg_roles WHERE rolname = ${quoteLiteral(foreignGrantor)}`,
    ]).stdout.trim() === "0",
    "adversarial grantor retained role membership revoke authority",
  );
  psql(release, [
    "-c",
    `SELECT reviewrouter_bootstrap.consume_migration_evidence(
      'sha256:${"c".repeat(64)}',
      '303',
      'rehearsal-rollout',
      '101',
      1,
      '202',
      '.github/workflows/codex-rotating-release-migration.yml',
      '${"a".repeat(40)}',
      'sha256:${"b".repeat(64)}',
      (SELECT system_identifier::text FROM pg_control_system()),
      '${"f".repeat(64)}'
    );`,
  ]);
  psql(bootstrap, [
    "-c",
    `DO $receipt$
    DECLARE binding jsonb;
    BEGIN
      SELECT shobj_description(oid, 'pg_database')::jsonb INTO binding
      FROM pg_database WHERE datname = current_database();
      IF binding->>'version' <> '4'
         OR jsonb_array_length(binding->'consumedMigrationEvidence') <> 1
         OR binding#>>'{consumedMigrationEvidence,0,rolloutId}' <> 'rehearsal-rollout'
         OR binding#>>'{consumedMigrationEvidence,0,commit}' <> '${"a".repeat(40)}'
         OR binding#>>'{consumedMigrationEvidence,0,imageDigest}' <> 'sha256:${"b".repeat(64)}'
         OR binding#>>'{consumedMigrationEvidence,0,systemIdentifier}' <> binding->>'systemIdentifier'
         OR binding#>>'{consumedMigrationEvidence,0,recoveryWitnessSha256}' <> '${"f".repeat(64)}' THEN
        RAISE EXCEPTION 'trusted GitHub migration receipt was not bound to the database generation';
      END IF;
    END
    $receipt$;`,
  ]);
  const transferredLegacyOwners = psql(url, [
    "-Atc",
    `SELECT count(*) || ':' || count(*) FILTER (WHERE owner_name = 'reviewrouter_release_schema_owner')
     FROM (
       SELECT owner.rolname AS owner_name
       FROM pg_class relation
       JOIN pg_roles owner ON owner.oid = relation.relowner
       WHERE relation.oid = 'public.rr_legacy_bootstrap_owned'::regclass
       UNION ALL
       SELECT owner.rolname AS owner_name
       FROM pg_proc routine
       JOIN pg_roles owner ON owner.oid = routine.proowner
       WHERE routine.oid = 'public.rr_legacy_bootstrap_owned_fn()'::regprocedure
     ) ownership`,
  ]).stdout.trim();
  assert(
    transferredLegacyOwners === "2:2",
    "role bootstrap did not transfer pre-existing public objects to the schema owner",
  );
  psql(url, [
    "-c",
    `DROP FUNCTION public.rr_legacy_bootstrap_owned_fn();
     DROP TABLE public.rr_legacy_bootstrap_owned;`,
  ]);
  markCanonicalRehearsalRoles(url.toString());
  assertRehearsalRoleObservation(
    psql(url, ["-Atc", rehearsalRoleObservationSql(rehearsalRoleMarker)])
      .stdout,
  );
  return {
    authority: createRehearsalAuthorityContext({
      providerAdmin: url,
      bootstrap,
      permitInstaller,
      releaseMigration: release,
      runtime,
    }),
    environment,
  };
}

function installRehearsalMigrationPermit(
  authority,
  { transformSourceEvidence } = {},
) {
  const targetSystemIdentifier = psql(authority.providerAdmin, [
    "-Atc",
    "SELECT system_identifier::text FROM pg_control_system()",
  ]).stdout.trim();
  const inventory = JSON.parse(
    psql(authority.providerAdmin, [
      "-Atc",
      legacyAmbiguityInventorySql,
    ]).stdout.trim(),
  );
  const inventorySha256 = `sha256:${createHash("sha256")
    .update(JSON.stringify(inventory))
    .digest("hex")}`;
  const observedAt = JSON.parse(
    psql(authority.providerAdmin, [
      "-Atc",
      `SELECT json_build_array(
        to_char((clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(clock_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    ]).stdout.trim(),
  );
  const capturedSourceLegacyAmbiguity = Object.freeze({
    schemaVersion: 1,
    rolloutId: "rehearsal-rollout-v1",
    sourceSystemIdentifier: targetSystemIdentifier === "1" ? "2" : "1",
    sourceDatabaseName: "reviewrouter_rehearsal_source",
    sourceRecoveryWitnessSha256: "a".repeat(64),
    authorityPrincipal: "reviewrouter_rehearsal_source_authority",
    fenceId: "source-fence:rehearsal-rollout-v1",
    fenceEstablishedAt: observedAt[0],
    fencedInventorySha256: inventorySha256,
    ...inventory,
    inventorySha256,
    observations: [
      { observedAt: observedAt[0], inventorySha256 },
      { observedAt: observedAt[1], inventorySha256 },
    ],
    eligibilityCutoff: observedAt[1],
    stable: true,
  });
  const transformedSourceLegacyAmbiguity = Object.freeze(
    transformSourceEvidence
      ? transformSourceEvidence(capturedSourceLegacyAmbiguity)
      : capturedSourceLegacyAmbiguity,
  );
  const sourceLegacyAmbiguity = Object.freeze({
    ...transformedSourceLegacyAmbiguity,
    receiptSha256: `sha256:${sha256Canonical(transformedSourceLegacyAmbiguity)}`,
  });
  const eligibilityCutoff = sourceLegacyAmbiguity.eligibilityCutoff;
  const permit = Object.freeze({
    rolloutId: "rehearsal-rollout-v1",
    sourceSystemIdentifier: targetSystemIdentifier === "1" ? "2" : "1",
    targetSystemIdentifier,
    targetRecoveryWitnessSha256: "f".repeat(64),
    transitionSha256: `sha256:${"d".repeat(64)}`,
    previousReceiptSha256: `sha256:${"e".repeat(64)}`,
    epoch: "1",
    nonce: "c".repeat(32),
    sourceLegacyAmbiguity,
    eligibilityCutoff,
  });
  const installed = psql(authority.permitInstaller, [
    "-Atc",
    `SELECT reviewrouter_activation.install_migration_permit(
      ${quoteLiteral(permit.rolloutId)},
      ${quoteLiteral(permit.sourceSystemIdentifier)},
      ${quoteLiteral(permit.targetSystemIdentifier)},
      ${quoteLiteral(permit.targetRecoveryWitnessSha256)},
      ${quoteLiteral(permit.transitionSha256)},
      ${quoteLiteral(permit.previousReceiptSha256)},
      ${quoteLiteral(rehearsalPostManifestIdentitySha256)},
      ${quoteLiteral(liveV70V73CatalogDigestSha256)},
      ${quoteLiteral(JSON.stringify(sourceLegacyAmbiguity))}::jsonb,
      ${quoteLiteral(eligibilityCutoff)}::timestamptz,
      ${permit.epoch}::bigint,
      ${quoteLiteral(permit.nonce)}
    )`,
  ]).stdout.trim();
  assert(installed === "t", "rehearsal_migration_permit_not_installed");
  return Object.freeze({
    REVIEW_ROUTER_ROLLOUT_ID: permit.rolloutId,
    REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_SYSTEM_IDENTIFIER:
      permit.targetSystemIdentifier,
    REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_RECOVERY_WITNESS_SHA256:
      permit.targetRecoveryWitnessSha256,
    REVIEW_ROUTER_MIGRATION_PERMIT_TRANSITION_SHA256: permit.transitionSha256,
    REVIEW_ROUTER_MIGRATION_PERMIT_PREVIOUS_RECEIPT_SHA256:
      permit.previousReceiptSha256,
    REVIEW_ROUTER_MIGRATION_PERMIT_EPOCH: permit.epoch,
    REVIEW_ROUTER_MIGRATION_PERMIT_NONCE: permit.nonce,
    REVIEW_ROUTER_MIGRATION_PERMIT_SOURCE_LEGACY_AMBIGUITY_BASE64URL:
      Buffer.from(JSON.stringify(sourceLegacyAmbiguity)).toString("base64url"),
    REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF: eligibilityCutoff,
  });
}

function runRehearsalReleaseSubprocess(step, command, args, options = {}) {
  let cleanup;
  let executable;
  let childArgs;
  let childEnvironment;
  let childInput = options.input;
  if (command === "psql") {
    const urlIndex = args.findIndex(
      (arg) => arg.startsWith("postgres://") || arg.startsWith("postgresql://"),
    );
    if (urlIndex < 0)
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
      });
    const postgres = createSecretSafePostgresInvocation({
      databaseUrl: args[urlIndex],
      args: args.filter((_, index) => index !== urlIndex),
      input: options.input,
    });
    const credential = createDatabaseCredentialBoundary(args[urlIndex]);
    executable = psqlBinary;
    childArgs = postgres.args;
    childEnvironment = {
      ...postgres.environment,
      REVIEW_ROUTER_DATABASE_URL_FILE:
        credential.environment.REVIEW_ROUTER_DATABASE_URL_FILE,
    };
    childInput = postgres.input;
    cleanup = () => {
      postgres.cleanup();
      credential.cleanup();
    };
  } else {
    const databaseUrl = options.env?.DATABASE_URL;
    if (!databaseUrl)
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
      });
    const credential = createDatabaseCredentialBoundary(databaseUrl);
    executable =
      command === "pnpm" && process.env.npm_execpath
        ? process.execPath
        : command;
    childArgs =
      command === "pnpm" && process.env.npm_execpath
        ? [process.env.npm_execpath, ...args]
        : args;
    childEnvironment = credential.environment;
    cleanup = credential.cleanup;
  }
  try {
    const result = spawnSync(executable, childArgs, {
      cwd: root,
      encoding: "utf8",
      env: childEnvironment,
      input: childInput,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
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
  } finally {
    cleanup();
  }
}

function markCanonicalRehearsalRoles(url) {
  psql(url, [
    "-c",
    [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
      "reviewrouter_codex_effect_authority",
      "reviewrouter_release_migration",
      "reviewrouter_release_schema_owner",
    ]
      .map(
        (role) =>
          `COMMENT ON ROLE ${quoteIdentifier(role)} IS ${quoteLiteral(rehearsalRoleMarker)};`,
      )
      .join("\n"),
  ]);
}

function cleanupRuntimeRoles(url) {
  const roles = [
    "reviewrouter_api",
    "reviewrouter_web",
    "reviewrouter_worker",
    "reviewrouter_codex_effect_authority",
    "reviewrouter_release_migration",
    "reviewrouter_release_schema_owner",
    "reviewrouter_activation_receipt_guard",
    "reviewrouter_activation_permit_installer",
    "reviewrouter_activation_receipt_reader",
    "reviewrouter_role_bootstrap",
  ];
  for (const role of roles) {
    const marker = psql(
      url,
      [
        "-Atc",
        `SELECT coalesce(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname=${quoteLiteral(role)}`,
      ],
      false,
    );
    if (marker.status === 0 && marker.stdout.trim() === rehearsalRoleMarker) {
      if (role === "reviewrouter_release_schema_owner") {
        // The role handoff used while transferring migration-created objects is
        // cluster-global.  A failed or completed rehearsal must remove any
        // remaining edge by its PG17 catalog-recorded grantor after the
        // disposable database has gone away.  Only edges whose two endpoints
        // belong to this rehearsal are eligible for cleanup.
        psql(url, [
          "-c",
          `DO $rehearsal_schema_owner_membership_cleanup$
           DECLARE edge record;
           BEGIN
             FOR edge IN
               SELECT granted.rolname AS granted_name,
                 member.rolname AS member_name,
                 grantor.rolname AS grantor_name,
                 coalesce(shobj_description(granted.oid, 'pg_authid'), '') AS granted_marker,
                 coalesce(shobj_description(member.oid, 'pg_authid'), '') AS member_marker
               FROM pg_auth_members membership
               JOIN pg_roles granted ON granted.oid=membership.roleid
               JOIN pg_roles member ON member.oid=membership.member
               JOIN pg_roles grantor ON grantor.oid=membership.grantor
               WHERE membership.roleid='reviewrouter_release_schema_owner'::regrole
                  OR membership.member='reviewrouter_release_schema_owner'::regrole
                  OR membership.grantor='reviewrouter_release_schema_owner'::regrole
             LOOP
               IF edge.granted_marker IS DISTINCT FROM ${quoteLiteral(rehearsalRoleMarker)}
                  OR edge.member_marker IS DISTINCT FROM ${quoteLiteral(rehearsalRoleMarker)} THEN
                 RAISE EXCEPTION
                   'refusing non-rehearsal schema-owner membership cleanup: % -> % granted by %',
                   edge.granted_name,edge.member_name,edge.grantor_name;
               END IF;
               EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE',
                 edge.granted_name,edge.member_name,edge.grantor_name);
             END LOOP;
           END
           $rehearsal_schema_owner_membership_cleanup$;`,
        ]);
        const cleanupSafety = psql(url, [
          "-Atc",
          `SELECT
             (SELECT count(*) FROM pg_shdepend dependency
              WHERE dependency.refclassid = 'pg_authid'::regclass
                AND dependency.refobjid = 'reviewrouter_release_schema_owner'::regrole
                AND dependency.deptype IN ('a','o')) || ':' ||
             (SELECT count(*) FROM pg_auth_members membership
              WHERE membership.roleid = 'reviewrouter_release_schema_owner'::regrole
                 OR membership.member = 'reviewrouter_release_schema_owner'::regrole
                 OR membership.grantor = 'reviewrouter_release_schema_owner'::regrole) || ':' ||
             (SELECT count(*) FROM pg_roles
              WHERE rolname = 'reviewrouter_release_schema_owner' AND rolcanlogin)`,
        ]).stdout.trim();
        assert(
          cleanupSafety === "0:0:0",
          `schema_owner_cleanup_dependencies_present:${cleanupSafety}`,
        );
      }
      const dropped = psql(
        url,
        ["-c", `DROP ROLE ${quoteIdentifier(role)}`],
        false,
      );
      assert(dropped.status === 0, `rehearsal_role_cleanup_failed:${role}`);
    }
  }
}

function convergeRuntimePrivileges(url) {
  psql(url, [
    "-c",
    `BEGIN;
${runtimeGrantStatements(
  {
    roles: [
      { role: "api", username: "reviewrouter_api" },
      { role: "web", username: "reviewrouter_web" },
      { role: "worker", username: "reviewrouter_worker" },
      {
        role: "effect-authority",
        username: "reviewrouter_codex_effect_authority",
      },
    ],
  },
  quoteIdentifier(databaseName),
)}
COMMIT;`,
  ]);
}

function proveSequentialFabricationDeniedForEveryRuntimeRole(clients) {
  for (const [ordinal, role, expectedSetupFailure, expectedRuntimeFailure] of [
    [
      1,
      "reviewrouter_api",
      "permission denied for function codex_oauth_authorize_setup_confirmation",
      "codex_oauth_database_authority_signature_invalid",
    ],
    [
      2,
      "reviewrouter_web",
      "codex_oauth_database_authority_signature_invalid",
      "permission denied for function codex_oauth_authorize_runtime_confirmation",
    ],
    [
      3,
      "reviewrouter_worker",
      "permission denied for function codex_oauth_authorize_setup_confirmation",
      "permission denied for function codex_oauth_authorize_runtime_confirmation",
    ],
  ]) {
    const url = clients[role.replace("reviewrouter_", "")];
    assert(url instanceof URL, `${role} direct rehearsal client is missing`);
    assert(
      psql(url, [
        "-Atc",
        "SELECT session_user || ':' || current_user",
      ]).stdout.trim() === `${role}:${role}`,
      `${role} rehearsal attack did not use a direct production-faithful login`,
    );
    const guard = psql(
      url,
      ["-c", `SELECT "codex_oauth_provider_identity_guard"();`],
      false,
    );
    assert(
      guard.status !== 0 &&
        `${guard.stdout}${guard.stderr}`.includes(
          "permission denied for function codex_oauth_provider_identity_guard",
        ),
      `${role} could invoke the elevated identity guard directly: ${psqlResultDiagnostic(guard)}`,
    );
    const signer = psql(
      url,
      [
        "-c",
        `BEGIN; SELECT "codex_oauth_sign_database_authority"('forged'); COMMIT;`,
      ],
      false,
    );
    assert(
      signer.status !== 0 &&
        `${signer.stdout}${signer.stderr}`.includes(
          "permission denied for function codex_oauth_sign_database_authority",
        ),
      `${role} could invoke the isolated database effect signer: ${psqlResultDiagnostic(signer)}`,
    );
    const fabricatedQuarantine = psql(
      url,
      [
        "-c",
        String.raw`INSERT INTO "CodexOAuthProviderIdentityQuarantine" (
          "providerInstanceRowId", "observedWorkspaceId", "observedRepositoryId",
          "observedProviderInstanceId", "expectedProviderInstanceId", "reason", "evidenceJson"
        ) VALUES (
          'p-clean', 'ws-proof', 'repo-7', 'codex-rotating:900007',
          'codex-rotating:900007', 'fabricated', '{}'
        )`,
      ],
      false,
    );
    assert(
      fabricatedQuarantine.status !== 0 &&
        `${fabricatedQuarantine.stdout}${fabricatedQuarantine.stderr}`.includes(
          "permission denied for table CodexOAuthProviderIdentityQuarantine",
        ),
      `${role} could fabricate provider quarantine evidence`,
    );
    const fabricatedRepair = psql(
      url,
      [
        "-c",
        `UPDATE "CodexOAuthProviderInstance" SET "providerInstanceId"='codex-rotating:900006' WHERE "id"='p-quarantine'`,
      ],
      false,
    );
    assert(
      fabricatedRepair.status !== 0 &&
        `${fabricatedRepair.stdout}${fabricatedRepair.stderr}`.includes(
          "permission denied",
        ),
      `${role} retained direct provider identity-column update authority`,
    );
    const setup = psql(
      url,
      [
        "-c",
        String.raw`BEGIN;
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
    assertPsqlFailedWithExactMessage(
      setup,
      expectedSetupFailure,
      `${role} fabricated setup sequence did not fail at its role-specific authorization boundary`,
    );

    const runtime = psql(
      url,
      [
        "-c",
        String.raw`BEGIN;
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
    assertPsqlFailedWithExactMessage(
      runtime,
      expectedRuntimeFailure,
      `${role} fabricated runtime sequence did not fail at its role-specific authorization boundary`,
    );
  }
}

function proveStaleAclProviderIdentityEscalationDenied(adminUrl, clients) {
  for (const role of [
    "reviewrouter_api",
    "reviewrouter_web",
    "reviewrouter_worker",
  ]) {
    const url = clients[role.replace("reviewrouter_", "")];
    psql(adminUrl, [
      "-c",
      `GRANT INSERT ON TABLE "CodexOAuthProviderIdentityQuarantine" TO ${quoteIdentifier(role)};
       GRANT UPDATE ("workspaceId","repositoryId","providerInstanceId","authMode","secretName")
         ON TABLE "CodexOAuthProviderInstance" TO ${quoteIdentifier(role)}`,
    ]);
    try {
      const escalation = psql(
        url,
        [
          "-c",
          String.raw`BEGIN;
            INSERT INTO "CodexOAuthProviderIdentityQuarantine" (
              "providerInstanceRowId", "observedWorkspaceId", "observedRepositoryId",
              "observedProviderInstanceId", "expectedProviderInstanceId", "reason", "evidenceJson"
            ) VALUES (
              'p-clean', 'ws-proof', 'repo-7', 'codex-rotating:900007',
              'codex-rotating:900006', 'fabricated_stale_acl', '{}'
            );
            UPDATE "CodexOAuthProviderInstance"
            SET "mutationEpoch"="mutationEpoch"+1,
                "mutationOwner"='recovery',
                "mutationOwnerId"='fabricated-recovery-owner',
                "updatedAt"=now()
            WHERE "id"='p-clean';
            UPDATE "CodexOAuthProviderInstance"
            SET "repositoryId"='repo-6',
                "providerInstanceId"='codex-rotating:900006',
                "updatedAt"=now()
            WHERE "id"='p-clean';
            COMMIT;`,
        ],
        false,
      );
      assertPsqlFailedWithExactMessage(
        escalation,
        "codex_oauth_provider_identity_authority_required",
        `${role} used fabricated quarantine and recovery flags after stale ACL regrant`,
      );
    } finally {
      psql(adminUrl, [
        "-c",
        `REVOKE INSERT ON TABLE "CodexOAuthProviderIdentityQuarantine" FROM ${quoteIdentifier(role)};
         REVOKE UPDATE ("workspaceId","repositoryId","providerInstanceId","authMode","secretName")
           ON TABLE "CodexOAuthProviderInstance" FROM ${quoteIdentifier(role)}`,
      ]);
    }
  }
  proveDatabasePrivileges(adminUrl);
}

function proveRuntimeParentCascadesDenied(adminUrl, clients) {
  const roles = [
    ["reviewrouter_api", clients.api],
    ["reviewrouter_web", clients.web],
    ["reviewrouter_worker", clients.worker],
    ["reviewrouter_codex_effect_authority", clients.effectAuthority],
  ];
  for (const [role, url] of roles) {
    const canConnect = psql(adminUrl, [
      "-Atc",
      `SELECT has_database_privilege(${quoteLiteral(role)}, current_database(), 'CONNECT')`,
    ]).stdout.trim();
    assert(
      canConnect === "t",
      `${role} must retain CONNECT before runtime cascade proofs`,
    );
    psql(adminUrl, [
      "-c",
      `GRANT SELECT, UPDATE, DELETE ON TABLE "Workspace", "GitHubInstallation", "GitLabInstallation", "ScmRepositoryIdentity" TO ${quoteIdentifier(role)};
       GRANT SELECT, DELETE, UPDATE ("id") ON TABLE "CodexOAuthProviderInstance" TO ${quoteIdentifier(role)}`,
    ]);
    try {
      psql(adminUrl, [
        "-c",
        `INSERT INTO "Workspace" ("id","slug","name","updatedAt") VALUES ('normal-delete-${role}','normal-delete-${role}','normal delete proof',now())`,
      ]);
      psql(url, [
        "-c",
        `DELETE FROM "Workspace" WHERE "id"='normal-delete-${role}'`,
      ]);
      for (const [label, sql, expected] of [
        [
          "workspace delete",
          `DELETE FROM "Workspace" WHERE "id"='ws-proof'`,
          "codex_oauth_runtime_referential_delete_forbidden",
        ],
        [
          "workspace key update",
          `UPDATE "Workspace" SET "id"='ws-proof-${role}' WHERE "id"='ws-proof'`,
          "codex_oauth_runtime_referential_update_forbidden",
        ],
        [
          "installation delete",
          `DELETE FROM "GitHubInstallation" WHERE "id"='installation-proof'`,
          "codex_oauth_runtime_referential_delete_forbidden",
        ],
        [
          "installation key update",
          `UPDATE "GitHubInstallation" SET "id"='installation-proof-${role}' WHERE "id"='installation-proof'`,
          "codex_oauth_runtime_referential_update_forbidden",
        ],
        [
          "gitlab installation delete",
          `DELETE FROM "GitLabInstallation" WHERE "id"='gitlab-installation-proof'`,
          "codex_oauth_runtime_referential_delete_forbidden",
        ],
        [
          "gitlab installation key update",
          `UPDATE "GitLabInstallation" SET "id"='gitlab-installation-proof-${role}' WHERE "id"='gitlab-installation-proof'`,
          "codex_oauth_runtime_referential_update_forbidden",
        ],
        [
          "SCM identity delete",
          `DELETE FROM "ScmRepositoryIdentity" WHERE "scmRepositoryIdentityId"='scm-identity-proof'`,
          "RepositoryConnection_scmRepositoryIdentityId_fkey",
        ],
        [
          "SCM identity key update",
          `UPDATE "ScmRepositoryIdentity" SET "scmRepositoryIdentityId"='scm-identity-proof-${role}' WHERE "scmRepositoryIdentityId"='scm-identity-proof'`,
          "codex_oauth_runtime_referential_update_forbidden",
        ],
        [
          "provider parent delete",
          `DELETE FROM "CodexOAuthProviderInstance" WHERE "id"='p-clean'`,
          "codex_oauth_runtime_referential_delete_forbidden",
        ],
        [
          "provider parent key update",
          `UPDATE "CodexOAuthProviderInstance" SET "id"='p-clean-${role}' WHERE "id"='p-clean'`,
          "codex_oauth_provider_identity_authority_required",
        ],
      ]) {
        const result = psql(url, ["-c", sql], false);
        assertPsqlFailedWithExactMessage(
          result,
          expected,
          `${role} bypassed rotating protection through ${label}`,
        );
      }
    } finally {
      convergeRuntimePrivileges(adminUrl);
    }
  }
  const preserved = psql(adminUrl, [
    "-Atc",
    `SELECT count(*) FROM "RepositoryConnection" WHERE "workspaceId"='ws-proof'`,
  ]).stdout.trim();
  assert(preserved === "13", "parent cascade proofs changed protected rows");
  proveDatabasePrivileges(adminUrl);
}

async function proveProviderRepairAuthorityV2(adminUrl, clients) {
  const receiptsBefore = Number(
    psql(adminUrl, [
      "-Atc",
      `SELECT count(*) FROM "CodexOAuthDatabaseAuthorityReceipt"
       WHERE "effect"='provider_identity_repair_v2'
         AND "databaseRole"='reviewrouter_web'
         AND "consumedAt" IS NOT NULL`,
    ]).stdout.trim(),
  );
  const repairArgs = [
    "'p-quarantine'",
    "'ws-proof'",
    "'repo-6'",
    "'legacy-wrong-id'",
    "'codex_subscription_oauth_rotating'",
    "'REVIEWROUTER_CODEX_AUTH_JSON'",
    "'github'",
    "900006",
    "'900006'",
    "'ws-proof'",
    "'repo-6'",
    "'codex-rotating:900006'",
    "'codex_subscription_oauth_rotating'",
    "'REVIEWROUTER_CODEX_AUTH_JSON'",
    "900006",
  ];
  const args = repairArgs.join(",");
  const webInvocation = createSecretSafePostgresInvocation({
    databaseUrl: clients.web,
    args: ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  });
  const web = spawn(psqlBinary, webInvocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: webInvocation.environment,
  });
  web.once("close", () => webInvocation.cleanup());
  const lines = createInterface({ input: web.stdout })[Symbol.asyncIterator]();
  web.stderr.resume();
  web.stdin.write(
    `BEGIN; SELECT "codex_oauth_provider_identity_repair_challenge"(${args});\n`,
  );
  const challengeLine = await lines.next();
  assert(!challengeLine.done, "provider_repair_challenge_missing");
  const signature = psql(clients.effectAuthority, [
    "-Atc",
    `SELECT "codex_oauth_sign_database_authority"(${quoteLiteral(challengeLine.value)})`,
  ]).stdout.trim();
  assert(signature.length > 0, "repair challenge was not signed");
  const repairCall = `"codex_oauth_repair_quarantined_provider"(${args},${quoteLiteral(signature)})`;
  const tamperedRepairArgs = [...repairArgs];
  tamperedRepairArgs[11] = "'codex-rotating:900007'";
  tamperedRepairArgs[14] = "900007";
  const tamperedRepairCall =
    `"codex_oauth_repair_quarantined_provider"(` +
    `${tamperedRepairArgs.join(",")},${quoteLiteral(signature)})`;
  web.stdin.write(String.raw`
    DO $proof$
    BEGIN
      BEGIN
        PERFORM ${tamperedRepairCall};
        RAISE EXCEPTION 'signed provider repair authorized a different target';
      EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM <> 'codex_oauth_database_authority_signature_invalid' THEN
          RAISE;
        END IF;
      END;
    END $proof$;
    SAVEPOINT rollback_proof;
    DO $proof$ BEGIN
      PERFORM ${repairCall};
    END $proof$;
    ROLLBACK TO SAVEPOINT rollback_proof;
    DO $proof$
    BEGIN
      IF (SELECT "providerInstanceId" FROM "CodexOAuthProviderInstance" WHERE "id"='p-quarantine') <> 'legacy-wrong-id'
         OR (SELECT "resolvedAt" FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId"='p-quarantine') IS NOT NULL
      THEN
        RAISE EXCEPTION 'provider repair savepoint rollback did not restore all state';
      END IF;
    END $proof$;
    DO $proof$ BEGIN
      PERFORM ${repairCall};
    END $proof$;
    DO $proof$
    BEGIN
      BEGIN
        PERFORM ${repairCall};
        RAISE EXCEPTION 'provider repair replay succeeded';
      EXCEPTION WHEN serialization_failure THEN
        IF SQLERRM <> 'codex_oauth_provider_quarantine_recovery_required' THEN
          RAISE;
        END IF;
      END;
      IF (SELECT "providerInstanceId" FROM "CodexOAuthProviderInstance" WHERE "id"='p-quarantine') <> 'codex-rotating:900006'
         OR (SELECT "resolvedAt" FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId"='p-quarantine') IS NULL
      THEN
        RAISE EXCEPTION 'provider repair did not atomically consume and resolve';
      END IF;
    END $proof$;
    COMMIT;
    SELECT 'provider-repair-v2-passed';
  `);
  const terminal = await lines.next();
  assert(
    !terminal.done && terminal.value === "provider-repair-v2-passed",
    "provider_repair_v2_proof_failed",
  );
  web.stdin.end("\\q\n");
  const status = await new Promise((resolveExit) =>
    web.once("close", resolveExit),
  );
  assert(status === 0, "provider_repair_v2_client_failed");
  const receiptsAfter = Number(
    psql(adminUrl, [
      "-Atc",
      `SELECT count(*) FROM "CodexOAuthDatabaseAuthorityReceipt"
       WHERE "effect"='provider_identity_repair_v2'
         AND "databaseRole"='reviewrouter_web'
         AND "consumedAt" IS NOT NULL`,
    ]).stdout.trim(),
  );
  assert(
    receiptsAfter === receiptsBefore + 1,
    "provider repair did not atomically consume exactly one authority receipt",
  );
  proveDatabasePrivileges(adminUrl);
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
  assertPsqlFailedWithExactMessage(
    inferredSwitch,
    "codex_oauth_setup_recovery_initial_state_invalid",
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
  assertPsqlFailedWithExactMessage(
    recoveryDeletion,
    "codex_oauth_setup_recovery_delete_forbidden",
    "account-switch recovery authority must remain permanent evidence",
  );
}

function proveCompletedRecoveryEvidenceRetention(url) {
  for (const statement of [
    `UPDATE "CodexOAuthSetupRecoveryRequest" SET "state"='completed', "latestManifestId"='fetched-recovery', "completedAt"=now(), "updatedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
    `UPDATE "CodexOAuthSetupRecoveryRequest" SET "state"='manifest_issued', "latestManifestId"='fetched-recovery', "updatedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
  ]) {
    const rejected = psql(url, ["-c", statement], false);
    assertPsqlFailedWithExactMessage(
      rejected,
      "codex_oauth_setup_recovery_evidence_immutable",
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
  assertPsqlFailedWithExactMessage(
    skippedManifestIssued,
    "codex_oauth_setup_recovery_evidence_immutable",
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
  assertPsqlFailedWithExactMessage(
    fabricatedCompletion,
    "codex_oauth_setup_recovery_evidence_immutable",
    "issued manifest alone must not complete recovery without its exact consumed active evidence chain",
  );
  for (const [statement, expectedReason] of [
    [
      `UPDATE "CodexOAuthSetupRecoveryRequest" SET "latestManifestId"=NULL WHERE "id"='recovery-account-switch-proof'`,
      "codex_oauth_setup_recovery_evidence_immutable",
    ],
    [
      `UPDATE "CodexOAuthSetupRecoveryRequest" SET "completedAt"=now() WHERE "id"='recovery-account-switch-proof'`,
      "codex_oauth_setup_recovery_evidence_immutable",
    ],
    [
      `DELETE FROM "CodexOAuthSetupManifest" WHERE "id"='manifest-completed-recovery-proof'`,
      "codex_oauth_setup_manifest_delete_forbidden",
    ],
  ]) {
    const rejected = psql(url, ["-c", statement], false);
    assertPsqlFailedWithExactMessage(
      rejected,
      expectedReason,
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
    "legacy setup mutation on recovered evidence must fail",
  );
  assert(
    `${setup.stdout}${setup.stderr}`.includes(
      "codex_oauth_setup_manifest_terminal_evidence_immutable",
    ),
    "legacy setup rejection must identify the terminal evidence fence",
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
      IF (SELECT status FROM "CodexOAuthSetupManifest" WHERE id='fetched-recovery') <> 'recovered'
        OR (SELECT status FROM "CodexOAuthLease" WHERE id='lease-recovery') <> 'expired'
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

async function executeProviderIdentityRepairWithAuthority(
  clients,
  argumentsSql,
) {
  const webInvocation = createSecretSafePostgresInvocation({
    databaseUrl: clients.web,
    args: ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  });
  const web = spawn(psqlBinary, webInvocation.args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: webInvocation.environment,
  });
  const lines = createInterface({ input: web.stdout })[Symbol.asyncIterator]();
  try {
    web.stdin.write(
      `BEGIN; SELECT codex_oauth_provider_identity_repair_challenge(${argumentsSql});\n`,
    );
    const challengeLine = await lines.next();
    assert(!challengeLine.done, "provider_repair_challenge_missing");
    const signature = psql(clients.effectAuthority, [
      "-Atc",
      `SELECT codex_oauth_sign_database_authority(${quoteLiteral(challengeLine.value)})`,
    ]).stdout.trim();
    web.stdin.end(
      `SELECT codex_oauth_repair_quarantined_provider(
        ${argumentsSql},${quoteLiteral(signature)}); COMMIT;\n`,
    );
    const status = await new Promise((resolveClose) =>
      web.once("close", resolveClose),
    );
    assert(status === 0, "provider_repair_authorized_session_failed");
  } finally {
    await terminateChild(web);
    webInvocation.cleanup();
  }
}

async function proveQuarantineCleanupPathV2(adminUrl, clients) {
  const providerRepairs = [
    {
      providerId: "p-parent-dirty",
      repositoryId: "repo-12",
      oldProviderId: "legacy-parent-id",
      oldRepositoryProvider: "gitlab",
      oldGithubId: null,
      oldExternalId: "900012",
      newGithubId: 900012,
    },
    {
      providerId: "p-parent-external-dirty",
      repositoryId: "repo-13",
      oldProviderId: "codex-rotating:900013",
      oldRepositoryProvider: "github",
      oldGithubId: 900013,
      oldExternalId: "dirty-external-id",
      newGithubId: 900013,
    },
  ];
  for (const repair of providerRepairs) {
    const oldGithubId = repair.oldGithubId ?? "NULL";
    const argumentsSql = [
      quoteLiteral(repair.providerId),
      "'ws-proof'",
      quoteLiteral(repair.repositoryId),
      quoteLiteral(repair.oldProviderId),
      "'codex_subscription_oauth_rotating'",
      "'REVIEWROUTER_CODEX_AUTH_JSON'",
      quoteLiteral(repair.oldRepositoryProvider),
      String(oldGithubId),
      quoteLiteral(repair.oldExternalId),
      "'ws-proof'",
      quoteLiteral(repair.repositoryId),
      quoteLiteral(`codex-rotating:${repair.newGithubId}`),
      "'codex_subscription_oauth_rotating'",
      "'REVIEWROUTER_CODEX_AUTH_JSON'",
      String(repair.newGithubId),
    ].join(",");
    await executeProviderIdentityRepairWithAuthority(clients, argumentsSql);
  }
  psql(adminUrl, [
    "-c",
    String.raw`
      SELECT codex_oauth_repair_quarantined_child('lease','lease-provider-dirty');
      SELECT codex_oauth_repair_quarantined_child('setup_manifest','manifest-dirty');
      SELECT codex_oauth_repair_quarantined_child('lease','lease-dirty');
      SELECT codex_oauth_repair_quarantined_child('writeback_intent','intent-dirty','lease-dirty');
      DO $$ BEGIN
        IF (SELECT "resolvedAt" FROM "CodexOAuthProviderIdentityQuarantine" WHERE "providerInstanceRowId"='p-parent-dirty') IS NULL
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
  const migrationNameSql = rotatingMigrationNames.map(quoteLiteral).join(",");
  const before = psql(url, [
    "-Atc",
    String.raw`SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY migration_name, started_at)::text)
      FROM "_prisma_migrations" m
      WHERE migration_name IN (${migrationNameSql})`,
  ]).stdout.trim();
  const rerun = migrateDeploy(url);
  const after = psql(url, [
    "-Atc",
    String.raw`SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY migration_name, started_at)::text)
      FROM "_prisma_migrations" m
      WHERE migration_name IN (${migrationNameSql})`,
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
  proveMigrationRunnerHistory(url, migration65Name, true);
  proveMigrationRunnerHistory(url, migration66Name, true);
  proveMigrationRunnerHistory(url, migration69Name, true);
  proveMigrationRunnerHistory(url, migration70Name, true);
  proveMigrationRunnerHistory(url, migration71Name, true);
  proveMigrationRunnerHistory(url, migration72RetireName, true);
  proveMigrationRunnerHistory(url, migration72CanaryName, true);
}

function collectObservation(url) {
  const migrationNameSql = rotatingMigrationNames.map(quoteLiteral).join(",");
  const history = JSON.parse(
    psql(url, [
      "-Atc",
      String.raw`SELECT json_agg(x ORDER BY migration_name) FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS current, applied_steps_count FROM "_prisma_migrations" WHERE migration_name IN (${migrationNameSql})) x`,
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
    `${name}_runner_history_state_invalid`,
  );
}

function discardRehearsalOnlyRolledBackMigrationHistory(url) {
  for (const [migrationName, expectedSuccessful] of [
    [migration60Name, 1],
    [migration61Name, 0],
  ]) {
    const observation = psql(url, [
      "-Atc",
      `SELECT count(*) || ':' || count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || ':' || count(*) FILTER (WHERE rolled_back_at IS NULL) FROM "_prisma_migrations" WHERE migration_name = ${quoteLiteral(migrationName)}`,
    ]).stdout.trim();
    const [total, successful, current] = observation.split(":").map(Number);
    assert(
      total >= 2 &&
        successful === expectedSuccessful &&
        current === expectedSuccessful,
      `rehearsal_rolled_back_history_contract_mismatch:${migrationName}`,
    );
    psql(url, [
      "-c",
      `DELETE FROM "_prisma_migrations" WHERE migration_name = ${quoteLiteral(migrationName)} AND rolled_back_at IS NOT NULL`,
    ]);
    const remaining = psql(url, [
      "-Atc",
      `SELECT count(*) || ':' || count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) FROM "_prisma_migrations" WHERE migration_name = ${quoteLiteral(migrationName)}`,
    ]).stdout.trim();
    assert(
      remaining === `${expectedSuccessful}:${expectedSuccessful}`,
      `rehearsal_rolled_back_history_reset_failed:${migrationName}`,
    );
  }
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

function withApplicationName(url, applicationName) {
  const result = new URL(url);
  result.searchParams.set("application_name", applicationName);
  return result.toString();
}

function assertPrismaLockTimeoutEnvelope(result, message) {
  const output = `${result.stdout}${result.stderr}`.toLowerCase();
  // Prisma's schema engine can replace the inner PostgreSQL lock-timeout error
  // with the transaction-aborted envelope after the migration rolls back.
  assert(
    output.includes("lock timeout") ||
      output.includes("current transaction is aborted"),
    message,
  );
}

function assertPrismaMigrationFailureEnvelope(result, marker, message) {
  const output = `${result.stdout}${result.stderr}`.toLowerCase();
  const exactFailure =
    output.includes(marker.toLowerCase()) && output.includes("already exists");
  assert(
    result.status !== 0 &&
      (exactFailure || output.includes("current transaction is aborted")),
    message,
  );
}

async function waitForLock(url, applicationName, relation) {
  const deadline = Date.now() + 15_000;
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
  const credential = createDatabaseCredentialBoundary(url);
  try {
    const result = spawnSync(command.executable, command.args, {
      cwd: dbDirectory,
      env: credential.environment,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (requireSuccess && (result.status !== 0 || result.error))
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
    return result;
  } finally {
    credential.cleanup();
  }
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

function loopbackRehearsalDatabaseIdentity(value) {
  const url = requireLocalPostgres(String(value));
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
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
  throw sanitizedDiagnosticError({
    code: "private_pg17_rehearsal_command_failed",
    phase: "rehearsal",
  });
}

function psql(url, args, requireSuccess = true) {
  const invocation = createSecretSafePostgresInvocation({
    databaseUrl: url,
    args: ["-X", "-v", "ON_ERROR_STOP=1", ...args],
  });
  try {
    const result = spawnSync(psqlBinary, invocation.args, {
      encoding: "utf8",
      env: invocation.environment,
      input: invocation.input,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    });
    if (requireSuccess && (result.status !== 0 || result.error))
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
      });
    return result;
  } finally {
    invocation.cleanup();
  }
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
function psqlResultDiagnostic(result) {
  return JSON.stringify(rehearsalProcessDiagnostic(result));
}
function rehearsalProcessDiagnostic(result) {
  return createSanitizedDiagnostic({
    code: "private_pg17_rehearsal_command_failed",
    phase: "rehearsal",
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
  });
}
function assertPsqlFailedWithExactMessage(result, expectedFailure, message) {
  assert(
    result.status !== 0 &&
      `${result.stdout}${result.stderr}`.includes(expectedFailure),
    `${message}: expected=${JSON.stringify(expectedFailure)}; ${psqlResultDiagnostic(result)}`,
  );
}
function assertPsqlFailedWithOneOfExactMessages(
  result,
  expectedFailures,
  message,
) {
  const output = `${result.stdout}${result.stderr}`;
  assert(
    result.status !== 0 &&
      expectedFailures.some((expectedFailure) =>
        output.includes(expectedFailure),
      ),
    `${message}: expectedOneOf=${JSON.stringify(expectedFailures)}; ${psqlResultDiagnostic(result)}`,
  );
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
