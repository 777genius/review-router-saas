import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  assertDisposableCaptureTarget,
  createRehearsalRunnerJobBinding,
  cleanupCaptureOnlyRehearsalFixtures,
  cleanupDisposableRehearsalResources,
  captureOnlyRehearsalFixtureCleanupSql,
  disposablePg17CanonicalRoleBootstrapSetupSql,
  disposableTargetPublicTableAclCanonicalizationSql,
  normalizeRehearsalDockerInvocation,
  resolveRehearsalCaptureOnlyConfiguration,
  resolvePreReleaseMigrationExclusions,
  rehearsalActivationCatalogPolicyAuthorization,
  routeRehearsalAfterReleaseMigration,
  runRehearsalReleaseMigration,
  validateRehearsalConfiguration,
  waitForFinalPostgresServer,
} from "./rehearse-private-pg17-rollout.mjs";

const digest = "d".repeat(64);
describe("disposable dual-version rehearsal", () => {
  it("requires explicit opt-in and immutable PG16.13/PG17 images", () => {
    expect(
      validateRehearsalConfiguration({
        REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1",
        REVIEW_ROUTER_REHEARSAL_PG16_IMAGE: `postgres:16.13-bookworm@sha256:${digest}`,
        REVIEW_ROUTER_REHEARSAL_PG17_IMAGE: `postgres:17.5-bookworm@sha256:${digest}`,
      }),
    ).toEqual({
      sourceImage: `postgres:16.13-bookworm@sha256:${digest}`,
      targetImage: `postgres:17.5-bookworm@sha256:${digest}`,
    });
    expect(() =>
      validateRehearsalConfiguration({
        REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1",
        REVIEW_ROUTER_REHEARSAL_PG16_IMAGE: "postgres:16",
        REVIEW_ROUTER_REHEARSAL_PG17_IMAGE: "postgres:17",
      }),
    ).toThrow("private_pg17_rehearsal_immutable_images_required");
  });
  it("cannot accidentally target external infrastructure", () => {
    expect(() => validateRehearsalConfiguration({})).toThrow(
      "private_pg17_rehearsal_explicit_opt_in_required",
    );
  });
  it("uses the exact reviewed compact digest authorization in normal rehearsal", () => {
    expect(rehearsalActivationCatalogPolicyAuthorization).toEqual({
      preactivationCatalogPolicySha256:
        "sha256:c133bacb4a813540245430151ffd80f3380a4123ccc379250828d0317ac514d9",
      activatedCatalogPolicySha256:
        "sha256:7930dc496e760ae4f0577b50db1251f44c55f2db68bf97f790ce290edc8d5253",
    });
  });
  it("leaves bootstrap demotion exclusively to canonical role provisioning", () => {
    const setup = disposablePg17CanonicalRoleBootstrapSetupSql();

    expect(Object.keys(setup)).toEqual([
      "publicTableAclCanonicalization",
      "activationAuthorityProvisioning",
    ]);
    expect(setup).not.toHaveProperty("bootstrapDemotion");
  });
  it("enables capture-only for exact opt-in 1 and an exact disposable identity", () => {
    const identity = "rr-disposable-production-shaped-capture";
    expect(
      resolveRehearsalCaptureOnlyConfiguration({
        REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY: "1",
        REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY: identity,
      }),
    ).toEqual({ disposableDatabaseIdentity: identity });
    for (const value of [undefined, "0", "true", "01"])
      expect(
        resolveRehearsalCaptureOnlyConfiguration({
          REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:
            value,
          REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY:
            identity,
        }),
      ).toBeUndefined();
    expect(() =>
      resolveRehearsalCaptureOnlyConfiguration({
        REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY: "1",
        REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY:
          "production",
      }),
    ).toThrow(
      "activation_catalog_policy_candidate_disposable_identity_required",
    );
  });
  it("rejects capture against a durable or source database target", () => {
    expect(() =>
      assertDisposableCaptureTarget({
        createdContainers: ["rr-source", "rr-authority"],
        sourceContainer: "rr-source",
        targetContainer: "durable-configured-database",
      }),
    ).toThrow(
      "activation_catalog_policy_candidate_disposable_attestation_required",
    );
    expect(() =>
      assertDisposableCaptureTarget({
        createdContainers: ["rr-source"],
        sourceContainer: "rr-source",
        targetContainer: "rr-source",
      }),
    ).toThrow(
      "activation_catalog_policy_candidate_disposable_attestation_required",
    );
    expect(
      assertDisposableCaptureTarget({
        createdContainers: ["rr-source", "rr-target"],
        sourceContainer: "rr-source",
        targetContainer: "rr-target",
      }),
    ).toBeUndefined();
  });
  it("stops the capture-only branch before target staging", async () => {
    const candidate = Object.freeze({ kind: "candidate", version: 1 });
    const captureCandidate = vi.fn(async () => candidate);
    const stageTargetServices = vi.fn();

    await expect(
      routeRehearsalAfterReleaseMigration({
        captureOnly: { disposableDatabaseIdentity: "rr-disposable-test" },
        captureCandidate,
        stageTargetServices,
      }),
    ).resolves.toEqual({ mode: "capture-only", candidate });
    expect(captureCandidate).toHaveBeenCalledOnce();
    expect(stageTargetServices).not.toHaveBeenCalled();
  });
  it("uses a narrow transactional and asserted capture-only fixture cleanup", () => {
    const sql = captureOnlyRehearsalFixtureCleanupSql();
    const objectCleanup = sql.indexOf(
      "DROP TABLE IF EXISTS public.rehearsal_items CASCADE",
    );
    const postCleanupAssertions = sql.indexOf("DO $capture_fixture_cleanup$");
    expect(sql.startsWith("\\set ON_ERROR_STOP on\n")).toBe(true);
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain(
      "DROP TABLE IF EXISTS public.rehearsal_items CASCADE",
    );
    expect(sql).toContain("DROP SCHEMA IF EXISTS app_private CASCADE");
    expect(sql).toContain("to_regclass('public.rehearsal_items')");
    expect(sql).toContain("relation.relkind='S'");
    expect(sql).toContain("relation.relkind='i'");
    expect(sql).toContain("object_type.typname LIKE 'rehearsal_items%'");
    expect(sql).toContain("to_regnamespace('app_private')");
    expect(sql).toContain("to_regrole('rehearsal_writer')");
    expect(sql).toContain("capture-only rehearsal role unexpectedly present");
    expect(sql).toContain("capture-only rehearsal fixture cleanup incomplete");
    expect(sql).toContain("COMMIT;");
    expect(
      sql.indexOf("capture-only rehearsal role unexpectedly present"),
    ).toBeLessThan(objectCleanup);
    for (const assertion of [
      "to_regclass('public.rehearsal_items')",
      "relation.relkind='S'",
      "relation.relkind='i'",
      "object_type.typname LIKE 'rehearsal_items%'",
      "to_regnamespace('app_private')",
      "to_regrole('rehearsal_writer')",
    ])
      expect(sql.indexOf(assertion, postCleanupAssertions)).toBeGreaterThan(-1);
    expect(sql).not.toMatch(
      /(?:REVOKE[^;]*FROM|DROP ROLE)[^;]*rehearsal_writer/u,
    );
    expect(sql).not.toMatch(/DROP SCHEMA (?:public|reviewrouter_)/u);
  });
  it("cleans capture-only fixtures with release-migration authority and fails closed", () => {
    const releaseMigrationDatabaseUrl =
      "postgresql://reviewrouter_release_migration:secret@target/review_router";
    const canonicalRun = vi.fn(() => ({ stdout: "" }));

    expect(
      cleanupCaptureOnlyRehearsalFixtures({
        canonicalRun,
        releaseMigrationDatabaseUrl,
      }),
    ).toEqual({ stdout: "" });
    expect(canonicalRun).toHaveBeenCalledWith(
      "cleanup_capture_only_rehearsal_fixtures",
      "psql",
      [releaseMigrationDatabaseUrl, "--no-psqlrc", "--quiet"],
      {
        env: { DATABASE_URL: releaseMigrationDatabaseUrl },
        input: captureOnlyRehearsalFixtureCleanupSql(),
      },
    );

    const failure = new Error("must be owner of table rehearsal_items");
    expect(() =>
      cleanupCaptureOnlyRehearsalFixtures({
        canonicalRun: vi.fn(() => {
          throw failure;
        }),
        releaseMigrationDatabaseUrl,
      }),
    ).toThrow(failure);
  });
  it("runs capture-only through the authoritative migration use case without staging", async () => {
    const calls: string[] = [];
    const candidate = Object.freeze({ kind: "candidate", version: 1 });
    const transition = Object.freeze({
      transitionSha256: `sha256:${"1".repeat(64)}`,
      migrationArtifactDigest: `sha256:${"2".repeat(64)}`,
      postManifestIdentity: `sha256:${"3".repeat(64)}`,
      postCatalogDigest: `sha256:${"4".repeat(64)}`,
    });
    const migratedRollout = Object.freeze({
      targetManifestPhase: "post_migration",
      migrationTransition: transition,
      receipts: [
        {
          step: "run_release_migration",
          ...transition,
          migrationChecksum: transition.postManifestIdentity,
        },
      ],
    });
    const runReleaseMigration = vi.fn(async () => {
      calls.push("rollout-use-case-cas");
      return migratedRollout;
    });
    const captureCandidate = vi.fn(async () => {
      calls.push("capture-candidate");
      return candidate;
    });
    const stageTargetServices = vi.fn(async () => {
      calls.push("stage-target-services");
      return { phase: "staged" };
    });
    const runStage = vi.fn(async (name, operation) => {
      calls.push(`stage:${name}`);
      return operation();
    });

    await expect(
      runRehearsalReleaseMigration({
        captureOnly: { disposableDatabaseIdentity: "rr-disposable-test" },
        rollout: { phase: "pre-migration" },
        runStage,
        runReleaseMigration,
        captureCandidate,
        stageTargetServices,
      }),
    ).resolves.toEqual({ mode: "capture-only", candidate });
    expect(calls).toEqual([
      "stage:run_release_migration",
      "rollout-use-case-cas",
      "capture-candidate",
    ]);
    expect(runReleaseMigration).toHaveBeenCalledOnce();
    expect(stageTargetServices).not.toHaveBeenCalled();
  });
  it("keeps normal migration in the rollout use case and stages its result", async () => {
    const preMigrationRollout = Object.freeze({ phase: "pre-migration" });
    const transition = Object.freeze({
      transitionSha256: `sha256:${"1".repeat(64)}`,
      migrationArtifactDigest: `sha256:${"2".repeat(64)}`,
      postManifestIdentity: `sha256:${"3".repeat(64)}`,
      postCatalogDigest: `sha256:${"4".repeat(64)}`,
    });
    const migratedRollout = Object.freeze({
      phase: "migrated",
      targetManifestPhase: "post_migration",
      migrationTransition: transition,
      receipts: [
        {
          step: "run_release_migration",
          ...transition,
          migrationChecksum: transition.postManifestIdentity,
        },
      ],
    });
    const stagedRollout = Object.freeze({ phase: "staged" });
    const runReleaseMigration = vi.fn(async () => migratedRollout);
    const captureCandidate = vi.fn();
    const stageTargetServices = vi.fn(async () => stagedRollout);
    const runStage = vi.fn(async (_name, operation) => operation());

    await expect(
      runRehearsalReleaseMigration({
        captureOnly: undefined,
        rollout: preMigrationRollout,
        runStage,
        runReleaseMigration,
        captureCandidate,
        stageTargetServices,
      }),
    ).resolves.toEqual({ mode: "rollout", rollout: stagedRollout });
    expect(runStage).toHaveBeenCalledWith(
      "run_release_migration",
      runReleaseMigration,
    );
    expect(runReleaseMigration).toHaveBeenCalledOnce();
    expect(captureCandidate).not.toHaveBeenCalled();
    expect(stageTargetServices).toHaveBeenCalledWith(migratedRollout);
  });
  it("attempts every cleanup even when an earlier cleanup fails", async () => {
    const calls: string[] = [];
    const close = vi.fn(async () => {
      calls.push("control");
      throw new Error("close_failed");
    });
    const disconnect = vi.fn(async () => calls.push("database"));
    const docker = vi.fn((...args: string[]) => {
      calls.push(args.join(":"));
      if (args[0] === "rm") throw new Error("container_failed");
    });
    const removeDirectory = vi.fn(() => calls.push("directory"));

    await expect(
      cleanupDisposableRehearsalResources({
        releaseControl: { close },
        prismaClients: [{ $disconnect: disconnect }],
        createdContainers: ["source", "target"],
        networkCreated: true,
        network: "network",
        directory: "/tmp/disposable-rehearsal-test",
        docker,
        removeDirectory,
      }),
    ).rejects.toThrow("close_failed");
    expect(calls).toEqual([
      "control",
      "database",
      "rm:--force:target",
      "rm:--force:source",
      "network:rm:network",
      "directory",
    ]);
  });
  it("keeps an explicit fail-closed PG16 pre-release migration boundary", () => {
    const migrationNames = readdirSync(
      "packages/platform/db/prisma/migrations",
      { withFileTypes: true },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const exclusions = resolvePreReleaseMigrationExclusions(migrationNames);

    expect(exclusions).toEqual([
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
      "000072_runtime_canary_challenge",
    ]);
    expect(exclusions).not.toContain("000067_review_live_progress");
    expect(exclusions).not.toContain(
      "000068_validate_review_assignment_manifest",
    );
    expect(() =>
      resolvePreReleaseMigrationExclusions([
        ...migrationNames,
        "000073_future_release_migration",
      ]),
    ).toThrow("private_pg17_rehearsal_migration_boundary_unclassified");
    expect(() =>
      resolvePreReleaseMigrationExclusions([
        ...migrationNames,
        "000073_future_review_migration",
      ]),
    ).toThrow("private_pg17_rehearsal_migration_boundary_unclassified");
  });
  it("canonicalizes only the disposable PUBLIC table-read drift", () => {
    const sql = disposableTargetPublicTableAclCanonicalizationSql();

    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_role_bootstrap IN SCHEMA public",
    );
    expect(sql).toContain("REVOKE SELECT ON TABLES FROM PUBLIC");
    expect(sql).toContain(
      "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM PUBLIC",
    );
    expect(sql).not.toContain("REVOKE ALL");
  });
  it("adds Docker exec interactive mode when psql reads SQL from stdin", () => {
    expect(
      normalizeRehearsalDockerInvocation(
        ["exec", "rr-pg17-disposable", "psql", "-U", "postgres"],
        "SELECT 1;\n",
      ),
    ).toEqual({
      args: [
        "exec",
        "--interactive",
        "rr-pg17-disposable",
        "psql",
        "-U",
        "postgres",
      ],
      input: "SELECT 1;\n",
    });
  });
  it.each(["-i", "--interactive"])(
    "does not duplicate an existing Docker exec %s flag",
    (interactiveFlag) => {
      expect(
        normalizeRehearsalDockerInvocation(
          [
            "exec",
            interactiveFlag,
            "rr-pg17-disposable",
            "psql",
            "-U",
            "postgres",
          ],
          "SELECT 1;\n",
        ).args,
      ).toEqual([
        "exec",
        interactiveFlag,
        "rr-pg17-disposable",
        "psql",
        "-U",
        "postgres",
      ]);
    },
  );
  it("moves psql command SQL to interactive stdin and keeps it out of argv", () => {
    const sql =
      "SELECT 'postgresql://postgres:secret-canary@127.0.0.1/reviewrouter';";
    const invocation = normalizeRehearsalDockerInvocation(
      ["exec", "rr-pg17-disposable", "psql", "-U", "postgres", "-Atqc", sql],
      undefined,
    );

    expect(invocation.args).toEqual([
      "exec",
      "--interactive",
      "rr-pg17-disposable",
      "psql",
      "-U",
      "postgres",
      "-Atq",
    ]);
    expect(invocation.args.join(" ")).not.toContain("SELECT");
    expect(invocation.args.join(" ")).not.toContain("secret-canary");
    expect(invocation.input).toBe(sql);
  });
  it("waits for the final PostgreSQL server over loopback TCP", () => {
    const calls: Array<{
      args: string[];
      options?: { input?: string; timeout?: number };
    }> = [];
    waitForFinalPostgresServer((args, options) => {
      calls.push({ args, options });
      return "1\n";
    }, "rr-pg17-disposable");

    expect(calls).toEqual([
      {
        args: [
          "exec",
          "rr-pg17-disposable",
          "psql",
          "--host",
          "127.0.0.1",
          "--username",
          "postgres",
          "--dbname",
          "review_router",
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--quiet",
        ],
        options: { input: "SELECT 1;\n", timeout: 2_000 },
      },
    ]);
  });
  it("supports a provider-named PostgreSQL bootstrap administrator", () => {
    const calls: string[][] = [];
    waitForFinalPostgresServer(
      (args) => {
        calls.push(args);
        return "1\n";
      },
      "rr-pg17-disposable",
      { username: "reviewrouter_role_bootstrap" },
    );

    expect(calls[0]).toContain("reviewrouter_role_bootstrap");
    expect(calls[0]).not.toContain("postgres");
  });
  it("retries final-server readiness only up to the configured bound", () => {
    let probes = 0;
    let sleeps = 0;
    expect(() =>
      waitForFinalPostgresServer(
        (args) => {
          if (args.includes("psql")) {
            probes += 1;
            throw new Error("not ready");
          }
          sleeps += 1;
          return "";
        },
        "rr-pg17-disposable",
        { maxAttempts: 3 },
      ),
    ).toThrow("private_pg17_rehearsal_database_timeout");
    expect({ probes, sleeps }).toEqual({ probes: 3, sleeps: 2 });
  });
  it("keeps probe SQL and failed-command secrets out of argv and diagnostics", () => {
    const argv: string[][] = [];
    let diagnostic: Error | undefined;
    try {
      waitForFinalPostgresServer(
        (args) => {
          argv.push(args);
          if (args.includes("psql"))
            throw new Error(
              "SELECT 1; postgresql://postgres:secret-canary@127.0.0.1/reviewrouter",
            );
          return "";
        },
        "rr-pg17-disposable",
        { maxAttempts: 2 },
      );
    } catch (error) {
      diagnostic = error as Error;
    }

    expect(argv.flat().join(" ")).not.toContain("SELECT 1");
    expect(argv.flat().join(" ")).not.toContain("secret-canary");
    expect(diagnostic?.message).toBe("private_pg17_rehearsal_database_timeout");
    expect(diagnostic?.message).not.toContain("SELECT 1");
    expect(diagnostic?.message).not.toContain("secret-canary");
  });
  it("binds the persisted runner job to the authority-owned pre-dispatch time", () => {
    const providerCreationNotBefore = "2026-08-12T00:00:00.000Z";
    expect(
      createRehearsalRunnerJobBinding({
        identity: {
          baseServiceId: "srv-disposable",
          renderJobId: "job-role",
          cleanupCanary: "rr-cleanup:disposable-rehearsal:rr-role",
        },
        observation: { observedAt: "2026-08-12T00:00:01.000Z" },
        lifecycle: "role",
        provisioningIntentId: `rri-${"a".repeat(64)}`,
        providerCreationNotBefore,
      }),
    ).toEqual({
      rolloutId: "disposable-rehearsal",
      serviceId: "srv-disposable",
      jobId: "job-role",
      observedAt: "2026-08-12T00:00:01.000Z",
      providerCreationNotBefore,
      cleanupCanary: "rr-cleanup:disposable-rehearsal:rr-role",
      lifecycle: "role",
      provisioningIntentId: `rri-${"a".repeat(64)}`,
    });
  });
  it("routes rehearsal state through production use cases, SQL generators, and evidence verifier", () => {
    const source = readFileSync(
      "scripts/rehearse-private-pg17-rollout.mjs",
      "utf8",
    );
    const releaseMigrationSource = readFileSync(
      "scripts/run-codex-rotating-release-migration.mjs",
      "utf8",
    );
    for (const required of [
      "ReleaseRolloutUseCases",
      "TransactionalServiceCutover",
      "AuthenticatedRunnerLedgerAdapter",
      "HttpProviderAuthorityDecisionAdapter",
      "createReleaseControlApp",
      "rr-authority-pg17-",
      "releaseAuthorityMigrationBundle",
      "activationAuthorityProvisioningSql",
      "reviewrouter_activation_permit_installer",
      "reviewrouter_activation_receipt_reader",
      "targetReceiptReaderPrisma",
      "trustedDatabaseIdentity",
      "authorityOwnerRoleName",
      "installerRoutineBodySha256",
      "readerRoutineBodySha256",
      "reviewrouter_provider_authority",
      "providerAuthorityPrisma",
      "Promise.allSettled",
      "private_pg17_rehearsal_authority_replay_unproven",
      "private_pg17_rehearsal_authority_conflict_unproven",
      "private_pg17_rehearsal_authority_outage_unproven",
      "private_pg17_rehearsal_authority_database_isolation_unproven",
      "renderSourceRecoveryManifestSha256",
      "targetServiceConfigurationSha256",
      "executeCanonicalRoleBootstrap",
      "executeCanonicalReleaseMigration",
      "executePrivateGenerationActivation",
      "roleProvisioningSql",
      "private_pg17_rehearsal_pgcrypto_acl_failed",
      "extension.extname = 'pgcrypto'",
      "'reviewrouter_activation_receipt_reader', routine.oid, 'EXECUTE'",
      "acl.grantee = 0",
      "runtimeGrantSql",
      "activationRoutineBodyTrustRoots",
      "assembleTrustedRolloutEvidence",
      "reconnectDenied",
      "beginCompensation",
      "assertPromotionAllowed",
      "REVIEW_ROUTER_DATABASE_URL_FILE",
      "createDatabaseCredentialBoundary",
      '"000069_release_rollout_ledger"',
      '"000070_runtime_generation_witness_proof"',
      '"000071_transactional_service_transition"',
      '"000072_runtime_canary_challenge"',
      "private_pg17_rehearsal_migration_boundary_unclassified",
      "private_pg17_rehearsal_command_failed",
      "sanitizedDiagnosticError",
      "redactedErrorChain",
    ])
      expect(source).toContain(required);
    expect(source).toContain("createdContainers: facts.createdContainers");
    expect(source).toContain("sourceContainer: source");
    expect(source).toMatch(
      /verifyProductionPathRehearsal\(\{[\s\S]*createdContainers,[\s\S]*captureOnly,/u,
    );
    const activationTrustRootContract =
      /export function activationRoutineBodyTrustRoots\(\) \{([\s\S]+?)\n\}/u.exec(
        releaseMigrationSource,
      )?.[1];
    expect(activationTrustRootContract).toBeDefined();
    expect(source).toContain(
      "const activationTrustRoots = activationRoutineBodyTrustRoots()",
    );
    expect(source).toContain("activationTrustRoots.installerRoutineBodySha256");
    expect(source).toContain("activationTrustRoots.readerRoutineBodySha256");
    expect(activationTrustRootContract).toContain(
      'digestBody("install_permit")',
    );
    expect(activationTrustRootContract).toContain('digestBody("activate")');
    expect(activationTrustRootContract).toContain('digestBody("read_receipt")');
    expect(releaseMigrationSource).toContain(
      "encode(pg_catalog.sha256(convert_to(installer.prosrc,'UTF8')),'hex')",
    );
    expect(releaseMigrationSource).toContain(
      "encode(pg_catalog.sha256(convert_to(reader.prosrc,'UTF8')),'hex')",
    );
    const installer = readFileSync(
      "scripts/install-release-authority-db.mjs",
      "utf8",
    );
    const canonicalMigrationList = readFileSync(
      "apps/api/src/release-authority/domain/readiness-contract.mjs",
      "utf8",
    );
    const legacyCatalogList = installer.slice(
      installer.indexOf("const legacyCatalogPaths"),
      installer.indexOf("const legacyCatalogChecksums"),
    );
    expect(
      canonicalMigrationList.indexOf("000001_release_authority"),
    ).toBeLessThan(
      canonicalMigrationList.indexOf("000002_external_effect_protocol"),
    );
    expect(canonicalMigrationList).toContain(
      "packages/platform/release-authority-db/migrations/${name}/migration.sql",
    );
    expect(
      canonicalMigrationList.match(/000001_release_authority/gu),
    ).toHaveLength(1);
    expect(
      canonicalMigrationList.match(/000002_external_effect_protocol/gu),
    ).toHaveLength(1);
    expect(
      legacyCatalogList.match(/000001_release_authority\/migration\.sql/gu),
    ).toHaveLength(1);
    expect(
      legacyCatalogList.match(
        /000002_external_effect_protocol\/migration\.sql/gu,
      ),
    ).toHaveLength(1);
    expect(
      canonicalMigrationList.indexOf("000002_external_effect_protocol"),
    ).toBeLessThan(
      canonicalMigrationList.indexOf("000002_transactional_service_transition"),
    );
    expect(
      canonicalMigrationList.match(/000002_transactional_service_transition/gu),
    ).toHaveLength(1);
    expect(
      canonicalMigrationList.indexOf("000003_partial_source_freeze"),
    ).toBeLessThan(
      canonicalMigrationList.indexOf("000005_late_runner_effects"),
    );
    expect(
      canonicalMigrationList.match(/000005_late_runner_effects/gu),
    ).toHaveLength(1);
    expect(
      canonicalMigrationList.indexOf("000005_late_runner_effects"),
    ).toBeLessThan(
      canonicalMigrationList.indexOf("000007_compensation_effect_fence"),
    );
    expect(
      canonicalMigrationList.match(/000007_compensation_effect_fence/gu),
    ).toHaveLength(1);
    expect(source).not.toContain(
      "GRANT SELECT ON reviewrouter_activation.activation_receipt TO reviewrouter_role_bootstrap",
    );
    expect(source).not.toContain("writersSuspended: true");
    expect(source).not.toContain(
      'command === "pnpm" && step === "deploy_migrations"',
    );
    expect(source).not.toContain("rehearsal_001");
    expect(source).not.toMatch(/"run",\s*"--env",\s*"POSTGRES_PASSWORD/u);
    expect(source).not.toContain("env: { ...process.env, DATABASE_URL:");
    expect(source).not.toContain("persistLedger");
    expect(source).not.toContain("RENDER_API_KEY");
    expect(source).not.toContain("GITHUB_TOKEN");
    expect(source).toContain("JSON.stringify(safe)");
  });
  it("executes the canonical effective-principal projection on PG16 and PG17", () => {
    const source = readFileSync(
      "scripts/rehearse-private-pg17-rollout.mjs",
      "utf8",
    );

    expect(source).toContain("sql(source, effectivePrincipalInventorySql)");
    expect(source).toContain("sql(target, effectivePrincipalInventorySql)");
    expect(source).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC",
    );
    expect(source).toContain("default:postgres:r:public");
    expect(source).toContain(
      "private_pg17_rehearsal_pg16_default_acl_projection_failed",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_pg17_default_acl_projection_failed",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_target_principal_inventory_failed",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_public_acl_drift_unproven",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_public_acl_cleanup_failed",
    );
    expect(source).toContain(
      "deploymentRevision: canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA",
    );
    expect(source).toContain(
      "artifactDigest: canonicalEnv.REVIEW_ROUTER_RELEASE_IMAGE_DIGEST",
    );
    expect(source).not.toContain("closeBootstrapGuardRead");
    expect(source).toContain(
      "GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_role_bootstrap",
    );
    expect(source).toContain("REVIEW_ROUTER_RUNTIME_SERVICE_ID: serviceId");
    expect(source).toContain(
      "REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE: digest.slice(-64)",
    );
    expect(source).toContain("servicePostcondition: current.postcondition");
    expect(source).toContain("normalizedServicePostconditionSha256(");
    expect(source).toContain('const nonce = "a".repeat(48)');
    expect(source).toContain("expectedGeneration");
    expect(source).toContain("serviceFacts");
    expect(source).toContain("proowner=to_regrole('postgres')");
    expect(source).not.toContain("proowner='postgres'::regrole");
    expect(source).toContain(
      "POSTGRES_USER=reviewrouter_provider_administrator",
    );
    expect(source).not.toContain("POSTGRES_USER=reviewrouter_role_bootstrap");
    expect(source).toContain(
      "CREATE ROLE reviewrouter_role_bootstrap LOGIN PASSWORD 'disposable-bootstrap' SUPERUSER CREATEROLE",
    );
    expect(source).not.toContain(
      "GRANT CREATE ON DATABASE review_router TO reviewrouter_role_bootstrap",
    );
    expect(source).toContain("$remove_pg17_provider_memberships$");
    expect(source).toContain("'REVOKE %I FROM %I GRANTED BY CURRENT_ROLE'");
    expect(source).toContain("membership.member=provider_role.oid");
    expect(source).toContain("UPDATE pg_catalog.pg_authid");
    expect(
      source.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto"),
    ).toBeLessThan(source.indexOf("UPDATE pg_catalog.pg_authid"));
    expect(source).toContain("$provider_extension_owners$");
    expect(source.indexOf("$provider_extension_owners$")).toBeLessThan(
      source.indexOf("UPDATE pg_catalog.pg_authid"),
    );
    expect(source).toContain("'providerAdministratorInert'");
    expect(source).toContain(
      "disposableProviderRoles.bootstrapSuperuser !== true",
    );
    expect(source).not.toContain("bootstrapDemotion");
    expect(source).not.toContain(
      'sql(target, "ALTER ROLE reviewrouter_role_bootstrap',
    );
    expect(source).toContain("rolcanlogin AND rolsuper AND NOT rolcreatedb");
    expect(source).toContain(
      "AND rolcreaterole AND NOT rolreplication AND NOT rolbypassrls",
    );
    expect(source).toContain(
      "rolcanlogin AND NOT rolsuper AND NOT rolcreatedb",
    );
    expect(source).toContain(
      "AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_bootstrap_privilege_failed",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_bootstrap_demotion_failed",
    );
    const roleBootstrap = source.indexOf(
      "const result = executeCanonicalRoleBootstrap(",
    );
    const preProvisioningPrivilegeProof = source.lastIndexOf(
      "facts.assertCanonicalBootstrapPrivileged();",
      roleBootstrap,
    );
    const postProvisioningDemotionProof = source.indexOf(
      "facts.assertCanonicalBootstrapDemoted();",
      roleBootstrap,
    );
    const bootstrapStage = source.indexOf('runStage("bootstrap_target_roles"');
    const releaseMigrationStage = source.indexOf(
      "runRehearsalReleaseMigration({",
      bootstrapStage,
    );
    expect(preProvisioningPrivilegeProof).toBeGreaterThan(-1);
    expect(preProvisioningPrivilegeProof).toBeLessThan(roleBootstrap);
    expect(postProvisioningDemotionProof).toBeGreaterThan(roleBootstrap);
    expect(bootstrapStage).toBeGreaterThan(postProvisioningDemotionProof);
    expect(bootstrapStage).toBeLessThan(releaseMigrationStage);
    expect(source).toContain("rehearsal_canonical_step_failed:${step}");
    expect(source).toContain("safePostgresErrorClassification(result.stderr)");
    expect(source).toContain("rehearsal_canonical_postgres_error:${step}");
    expect(source).toContain(
      "rehearsal_stage_failed:${safeName}:${redactedErrorChain(error)}",
    );
    expect(source).toContain(
      "rehearsal_migration_substep_started:canonical_migration",
    );
    expect(source).toContain(
      "rehearsal_migration_substep_completed:verify_migration_evidence",
    );
    expect(source).toContain(
      "targetRecoveryWitnessSha256: rollout.target.recoveryWitnessSha256",
    );
    expect(source).toContain(
      "migrationTransition: rollout.migrationTransition",
    );
    expect(source).toContain('"observe_migration_checksum"');
    expect(source).toContain(
      "private_pg17_rehearsal_provider_administrator_convergence_failed",
    );
    expect(
      source.indexOf("disposableTargetPublicTableAclCanonicalizationSql()"),
    ).toBeLessThan(source.indexOf("activationAuthorityProvisioningSql()"));
    expect(source).toContain("if (!targetPrincipalDecision.accepted)");
    expect(source).not.toContain("targetPrincipalDecision.allowed");
    expect(source).not.toContain("draftPolicyForDisposableRehearsal");
    expect(source).toContain(
      "authorizeCanonicalActivationCatalogPolicies(\n          rehearsalActivationCatalogPolicyAuthorization",
    );
    expect(source).not.toContain(
      "trustedActivationCatalogPolicies: canonicalActivationCatalogPolicies",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_activation_catalog_policy_trust_root_blocked",
    );
    const releaseMigration = source.indexOf(
      "const migratedRollout = await runStage(",
    );
    const capture = source.indexOf(
      '"capture_activation_catalog_policy_candidate"',
    );
    const marker = source.indexOf(
      '"mark_disposable_activation_catalog_database"',
    );
    const fixtureCleanup = source.indexOf(
      "cleanupCaptureOnlyRehearsalFixtures({",
      releaseMigration,
    );
    const stageTarget = source.indexOf(
      "useCases.stageTargetServices(migratedRollout)",
    );
    const activate = source.indexOf('runStage("activate_target_generation"');
    expect(releaseMigration).toBeGreaterThan(-1);
    expect(releaseMigration).toBeLessThan(marker);
    expect(releaseMigration).toBeLessThan(fixtureCleanup);
    expect(fixtureCleanup).toBeLessThan(marker);
    expect(marker).toBeLessThan(capture);
    expect(capture).toBeLessThan(stageTarget);
    expect(stageTarget).toBeLessThan(activate);
    const fixtureCleanupBranch = source.slice(fixtureCleanup, marker);
    expect(fixtureCleanupBranch).toContain(
      "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
    );
    expect(fixtureCleanupBranch).not.toContain(
      "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
    );
    const captureBranch = source.slice(marker, stageTarget);
    expect(captureBranch).toContain(
      "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
    );
    expect(captureBranch).toContain(
      "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
    );
    expect(captureBranch).toContain(
      "canonicalActivationCatalogPolicyCandidateSql",
    );
    expect(captureBranch).not.toContain("install_activation_permit");
    expect(captureBranch).not.toContain("executePrivateGenerationActivation");
    expect(source).not.toContain("rehearsal_capture_debug_");
  });
});
