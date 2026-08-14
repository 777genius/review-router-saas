import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  assertRehearsalRoleObservation,
  provisionAndAssertRehearsalRoles,
  rehearsalRoleLoginContract,
} from "./codex-rotating-rehearsal-role-provisioning.mjs";

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
  const prismaRetentionProofSource = readFileSync(
    resolve(import.meta.dirname, "prove-codex-rotating-evidence-prisma.ts"),
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

  it("rehearses every canonical migration from 000060 through 000071 in order", () => {
    const inventory =
      /JSON\.stringify\(\[([\s\S]+?)\]\),\n\s+"rehearsal migration inventory/u.exec(
        source,
      )?.[1];

    expect(inventory).toBeDefined();
    expect(
      [...(inventory ?? "").matchAll(/migration\d+Name/gu)].map(
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
    expect(source).not.toContain("000067_release_rollout_ledger");
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
    expect(matrix).toContain("`${testCase.name} injected failure missing`");
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
      "production catalog verifier rejected the PostgreSQL 17 rehearsal",
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

  it("checks synthetic release sequence privileges by qualified name", () => {
    const privilegeProof =
      /function proveDatabasePrivileges\(url\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(privilegeProof).toBeDefined();
    expect(privilegeProof).toContain(
      "format('%I.%I', namespace.nspname, sequence.relname)",
    );
    expect(privilegeProof).not.toContain("sequence.oid");
  });

  it("rehearses fail-closed grantor topology and an idempotent second bootstrap", () => {
    const provisioning =
      /function prepareCanonicalReleaseRoles\(url\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(provisioning).toBeDefined();
    expect(provisioning).toContain("runSecretSafePostgresCommand({");
    expect(provisioning).toContain(
      'expectFailureContaining:\n        "refusing non-canonical role membership topology"',
    );
    expect(provisioning).toContain("expectedFailure?.expectedFailure === true");
    expect(provisioning).not.toContain("rejectedForeignGrantor");
    expect(provisioning).not.toContain("String(error)");
    expect(provisioning).not.toContain(".stderr");
    expect(source).toContain("refusing non-canonical role membership topology");
    expect(source).toContain("idempotent_second_role_provisioning");
    expect(source).toContain(
      "second role bootstrap changed the canonical membership topology",
    );
    expect(source).toContain(
      "adversarial grantor retained role membership revoke authority",
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

  it("proves runtime roles retain database access before cascade denial checks", () => {
    expect(source).toContain('REVIEW_ROUTER_RELEASE_ACL_GATE_MODE: "open"');
    expect(source).toContain('releaseMigrationResult.aclGateState === "open"');
    expect(source).toContain(
      "must retain CONNECT before runtime cascade proofs",
    );
    expect(source).toContain(
      "has_database_privilege(${quoteLiteral(role)}, current_database(), 'CONNECT')",
    );
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
      "owner.rolname = 'reviewrouter_release_migration'",
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

  it("rehearses the canonical helper with separate direct bootstrap and release logins", () => {
    const orchestration = source.slice(
      source.indexOf("try {"),
      source.indexOf("function proveLateMigrationRollbackAndReplayMatrix"),
    );
    const prepareIndex = orchestration.indexOf(
      "prepareCanonicalReleaseRoles(rehearsalUrl)",
    );
    const helperIndex = orchestration.indexOf(
      "executeCanonicalReleaseMigration(",
    );
    const rehearsalHistoryResetIndex = orchestration.indexOf(
      "discardRehearsalOnlyRolledBackMigrationHistory(rehearsalUrl)",
    );
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(helperIndex);
    expect(rehearsalHistoryResetIndex).toBeGreaterThan(prepareIndex);
    expect(rehearsalHistoryResetIndex).toBeLessThan(helperIndex);
    expect(source).not.toContain("psqlInput");

    const provisioning =
      /function prepareCanonicalReleaseRoles\(url\) \{([\s\S]+?)\n\}/u.exec(
        source,
      )?.[1];
    expect(provisioning).toBeDefined();
    expect(provisioning).toContain("reviewrouter_role_bootstrap");
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_activation_receipt_guard NOLOGIN",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_release_migration LOGIN",
    );
    expect(
      provisioning.indexOf("CREATE ROLE reviewrouter_release_migration LOGIN"),
    ).toBeLessThan(
      provisioning.indexOf('"external_activation_authority_provisioning"'),
    );
    expect(provisioning).toContain(
      "GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_activation_permit_installer LOGIN",
    );
    expect(provisioning).toContain(
      "CREATE ROLE reviewrouter_activation_receipt_reader LOGIN",
    );
    expect(provisioning).toContain('CREATE TABLE public."_prisma_migrations"');
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
    expect(provisioning).toContain(
      "markCanonicalRehearsalRoles(bootstrap.toString())",
    );
    expect(source).toContain(
      'searchParams.set("application_name", applicationName)',
    );
    expect(source).not.toContain("PGAPPNAME");
    expect(source).toContain(
      "rehearsal-only rolled-back history contract mismatch",
    );
    expect(source).not.toContain(
      "convergeSyntheticReleaseOwnerEquivalentPrivileges",
    );
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
    const helperSource =
      /function assertPsqlFailedWithExactMessage\(result, expectedFailure, message\) \{[\s\S]+?\n\}/u.exec(
        source,
      )?.[0];
    expect(helperSource).toBeDefined();

    const observedConditions: boolean[] = [];
    const assertPsqlFailedWithExactMessage = runInNewContext(
      `${helperSource}; assertPsqlFailedWithExactMessage`,
      {
        assert(condition: boolean) {
          observedConditions.push(condition);
        },
        psqlResultDiagnostic() {
          return "diagnostic";
        },
      },
    ) as (
      result: { status: number; stdout: string; stderr: string },
      expectedFailure: string,
      message: string,
    ) => void;

    const exactFailures = [
      "codex_oauth_database_authority_signature_invalid",
      "permission denied for function codex_oauth_authorize_setup_confirmation",
      "permission denied for function codex_oauth_authorize_runtime_confirmation",
    ];
    for (const expectedFailure of exactFailures) {
      assertPsqlFailedWithExactMessage(
        { status: 1, stdout: "", stderr: `ERROR: ${expectedFailure}` },
        expectedFailure,
        "expected failure",
      );
      assertPsqlFailedWithExactMessage(
        {
          status: 1,
          stdout: "",
          stderr:
            "ERROR: permission denied for table CodexOAuthProviderInstance",
        },
        expectedFailure,
        "unrelated table failure",
      );
      assertPsqlFailedWithExactMessage(
        {
          status: 1,
          stdout: "",
          stderr:
            "ERROR: permission denied for function codex_oauth_provider_identity_guard",
        },
        expectedFailure,
        "unrelated function failure",
      );
    }

    expect(observedConditions).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
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
    expect(ledgerProof).toContain("recoverySetupTombstone");
    expect(ledgerProof).toContain("definiteRuntimeTombstone");
    expect(ledgerProof).toContain("ambiguousRuntimeTombstone");
    expect(ledgerProof).toContain("activeRuntimeNamespace");
    expect(ledgerProof).toContain("confirmedRestartRuntimeTombstone");
    expect(ledgerProof).toContain(
      'evidence.recoverySetupTombstone?.claimStatus === "active"',
    );
    expect(ledgerProof).toContain(
      'evidence.recoverySetupTombstone.attemptStatus === "confirmed"',
    );
    expect(ledgerProof).toContain(
      'evidence.recoverySetupTombstone.namespaceStatus ===\n        "retired_superseded"',
    );
    expect(ledgerProof).toContain(
      "evidence.recoverySetupTombstone.permanentlyRetired === true",
    );
    expect(ledgerProof).toContain(
      'evidence.definiteRuntimeTombstone?.intentStatus === "completed"',
    );
    expect(ledgerProof).toContain(
      'evidence.definiteRuntimeTombstone.namespaceStatus ===\n        "retired_superseded"',
    );
    expect(ledgerProof).toContain(
      "evidence.definiteRuntimeTombstone.permanentlyRetired === true",
    );
    expect(ledgerProof).toContain(
      'evidence.confirmedRestartRuntimeTombstone?.intentStatus ===\n      "remote_outcome_unknown"',
    );
    expect(ledgerProof).toContain(
      'evidence.confirmedRestartRuntimeTombstone.namespaceStatus ===\n        "retired_ambiguous"',
    );
    expect(ledgerProof).toContain(
      "evidence.confirmedRestartRuntimeTombstone.permanentlyRetired === true",
    );
    const confirmedRestartEvidence =
      /'confirmedRestartRuntimeTombstone', \(([\s\S]+?)\n {8}\),\n {8}'provider'/u.exec(
        ledgerProof ?? "",
      )?.[1];
    expect(confirmedRestartEvidence).toBeDefined();
    expect(confirmedRestartEvidence).not.toContain("recoveryRequestRowId");
    expect(ledgerProof).toContain(
      "quoteLiteral(recoverySetupTombstone.claimId)",
    );
    expect(ledgerProof).toContain(
      "quoteLiteral(recoverySetupTombstone.attemptId)",
    );
    expect(ledgerProof).toContain(
      'evidence.activeRuntimeNamespace?.intentStatus === "completed"',
    );
    expect(ledgerProof).toContain(
      'evidence.activeRuntimeNamespace.namespaceStatus === "active"',
    );
    expect(ledgerProof).toContain(
      "evidence.activeRuntimeNamespace.namespaceId",
    );
    expect(ledgerProof).not.toContain("activeRuntimeNamespace.claimId");
    expect(ledgerProof).not.toContain("activeRuntimeNamespace.attemptId");
    expect(source).toContain(
      '"confirmedAttemptId"=${quoteLiteral(evidence.recoverySetupTombstone.attemptId)}',
    );
    expect(source).toContain("intent.\"idempotencyKey\"='proof:rollback'");
    expect(source).toContain(
      '"activeAccountIdentityHash"=${quoteLiteral(evidence.activeRuntimeNamespace.accountIdentityHash)}',
    );
    expect(source).toContain(
      '"latestGenerationHash"=${quoteLiteral(evidence.activeRuntimeNamespace.latestGenerationHash)}',
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\?\.activeSecretNamespaceId ===\s+evidence\.activeRuntimeNamespace\.namespaceId/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\.activeSecretNamespaceEpoch ===\s+evidence\.activeRuntimeNamespace\.namespaceEpoch/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\.activeSecretNamespaceName ===\s+evidence\.activeRuntimeNamespace\.secretName/u,
    );
    expect(ledgerProof).toMatch(
      /evidence\.provider\.latestGenerationHash ===\s+evidence\.activeRuntimeNamespace\.latestGenerationHash/u,
    );
    expect(source).toContain(
      '"status"=\'active\' AND NOT "permanentlyRetired"',
    );
    expect(ledgerProof).toContain(
      "BigInt(evidence.initialSetupTombstone.namespaceEpoch) <",
    );
    expect(ledgerProof).toContain(
      "BigInt(evidence.activeRuntimeNamespace.namespaceEpoch) <\n        BigInt(evidence.confirmedRestartRuntimeTombstone.namespaceEpoch)",
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
    for (const environmentName of [
      "REVIEW_ROUTER_PRISMA_EVIDENCE_RELEASE_DATABASE_URL",
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
    expect(source).toContain("clients.release.toString()");
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
