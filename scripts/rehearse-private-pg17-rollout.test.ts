import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createRehearsalRunnerJobBinding,
  normalizeRehearsalDockerInvocation,
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
          "reviewrouter",
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--quiet",
        ],
        options: { input: "SELECT 1;\n", timeout: 2_000 },
      },
    ]);
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
      '"000069_release_rollout_ledger"',
      "private_pg17_rehearsal_command_failed",
      "sanitizedDiagnosticError",
      "redactedErrorChain",
    ])
      expect(source).toContain(required);
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
    expect(source).toContain("if (!targetPrincipalDecision.accepted)");
    expect(source).not.toContain("targetPrincipalDecision.allowed");
  });
});
