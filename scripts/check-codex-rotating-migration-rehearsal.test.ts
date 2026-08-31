import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  assertRehearsalRoleObservation,
  provisionAndAssertRehearsalRoles,
  rehearsalRoleLoginContract,
} from "./codex-rotating-rehearsal-role-provisioning.mjs";
import {
  createRehearsalAuthorityContext,
  rehearsalSchemaOwnerIdentity,
} from "./codex-rotating-rehearsal-authority-context.mjs";
import { codexRotatingFunctions } from "./codex-rotating-production-writer-schema.mjs";
import {
  hasExactPostgresAbortedTransactionEnvelope,
  hasExactPostgresLockTimeoutEnvelope,
  isExpectedPrismaLockTimeoutFailure,
} from "./codex-rotating-lock-timeout-proof.mjs";
import {
  assertPsqlFailedWithExactMessage,
  assertPsqlFailedWithOneOfExactMessages,
  rehearsalProcessDiagnostic,
} from "./codex-rotating-rehearsal-process-result.mjs";

describe("Codex rotating PostgreSQL 17 rehearsal contract", () => {
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "check-codex-rotating-migration-rehearsal.mjs",
    ),
    "utf8",
  );
  const runtimeProofSource = readFileSync(
    resolve(
      import.meta.dirname,
      "prove-codex-runtime-versioned-writeback-prisma.ts",
    ),
    "utf8",
  );
  const productionRehearsalSource = readFileSync(
    resolve(import.meta.dirname, "rehearse-private-pg17-rollout.mjs"),
    "utf8",
  );
  const prismaRetentionProofSource = readFileSync(
    resolve(import.meta.dirname, "prove-codex-rotating-evidence-prisma.ts"),
    "utf8",
  );
  const prismaSchemaSource = readFileSync(
    resolve(
      import.meta.dirname,
      "../packages/platform/db/prisma/schema.prisma",
    ),
    "utf8",
  );
  const migration84Source = readFileSync(
    resolve(
      import.meta.dirname,
      "../packages/platform/db/prisma/migrations/000084_harden_comment_token_custody/migration.sql",
    ),
    "utf8",
  );
  const setupAdapterSource = readFileSync(
    resolve(
      import.meta.dirname,
      "../apps/web/src/server/prisma-codex-rotating-setup-payload-claim.ts",
    ),
    "utf8",
  );
  const runtimeAdapterSource = readFileSync(
    resolve(
      import.meta.dirname,
      "../packages/features/action-control-plane/src/infrastructure/prisma/prisma-codex-rotating-oauth-repository.ts",
    ),
    "utf8",
  );

  it("rehearses every canonical migration from 000060 through 000089 in order", () => {
    const inventory =
      /JSON\.stringify\(\[([\s\S]+?)\]\),\n\s+"rehearsal migration inventory/u.exec(
        source,
      )?.[1];

    expect(inventory).toBeDefined();
    expect(
      [...(inventory ?? "").matchAll(/migration\d+[A-Za-z]*Name/gu)].map(
        ([name]) => name,
      ),
    ).toEqual([
      "migration60Name",
      "migration61Name",
      "migration62Name",
      "migration63Name",
      "migration64Name",
      "migration65Name",
      "migration66Name",
      "migration67Name",
      "migration68Name",
      "migration69Name",
      "migration70Name",
      "migration71Name",
      "migration72RetireName",
      "migration72CanaryName",
      "migration73Name",
      "migration74Name",
      "migration75Name",
      "migration76Name",
      "migration77Name",
      "migration78Name",
      "migration79Name",
      "migration79ScopeName",
      "migration80Name",
      "migration81Name",
      "migration82Name",
      "migration83Name",
      "migration84Name",
      "migration85Name",
      "migration86Name",
      "migration87Name",
      "migration88Name",
      "migration89Name",
    ]);
    expect(source).toContain(
      'const migration67Name = "000067_review_live_progress"',
    );
    expect(source).toContain(
      'const migration68Name = "000068_validate_review_assignment_manifest"',
    );
    expect(source).toContain(
      'const migration69Name = "000069_release_rollout_ledger"',
    );
    expect(source).toContain(
      'const migration70Name = "000070_runtime_generation_witness_proof"',
    );
    expect(source).toContain(
      'const migration71Name = "000071_transactional_service_transition"',
    );
    expect(source).toContain(
      'const migration79Name = "000079_hosted_codex_output_limits"',
    );
    expect(source).toContain(
      'const migration80Name = "000080_hosted_codex_attempt_generation"',
    );
    expect(source).toContain(
      'const migration81Name = "000081_hosted_codex_runtime_gate"',
    );
    expect(source).toContain(
      'const migration82Name = "000082_validate_hosted_codex_output_limits"',
    );
    expect(source).toContain(
      'const migration83Name = "000083_hosted_codex_comment_token_mint_protocol"',
    );
    expect(source).toContain(
      'const migration84Name = "000084_harden_comment_token_custody"',
    );
    expect(source).toContain(
      'const migration85Name = "000085_comment_token_gate_lock_result"',
    );
    expect(source).toContain(
      'const migration86Name = "000086_comment_token_custody_r18_remediation"',
    );
    expect(source).toContain(
      '"000079_remove_account_wide_provider_lane_serialization"',
    );
    expect(source).toContain(
      'const migration72RetireName = "000072_retire_superseded_codex_setup_claims"',
    );
    expect(source).toContain(
      'const migration72CanaryName = "000072_runtime_canary_challenge"',
    );
    expect(source).toContain(
      'const migration73Name = "000073_codex_oauth_active_namespace_refresh"',
    );
    expect(source).toContain(
      'const migration74Name = "000074_hosted_codex_account_pool"',
    );
    expect(source).toContain(
      'const migration87Name = "000087_codex_oauth_v4_v5_workflow_reattestation"',
    );
    expect(source).toContain(
      'const migration88Name = "000088_codex_oauth_reattestation_mutation_owner_fence"',
    );
    expect(source).toContain(
      'const migration89Name = "000089_codex_oauth_v4_v5_staged_compatibility"',
    );
    expect(source).toContain(
      "for (const migrationName of rotatingMigrationNames)",
    );
    expect(source).toContain(
      "proveMigrationRunnerHistory(url, migrationName, true)",
    );
    expect(source).not.toContain("000067_release_rollout_ledger");
  });

  it("keeps migration 000084 installable before the custody role is provisioned", () => {
    expect(migration84Source).toContain(
      "IF to_regrole('reviewrouter_comment_token_custody') IS NOT NULL THEN",
    );
    expect(migration84Source).toContain(
      "FROM reviewrouter_comment_token_custody;",
    );
    expect(migration84Source).not.toContain(
      "FROM PUBLIC, reviewrouter_comment_token_custody;",
    );
  });

  it("keeps custody evidence and closure uniqueness represented in Prisma drift checks", () => {
    const proofModel =
      /model HostedCodexCommentTokenRevocationProof \{([\s\S]+?)\n\}/u.exec(
        prismaSchemaSource,
      )?.[1];
    expect(proofModel).toBeDefined();
    expect(proofModel).toContain("mintId           String   @id");
    expect(proofModel).toContain("ownerIdHash");
    expect(proofModel).toContain("fenceEpoch");
    expect(proofModel).toContain("receiptAuthority");
    expect(proofModel).toContain("receiptResult");
    expect(proofModel).toContain("@@ignore");
    expect(prismaSchemaSource).toContain(
      '@unique(map: "HostedCodexRuntimeClosure_gate_revision_key")',
    );
  });

  it("derives the post-000089 exact function count from the canonical manifest", () => {
    expect(new Set(codexRotatingFunctions).size).toBe(
      codexRotatingFunctions.length,
    );
    expect(source).toContain(
      "IF function_count <> ${codexRotatingFunctions.length} OR unsafe_function_count <> 0 THEN",
    );
    expect(source).not.toContain("IF function_count <> 24");
  });

  it("runs the exact migration89 SQL in two PG17 sessions for both lock orderings", () => {
    expect(source).toContain("await proveMigration89TwoSessionBoundary()");
    expect(source).toContain(
      'for (const ordering of ["old_invocation_first", "migration_boundary_first"])',
    );
    expect(source).toContain('spawnPsql(migrationUrl, ["-f", migration89])');
    expect(source).toContain(
      'LOCK TABLE public."CodexOAuthSecretNamespace" IN ROW EXCLUSIVE MODE',
    );
    expect(source).toContain('"ShareRowExclusiveLock",\n              false');
    expect(source).toContain(
      "codex_oauth_v4_v5_compatibility_predecessor_evidence_missing",
    );
    expect(source).toContain("PERFORM pg_advisory_xact_lock(810081, 1)");
    expect(source).toContain(
      'blocker.write("SELECT pg_advisory_lock(810081, 1);\\n")',
    );
    const proof =
      /async function proveMigration89TwoSessionBoundary\(\) \{([\s\S]+?)\n\}\n\nasync function proveMigrationSpecificLegacyBehavior/u.exec(
        source,
      )?.[1];
    expect(proof).toBeDefined();
    expect(proof).not.toContain("pg_sleep");
    expect(proof).not.toContain('"Migration89RaceLatch"');
    expect(proof).not.toMatch(/predecessor_evidence_missing\|does not exist/u);
    expect(proof).toContain("spawnMigration89Process({");
    expect(proof).toContain("waitForMigration89LockState({");
    expect(proof).toContain("findMigration89RelationLock(");
    expect(proof).toContain("findMigration89AdvisoryLock(");
    expect(proof).toContain("migration89LockBlockedBy(");
    expect(proof).toContain('sqlState: "55000"');
    expect(proof).toContain('routine: "exec_stmt_raise"');
    expect(proof).toContain("postgresInputSource: migration89");
    expect(proof).toContain('"VERBOSITY=verbose"');
    expect(proof).toContain('"SHOW_CONTEXT=never"');
    expect(proof).toContain("watchedProcesses:");
    expect(proof).toContain("handle.terminateAndWait()");
    expect(proof).toContain("migration89_blocker_cleanup_failed");
    expect(proof).toContain("migration89_database_cleanup_failed");
    expect(proof).not.toContain("spawn(psqlBinary");
    expect(proof).not.toContain("child.kill(");
    expect(proof).not.toContain("child.stdin");
    expect(proof).not.toContain(".blockers.includes(");
    expect(proof).not.toContain('.includes("does not exist")');
  });

  it("exposes the disposable real-PG17 migration89 boundary phase", () => {
    expect(source).toContain('"--migration89-boundary-only"');
    expect(source).toContain(
      "Codex rotating PostgreSQL 17 migration89 two-session boundary passed.",
    );
  });

  it("takes one database-bound lock snapshot with exact object identities", () => {
    const lockSnapshot =
      /const lockSnapshot = \(url\) =>([\s\S]+?)\n[ ]{2}const releaseBlocker/u.exec(
        source,
      )?.[1];

    expect(lockSnapshot).toBeDefined();
    expect(lockSnapshot).toContain('psql(url, [\n        "-qAtc",');
    expect(lockSnapshot).toContain("SET statement_timeout='2s';");
    expect(lockSnapshot).toContain("SELECT json_build_object(");
    expect(lockSnapshot).toContain(
      "'databaseOid', target_database.oid::bigint",
    );
    expect(lockSnapshot).toContain(
      "'relationOid', target_relation.oid::bigint",
    );
    expect(lockSnapshot).toContain(
      'observed_lock.database::bigint AS "lockDatabaseOid"',
    );
    expect(lockSnapshot).toContain(
      'observed_lock.relation::bigint AS "relationOid"',
    );
    expect(lockSnapshot).toContain(
      "observed_lock.database=target_database.oid",
    );
    expect(lockSnapshot).toContain(
      "observed_lock.relation=target_relation.oid",
    );
    expect(lockSnapshot).toContain("observed_lock.classid=810081");
    expect(lockSnapshot).toContain("observed_lock.objid=1");
    expect(lockSnapshot).toContain("observed_lock.objsubid=2");
    expect(lockSnapshot).toContain("pg_blocking_pids(activity.pid) AS blockers");
  });

  it.each([{ timedOut: true }, { error: { code: "ETIMEDOUT" } }])(
    "rejects timed-out failure evidence %#",
    (timeoutState) => {
      const result = {
        status: null,
        signal: "SIGKILL",
        stdout: "expected_failure",
        stderr: "",
        ...timeoutState,
      };

      expect(() =>
        assertPsqlFailedWithExactMessage(
          result,
          "expected_failure",
          "exact timeout",
        ),
      ).toThrow(/exact timeout/u);
      expect(() =>
        assertPsqlFailedWithOneOfExactMessages(
          result,
          ["expected_failure"],
          "one-of timeout",
        ),
      ).toThrow(/one-of timeout/u);
      expect(rehearsalProcessDiagnostic(result).metadata.timedOut).toBe(true);
    },
  );

  it("retains ordinary migration 000074 in the pre-release source manifest", () => {
    expect(source).toContain("directory === migration74Name");
    expect(source).not.toContain("applyOrdinaryPostReleaseMigrations");
    expect(source).not.toContain("assertMigrationAbsentFromHistory");
    expect(source).toContain("proveMigrateDeployNoOp(providerAdmin)");
    expect(source).toContain("combined 000060 through 000089 rehearsal passed");
  });

  it("rehearses rejection of legacy active namespace schemas 1 through 3", () => {
    expect(source).toContain("for (const rejectedSchemaVersion of [1, 2, 3])");
    expect(source).toContain(
      "codex_oauth_secret_namespace_workflow_schema_invalid",
    );
    expect(source).toContain(
      "active namespace schema V${rejectedSchemaVersion} did not fail closed",
    );
  });

  it("reproduces the trusted production pre-migration manifest", () => {
    expect(source).toContain("applyCanonicalPreMigrationBaseline");
    expect(source).toContain("directory === migration67Name");
    expect(source).toContain("directory === migration68Name");
    expect(source).toContain("directory === migration74Name");
    expect(source).toContain("directory === migration78Name");
    expect(source).toContain(
      "rehearsal baseline must reproduce the trusted pre-migration manifest",
    );
    expect(source).not.toContain("applyBaselineThrough59");
  });

  it("splits safe canonical fixtures from rollback-only legacy negatives", () => {
    const negativeCases =
      /function proveCanonicalLegacyReconciliationNegativeCases\(\) \{([\s\S]+?)\n\}\n\nfunction proveLateMigrationRollbackAndReplayMatrix/u.exec(
        source,
      )?.[1];
    expect(negativeCases).toBeDefined();
    const expectedFailures = [
      ["unresolved", "database", "legacy_reconciliation_unresolved_intent"],
      ["unexpired", "database", "legacy_reconciliation_lease_not_eligible"],
      ["inventory_race", "database", "legacy_reconciliation_inventory_changed"],
      ["ttl_crossing", "database", "legacy_reconciliation_lease_not_eligible"],
      [
        "unknown_status",
        "preflight",
        "legacy_reconciliation_intent_status_unclassified:new_state",
      ],
      [
        "forged_digest",
        "preflight",
        "legacy_ambiguity_evidence_digest_invalid",
      ],
    ] as const;
    const caseOffsets = expectedFailures.map(([name]) =>
      negativeCases!.indexOf(`name: "${name}"`),
    );
    expect(caseOffsets).toEqual(
      [...caseOffsets].sort((left, right) => left - right),
    );
    expect(caseOffsets.every((offset) => offset >= 0)).toBe(true);
    for (const [
      index,
      [name, stage, expectedError],
    ] of expectedFailures.entries()) {
      const caseSource = negativeCases!.slice(
        caseOffsets[index],
        caseOffsets[index + 1] ?? negativeCases!.length,
      );
      expect(caseSource).toContain(`stage: "${stage}"`);
      expect(caseSource).toContain(`error: "${expectedError}"`);
      expect(caseSource).toContain(
        `canonical_negative_${stage}_guard_observed:${name}:${expectedError}`,
      );
    }
    expect(negativeCases?.match(/stage: "preflight"/gu)).toHaveLength(2);
    expect(negativeCases?.match(/stage: "database"/gu)).toHaveLength(4);
    expect(negativeCases?.match(/error: "/gu)).toHaveLength(6);
    expect(negativeCases?.match(/^ {8}evidence:/gmu)).toHaveLength(6);
    expect(source).toContain("canonicalSuccess: true");
    expect(source).toContain("retainUnexpiredLease: true");
    expect(source).toContain('name: "inventory_race"');
    expect(source).toContain('name: "ttl_crossing"');
    expect(source).toContain('name: "unknown_status"');
    expect(source).toContain('name: "forged_digest"');
    expect(source).toContain(
      'step === "deploy_migrations_and_converge_grants"',
    );
    expect(source).toContain("canonical_fixture_terminal");
    expect(source).toContain(
      "pending-to-failed-to-remote-outcome-unknown proof failed",
    );
    expect(source).toContain('rollback.permitState === "installed"');
    expect(source).toContain("rollback.targetReceipt === null");
    expect(source).toContain("rollback.committedTargetMigrations === 0");
    expect(source).toContain("transformSourceEvidence");
    expect(source).toContain("interval '100 milliseconds'");
    expect(source).toContain("SELECT pg_sleep(0.2)");
    expect(negativeCases).toContain(
      'error: "legacy_reconciliation_unresolved_intent"',
    );
    expect(negativeCases).toContain(
      'error: "legacy_reconciliation_lease_not_eligible"',
    );
    expect(negativeCases).toContain(
      'error: "legacy_reconciliation_inventory_changed"',
    );
    expect(negativeCases).toContain(
      'error: "legacy_reconciliation_intent_status_unclassified:new_state"',
    );
    expect(negativeCases).toContain(
      'error: "legacy_ambiguity_evidence_digest_invalid"',
    );
    expect(negativeCases).toContain(
      'REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed"',
    );
    expect(negativeCases).not.toContain(
      'REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "open"',
    );
    expect(negativeCases).toContain(
      'step === "deploy_migrations_and_converge_grants"',
    );
    expect(negativeCases).toContain(
      'testCase.expectedFailure.stage === "database"',
    );
    expect(negativeCases).toContain("exactPreflightFailure");
    expect(negativeCases).toContain("exactDatabaseFailure");
    expect(negativeCases).toContain("error instanceof Error");
    expect(negativeCases).toContain(
      "error.message === testCase.expectedFailure.error",
    );
    expect(negativeCases).toContain(
      "error.message === testCase.expectedFailure.evidence",
    );
    expect(negativeCases).toContain('rollback.permitState === "installed"');
    expect(negativeCases).toContain("rollback.targetReceipt === null");
    expect(negativeCases).toContain("rollback.committedTargetMigrations === 0");
    expect(source).toContain(
      "canonical replay did not return the immutable original receipt",
    );
  });

  it("only accepts a negative subprocess failure with its exact guard evidence", () => {
    const runner =
      /function runRehearsalReleaseSubprocess\(step, command, args, options = \{\}\) \{([\s\S]+?)\n\}\n\nfunction markCanonicalRehearsalRoles/u.exec(
        source,
      )?.[1];
    expect(runner).toBeDefined();
    expect(runner).toContain("options.expectedFailure");
    expect(runner).toContain("canonicalFailureSourceArgs");
    expect(runner).toContain('["--file=-"]');
    expect(runner).toContain("...canonicalFailureSourceArgs");
    expect(runner).toContain("isExactPostgresGuardFailure(");
    expect(runner).toContain("result,");
    expect(runner).toContain("options.expectedFailure.guard");
    expect(runner).toContain(
      "throw new Error(options.expectedFailure.evidence)",
    );
  });

  it("keeps a post-observation TTL crossing outside release reconciliation", () => {
    const proof =
      /async function proveMigrationSpecificLegacyBehavior\(\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(proof).toBeDefined();
    expect(proof).toContain("id = 'issued-crossing') <> 'expired'");
    expect(proof).toContain(
      `"mutationEpoch" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') <> 0`,
    );
    expect(proof).toContain(
      `"mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') IS NOT NULL`,
    );
    expect(proof).toContain(
      "made a post-observation TTL crossing newly eligible for reconciliation",
    );
    expect(proof).not.toContain(
      `"mutationOwner" FROM "CodexOAuthProviderInstance" WHERE id = 'p-crossing') <> 'recovery'`,
    );
  });

  it("reads the database generation binding as shared-object metadata", () => {
    expect(source).toContain("shobj_description(oid, 'pg_database')");
    expect(source).not.toMatch(/\bobj_description\(oid, 'pg_database'\)/u);
  });

  it("keeps stateful 000063 through 000066 in the late-failure rollback/replay matrix", () => {
    const matrix =
      /function proveLateMigrationRollbackAndReplayMatrix\(\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(matrix).toBeDefined();
    expect(matrix).toContain("name: migration63Name");
    expect(matrix).toContain("name: migration64Name");
    expect(matrix).toContain("name: migration65Name");
    expect(matrix).toContain("name: migration66Name");
    expect(matrix).not.toContain("name: migration69Name");
    expect(matrix).not.toContain("release_rollout_receipt_ledger");
    expect(matrix).toContain('psql(url, ["-c", testCase.decoy])');
    expect(matrix).toContain(
      "`${testCase.name} injected failure did not report its decoy collision`",
    );
    expect(matrix).toContain("assertPrismaMigrationFailureEnvelope(");
    expect(matrix).toContain("testCase.failureMarker");
    expect(matrix).toContain('includes("already exists")');
    expect(matrix).toContain(
      'const directFailure = psql(url, ["-f", testCase.source], false)',
    );
    expect(matrix).toContain(
      "`${testCase.name} leaked partial catalog state after rollback`",
    );
    expect(matrix).toContain('.stdout.trim() === "0"');
    expect(matrix).toContain('psql(url, ["-c", testCase.cleanup])');
    expect(matrix).toContain("const failed = migrateDeploy(url, false)");
    expect(matrix).toContain(
      "proveMigrationRunnerHistory(url, testCase.name, false)",
    );
    expect(matrix).toContain(
      'migrateResolve(url, "--rolled-back", testCase.name)',
    );
    expect(matrix).toContain("migrateDeploy(url)");
    expect(matrix).toContain(
      "proveMigrationRunnerHistory(url, testCase.name, true)",
    );
    expect(matrix).not.toContain("registerDirectMigrationSuccess");
    expect(source).not.toContain("function registerDirectMigrationSuccess");
  });

  it("requires 000069 to remain an immutable application-database no-op marker", () => {
    const migration = readFileSync(
      resolve(
        import.meta.dirname,
        "../packages/platform/db/prisma/migrations/000069_release_rollout_ledger/migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("immutable history marker");
    expect(migration).toContain("packages/platform/release-authority-db");
    expect(migration).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/iu,
    );
    expect(source).toContain("function proveReleaseAuthorityMarkerIsolation");
    expect(source).toContain('forbiddenObjects === "0"');
    expect(source).toContain('"reviewrouter_release_control"');
    expect(source).toContain('"reviewrouter_release_witness"');
  });

  it("uses the production exact catalog observation and verifier", () => {
    expect(source).toContain(
      "verifyCodexRotatingDatabaseCatalog(observation.catalog, {",
    );
    expect(source).toContain(
      "`production_catalog_verifier_rejected_rehearsal:${JSON.stringify(result)}`",
    );
    expect(source).toContain("verifyPrivileges: false");
    const collection =
      /function collectObservation\(url\) \{([\s\S]+?)\n\}/u.exec(source)?.[1];
    expect(collection).toBeDefined();
    expect(collection).toContain(
      "codexRotatingProductionWriterBaseObservationSql",
    );
    expect(collection).toContain(").catalog");
  });

  it("proves schema-owner ownership and narrow release authority", () => {
    const privilegeProof =
      /function proveDatabasePrivileges\(url\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(privilegeProof).toBeDefined();
    expect(privilegeProof).toContain(
      "owner.rolname <> 'reviewrouter_release_schema_owner'",
    );
    expect(privilegeProof).toContain(
      "membership.roleid = 'reviewrouter_release_schema_owner'::regrole",
    );
    expect(privilegeProof).toContain("namespace.nspname = 'public'");
    expect(privilegeProof).toContain("'reviewrouter_release_schema_owner'");
    expect(privilegeProof).toContain("'SET'");
    expect(privilegeProof).toContain(
      "membership.member = 'reviewrouter_release_migration'::regrole",
    );
    expect(privilegeProof).toContain(
      "'reviewrouter_release_migration', 'public', 'USAGE'",
    );
    expect(privilegeProof).toContain(
      "'reviewrouter_release_migration', namespace.oid, 'CREATE'",
    );
    expect(privilegeProof).toContain(
      "'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean,boolean)'::regprocedure",
    );
    expect(privilegeProof).toContain('public."_prisma_migrations"');
    expect(privilegeProof).toContain("attribute.attname IN ('id','status')");
    expect(privilegeProof).toContain("is_grantable = 'YES'");
    expect(privilegeProof).toContain(
      "'public.\"ReviewInvestigationMaintenanceCheckpoint\"'",
    );
    expect(privilegeProof).toContain(
      "IS DISTINCT FROM (role_name = 'reviewrouter_worker')",
    );
    expect(privilegeProof).toContain("'DELETE,TRUNCATE,REFERENCES,TRIGGER'");
    expect(privilegeProof).not.toContain(
      "owner-equivalent data privileges must remain complete",
    );
  });

  it("rehearses fail-closed grantor topology and rejects bootstrap replay", () => {
    const provisioning =
      /function prepareCanonicalReleaseRoles\(url, installHistoricalSchema\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(provisioning).toBeDefined();
    expect(provisioning).toContain("const targetDatabaseName");
    expect(provisioning).toContain("databaseUrl(url, targetDatabaseName)");
    expect(provisioning).not.toContain("databaseUrl(url, databaseName)");
    expect(provisioning).toContain("runSecretSafePostgresCommand({");
    expect(provisioning).toContain(
      'expectFailureContaining:\n        "refusing non-canonical role membership topology"',
    );
    expect(provisioning).toContain("expectedFailure?.expectedFailure === true");
    expect(provisioning).not.toContain("rejectedForeignGrantor");
    expect(provisioning).not.toContain("String(error)");
    expect(provisioning).not.toContain(".stderr");
    expect(source).toContain("refusing non-canonical role membership topology");
    expect(source).toContain(
      "demoted role bootstrap unexpectedly retained provisioning authority",
    );
    expect(source).toContain(
      "rejected role bootstrap replay changed the canonical membership topology",
    );
    expect(provisioning.indexOf("const foreignGrantor")).toBeLessThan(
      provisioning.indexOf('"initial_role_provisioning"'),
    );
    expect(provisioning).toContain(
      'expectFailureContaining: "trusted role bootstrap authority is not exact"',
    );
    expect(source).toContain(
      "adversarial grantor retained role membership revoke authority",
    );
    expect(provisioning).toContain(
      'const foreignGrantedRole = "reviewrouter_rehearsal_foreign_role"',
    );
    expect(source).toContain(
      "independent adversarial membership chain was not installed",
    );
    expect(provisioning).toContain(
      "GRANT ${foreignGrantedRole} TO ${foreignGrantor}",
    );
    expect(provisioning).toContain(
      "GRANT ${foreignGrantedRole} TO reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain(
      "REVOKE ${foreignGrantedRole} FROM reviewrouter_role_bootstrap GRANTED BY ${foreignGrantor}",
    );
    expect(provisioning).toContain("DROP ROLE ${foreignGrantedRole}");
    expect(provisioning).toContain(
      "owner_name = 'reviewrouter_release_schema_owner'",
    );
    expect(provisioning).toContain(
      "role bootstrap did not transfer pre-existing public objects to the schema owner",
    );
    expect(provisioning).toMatch(
      /psql\(url, \[\s+"-c",\s+`DROP FUNCTION public\.rr_legacy_bootstrap_owned_fn\(\);/u,
    );
    expect(source).toContain("membership_grantor_count <> 1");
    expect(source).toContain(
      "granted.rolname <> 'reviewrouter_activation_receipt_guard'",
    );
    expect(source).toContain(
      "member.rolname <> 'reviewrouter_activation_receipt_guard'",
    );
    expect(source).toContain(
      "Codex OAuth role membership authority mismatch: total %, canonical %, roles %, grantors %",
    );
  });

  it("completes and replays against the trusted pre-activation catalog before runtime proofs", () => {
    expect(
      source.match(/REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed"/gu),
    ).toHaveLength(3);
    expect(source).toContain(
      'releaseMigrationResult.aclGateState === "closed"',
    );
    expect(productionRehearsalSource).toMatch(
      /const runReleaseMigrationPort[\s\S]+?REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "closed"/u,
    );
    expect(source).toContain(
      "must complete against the trusted pre-activation catalog",
    );
    expect(source).toContain(
      "must retain CONNECT before runtime cascade proofs",
    );
    expect(source).toContain(
      "has_database_privilege(${quoteLiteral(role)}, current_database(), 'CONNECT')",
    );
    const replayIndex = source.indexOf(
      "const replayMigrationResult = executeCanonicalReleaseMigration(",
    );
    const reopenIndex = source.indexOf(
      "convergeRuntimePrivileges(providerAdmin);",
    );
    const runtimeProofIndex = source.indexOf(
      "proveSuccessfulCombinedRelease(providerAdmin);",
    );
    expect(replayIndex).toBeGreaterThan(-1);
    expect(reopenIndex).toBeGreaterThan(replayIndex);
    expect(runtimeProofIndex).toBeGreaterThan(reopenIndex);
  });

  it("asserts the two locking guards' exact and distinct execution contracts", () => {
    const privilegeProof =
      /function proveDatabasePrivileges\(url\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    const providerGuardContract =
      /IF NOT EXISTS \(\s+SELECT 1[\s\S]+?p\.oid = 'public\.codex_oauth_provider_identity_guard\(\)'::regprocedure([\s\S]+?)\s+\) THEN\s+RAISE EXCEPTION 'Codex OAuth provider identity guard execution contract mismatch'/u.exec(
        privilegeProof ?? "",
      )?.[1];
    expect(privilegeProof).toBeDefined();
    expect(providerGuardContract).toBeDefined();
    expect(privilegeProof).toContain(
      "p.oid = 'public.codex_oauth_provider_identity_guard()'::regprocedure",
    );
    expect(privilegeProof).toContain("AND p.prosecdef");
    expect(privilegeProof).toContain(
      "owner.rolname = 'reviewrouter_release_schema_owner'",
    );
    expect(privilegeProof).toContain(
      "p.proconfig = ARRAY['search_path=pg_catalog, public']::text[]",
    );
    expect(privilegeProof).toContain("pg_get_functiondef(p.oid)");
    expect(privilegeProof).toContain(
      'FROM public."CodexOAuthProviderIdentityQuarantine"',
    );
    expect(privilegeProof).toContain('FROM public."RepositoryConnection"');
    expect(providerGuardContract).toContain(
      'public."codex_oauth_consume_database_authority"(',
    );
    expect(providerGuardContract).toContain(
      `'''provider_identity_repair_v2'', transition_key, 0'`,
    );
    expect(providerGuardContract).toMatch(
      /position\(\s+'FROM public\."CodexOAuthDatabaseAuthorityReceipt"'\s+IN pg_get_functiondef\(p\.oid\)\s+\) = 0/u,
    );
    expect(providerGuardContract).toMatch(
      /position\(\s+'receipt\."consumedAt" IS NOT NULL'\s+IN pg_get_functiondef\(p\.oid\)\s+\) = 0/u,
    );
    expect(providerGuardContract).not.toMatch(
      /position\(\s+'FROM public\."CodexOAuthDatabaseAuthorityReceipt"'[\s\S]+?\) > 0/u,
    );
    expect(providerGuardContract).not.toMatch(
      /position\(\s+'receipt\."consumedAt" IS NOT NULL'[\s\S]+?\) > 0/u,
    );
    expect(privilegeProof).toContain(
      "IN replace(\n                pg_get_functiondef(p.oid)",
    );
    expect(privilegeProof).toContain(
      "'public.\"CodexOAuthProviderIdentityQuarantine\"',",
    );
    expect(privilegeProof).toContain("'public.\"RepositoryConnection\"',");
    expect(privilegeProof).toContain(
      "p.oid = 'public.codex_oauth_child_identity_fence_guard()'::regprocedure",
    );
    expect(privilegeProof).toContain("AND NOT p.prosecdef");
    expect(privilegeProof).toContain("AND p.proconfig IS NULL");
    expect(privilegeProof).not.toMatch(
      /p\.proname IN \([\s\S]+?codex_oauth_provider_identity_guard[\s\S]+?codex_oauth_child_identity_fence_guard/u,
    );
  });

  it("routes rehearsal work through explicit authority clients", () => {
    const orchestration = source.slice(
      source.indexOf("try {"),
      source.indexOf("function proveLateMigrationRollbackAndReplayMatrix"),
    );
    const prepareIndex = orchestration.indexOf("prepareCanonicalReleaseRoles(");
    const fixtureSeedIndex = orchestration.indexOf(
      "seedDirtyFixtures(providerAdmin, { canonicalSuccess: true })",
    );
    const authorityIndex = orchestration.indexOf(
      "rehearsalAuthority = rehearsalRelease.authority",
    );
    const helperIndex = orchestration.indexOf(
      "executeCanonicalReleaseMigration(",
    );
    const migrationSpecificIndex = orchestration.indexOf(
      "await proveMigrationSpecificLegacyBehavior()",
    );
    const negativeCasesIndex = orchestration.indexOf(
      "proveCanonicalLegacyReconciliationNegativeCases()",
    );
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(authorityIndex).toBeGreaterThan(prepareIndex);
    expect(fixtureSeedIndex).toBeGreaterThan(authorityIndex);
    expect(migrationSpecificIndex).toBeLessThan(prepareIndex);
    expect(negativeCasesIndex).toBeLessThan(prepareIndex);
    expect(source).toContain(
      "proveMigration60LockTimeout(providerAdmin, providerAdmin)",
    );
    expect(source).toContain(
      "proveCombinedLockTimeout(providerAdmin, providerAdmin)",
    );
    expect(source).toContain(
      "withApplicationName(fixtureAdminUrl, applicationName)",
    );
    expect(source).toContain("isExpectedPrismaLockTimeoutFailure({");
    expect(source).toContain("runnerElapsedMs < 45_000");
    expect(prepareIndex).toBeLessThan(helperIndex);
    expect(source).toContain(
      "discardRehearsalOnlyRolledBackMigrationHistory(providerAdmin)",
    );
    expect(source).toContain('name: "unresolved"');
    expect(source).toContain("retainUnexpiredLease: true");
    expect(source).toContain('rollback.permitState === "installed"');
    expect(source).toContain("rollback.committedTargetMigrations === 0");
    expect(source).not.toContain("psqlInput");
    expect(source).not.toContain("let rehearsalUrl");
    expect(source).not.toContain("rehearsalRoleClients");
    expect(source).toContain("createRehearsalAuthorityContext({");
    expect(source).toContain("permitInstaller,");
    expect(source).toContain("installRehearsalMigrationPermit(");
    expect(source).toContain("receiptSha256: `sha256:${sha256Canonical(");
    expect(source).toContain(
      "const eligibilityCutoff = sourceLegacyAmbiguity.eligibilityCutoff",
    );
    expect(source).not.toContain(
      "const eligibilityCutoff = new Date().toISOString()",
    );
    expect(source).toContain(
      "reviewrouter_activation.install_migration_permit(",
    );
    expect(source).toContain(
      "REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_SYSTEM_IDENTIFIER",
    );
    expect(source.match(/psql\(release,/gu)).toHaveLength(1);
    expect(source).toMatch(
      /psql\(release, \[[\s\S]+?reviewrouter_bootstrap\.consume_migration_evidence/u,
    );

    const provisioning =
      /function prepareCanonicalReleaseRoles\(url, installHistoricalSchema\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(provisioning).toBeDefined();
    expect(provisioning).toContain("reviewrouter_role_bootstrap");
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_role_bootstrap LOGIN SUPERUSER NOCREATEDB CREATEROLE",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_release_migration LOGIN",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_release_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(
      provisioning.indexOf("CREATE ROLE reviewrouter_release_migration LOGIN"),
    ).toBeLessThan(provisioning.indexOf("installHistoricalSchema(bootstrap)"));
    expect(
      provisioning.indexOf(
        "CREATE ROLE reviewrouter_release_schema_owner NOLOGIN",
      ),
    ).toBeLessThan(provisioning.indexOf("installHistoricalSchema(bootstrap)"));
    expect(provisioning).toContain(
      "GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_activation_permit_installer LOGIN",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_activation_receipt_reader LOGIN",
    );
    expect(provisioning).toContain(
      'CREATE TABLE IF NOT EXISTS public."_prisma_migrations"',
    );
    expect(provisioning).toContain("installHistoricalSchema(bootstrap)");
    expect(
      provisioning.indexOf("installHistoricalSchema(bootstrap)"),
    ).toBeLessThan(
      provisioning.indexOf('"external_activation_authority_provisioning"'),
    );
    expect(provisioning).toContain(
      '"external_activation_authority_provisioning"',
    );
    expect(
      provisioning.indexOf('"external_activation_authority_provisioning"'),
    ).toBeLessThan(provisioning.indexOf('"initial_role_provisioning"'));
    expect(provisioning).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(provisioning).toContain("DO $extension_owners$");
    expect(provisioning).toContain(
      "ALTER ROUTINE %s OWNER TO reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain(
      "ALTER TYPE public.%I OWNER TO reviewrouter_role_bootstrap",
    );
    expect(
      provisioning.indexOf("bootstrap.password = bootstrapPassword"),
    ).toBeLessThan(
      provisioning.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto"),
    );
    expect(provisioning).toContain("CREATEROLE");
    expect(provisioning).toContain("REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL");
    expect(provisioning).toContain(
      "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
    );
    for (const role of [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
      "reviewrouter_codex_effect_authority",
      "reviewrouter_release_migration",
      "reviewrouter_release_schema_owner",
    ]) {
      expect(provisioning).toContain(role);
    }
    expect(provisioning).toContain("pg_advisory_xact_lock");
    expect(provisioning).toContain(
      "refusing to take over pre-existing canonical role",
    );
    expect(provisioning).not.toContain(
      'startsWith("reviewrouter-rehearsal-managed:")',
    );
    expect(provisioning.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      provisioning.indexOf("SELECT rolname INTO existing_role"),
    );
    expect(source).toContain("runRehearsalReleaseSubprocess");
    expect(source).toContain("proveSelfHostedV4V5ReattestationOwnerInvocation");
    expect(source).toContain(
      "self-hosted canonical table/function owner session was not admitted",
    );
    expect(source).toContain(
      "self-hosted non-owner session bypassed exact owner admission",
    );
    expect(provisioning).toContain(
      "markCanonicalRehearsalRoles(url.toString())",
    );
    expect(source).toContain(
      'searchParams.set("application_name", applicationName)',
    );
    expect(source).not.toContain("PGAPPNAME");
    expect(source).toContain(
      "rehearsal_rolled_back_history_contract_mismatch:${migrationName}",
    );
    expect(source).not.toContain(
      "convergeSyntheticReleaseOwnerEquivalentPrivileges",
    );
    expect(source).toContain(
      "rehearsalRoleObservationSql(rehearsalRoleMarker)",
    );
    expect(source).toContain("schema_owner_cleanup_dependencies_present");
    expect(source).toContain("dependency.deptype IN ('a','o')");
    expect(source).toContain("DO $rehearsal_schema_owner_membership_cleanup$");
    expect(source).toContain(
      "refusing non-rehearsal schema-owner membership cleanup",
    );
    expect(source).toContain("REVOKE %I FROM %I GRANTED BY %I CASCADE");
    expect(
      source.indexOf("$rehearsal_schema_owner_membership_cleanup$;"),
    ).toBeLessThan(source.indexOf('cleanupSafety === "0:0:0"'));
    expect(source).toContain('cleanupSafety === "0:0:0"');
    expect(source).toContain(
      "rehearsal_database_removal_not_proven_before_role_cleanup",
    );
    expect(source.indexOf("cleanupRuntimeRoles(adminUrl)")).toBeGreaterThan(
      source.indexOf(
        "rehearsal_database_removal_not_proven_before_role_cleanup",
      ),
    );
  });

  it("accepts the generic 000061 aborted-transaction wrapper with exact direct and history proof", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    const output = `Migration name: ${migrationName}\nERROR: current transaction is aborted`;
    const exactEvidence = {
      total: 1,
      currentFailed: 1,
      zeroStep: 1,
      lockTimeoutLog: 0,
      abortedTransactionLog: 0,
      exactFailureLog: 0,
      emptyLog: 1,
    };
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof: {
          migrationName,
          observed: true,
        },
      }),
    ).toBe(true);
  });

  it.each([
    [
      "aborted transaction",
      "Migration runner note: current transaction is aborted after cleanup",
    ],
    ["lock timeout", "Migration runner note: lock timeout was expected"],
  ])(
    "rejects unrelated %s prose despite exact migration, history, and direct proof",
    (_case, unrelatedProse) => {
      const migrationName = "000061_codex_oauth_provider_mutation_fence";
      expect(
        isExpectedPrismaLockTimeoutFailure({
          output: `P3018\nMigration name: ${migrationName}\n${unrelatedProse}`,
          migrationName,
          historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
          directLockTimeoutProof: { migrationName, observed: true },
        }),
      ).toBe(false);
    },
  );

  it("requires a canonical ERROR line for the rehearsal aborted-transaction fallback", () => {
    expect(
      hasExactPostgresAbortedTransactionEnvelope(
        "unrelated prose says current transaction is aborted",
      ),
    ).toBe(false);
    expect(
      hasExactPostgresAbortedTransactionEnvelope(
        "\u001b[31mError: ERROR: current transaction is aborted, commands ignored until end of transaction block\u001b[0m",
      ),
    ).toBe(true);
  });

  it("requires a canonical ERROR line for direct lock-timeout proof", () => {
    expect(
      hasExactPostgresLockTimeoutEnvelope(
        "unrelated prose says the lock timeout was expected",
      ),
    ).toBe(false);
    expect(
      hasExactPostgresLockTimeoutEnvelope(
        "\u001b[31mERROR: canceling statement due to lock timeout\u001b[0m",
      ),
    ).toBe(true);
    expect(
      hasExactPostgresLockTimeoutEnvelope(
        "psql:/workspace/migration.sql:42: ERROR: canceling statement due to lock timeout",
      ),
    ).toBe(true);
  });

  it("accepts Prisma 7.8's empty-log aborted envelope only with exact DB and direct proof", () => {
    const migrationName = "000060_codex_oauth_setup_serialization";
    const exactEvidence = {
      total: 1,
      currentFailed: 1,
      zeroStep: 1,
      lockTimeoutLog: 0,
      abortedTransactionLog: 0,
      exactFailureLog: 0,
      emptyLog: 1,
    };
    const directLockTimeoutProof = { migrationName, observed: true };

    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "ERROR: current transaction is aborted",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(true);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "ERROR: current transaction is aborted".toLowerCase(),
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(true);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "\u001b[31mERROR: current transaction is aborted\u001b[0m",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(true);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output:
          "\u001b[31mERROR: current transaction is aborted, commands ignored until end of transaction block\u001b[0m",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(true);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output:
          "\u001b[31mError: ERROR: current transaction is aborted, commands ignored until end of transaction block\u001b[0m",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(true);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output:
          "Schema engine migration failure: ERROR: current transaction is aborted; migration rolled back",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "ERROR: permission denied",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "ERROR: current transaction is aborted",
        migrationName,
        historyEvidence: { ...exactEvidence, emptyLog: 0 },
        directLockTimeoutProof,
      }),
    ).toBe(false);
  });

  it.each([
    [
      "permission denial",
      "ERROR: permission denied for schema public\nERROR: current transaction is aborted",
    ],
    [
      "a different Prisma failure",
      "P1000\nERROR: current transaction is aborted",
    ],
    [
      "a missing relation",
      'ERROR: relation "private_table" does not exist\nERROR: current transaction is aborted',
    ],
    [
      "a different migration-name field",
      "Migration name: 000059_other_migration\nERROR: current transaction is aborted",
    ],
  ])("rejects empty-log fallback combined with %s", (_case, output) => {
    const migrationName = "000060_codex_oauth_setup_serialization";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: {
          total: 1,
          currentFailed: 1,
          zeroStep: 1,
          lockTimeoutLog: 0,
          abortedTransactionLog: 0,
          exactFailureLog: 0,
          emptyLog: 1,
        },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(false);
  });

  it("keeps the stronger P3018 and migration-name lock-timeout path", () => {
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `P3018\nMigration name: 000061_codex_oauth_provider_mutation_fence\nERROR: lock timeout`,
        migrationName: "000061_codex_oauth_provider_mutation_fence",
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: {
          migrationName: "000061_codex_oauth_provider_mutation_fence",
          observed: true,
        },
      }),
    ).toBe(true);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output:
          `P3018\nMigration name: 000061_codex_oauth_provider_mutation_fence\nERROR: lock timeout`.toLowerCase(),
        migrationName: "000061_codex_oauth_provider_mutation_fence",
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: {
          migrationName: "000061_codex_oauth_provider_mutation_fence",
          observed: true,
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["permission failure", "ERROR: permission denied for schema public"],
    ["authentication failure", "ERROR: password authentication failed"],
    ["authentication SQLSTATE", "ERROR: 28P01: redacted"],
    ["permission SQLSTATE", "ERROR: 42501: redacted"],
    ["missing schema", 'ERROR: schema "private_data" does not exist'],
    ["missing schema SQLSTATE", "ERROR: 3F000: redacted"],
    ["missing object", 'ERROR: relation "private_table" does not exist'],
    ["missing object SQLSTATE", "ERROR: 42P01: redacted"],
  ])(
    "rejects a P3018 lock-timeout envelope with a contradictory %s",
    (_case, contradiction) => {
      const migrationName = "000061_codex_oauth_provider_mutation_fence";
      expect(
        isExpectedPrismaLockTimeoutFailure({
          output: `P3018\nMigration name: ${migrationName}\nERROR: lock timeout\n${contradiction}`,
          migrationName,
          historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
          directLockTimeoutProof: { migrationName, observed: true },
        }),
      ).toBe(false);
    },
  );

  it("rejects mixed P1000 and P3018 codes with the correct migration field", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `P1000\nP3018\nMigration name: ${migrationName}\nERROR: lock timeout`,
        migrationName,
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(false);
  });

  it.each([
    ["prefix", "attacker_000061_codex_oauth_provider_mutation_fence"],
    ["suffix", "000061_codex_oauth_provider_mutation_fence_attacker"],
    ["substring", "codex_oauth_provider_mutation"],
  ])("rejects a %s migration-name field", (_case, presentedName) => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `P3018\nMigration name: ${presentedName}\nERROR: lock timeout`,
        migrationName,
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(false);
  });

  it("rejects multiple conflicting migration-name fields", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `P3018\nMigration name: ${migrationName}\nMigration name: ${migrationName}_attacker\nERROR: lock timeout`,
        migrationName,
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(false);
  });

  it("rejects a missing migration-name field", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "P3018\nERROR: lock timeout",
        migrationName,
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(false);
  });

  it("rejects duplicate exact migration-name fields", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `P3018\nMigration name: ${migrationName}\nMigration name: ${migrationName}\nERROR: lock timeout`,
        migrationName,
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(false);
  });

  it("accepts the exact real 000061 Prisma field with CRLF output", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `P3018\r\nMigration name: ${migrationName}\r\nERROR: current transaction is aborted\r\n`,
        migrationName,
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: { migrationName, observed: true },
      }),
    ).toBe(true);
  });

  it("fails a generic aborted-transaction wrapper closed without each required proof", () => {
    const migrationName = "000061_codex_oauth_provider_mutation_fence";
    const output = `Migration name: ${migrationName}\nERROR: current transaction is aborted`;
    const exactEvidence = { total: 1, currentFailed: 1, zeroStep: 1 };
    const directLockTimeoutProof = { migrationName, observed: true };

    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof: undefined,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof: { ...directLockTimeoutProof, observed: false },
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof: {
          migrationName: "000060_codex_oauth_setup_serialization",
          observed: true,
        },
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: { ...exactEvidence, currentFailed: 0 },
        directLockTimeoutProof,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: { ...exactEvidence, total: 2 },
        directLockTimeoutProof,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output,
        migrationName,
        historyEvidence: { ...exactEvidence, zeroStep: 0 },
        directLockTimeoutProof,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: `Migration name: ${migrationName}\nERROR: permission denied`,
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(false);
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "ERROR: current transaction is aborted",
        migrationName,
        historyEvidence: exactEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(false);
  });

  it("does not treat a bare 000061 lock-timeout string as a Prisma wrapper", () => {
    expect(
      isExpectedPrismaLockTimeoutFailure({
        output: "000061_codex_oauth_provider_mutation_fence: lock timeout",
        migrationName: "000061_codex_oauth_provider_mutation_fence",
        historyEvidence: { total: 1, currentFailed: 1, zeroStep: 1 },
        directLockTimeoutProof: {
          migrationName: "000061_codex_oauth_provider_mutation_fence",
          observed: true,
        },
      }),
    ).toBe(false);
  });

  it("restores source-owned evidence before installing a rehearsal migration permit", () => {
    const permitInstallation =
      /function installRehearsalMigrationPermit\([\s\S]+?\n\}/u.exec(
        source,
      )?.[0];
    expect(permitInstallation).toBeDefined();
    expect(permitInstallation).toContain("restoreRehearsalSourceOwnedReceipt(");
    expect(permitInstallation).toMatch(
      /restoreRehearsalSourceOwnedReceipt\([\s\S]+?reviewrouter_activation\.install_migration_permit\(/u,
    );
    expect(permitInstallation).toContain("finally {");
    expect(permitInstallation).toContain("discardSourceReceipt();");

    const sourceReceiptFixture =
      /function restoreRehearsalSourceOwnedReceipt\([\s\S]+?\n\}/u.exec(
        source,
      )?.[0];
    expect(sourceReceiptFixture).toBeDefined();
    expect(sourceReceiptFixture).toContain(
      "CREATE TABLE release_authority.source_legacy_ambiguity_receipt",
    );
    expect(sourceReceiptFixture).toContain(
      "OWNER TO reviewrouter_activation_receipt_guard",
    );
    expect(sourceReceiptFixture).toContain(
      "INSERT INTO release_authority.source_legacy_ambiguity_receipt",
    );
    expect(sourceReceiptFixture).toContain("quoteLiteral(evidence.rolloutId)");
    expect(sourceReceiptFixture).toContain("quoteLiteral(evidence.fenceId)");
    expect(sourceReceiptFixture).toContain(
      "quoteLiteral(evidence.sourceSystemIdentifier)",
    );
    expect(sourceReceiptFixture).toContain(
      "quoteLiteral(JSON.stringify(evidence))",
    );
    expect(sourceReceiptFixture).toContain(
      "DROP SCHEMA release_authority CASCADE",
    );
  });

  it("models the NOLOGIN schema owner separately from client credentials", () => {
    const client = (name: string) =>
      new URL(`postgresql://${name}@localhost/rehearsal`);
    const context = createRehearsalAuthorityContext({
      providerAdmin: client("provider-admin"),
      bootstrap: client("bootstrap"),
      permitInstaller: client("permit-installer"),
      releaseMigration: client("release-migration"),
      runtime: {
        api: client("api"),
        web: client("web"),
        worker: client("worker"),
        custody: client("custody"),
        effectAuthority: client("effect-authority"),
      },
    });

    expect(context.providerAdmin).not.toBe(context.releaseMigration);
    expect(context.schemaOwner).toEqual({
      roleName: "reviewrouter_release_schema_owner",
      login: false,
    });
    expect(rehearsalSchemaOwnerIdentity.login).toBe(false);
    expect(
      rehearsalRoleLoginContract.get("reviewrouter_release_schema_owner"),
    ).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.runtime)).toBe(true);
    expect(() =>
      createRehearsalAuthorityContext({
        providerAdmin: client("provider-admin"),
        bootstrap: client("bootstrap"),
        permitInstaller: client("permit-installer"),
        releaseMigration: client("release-migration"),
        runtime: {
          api: client("api"),
          web: client("web"),
          custody: client("custody"),
          effectAuthority: client("effect-authority"),
        },
      }),
    ).toThrow("rehearsal_authority_client_invalid:worker");
  });

  it("requires Prisma retention failures to identify the expected guard or constraint", () => {
    expect(prismaRetentionProofSource).not.toContain("catch {");
    expect(prismaRetentionProofSource).toContain(
      "attempt.expectedReasons.some",
    );
    expect(prismaRetentionProofSource).toContain(
      "message.includes(expectedReason)",
    );
    for (const expectedReason of [
      "codex_oauth_setup_attempt_delete_forbidden",
      "codex_oauth_setup_claim_delete_forbidden",
      "codex_oauth_setup_manifest_delete_forbidden",
      "codex_oauth_secret_namespace_delete_forbidden",
      "CodexOAuthSetupPayloadClaim_provider_fkey",
      "CodexOAuthSetupPayloadClaim_repository_fkey",
      "CodexOAuthSetupPayloadClaim_workspace_fkey",
      "CodexOAuthSecretNamespace_provider_fkey",
    ]) {
      expect(prismaRetentionProofSource).toContain(expectedReason);
    }
    expect(
      prismaRetentionProofSource.match(
        /codex_oauth_setup_manifest_delete_forbidden/gu,
      ),
    ).toHaveLength(3);
    expect(
      source.match(/codex_oauth_setup_manifest_delete_forbidden/gu),
    ).toHaveLength(4);
  });

  it("proves terminal legacy recovery evidence and the database-owned effect fingerprint exactly", () => {
    expect(source).toContain(
      "targetMigrationReceipt.effectFingerprint === expectedEffectFingerprint",
    );
    expect(source).toContain(
      "targetMigrationReceipt.sourceLegacyAmbiguity.inventorySha256",
    );
    expect(source).toContain(
      "codex_oauth_setup_manifest_terminal_evidence_immutable",
    );
    expect(source).toContain(
      `status FROM "CodexOAuthSetupManifest" WHERE id='fetched-recovery') <> 'recovered'`,
    );
    expect(source).toContain(
      `status FROM "CodexOAuthLease" WHERE id='lease-recovery') <> 'expired'`,
    );
  });

  it("requires runtime Prisma negative proofs to identify the receipt guard", () => {
    expect(runtimeProofSource).not.toContain("catch {");
    expect(
      runtimeProofSource.match(
        /codex_oauth_database_authority_receipt_required/gu,
      ),
    ).toHaveLength(2);
  });

  it("cannot false-green when a zero-exit wrapper discards stdin", () => {
    const calls: string[][] = [];
    let provisioned = false;
    const zeroExitStdinDiscardWrapper = (_url: URL, args: string[]) => {
      calls.push(args);
      if (args[0] === "-c" && args[1]?.includes("CREATE ROLE")) {
        provisioned = true;
        return { status: 0, stderr: "", stdout: "" };
      }
      if (args[0] === "-Atc") {
        const roles = provisioned
          ? [...rehearsalRoleLoginContract].map(([username, login]) => ({
              username,
              markerExact: true,
              login,
              superuser: false,
              createDatabase: false,
              createRole: false,
              replication: false,
              bypassRls: false,
            }))
          : [];
        return { status: 0, stderr: "", stdout: JSON.stringify(roles) };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    provisionAndAssertRehearsalRoles({
      marker: "exact-marker",
      provisioningSql: "CREATE ROLE rehearsal_fixture",
      psql: zeroExitStdinDiscardWrapper,
      url: new URL("postgresql://localhost/rehearsal"),
    });

    expect(calls[0]).toEqual(["-c", "CREATE ROLE rehearsal_fixture"]);
    expect(calls[1]?.[0]).toBe("-Atc");
    expect(calls[1]?.[1]).toContain("shobj_description");
    expect(calls[1]?.[1]).toContain("'exact-marker'");
  });

  it("rejects a zero-exit observation that omitted every role", () => {
    expect(() => assertRehearsalRoleObservation("[]")).toThrow(
      "rehearsal_role_provisioning_postcondition_failed",
    );
  });

  it("expects each runtime role to fail fabrication at its exact ACL boundary", () => {
    const attack =
      /function proveSequentialFabricationDeniedForEveryRuntimeRole\(clients\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(attack).toBeDefined();
    for (const role of [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
    ]) {
      expect(attack).toContain(role);
    }
    for (const table of [
      "CodexOAuthProviderInstance",
      "CodexOAuthSetupManifest",
      "CodexOAuthSetupPayloadClaim",
      "CodexOAuthSecretNamespace",
      "CodexOAuthSetupDispatchAttempt",
      "CodexOAuthLease",
      "CodexOAuthWritebackIntent",
    ]) {
      expect(attack).toContain(table);
    }
    expect(attack).toContain(
      "codex_oauth_database_authority_signature_invalid",
    );
    expect(attack).toContain("codex_oauth_database_authority_challenge");
    expect(attack).toContain("codex_oauth_sign_database_authority");
    expect(attack).toContain("CodexOAuthProviderIdentityQuarantine");
    expect(source).toContain("proveStaleAclProviderIdentityEscalationDenied");
    expect(source).toContain(
      "proveMaintenanceCheckpointColumnAclConvergence(providerAdmin)",
    );
    expect(source).toContain('REFERENCES ("checkpointKey")');
    expect(source).toContain(
      "codex_oauth_provider_identity_authority_required",
    );
    expect(source).toContain("fabricated_stale_acl");
    const oneShotIdentityMutationProof =
      /async function proveProviderRepairAuthorityV2\(adminUrl, clients\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(oneShotIdentityMutationProof).toBeDefined();
    expect(oneShotIdentityMutationProof).toContain(
      "provider repair savepoint rollback did not restore all state",
    );
    expect(oneShotIdentityMutationProof).toContain(
      "signed provider repair authorized a different target",
    );
    expect(oneShotIdentityMutationProof).toContain(
      "codex_oauth_database_authority_signature_invalid",
    );
    const cleanupProof =
      /async function proveQuarantineCleanupPathV2\(adminUrl, clients\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(cleanupProof).toBeDefined();
    expect(cleanupProof).toContain(
      "await executeProviderIdentityRepairWithAuthority",
    );
    expect(source).toContain("psql(clients.effectAuthority");
    expect(source).toContain("databaseUrl: clients.web");
    expect(oneShotIdentityMutationProof).toContain(
      "provider repair replay succeeded",
    );
    expect(oneShotIdentityMutationProof).toContain(
      "provider repair did not atomically consume and resolve",
    );
    expect(oneShotIdentityMutationProof).toContain(
      "ROLLBACK TO SAVEPOINT rollback_proof",
    );
    expect(oneShotIdentityMutationProof).toContain(
      "provider_identity_repair_v2",
    );
    expect(oneShotIdentityMutationProof).toContain(
      "codex_oauth_provider_quarantine_recovery_required",
    );
    expect(oneShotIdentityMutationProof).toContain("clients.web");
    expect(oneShotIdentityMutationProof).toContain("clients.effectAuthority");
    const cascadeProof =
      /function proveRuntimeParentCascadesDenied\(adminUrl, clients\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(cascadeProof).toBeDefined();
    for (const role of [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
      "reviewrouter_codex_effect_authority",
    ]) {
      expect(cascadeProof).toContain(role);
    }
    expect(cascadeProof).toContain("workspace delete");
    expect(cascadeProof).toContain("normal-delete-${role}");
    expect(cascadeProof).toContain("workspace key update");
    expect(cascadeProof).toContain("installation delete");
    expect(cascadeProof).toContain("installation key update");
    expect(cascadeProof).toContain("gitlab installation delete");
    expect(cascadeProof).toContain("gitlab installation key update");
    expect(cascadeProof).toContain("SCM identity delete");
    expect(cascadeProof).toContain("SCM identity key update");
    expect(cascadeProof).toContain("provider parent delete");
    expect(cascadeProof).toContain("provider parent key update");
    expect(attack).toContain("repeat('0',64)");
    expect(attack).toContain("direct production-faithful login");
    expect(attack).not.toContain("SET SESSION AUTHORIZATION");
    expect(attack).not.toContain("SET LOCAL ROLE");
    expect(attack).toContain("definiteResponseCode");
    expect(attack).toContain("providerResponseCode");
    expect(attack).toContain("\"status\"='active'");
    expect(attack).toContain("\"status\"='completed'");
    expect(attack).toContain('"mutationOwner"=NULL');
    const expectationMatrixSource =
      /for \(const \[ordinal, role, expectedSetupFailure, expectedRuntimeFailure\] of (\[[\s\S]+?\n {2}\])\) \{/u.exec(
        attack,
      )?.[1];
    expect(expectationMatrixSource).toBeDefined();
    expect(runInNewContext(expectationMatrixSource!)).toEqual([
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
    ]);
    expect(attack).toContain("assertPsqlFailedWithExactMessage(");
    expect(attack).toContain("expectedSetupFailure");
    expect(attack).toContain("expectedRuntimeFailure");
    expect(attack).toContain("psqlResultDiagnostic(signer)");
    expect(source).toContain("psqlResultDiagnostic(result)");
    expect(source).toContain(
      "Codex OAuth provider identity guard execution contract mismatch",
    );
    expect(source).toContain(
      "Codex OAuth child identity fence guard execution contract mismatch",
    );
    expect(source).toContain("Codex OAuth runtime least privilege mismatch");
    expect(source).toMatch(
      /relation\.relname NOT IN \([\s\S]+?RuntimeCanaryChallenge[\s\S]+?RuntimeCanaryChallengeProof[\s\S]+?RuntimeGenerationWitnessProof/u,
    );
    expect(source).toMatch(
      /relation\.relname IN \([\s\S]+?CodexOAuthDatabaseAuthorityReceipt[\s\S]+?RuntimeCanaryChallenge[\s\S]+?RuntimeCanaryChallengeProof[\s\S]+?RuntimeGenerationWitnessProof[\s\S]+?has_table_privilege/u,
    );
    expect(source).toContain(
      "Codex OAuth release migration privilege mismatch",
    );
    expect(source).toContain("AND rolcanlogin");
    expect(source).not.toContain("synthetic NOLOGIN role");
    expect(source).toContain("Codex OAuth role membership authority mismatch");
    expect(source).toContain("Codex OAuth effect authority isolation mismatch");
    expect(source).toContain("p.prosecdef");
    expect(source).toContain("search_path=pg_catalog, public");
    expect(source).toContain(
      "has_table_privilege(role_name, 'public.\"RepositoryConnection\"', 'UPDATE')",
    );
    expect(source).not.toContain("grantSyntheticReleaseGuardPrivileges");
    expect(source).toContain("executeCanonicalReleaseMigration(");
    expect(source).toContain("loopbackRehearsalDatabaseIdentity");
    expect(source).toContain("const url = requireLocalPostgres(String(value))");
    expect(source).toContain(
      "pg_has_role(role_name, 'reviewrouter_release_migration', 'SET')",
    );
    expect(attack).toContain(
      "could invoke the elevated identity guard directly",
    );
    expect(attack).toContain(
      "permission denied for function codex_oauth_authorize_setup_confirmation",
    );
    expect(attack).toContain(
      "permission denied for function codex_oauth_authorize_runtime_confirmation",
    );
  });

  it("rejects unrelated permission-denied failures", () => {
    const exactFailures = [
      "codex_oauth_database_authority_signature_invalid",
      "permission denied for function codex_oauth_authorize_setup_confirmation",
      "permission denied for function codex_oauth_authorize_runtime_confirmation",
    ];
    for (const expectedFailure of exactFailures) {
      expect(() =>
        assertPsqlFailedWithExactMessage(
          { status: 1, stdout: "", stderr: `ERROR: ${expectedFailure}` },
          expectedFailure,
          "expected failure",
        ),
      ).not.toThrow();
      for (const stderr of [
        "ERROR: permission denied for table CodexOAuthProviderInstance",
        "ERROR: permission denied for function codex_oauth_provider_identity_guard",
      ]) {
        expect(() =>
          assertPsqlFailedWithExactMessage(
            { status: 1, stdout: "", stderr },
            expectedFailure,
            "unrelated failure",
          ),
        ).toThrow(/unrelated failure/u);
      }
    }
  });

  it("routes production Prisma terminal writers through database authority", () => {
    expect(setupAdapterSource).toContain(
      'SELECT "codex_oauth_authorize_setup_confirmation"',
    );
    expect(runtimeAdapterSource).toContain(
      'SELECT "codex_oauth_authorize_runtime_confirmation"',
    );
    expect(
      runtimeAdapterSource.match(
        /SELECT "codex_oauth_authorize_runtime_completion"/gu,
      ),
    ).toHaveLength(2);
  });

  it("executes the void re-attestation routine without Prisma row decoding", () => {
    const reattestation =
      /async replaceActiveWorkflowSource\([\s\S]+?\n {2}\}\n\n {2}async retireProviderGeneration/u.exec(
        setupAdapterSource,
      )?.[0];
    expect(reattestation).toBeDefined();
    expect(reattestation).toContain("await tx.$executeRaw`");
    expect(reattestation).not.toContain("await tx.$queryRaw`");
    expect(reattestation).toContain(
      'SELECT "codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(runtimeProofSource).toContain("reattestCodexRotatingWorkflow(");
  });

  it("binds acknowledged W2 recovery issuance to the explicit proof witness", () => {
    const recoveryFlow =
      /const recoveryRequestId = "recovery:runtime-proof-ambiguous";([\s\S]+?)\n {2}ledger = rotatedRuntime;/u.exec(
        runtimeProofSource,
      )?.[1];

    expect(recoveryFlow).toBeDefined();
    expect(recoveryFlow).toContain(
      "acknowledgement: codexRotatingSetupRecoveryAcknowledgement",
    );
    expect(recoveryFlow).toMatch(
      /new PrismaCodexRotatingSetupRecovery\(\s*webPrisma,\s*databaseRecoveryWitnessW2,\s*\)/u,
    );
    expect(recoveryFlow).toMatch(
      /issueCodexRotatingSetupCommand\(\{[\s\S]+?databaseRecoveryWitness: databaseRecoveryWitnessW2,/u,
    );
    expect(recoveryFlow).not.toContain(
      "process.env.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    );
  });

  it("rejects W2 at the healthy W1 witness boundary without ambient flag mutation", () => {
    const witnessBoundary =
      /const rotatedRuntime = new PrismaCodexRotatingOAuthRepository([\s\S]+?)\n {2}const definite = await run/u.exec(
        runtimeProofSource,
      )?.[1];

    expect(witnessBoundary).toBeDefined();
    expect(witnessBoundary).toContain(
      'providerBeforeRejectedPrelease.state !== "active"',
    );
    expect(witnessBoundary).toContain("verifiedWorkflowAttestation,");
    expect(witnessBoundary).toContain(
      '"codex_rotating_database_recovery_witness_mismatch"',
    );
    expect(witnessBoundary).toContain(
      "leaseCountAfterRejectedPrelease !== leaseCountBeforeRejectedPrelease",
    );
    expect(runtimeProofSource).toContain(
      "runtimeEnvironment: localProofRuntimeEnvironment",
    );
    expect(runtimeProofSource).not.toMatch(
      /process\.env\.REVIEW_ROUTER_(?:CODEX_ROTATING_SETUP_ISSUANCE_ENABLED|ENABLE_CODEX_ROTATING_OAUTH|CODEX_ROTATING_OAUTH_REPOSITORIES)\s*=/u,
    );
  });

  it("passes and advances the exact verified workflow attestation through the real runtime proof", () => {
    const runHelper = /const run = async \([\s\S]+?\n {2}\};/u.exec(
      runtimeProofSource,
    )?.[0];
    expect(runHelper).toBeDefined();
    expect(runHelper).toContain("verifiedWorkflowAttestation,");
    expect(runtimeProofSource).toContain(
      'verifiedWorkflowAttestation = attestationFor(definite.namespace, "2")',
    );
    expect(runtimeProofSource).toContain(
      'verifiedWorkflowAttestation = attestationFor(recoveredNamespace, "4", 4)',
    );
    expect(runtimeProofSource).toContain(
      "verifiedWorkflowAttestation = reattestedWorkflow",
    );
    expect(runtimeProofSource).toContain(
      'verifiedWorkflowAttestation = attestationFor(rollbackClaim.namespace, "6")',
    );
  });

  it("reuses exact production-path namespace evidence for ledger retention proofs", () => {
    const ledgerProof =
      /function proveVersionedNamespaceLedger\(url\) \{([\s\S]+?)\n\}\n\nfunction assertVersionedNamespaceEvidenceRetained/u.exec(
        source,
      )?.[1];

    expect(ledgerProof).toBeDefined();
    expect(ledgerProof).toContain("operation:runtime-proof-initial");
    expect(ledgerProof).toContain("operation:runtime-proof-recovery");
    expect(ledgerProof).toContain("proof:definite");
    expect(ledgerProof).toContain("proof:ambiguous");
    expect(ledgerProof).toContain("proof:rollback");
    expect(ledgerProof).toContain("proof:confirmed-restart");
    expect(ledgerProof).toContain("initialSetupTombstone");
    expect(ledgerProof).toContain("activeRecoverySetupNamespace");
    expect(ledgerProof).toContain("definiteIntentOnRetiredInitialNamespace");
    expect(ledgerProof).toContain(
      "recoveredAmbiguousIntentOnRetiredInitialNamespace",
    );
    expect(ledgerProof).toContain("completedIntentOnActiveRecoveryNamespace");
    expect(ledgerProof).toContain(
      "confirmedRestartUnknownIntentOnActiveRecoveryNamespace",
    );
    expect(ledgerProof).toContain(
      'evidence.activeRecoverySetupNamespace?.claimStatus === "active"',
    );
    expect(ledgerProof).toContain(
      'evidence.activeRecoverySetupNamespace.attemptStatus === "confirmed"',
    );
    expect(ledgerProof).toContain(
      'evidence.activeRecoverySetupNamespace.namespaceStatus === "active"',
    );
    expect(ledgerProof).toContain(
      "evidence.activeRecoverySetupNamespace.permanentlyRetired === false",
    );
    expect(ledgerProof).toMatch(
      /evidence\.activeRecoverySetupNamespace\.namespaceId ===\s+evidence\.completedIntentOnActiveRecoveryNamespace\?\.namespaceId/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.activeRecoverySetupNamespace\.namespaceId ===\s+evidence\.confirmedRestartUnknownIntentOnActiveRecoveryNamespace\s+\?\.namespaceId/u,
    );
    expect(ledgerProof).toContain(
      'evidence.definiteIntentOnRetiredInitialNamespace?.intentStatus ===\n      "completed"',
    );
    expect(ledgerProof).toContain(
      'evidence.definiteIntentOnRetiredInitialNamespace.namespaceStatus ===\n        "retired_superseded"',
    );
    expect(ledgerProof).toContain(
      "evidence.definiteIntentOnRetiredInitialNamespace.namespaceId ===\n        evidence.initialSetupTombstone.namespaceId",
    );
    expect(ledgerProof).toContain(
      'evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace\n      ?.namespaceStatus === "retired_superseded"',
    );
    expect(ledgerProof).toContain(
      "evidence.recoveredAmbiguousIntentOnRetiredInitialNamespace.namespaceId ===\n        evidence.initialSetupTombstone.namespaceId",
    );
    expect(ledgerProof).toMatch(
      /evidence\.confirmedRestartUnknownIntentOnActiveRecoveryNamespace\s+\?\.intentStatus ===\s+"remote_outcome_unknown"/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.confirmedRestartUnknownIntentOnActiveRecoveryNamespace\s+\.namespaceStatus === "active"/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.confirmedRestartUnknownIntentOnActiveRecoveryNamespace\s+\.permanentlyRetired === false/u,
    );
    const confirmedRestartEvidence =
      /'confirmedRestartUnknownIntentOnActiveRecoveryNamespace', \(([\s\S]+?)\n {8}\),\n {8}'provider'/u.exec(
        ledgerProof ?? "",
      )?.[1];
    expect(confirmedRestartEvidence).toBeDefined();
    expect(confirmedRestartEvidence).not.toContain("recoveryRequestRowId");
    expect(ledgerProof).toContain(
      "quoteLiteral(activeRecoverySetupNamespace.claimId)",
    );
    expect(ledgerProof).toContain(
      "quoteLiteral(activeRecoverySetupNamespace.attemptId)",
    );
    expect(ledgerProof).toContain(
      'evidence.completedIntentOnActiveRecoveryNamespace?.intentStatus ===\n      "completed"',
    );
    expect(ledgerProof).toContain(
      'evidence.completedIntentOnActiveRecoveryNamespace.namespaceStatus ===\n        "active"',
    );
    expect(ledgerProof).toContain(
      "evidence.completedIntentOnActiveRecoveryNamespace.namespaceId",
    );
    expect(ledgerProof).not.toContain(
      "completedIntentOnActiveRecoveryNamespace.claimId",
    );
    expect(ledgerProof).not.toContain(
      "completedIntentOnActiveRecoveryNamespace.attemptId",
    );
    expect(source).toContain(
      '"confirmedAttemptId"=${quoteLiteral(evidence.activeRecoverySetupNamespace.attemptId)}',
    );
    expect(source).toContain("intent.\"idempotencyKey\"='proof:rollback'");
    expect(source).toContain(
      '"activeAccountIdentityHash"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.accountIdentityHash)}',
    );
    expect(source).toContain(
      '"latestGenerationHash"=${quoteLiteral(evidence.completedIntentOnActiveRecoveryNamespace.latestGenerationHash)}',
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\?\.activeSecretNamespaceId ===\s+evidence\.completedIntentOnActiveRecoveryNamespace\.namespaceId/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\.activeSecretNamespaceEpoch ===\s+evidence\.completedIntentOnActiveRecoveryNamespace\.namespaceEpoch/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\.activeSecretNamespaceName ===\s+evidence\.completedIntentOnActiveRecoveryNamespace\.secretName/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\.latestGenerationHash ===\s+evidence\.completedIntentOnActiveRecoveryNamespace\.latestGenerationHash/u,
    );
    expect(source).toContain(
      '"status"=\'active\' AND NOT "permanentlyRetired"',
    );
    expect(ledgerProof).toContain(
      "BigInt(evidence.initialSetupTombstone.namespaceEpoch) ===",
    );
    expect(ledgerProof).toContain(
      "BigInt(evidence.activeRecoverySetupNamespace.namespaceEpoch) ===",
    );
    expect(ledgerProof).toContain("CodexOAuthSecretNamespace_secretName_key");
    expect(ledgerProof).not.toContain("claim-proof");
    expect(ledgerProof).not.toContain("p-fetched");
    expect(source).toContain('retained === "1:1:1:1:1:1:1:1:1:1"');
    expect(source).toContain(
      'assertVersionedNamespaceEvidenceRetained(url, evidence, "Prisma")',
    );
    expect(prismaRetentionProofSource).toContain(
      "REVIEW_ROUTER_PRISMA_EVIDENCE_IDENTITIES",
    );
    expect(prismaRetentionProofSource).not.toContain("claim-proof");
    expect(prismaRetentionProofSource).not.toContain("p-fetched");
  });

  it("runs the positive proof with isolated identities, database time, and replay evidence", () => {
    const runtimeWritebackProof =
      /function proveRuntimeVersionedWriteback\(providerAdminUrl, clients\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(runtimeWritebackProof).toBeDefined();
    for (const environmentName of [
      "REVIEW_ROUTER_PRISMA_EVIDENCE_PROVIDER_ADMIN_DATABASE_URL",
      "REVIEW_ROUTER_PRISMA_EVIDENCE_API_DATABASE_URL",
      "REVIEW_ROUTER_PRISMA_EVIDENCE_WEB_DATABASE_URL",
      "REVIEW_ROUTER_PRISMA_EVIDENCE_EFFECT_AUTHORITY_DATABASE_URL",
    ]) {
      expect(source).toContain(environmentName);
      expect(runtimeProofSource).toContain(environmentName);
    }
    expect(runtimeProofSource).not.toContain(
      'new Date("2026-08-10T12:00:00.000Z")',
    );
    expect(runtimeProofSource.match(/poolMax: 1/gu)).toHaveLength(4);
    expect(runtimeProofSource).toContain("observeDatabaseSession");
    expect(runtimeProofSource).toContain("pg_backend_pid()");
    expect(runtimeProofSource).toContain("assertConsumedReceipt");
    expect(runtimeProofSource).toContain("runtime_authority_rollback_sentinel");
    expect(runtimeProofSource).toContain("expectSignatureReplayRejected");
    expect(runtimeProofSource).toContain(
      "runtime receipt double consume succeeded",
    );
    expect(source).toMatch(
      /already connected\.\*deprecated\|deprecated\.\*already connected/iu,
    );
    expect(runtimeWritebackProof).toContain(
      "providerAdmin: createDatabaseCredentialBoundary(providerAdminUrl)",
    );
    expect(runtimeWritebackProof).toContain(
      "REVIEW_ROUTER_PRISMA_EVIDENCE_PROVIDER_ADMIN_DATABASE_URL_FILE:",
    );
    expect(runtimeWritebackProof).toContain(
      "credentials.providerAdmin.environment",
    );
    expect(runtimeWritebackProof).not.toContain("clients.release.toString()");
    expect(source).not.toContain("clients.admin");
  });

  it("compares real namespace lifecycle evidence across authority rollback", () => {
    const rollbackProof =
      /const rollbackBefore =([\s\S]+?)throw new Error\("runtime authorization rollback left poison state"\);/u.exec(
        runtimeProofSource,
      )?.[1];
    const dateEquality =
      /function nullableDatesExactlyEqual\([\s\S]+?\n\}/u.exec(
        runtimeProofSource,
      )?.[0];

    expect(rollbackProof).toBeDefined();
    expect(dateEquality).toBeDefined();
    expect(dateEquality).toContain("left === null || right === null");
    expect(dateEquality).toContain("left.getTime() === right.getTime()");
    expect(rollbackProof?.match(/id: true/gu)).toHaveLength(2);
    for (const field of ["status", "confirmedAt", "activatedAt", "retiredAt"]) {
      expect(
        rollbackProof?.match(new RegExp(`${field}: true`, "gu")),
      ).toHaveLength(2);
    }
    expect(rollbackProof).toContain("rollbackBefore.secretNamespace === null");
    expect(rollbackProof).toContain("rollbackAfter.secretNamespace === null");
    expect(rollbackProof).toContain(
      "rollbackAfter.secretNamespace.id !== rollbackBefore.secretNamespace.id",
    );
    for (const field of ["confirmedAt", "activatedAt", "retiredAt"]) {
      expect(rollbackProof).toContain(
        `rollbackAfter.secretNamespace.${field},\n      rollbackBefore.secretNamespace.${field},`,
      );
    }
    expect(rollbackProof).not.toContain("secretNamespace?.updatedAt");
    expect(rollbackProof).not.toMatch(
      /secretNamespace:\s*\{\s*select:\s*\{[^}]*updatedAt/u,
    );
  });

  it("rehearses retiredAt set, change, and clear as immutable direct updates", () => {
    expect(source).toContain(
      "direct ${runtimeRole} namespace retiredAt set bypassed the tombstone guard",
    );
    expect(source).toContain(
      "direct ${runtimeRole} namespace retiredAt ${label} bypassed the tombstone guard",
    );
    expect(source).toContain("api: clients.api");
    expect(source).toContain("web: clients.web");
    expect(source).toContain("worker: clients.worker");
    expect(source).toContain(
      '["change", `"retiredAt" + interval \'1 second\'`]',
    );
    expect(source).toContain('["clear", "NULL"]');
  });

  it("reads ignored authority receipts with typed parameterized raw SQL", () => {
    const receiptAssertion =
      /async function assertConsumedReceipt\([\s\S]+?\n\}/u.exec(
        runtimeProofSource,
      )?.[0];

    expect(receiptAssertion).toBeDefined();
    expect(receiptAssertion).toContain("admin.$queryRaw<");
    expect(receiptAssertion).toContain(
      'FROM public."CodexOAuthDatabaseAuthorityReceipt"',
    );
    expect(receiptAssertion).toContain("${input.ownerId}");
    expect(receiptAssertion).toContain("${input.effect}");
    expect(receiptAssertion).toContain("${input.effectCode}");
    expect(receiptAssertion).toContain("receipts.length !== 1");
    expect(receiptAssertion).toContain(
      "receipts[0]?.databaseRole !== input.databaseRole",
    );
    expect(receiptAssertion).toContain("!receipts[0].consumedAt");
    expect(receiptAssertion).not.toContain("$queryRawUnsafe");
    expect(runtimeProofSource).not.toContain(
      "codexOAuthDatabaseAuthorityReceipt",
    );
  });
});
