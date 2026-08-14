import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createRehearsalRunnerJobBinding,
  validateRehearsalConfiguration,
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
      "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')",
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
      "runtimeGrantSql",
      "canonicalActivationSql",
      "assembleTrustedRolloutEvidence",
      "reconnectDenied",
      "beginCompensation",
      "assertPromotionAllowed",
      "REVIEW_ROUTER_DATABASE_URL_FILE",
      '"000069_release_rollout_ledger"',
      "private_pg17_rehearsal_source_migration_failed:exit=",
      "[redacted-database-url]",
      "redactedErrorChain",
    ])
      expect(source).toContain(required);
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
    expect(source).toContain(".slice(0, 2_000)");
  });
});
