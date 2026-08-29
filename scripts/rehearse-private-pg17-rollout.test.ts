import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalReleaseMigrationArtifact } from "../packages/features/release-rollout/src/domain/release-migration-transition.js";
import {
  assertDisposableCaptureTarget,
  createRehearsalRunnerJobBinding,
  createActivationCatalogCaptureCheckpoint,
  cleanupCaptureOnlyRehearsalFixtures,
  cleanupDisposableRehearsalResources,
  captureOnlyRehearsalFixtureCleanupSql,
  disposablePg17CanonicalRoleBootstrapSetupSql,
  disposableTargetPublicTableAclCanonicalizationSql,
  normalizeRehearsalDockerInvocation,
  resolveRehearsalCaptureOnlyConfiguration,
  resolvePreReleaseMigrationExclusions,
  safePostgresErrorClassification,
  safeRehearsalStageErrorCode,
  safeRehearsalStageErrorDiagnostic,
  safeReleaseAuthorityErrorClassification,
  summarizeErrorShape,
  summarizeAuthorityReadinessMismatch,
  rehearsalActivationCatalogPolicyAuthorization,
  rehearsalReadinessPolicy,
  routeRehearsalAfterReleaseMigration,
  runRehearsalReleaseMigration,
  validateRehearsalConfiguration,
  waitForRehearsalControlReady,
  waitForFinalPostgresServer,
} from "./rehearse-private-pg17-rollout.mjs";

const digest = "d".repeat(64);

function gitCustodyFixture() {
  const root = mkdtempSync(join(tmpdir(), "rr-catalog-git-custody-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "ReviewRouter Test");
  git("config", "user.email", "reviewrouter@example.invalid");
  writeFileSync(join(root, "evidence.txt"), "base\n");
  git("add", "evidence.txt");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "evidence.txt"), "audited\n");
  git("commit", "-qam", "audited");
  const head = git("rev-parse", "HEAD");
  return { root, base, head, cleanup: () => rmSync(root, { recursive: true }) };
}

const migrationManifestIdentity = (migrationNames: readonly string[]) => {
  const migrationsRoot = "packages/platform/db/prisma/migrations";
  const manifest = [...migrationNames]
    .sort()
    .map((migrationName) => {
      const checksum = createHash("sha256")
        .update(
          readFileSync(join(migrationsRoot, migrationName, "migration.sql")),
        )
        .digest("hex");
      return `${migrationName}:${checksum}`;
    })
    .join(",");
  return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
};

