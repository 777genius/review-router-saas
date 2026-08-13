import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateRehearsalConfiguration } from "./rehearse-private-pg17-rollout.mjs";

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
      "reviewrouter_provider_authority",
      "providerAuthorityPrisma",
      "Promise.allSettled",
      "private_pg17_rehearsal_authority_replay_unproven",
      "private_pg17_rehearsal_authority_conflict_unproven",
      "private_pg17_rehearsal_authority_outage_unproven",
      "private_pg17_rehearsal_authority_database_isolation_unproven",
      "sourceRecoveryManifestSha256",
      "targetServiceContractSha256",
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
    expect(installer.indexOf("000001_release_authority")).toBeLessThan(
      installer.indexOf("000002_external_effect_protocol"),
    );
    expect(
      installer.match(/000001_release_authority\/migration\.sql/gu),
    ).toHaveLength(1);
    expect(
      installer.match(/000002_external_effect_protocol\/migration\.sql/gu),
    ).toHaveLength(1);
    expect(installer.indexOf("000002_external_effect_protocol")).toBeLessThan(
      installer.indexOf("000002_transactional_service_transition"),
    );
    expect(
      installer.match(
        /000002_transactional_service_transition\/migration\.sql/gu,
      ),
    ).toHaveLength(1);
    expect(installer.indexOf("000003_partial_source_freeze")).toBeLessThan(
      installer.indexOf("000005_late_runner_effects"),
    );
    expect(
      installer.match(/000005_late_runner_effects\/migration\.sql/gu),
    ).toHaveLength(1);
    expect(installer.indexOf("000005_late_runner_effects")).toBeLessThan(
      installer.indexOf("000007_compensation_effect_fence"),
    );
    expect(
      installer.match(/000007_compensation_effect_fence\/migration\.sql/gu),
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
