import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  releaseAuthorityMigrationBundle,
  releaseAuthorityMigrationManifest,
  releaseAuthorityMigrationPaths,
  postgresEnvironment,
} from "./install-release-authority-db.mjs";

describe("release authority database installation", () => {
  it("isolates owner psql from ambient PostgreSQL configuration", () => {
    const environment = postgresEnvironment(
      "postgresql://owner:secret@authority.internal/reviewrouter",
      {
        PATH: "/custom/bin",
        LANG: "en_US.UTF-8",
        PGSERVICE: "attacker",
        PGOPTIONS: "-c search_path=attacker",
        PGSSLMODE: "disable",
      },
    );
    expect(environment).toEqual({
      PATH: "/custom/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PGCONNECT_TIMEOUT: "10",
      PGSSLMODE: "require",
      PGHOST: "authority.internal",
      PGPORT: "5432",
      PGDATABASE: "reviewrouter",
      PGUSER: "owner",
      PGPASSWORD: "secret",
    });
    expect(environment).not.toHaveProperty("PGSERVICE");
    expect(environment).not.toHaveProperty("PGOPTIONS");
  });

  it("fails the database compensation gate on unresolved freeze effects", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql",
      "utf8",
    );
    expect(migration).toContain("phase IN ('intent','unchanged','suspended')");
    expect(migration).toContain("completed.phase='suspended'");
    expect(migration).toContain(
      "release runner effects unsafe for compensation",
    );
    expect(migration).toContain("source_freeze_completion");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_source_freeze_immutable() FROM PUBLIC;",
    );
  });
  it("installs the late-effect activation fence and forward-only persistence repair", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "release runner duplicate effects unsafe for activation",
    );
    expect(migration).toContain("rolloutStateAtPersistence");
    expect(migration).toContain("release_authority.release_runner_persist_job");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_runner_compensation_gate() FROM PUBLIC;",
    );
  });
  it("installs the provider creation not-before boundary without rewriting migration history", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql",
      "utf8",
    );
    expect(migration).toContain("provider_creation_not_before");
    expect(migration).toContain(
      "not_before IS DISTINCT FROM intent.created_at",
    );
    expect(migration).toContain(
      "providerCreatedAt')::timestamptz < current_row.provider_creation_not_before",
    );
  });
  it("rechecks late runner effects at every compensation boundary", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql",
      "utf8",
    );
    expect(migration).toContain("release_compensation_effects_are_safe");
    expect(migration).toContain("release_compensation_receipt_effect_gate");
    expect(migration).toContain("release_compensation_source_recovery_gate");
    expect(migration).toContain("sourceEligible',false");
    expect(migration).toContain(
      "WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;",
    );
    expect(migration.indexOf("DECLARE rollout_row")).toBeLessThan(
      migration.indexOf("DECLARE transition"),
    );
  });
  it("revokes public execution of the service transition trigger helper forward-only", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_service_transition_immutable() FROM PUBLIC;",
    );
  });
  it("moves published-file repairs into 000009 and records canonical or legacy byte identity", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TABLE release_authority.schema_migration",
    );
    expect(migration).toContain("legacy_equivalent");
    expect(migration).toContain(
      "sha256:eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
    );
    expect(migration).toContain(
      "sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
    );
    expect(migration).toContain(
      "receipt_sha256=current_row.last_receipt_sha256",
    );
    expect(migration).toContain("intent_rollout_id");
    expect(migration).toContain("release_schema_migration_manifest");
    expect(migration).toContain("complete catalog verification");
    expect(migration).toContain(
      "release_authority_catalog_fingerprint('release_authority')",
    );
  });
  it("identifies exact two-file catalogs before later migrations can erase byte evidence", () => {
    const bundle = releaseAuthorityMigrationBundle();
    expect(bundle).toContain("release_authority_verify_canonical");
    expect(bundle).toContain("release_authority_verify_legacy");
    expect(bundle).toContain("complete_catalog_v1");
    expect(bundle).toContain(
      "legacy catalog is ambiguous or modified; audited repair required",
    );
    expect(bundle).toContain("procedure.prosrc");
    expect(bundle).toContain("pg_catalog.pg_get_triggerdef");
    expect(bundle).toContain("pg_catalog.pg_get_constraintdef");
    expect(bundle).toContain("pg_catalog.pg_get_indexdef");
    expect(bundle).toContain("pg_catalog.aclexplode");
    expect(bundle).toContain("pg_catalog.pg_enum");
    expect(bundle).toContain("attribute.attacl");
    expect(bundle).toContain("pg_catalog.pg_get_function_arguments");
    const canonicalAudit = bundle.indexOf(
      "building verified catalog release_authority_verify_canonical",
    );
    const legacyAudit = bundle.indexOf(
      "building verified catalog release_authority_verify_legacy",
    );
    const auditsComplete = bundle.indexOf(
      "DROP SCHEMA release_authority_verify_legacy CASCADE",
    );
    const catchup = bundle.indexOf(
      "applying packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql",
      auditsComplete,
    );
    expect(canonicalAudit).toBeGreaterThan(-1);
    expect(legacyAudit).toBeGreaterThan(canonicalAudit);
    expect(auditsComplete).toBeGreaterThan(legacyAudit);
    expect(catchup).toBeGreaterThan(auditsComplete);
    expect(bundle.slice(canonicalAudit, auditsComplete)).not.toContain(
      "CREATE TABLE release_authority_verify_canonical.service_transition",
    );
    expect(bundle.slice(legacyAudit, auditsComplete)).not.toContain(
      "CREATE TABLE release_authority_verify_legacy.service_transition",
    );
    expect(
      bundle.indexOf("UPDATE release_authority_catalog_verification", catchup),
    ).toBeGreaterThan(catchup);
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            "packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql",
          ),
        )
        .digest("hex"),
    ).toBe("e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b");
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            "packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql",
          ),
        )
        .digest("hex"),
    ).toBe("cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e");
  });
  it("installs single-use rollout-first recovery effect permits", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
      "utf8",
    );
    expect(migration).toContain("release_recovery_effect_consume");
    expect(migration).toContain("release_late_job_recovery_effect_gate");
    expect(migration).toContain("release_recovery_checkpoint_permit_gate");
    expect(migration).toContain("state='forward_repair'");
  });
  it("applies the complete ordered migration chain exactly once in one transaction", () => {
    expect(releaseAuthorityMigrationPaths).toEqual([
      "packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql",
      "packages/platform/release-authority-db/migrations/000002_external_effect_protocol/migration.sql",
      "packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql",
      "packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql",
      "packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql",
      "packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql",
      "packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql",
      "packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql",
      "packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql",
      "packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql",
      "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
    ]);
    expect(
      releaseAuthorityMigrationPaths.map((path) =>
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ),
    ).toEqual([
      "eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
      "66a1cd48303f31691596ae4e64d952d0fe3543444d042b17243c1a60efb10201",
      "5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099",
      "02dcd03e3d86c362598537e2ac7afc1dff2d20713fa01158f65e02db621d0da5",
      "c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97",
      "35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb",
      "4ee3a75a1528870df6d66a24eded9fc588aed2681b82aef57335ad7bbadf1260",
      "99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9",
      "550e7c1e5f11bd795a867c03873d09a6b681c559f07b2101b8e8a3dbea3408c8",
      "f1b29f3ff66ef22ed91230f8295b53aaa642fed6e34c081d9c8f6ce3453723f4",
      "a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd",
    ]);
    const bundle = releaseAuthorityMigrationBundle();
    const first = bundle.indexOf("CREATE SCHEMA release_authority");
    const second = bundle.indexOf("ADD COLUMN effect_state");
    const third = bundle.indexOf(
      "CREATE TABLE release_authority.service_transition",
    );
    const fourth = bundle.indexOf(
      "CREATE TABLE release_authority.source_freeze_observation",
    );
    const fifth = bundle.indexOf(
      "CREATE TRIGGER release_source_resume_rollout_ownership_guard",
    );
    const sixth = bundle.indexOf("rolloutStateAtPersistence");
    const seventh = bundle.indexOf("runner_job_provider_creation_boundary");
    const eighth = bundle.indexOf("release_compensation_effects_are_safe");
    const ninth = bundle.indexOf(
      "REVOKE ALL ON FUNCTION release_authority.release_service_transition_immutable() FROM PUBLIC;",
      eighth,
    );
    const tenth = bundle.indexOf(
      "CREATE TABLE release_authority.schema_migration",
      ninth,
    );
    const eleventh = bundle.indexOf(
      "CREATE TABLE release_authority.recovery_effect",
      tenth,
    );
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(fourth).toBeGreaterThan(third);
    expect(fifth).toBeGreaterThan(fourth);
    expect(sixth).toBeGreaterThan(fifth);
    expect(seventh).toBeGreaterThan(sixth);
    expect(eighth).toBeGreaterThan(seventh);
    expect(ninth).toBeGreaterThan(eighth);
    expect(tenth).toBeGreaterThan(ninth);
    expect(eleventh).toBeGreaterThan(tenth);
    expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(bundle.match(/CREATE SCHEMA release_authority/gu)).toHaveLength(3);
    expect(bundle.match(/ADD COLUMN effect_state/gu)).toHaveLength(3);
    expect(
      bundle.match(/CREATE TABLE release_authority\.service_transition \(/gu),
    ).toHaveLength(2);
    expect(
      bundle.match(
        /CREATE FUNCTION release_authority\.release_source_freeze_prepare/gu,
      ),
    ).toHaveLength(2);
    expect(
      bundle.match(
        /CREATE FUNCTION release_authority\.release_source_freeze_complete/gu,
      ),
    ).toHaveLength(2);
  });

  it("keeps the static migration ledger identical to the immutable file bytes", () => {
    expect(
      releaseAuthorityMigrationManifest.map(
        ([migrationName, checksumSha256]) => ({
          migrationName,
          checksumSha256,
        }),
      ),
    ).toEqual(
      releaseAuthorityMigrationPaths.map((path) => ({
        migrationName: path.split("/").at(-2),
        checksumSha256: `sha256:${createHash("sha256")
          .update(readFileSync(path))
          .digest("hex")}`,
      })),
    );
    const bundle = releaseAuthorityMigrationBundle();
    expect(bundle).toContain("authority_forward_present");
    expect(bundle).toContain("release authority migration history mismatch");
    expect(bundle).toContain("position=1) IS DISTINCT FROM");
    expect(bundle).toContain("VALUES (11, '000010_recovery_effect_permits'");
  });

  it("requires rollout-owned suspension evidence for every source resume", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "release source resume lacks rollout suspension evidence",
    );
    expect(migration).toContain("release source recovery manifest mismatch");
    expect(migration).toContain("freeze_observation.phase = 'suspended'");
    expect(migration).toContain("checkpoint.step='source_resumed'");
  });
});
