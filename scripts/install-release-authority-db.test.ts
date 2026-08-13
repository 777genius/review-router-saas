import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  releaseAuthorityMigrationBundle,
  releaseAuthorityMigrationPaths,
} from "./install-release-authority-db.mjs";

describe("release authority database installation", () => {
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
    ]);
    expect(
      releaseAuthorityMigrationPaths.map((path) =>
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ),
    ).toEqual([
      "e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
      "cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e",
      "5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099",
      "28079c64266e1045c9db82743f82412d9630f6b97f3143fcbe7730c290c33e94",
      "c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97",
      "35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb",
      "e49fe0f8c161fbe39953f01e299c81a752a152809c2261815a639bcf732c428a",
      "99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9",
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
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(fourth).toBeGreaterThan(third);
    expect(fifth).toBeGreaterThan(fourth);
    expect(sixth).toBeGreaterThan(fifth);
    expect(seventh).toBeGreaterThan(sixth);
    expect(eighth).toBeGreaterThan(seventh);
    expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(bundle.match(/CREATE SCHEMA release_authority/gu)).toHaveLength(1);
    expect(bundle.match(/ADD COLUMN effect_state/gu)).toHaveLength(1);
    expect(
      bundle.match(/CREATE TABLE release_authority\.service_transition \(/gu),
    ).toHaveLength(1);
    expect(
      bundle.match(
        /CREATE FUNCTION release_authority\.release_source_freeze_prepare/gu,
      ),
    ).toHaveLength(1);
    expect(
      bundle.match(
        /CREATE FUNCTION release_authority\.release_source_freeze_complete/gu,
      ),
    ).toHaveLength(1);
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