describe("disposable dual-version rehearsal", () => {
  it("reports only allowlisted static rehearsal stage errors", () => {
    expect(
      safeRehearsalStageErrorCode(
        new Error("trusted_rollout_evidence_receipt_chain_invalid"),
      ),
    ).toBe("trusted_rollout_evidence_receipt_chain_invalid");
    expect(
      safeRehearsalStageErrorCode(
        new Error("release_migration_target_permit_invalid"),
      ),
    ).toBe("release_migration_target_permit_invalid");
    expect(
      safeRehearsalStageErrorCode(
        new Error("legacy_ambiguity_evidence_invalid"),
      ),
    ).toBe("legacy_ambiguity_evidence_invalid");
    expect(
      safeRehearsalStageErrorCode(
        new Error("database failed token=do-not-print"),
      ),
    ).toBeUndefined();
  });

  it("classifies only allowlisted nested release-authority errors", () => {
    expect(
      safeReleaseAuthorityErrorClassification({
        meta: {
          driverAdapterError: {
            cause: {
              originalMessage:
                "ERROR: release migration begin binding conflict",
            },
          },
        },
      }),
    ).toBe("release migration begin binding conflict");
    expect(
      safeReleaseAuthorityErrorClassification({
        message: "secret database error token=do-not-print",
      }),
    ).toBeUndefined();
    expect(
      safeReleaseAuthorityErrorClassification({
        message: "release_migration_target_receipt_conflict",
      }),
    ).toBe("release_migration_target_receipt_conflict");
    expect(
      safeReleaseAuthorityErrorClassification({
        originalCode: "P0001",
        originalMessage: "release migration source receipt digest invalid",
      }),
    ).toBe("release migration source receipt digest invalid");
    expect(
      safeReleaseAuthorityErrorClassification({
        originalCode: "P0001",
        originalMessage: "release migration token=do-not-print",
      }),
    ).toBeUndefined();
    expect(
      safeReleaseAuthorityErrorClassification({
        originalCode: "42501",
        originalMessage: "permission denied for schema release_authority",
      }),
    ).toBe("permission denied for schema release_authority");
    expect(
      safeReleaseAuthorityErrorClassification({
        originalCode: "42501",
        originalMessage: "permission denied for schema private_customer_data",
      }),
    ).toBeUndefined();
    expect(
      summarizeErrorShape({
        message: "not exposed",
        meta: { driverAdapterError: { cause: new Error("not exposed") } },
      }),
    ).toEqual([
      { path: "error", constructor: "Object", keys: ["message", "meta"] },
      {
        path: "error.meta",
        constructor: "Object",
        keys: ["driverAdapterError"],
      },
      {
        path: "error.meta.driverAdapterError",
        constructor: "Object",
        keys: ["cause"],
      },
      {
        path: "error.meta.driverAdapterError.cause",
        constructor: "Error",
        keys: ["message", "stack"],
      },
    ]);
  });

  it("selects safe release-migration diagnostics and redacts arbitrary errors", () => {
    expect(
      safeRehearsalStageErrorDiagnostic("run_release_migration", {
        meta: {
          driverAdapterError: {
            cause: {
              originalMessage:
                "ERROR: release migration begin binding conflict",
            },
          },
        },
      }),
    ).toBe("release migration begin binding conflict");

    const secret =
      "postgres://admin:do-not-print@private.example/db?token=do-not-print";
    const diagnostic = safeRehearsalStageErrorDiagnostic(
      "run_release_migration",
      new Error(`database failed at ${secret}`),
    );
    expect(diagnostic).toBe(
      '{"version":1,"code":"private_pg17_rehearsal_command_failed","phase":"rehearsal","exit":{"code":null,"signal":null},"metadata":{},"operatorHint":"Inspect the disposable rehearsal phase and local container state."}',
    );
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("do-not-print");
  });

  it.each([
    ["direct snake case", new Error("credential_supersecret123")],
    [
      "prefixed migration snake case",
      new Error("release_migration_password_hunter2"),
    ],
    [
      "nested snake case",
      {
        meta: { driverAdapterError: { message: "credential_supersecret123" } },
      },
    ],
    ["direct release text", new Error("release migration password hunter2")],
    [
      "nested P0001 release text",
      {
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "P0001",
              originalMessage: "release migration password hunter2",
            },
          },
        },
      },
    ],
  ])("redacts adversarial %s diagnostics", (_case, error) => {
    const diagnostic = safeRehearsalStageErrorDiagnostic(
      "run_release_migration",
      error,
    );
    expect(diagnostic).toBe(
      '{"version":1,"code":"private_pg17_rehearsal_command_failed","phase":"rehearsal","exit":{"code":null,"signal":null},"metadata":{},"operatorHint":"Inspect the disposable rehearsal phase and local container state."}',
    );
    expect(diagnostic).not.toContain("credential_supersecret123");
    expect(diagnostic).not.toContain("release migration password hunter2");
    expect(diagnostic).not.toContain("release_migration_password_hunter2");
    expect(diagnostic).not.toContain("hunter2");
  });

  it("reports authority readiness drift without credential material", () => {
    expect(
      summarizeAuthorityReadinessMismatch({
        roleName: "reviewrouter_release_control",
        systemIdentifier: "123",
        databaseIdentity: {
          serverIdentity: "123",
          databaseIdentity: "456",
          databaseName: "review_router",
        },
        postgresMajor: 17,
        schemaVersion: 7,
        catalogVerifier: "sha256-catalog-v1",
        catalogFingerprint: "actual",
        expectedCatalogFingerprint: "expected",
        catalogExact: false,
        authorityAclExact: false,
        migrationManifest: [
          {
            migrationName: "000001_release_authority",
            byteVariant: "canonical",
          },
        ],
      }),
    ).toEqual({
      roleName: "reviewrouter_release_control",
      systemIdentifier: "123",
      databaseIdentity: {
        serverIdentity: "123",
        databaseIdentity: "456",
        databaseName: "review_router",
      },
      postgresMajor: 17,
      schemaVersion: 7,
      catalogVerifier: "sha256-catalog-v1",
      catalogFingerprintMatches: false,
      falseChecks: ["catalogExact", "authorityAclExact"],
      migrationManifest: [
        { migrationName: "000001_release_authority", byteVariant: "canonical" },
      ],
    });
  });

  it("classifies a denied catalog object without exposing surrounding stderr", () => {
    expect(
      safePostgresErrorClassification(
        "psql: ERROR: permission denied for table CodexOAuthSetupManifest\\nDETAIL: secret=value",
      ),
    ).toBe("permission denied for table CodexOAuthSetupManifest");
    expect(
      safePostgresErrorClassification(
        "psql: ERROR: permission denied for function internal_fn\\nCONTEXT: token=secret",
      ),
    ).toBe("permission denied for function internal_fn");
    expect(
      safePostgresErrorClassification(
        "psql: ERROR: public ownership convergence failed\nDETAIL: token=secret",
      ),
    ).toBe("public ownership convergence failed");
    expect(
      safePostgresErrorClassification(
        "psql: ERROR:  P0001: release migration executor runtime CONNECT gate mismatch\nDETAIL: token=secret",
      ),
    ).toBe("release migration executor runtime connect gate mismatch");
    expect(
      safePostgresErrorClassification(
        "psql: ERROR:  P0001: release migration V70-V73 live catalog digest mismatch: internal context redacted\nDETAIL: token=secret",
      ),
    ).toBe("release migration v70-v73 live catalog digest mismatch");
    expect(
      safePostgresErrorClassification(
        `psql: ERROR:  P0001: release migration target live completion mismatch:catalog_digest_observed\nDETAIL: expected=sha256:${"1".repeat(64)} observed=sha256:${"2".repeat(64)}\nCONTEXT: token=secret`,
      ),
    ).toBe(
      `release migration target live completion mismatch:catalog_digest_observed:expected=sha256:${"1".repeat(64)}:observed=sha256:${"2".repeat(64)}`,
    );
    expect(
      safePostgresErrorClassification(
        `psql: ERROR:  P0001: activation catalog policy mismatch\nDETAIL: sections=grants,roleReachability expected=sha256:${"3".repeat(64)} observed=sha256:${"4".repeat(64)}\nCONTEXT: token=secret`,
      ),
    ).toBe(
      `activation catalog policy mismatch:sections=grants,roleReachability:expected=sha256:${"3".repeat(64)}:observed=sha256:${"4".repeat(64)}`,
    );
    expect(
      safePostgresErrorClassification(
        "psql: ERROR:  P0001: codex_oauth_provider_identity_mismatch\nDETAIL: token=secret",
      ),
    ).toBe("codex_oauth_provider_identity_mismatch");
    expect(
      safePostgresErrorClassification(
        'psql: ERROR:  42P01: relation "CodexOAuthSetupManifest" does not exist\nDETAIL: token=secret',
      ),
    ).toBe('relation "codexoauthsetupmanifest" does not exist');
    expect(
      safePostgresErrorClassification(
        'psql: ERROR:  0A000: unsupported operation near "secret"\nDETAIL: token=secret',
      ),
    ).toBe("postgres sqlstate 0A000");
  });
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
  it("waits for the asynchronous control-plane attestation before mutation", async () => {
    const statuses = [503, 503, 200];
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForRehearsalControlReady(async () => statuses.shift() ?? 503, {
        maxAttempts: 3,
        intervalMilliseconds: 1,
        sleep,
      }),
    ).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("bounds a control-plane attestation that never becomes ready", async () => {
    await expect(
      waitForRehearsalControlReady(async () => 503, {
        maxAttempts: 2,
        intervalMilliseconds: 1,
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("private_pg17_rehearsal_control_readiness_timeout");
  });
  it("uses the exact reviewed compact digest authorization in normal rehearsal", () => {
    expect(rehearsalActivationCatalogPolicyAuthorization).toEqual({
      preactivationCatalogPolicySha256:
        "sha256:36e6e4875c530beba1cb6bfc580a358d031895334e6af6a6bad193148e1beebe",
      activatedCatalogPolicySha256:
        "sha256:d0ccc9a760f69c467d3c9df56502704abb1f03116a2be156eb206100b35f5866",
    });
  });
  it("allows loaded disposable catalog observations without changing production timing", () => {
    expect(rehearsalReadinessPolicy).toEqual({
      poolWaitMilliseconds: 5_000,
      lockTimeoutMilliseconds: 5_000,
      statementTimeoutMilliseconds: 45_000,
      transactionTimeoutMilliseconds: 50_000,
      observationDeadlineMilliseconds: 60_000,
      leaseMilliseconds: 900_000,
      refreshAfterMilliseconds: 600_000,
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
    const repository = gitCustodyFixture();
    try {
      const identity = "rr-disposable-production-shaped-capture";
      const captureBaseCommit = repository.base;
      const auditedHead = repository.head;
      expect(
        resolveRehearsalCaptureOnlyConfiguration(
          {
            REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:
              "1",
            REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY:
              identity,
            REVIEW_ROUTER_ACTIVATION_CATALOG_CAPTURE_BASE_COMMIT:
              captureBaseCommit,
            REVIEW_ROUTER_ACTIVATION_CATALOG_AUDITED_HEAD: auditedHead,
          },
          repository.root,
        ),
      ).toEqual({
        disposableDatabaseIdentity: identity,
        captureBaseCommit,
        auditedHead,
      });
      for (const value of [undefined, "0", "true", "01"])
        expect(
          resolveRehearsalCaptureOnlyConfiguration(
            {
              REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:
                value,
              REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY:
                identity,
              REVIEW_ROUTER_ACTIVATION_CATALOG_CAPTURE_BASE_COMMIT:
                captureBaseCommit,
              REVIEW_ROUTER_ACTIVATION_CATALOG_AUDITED_HEAD: auditedHead,
            },
            repository.root,
          ),
        ).toBeUndefined();
      expect(() =>
        resolveRehearsalCaptureOnlyConfiguration(
          {
            REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:
              "1",
            REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY:
              "production",
            REVIEW_ROUTER_ACTIVATION_CATALOG_CAPTURE_BASE_COMMIT:
              captureBaseCommit,
            REVIEW_ROUTER_ACTIVATION_CATALOG_AUDITED_HEAD: auditedHead,
          },
          repository.root,
        ),
      ).toThrow(
        "activation_catalog_policy_candidate_disposable_identity_required",
      );
      expect(() =>
        resolveRehearsalCaptureOnlyConfiguration(
          {
            REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:
              "1",
            REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY:
              identity,
            REVIEW_ROUTER_ACTIVATION_CATALOG_CAPTURE_BASE_COMMIT: auditedHead,
            REVIEW_ROUTER_ACTIVATION_CATALOG_AUDITED_HEAD: auditedHead,
          },
          repository.root,
        ),
      ).toThrow("activation_catalog_policy_git_review_range_invalid");
    } finally {
      repository.cleanup();
    }
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
  it("binds an emitted candidate to the exact disposable capture checkpoint", () => {
    const artifact = {
      kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
      version: 1,
      policies: {},
    };
    const candidate = {
      commitSha: "a".repeat(40),
      databaseIdentity: "127.0.0.1:5432/review_router",
      manifestIdentity: canonicalReleaseMigrationArtifact.postManifestIdentity,
      projectionSha256: `sha256:${"b".repeat(64)}`,
      catalogDigest: `sha256:${"c".repeat(64)}`,
    };
    expect(
      createActivationCatalogCaptureCheckpoint({
        artifact,
        candidate,
        disposableIdentity: "rr-disposable-candidate-test",
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "d".repeat(64),
        captureBaseCommit: "9".repeat(40),
        auditedHead: candidate.commitSha,
      }),
    ).toEqual({
      kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
      version: 2,
      policies: artifact.policies,
      capture: {
        commitSha: candidate.commitSha,
        postManifestIdentity: candidate.manifestIdentity,
        database: {
          disposableIdentity: "rr-disposable-candidate-test",
          configuredIdentity: candidate.databaseIdentity,
          systemIdentifier: "7612345678901234567",
          recoveryWitnessSha256: "d".repeat(64),
        },
        projection: {
          sha256: candidate.projectionSha256,
          observedDigest: candidate.catalogDigest,
        },
        custody: {
          captureBaseCommit: "9".repeat(40),
          auditedHead: candidate.commitSha,
          evidenceSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      },
    });
    expect(candidate.catalogDigest).not.toBe(
      canonicalReleaseMigrationArtifact.postCatalogDigest,
    );
    expect(() =>
      createActivationCatalogCaptureCheckpoint({
        artifact,
        candidate,
        disposableIdentity: "production",
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "d".repeat(64),
        captureBaseCommit: "9".repeat(40),
        auditedHead: candidate.commitSha,
      }),
    ).toThrow("activation_catalog_policy_capture_binding_invalid");
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
  it("delegates capture-only fixture cleanup to the attested disposable admin adapter", () => {
    const executeSql = vi.fn(() => "cleaned");

    expect(
      cleanupCaptureOnlyRehearsalFixtures({
        executeSql,
      }),
    ).toBe("cleaned");
    expect(executeSql).toHaveBeenCalledWith(
      captureOnlyRehearsalFixtureCleanupSql(),
    );

    const failure = new Error("must be owner of table rehearsal_items");
    expect(() =>
      cleanupCaptureOnlyRehearsalFixtures({
        executeSql: vi.fn(() => {
          throw failure;
        }),
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
  it("captures after an exact disposable catalog-digest mismatch without staging or promotion", async () => {
    const candidate = Object.freeze({ kind: "candidate", version: 1 });
    const captureCandidate = vi.fn(async () => candidate);
    const stageTargetServices = vi.fn();
    const runReleaseMigration = vi.fn(async () => {
      throw new Error("activation_catalog_policy_capture_ready");
    });

    await expect(
      runRehearsalReleaseMigration({
        captureOnly: { disposableDatabaseIdentity: "rr-disposable-test" },
        rollout: { phase: "pre-migration" },
        runStage: vi.fn(async (_name, operation) => operation()),
        runReleaseMigration,
        captureCandidate,
        stageTargetServices,
      }),
    ).resolves.toEqual({ mode: "capture-only", candidate });
    expect(captureCandidate).toHaveBeenCalledOnce();
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
      "000072_retire_superseded_codex_setup_claims",
      "000072_runtime_canary_challenge",
      "000073_codex_oauth_active_namespace_refresh",
      "000079_codex_oauth_v4_v5_workflow_reattestation",
      "000080_codex_oauth_reattestation_mutation_owner_fence",
      "000081_codex_oauth_v4_v5_staged_compatibility",
    ]);
    expect(exclusions).not.toContain("000067_review_live_progress");
    expect(exclusions).not.toContain(
      "000068_validate_review_assignment_manifest",
    );
    expect(exclusions).not.toContain("000074_hosted_codex_account_pool");
    expect(exclusions).not.toContain(
      "000078_review_investigation_maintenance_checkpoint",
    );
    expect(
      migrationManifestIdentity(
        migrationNames.filter(
          (migrationName) => !exclusions.includes(migrationName),
        ),
      ),
    ).toBe(canonicalReleaseMigrationArtifact.preManifestIdentity);
    expect(migrationManifestIdentity(migrationNames)).toBe(
      canonicalReleaseMigrationArtifact.postManifestIdentity,
    );
    expect(() =>
      resolvePreReleaseMigrationExclusions([
        ...migrationNames,
        "000075_future_release_migration",
      ]),
    ).toThrow("private_pg17_rehearsal_migration_boundary_unclassified");
    expect(() =>
      resolvePreReleaseMigrationExclusions([
        ...migrationNames,
        "000075_future_review_migration",
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
      "releaseAuthorityBootstrapCleanupSql",
      "releaseAuthorityBootstrapTerminalSql",
      "private_pg17_rehearsal_authority_terminal_state_unproven",
      "private_pg17_rehearsal_authority_migration_postcondition_unproven",
      '"reviewrouter_release_control",\n        `SELECT json_build_object(',
      "activationAuthorityProvisioningSql",
      "reviewrouter_activation_permit_installer",
      "reviewrouter_activation_receipt_reader",
      "targetReceiptReaderPrisma",
      "durableActivationReceipt",
      "trustedDatabaseIdentity",
      "authorityOwnerRoleName",
      "installerRoutineBodySha256",
      "readerRoutineBodySha256",
      "reviewrouter_provider_authority",
      "reviewrouter_migration_issuer",
      "reviewrouter_bootstrap_administrator",
      "NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1",
      "GRANT pg_signal_backend TO reviewrouter_bootstrap_administrator",
      "reviewrouter_rehearsal_authority_bootstrap",
      "SET createrole_self_grant=''",
      "ALTER DATABASE review_router OWNER TO ${authorityBootstrapRole}",
      "releaseAuthorityProviderRootProbeSql",
      'rr_root_probe_${randomBytes(16).toString("hex")}',
      "releaseAuthorityBootstrapPreparationSql",
      "releaseAuthorityBootstrapProvisioningSql",
      "releaseAuthorityBootstrapRelinquishSql",
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
    expect(source).not.toContain(
      "SELECT count(*) FROM reviewrouter_activation.activation_receipt",
    );
    expect(source).toMatch(
      /const authorityProviderRoot[\s\S]+releaseAuthorityProviderRootProbeSql[\s\S]+releaseAuthorityBootstrapPreparationSql[\s\S]+releaseAuthorityBootstrapProvisioningSql[\s\S]+finally[\s\S]+releaseAuthorityBootstrapRelinquishSql[\s\S]+releaseAuthorityMigrationBundle[\s\S]+releaseAuthorityBootstrapCleanupSql[\s\S]+releaseAuthorityBootstrapTerminalSql/u,
    );
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
    expect(source).toContain("rehearsal_control_stage_started:health_ready");
    expect(source).toContain("expectedDatabaseIdentity");
    expect(source.indexOf('runStage("quiesce_source"')).toBeLessThan(
      source.indexOf('runStage("capture_source_backup"'),
    );
    const sourceReceiptSeed = source.indexOf(
      "persistRehearsalSourceOwnedReceipt(sql, source, sourceLegacyAmbiguity)",
    );
    const physicalDump = source.indexOf('"pg_dump"', sourceReceiptSeed);
    expect(sourceReceiptSeed).toBeGreaterThan(-1);
    expect(physicalDump).toBeGreaterThan(sourceReceiptSeed);
    expect(source).toContain(
      "CREATE TRIGGER source_legacy_ambiguity_receipt_immutable_guard",
    );
    expect(source).toContain(
      "CREATE FUNCTION release_authority.source_receipt_canonical_json(value jsonb)",
    );
    expect(source).toContain(
      "sourceSystemIdentifier,\n      sourceLegacyAmbiguity,",
    );
    expect(
      source.match(/= rehearsalLegacyAmbiguityReceipt\(\{/gu),
    ).toHaveLength(1);
    expect(source).toContain(
      "useCases.runReleaseMigration(rollout, sourceLegacyAmbiguity)",
    );
    expect(source).toContain(
      "REVIEW_ROUTER_MIGRATION_PERMIT_SOURCE_LEGACY_AMBIGUITY_BASE64URL",
    );
    expect(source).toContain(
      "Buffer.from(JSON.stringify(permit.sourceLegacyAmbiguity))",
    );
    expect(source).toContain(
      "REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF",
    );
    expect(source).toContain(
      "private_pg17_rehearsal_source_legacy_ambiguity_missing",
    );
    expect(source).toContain(
      "rehearsal_control_health_not_ready:status=${status}",
    );
    expect(source).toContain("rehearsal_canonical_postgres_error:${step}");
    expect(source).toContain("rehearsal_canonical_step_started:${safeStep}");
    expect(source).toContain("rehearsal_canonical_step_completed:${safeStep}");
    expect(source).toContain(
      '"rehearsal_migration_substep_started:configuration\\n"',
    );
    expect(source).toContain(
      '"rehearsal_migration_substep_completed:configuration\\n"',
    );
    expect(source).toContain('"rehearsal_migration_substep_started:permit\\n"');
    expect(source).toContain(
      '"rehearsal_migration_substep_completed:permit\\n"',
    );
    expect(source).toContain(
      "rehearsal_stage_failed:${safeName}:${safeRehearsalStageErrorDiagnostic(safeName, error)}",
    );
    expect(source).toContain(
      "migrationManifestIdentity:\n              current.activationReceipt.postManifestIdentity",
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
    expect(source).toMatch(
      /trustedActivationCatalogPolicies:\s+captureOnly\s+\? canonicalActivationCatalogPolicies\s+: authorizeCanonicalActivationCatalogPolicies/u,
    );
    expect(source).toContain(
      "const releaseCommitSha = facts.canonicalEnv.REVIEW_ROUTER_RELEASE_COMMIT_SHA",
    );
    expect(source).toContain("expectedCommitSha: releaseCommitSha");
    expect(source).toContain("commitSha: releaseCommitSha");
    expect(source).toContain("sourceCommitSha: releaseCommitSha");
    expect(source).toContain(
      "private_pg17_rehearsal_activation_catalog_policy_trust_root_blocked",
    );
    const releaseMigration = source.indexOf(
      "migratedRollout = await runStage(",
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
    expect(source).toContain("facts.sql(facts.targetContainer, statement)");
    expect(source).toContain(
      'if (captureOnly) sql(source, "DROP TABLE public.rehearsal_items CASCADE")',
    );
    expect(source).toContain(
      'sql(target, "DROP TABLE public.rehearsal_items CASCADE")',
    );
    expect(source).not.toContain(
      "ALTER TABLE rehearsal_items OWNER TO reviewrouter_role_bootstrap",
    );
    expect(source).toContain(
      `'reviewrouter_api','public."AuditEvent"','INSERT'`,
    );
    const stageTarget = source.indexOf(
      "useCases.stageTargetServices(migratedRollout)",
    );
    const activate = source.indexOf('runStage("activate_target_generation"');
    expect(releaseMigration).toBeGreaterThan(-1);
    expect(releaseMigration).toBeLessThan(marker);
    expect(releaseMigration).toBeLessThan(fixtureCleanup);
    expect(marker).toBeLessThan(fixtureCleanup);
    expect(fixtureCleanup).toBeLessThan(capture);
    expect(capture).toBeLessThan(stageTarget);
    expect(stageTarget).toBeLessThan(activate);
    const fixtureCleanupBranch = source.slice(
      fixtureCleanup,
      source.indexOf("const stdout = canonicalRun(", fixtureCleanup),
    );
    expect(fixtureCleanupBranch).toContain(
      "facts.sql(facts.targetContainer, statement)",
    );
    expect(fixtureCleanupBranch).not.toContain(
      "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
    );
    expect(fixtureCleanupBranch).not.toContain(
      "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
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
