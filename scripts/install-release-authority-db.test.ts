import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installReleaseAuthorityDatabase,
  releaseAuthorityAclFingerprintSql,
  releaseAuthorityCatalogFingerprintSql,
  releaseAuthorityMigrationBundle,
  releaseAuthorityMigrationManifest,
  releaseAuthorityMigrationPaths,
  postgresEnvironment,
} from "./install-release-authority-db.mjs";

describe("release authority database installation", () => {
  it("requires an explicit fresh-install or incremental-upgrade gate", () => {
    expect(() => releaseAuthorityMigrationBundle(undefined)).toThrow(
      "release_authority_migration_mode_required",
    );
    const fresh = releaseAuthorityMigrationBundle("fresh-install");
    const upgrade = releaseAuthorityMigrationBundle("incremental-upgrade");
    for (const bundle of [fresh, upgrade]) {
      expect(bundle).toContain(
        "pg_try_advisory_xact_lock(1381126735, 1381258071)",
      );
      expect(bundle).toContain("SET LOCAL lock_timeout = '5000ms'");
      expect(bundle).toContain("SET LOCAL statement_timeout = '120000ms'");
      expect(bundle).toContain("current_user IS DISTINCT FROM session_user");
      expect(bundle).toContain(
        "release authority migration caller is not the database owner session",
      );
      expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
      expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    }
    expect(fresh).toContain(
      "release authority fresh install requires an absent authority schema",
    );
    expect(upgrade).toContain(
      "release authority incremental upgrade requires an existing authority schema",
    );
    expect(upgrade).toContain(
      "release authority migration caller does not own the authority schema",
    );
  });

  it("bounds production timeout configuration", () => {
    expect(() =>
      releaseAuthorityMigrationBundle("incremental-upgrade", process.cwd(), {
        lockTimeoutMs: 99,
      }),
    ).toThrow("release_authority_lock_timeout_invalid");
    expect(() =>
      releaseAuthorityMigrationBundle("incremental-upgrade", process.cwd(), {
        lockTimeoutMs: 2_000,
        statementTimeoutMs: 2_000,
      }),
    ).toThrow("release_authority_statement_timeout_invalid");
  });

  it("fails closed on global and schema-scoped creating-owner default ACLs before DDL", () => {
    for (const mode of ["fresh-install", "incremental-upgrade"] as const) {
      const bundle = releaseAuthorityMigrationBundle(mode);
      const gate = bundle.indexOf("DO $default_acl_gate$");
      const firstAuthorityDdl = bundle.indexOf(
        "CREATE SCHEMA release_authority",
      );
      expect(gate).toBeGreaterThan(bundle.indexOf("DO $upgrade_gate$"));
      expect(gate).toBeLessThan(firstAuthorityDdl);
      expect(bundle).toContain("pg_catalog.pg_default_acl");
      expect(bundle).toContain("WITH relevant_owners(owner_oid) AS");
      expect(bundle).toContain(
        "default_acl.defaclrole IN (SELECT owner_oid FROM relevant_owners)",
      );
      expect(bundle).toContain(
        "default_acl.defaclnamespace IN\n        (0,coalesce(pg_catalog.to_regnamespace('release_authority')::oid,0))",
      );
      for (const kind of ["r", "S", "f", "T"])
        expect(bundle).toContain(`'${kind}'::"char"`);
      expect(bundle).toContain(
        "release authority creating owner default ACL is noncanonical",
      );
    }
  });

  it("independently gates activation on the explicit final object ACL matrix", () => {
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    const finalGate = bundle.indexOf("DO $final_catalog$");
    const attestation = bundle.indexOf(
      "COMMENT ON SCHEMA release_authority",
      finalGate,
    );
    expect(finalGate).toBeGreaterThan(-1);
    expect(attestation).toBeGreaterThan(finalGate);
    expect(bundle.slice(finalGate, attestation)).toContain(
      "release authority final default ACL is noncanonical",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "release authority final object ACL matrix mismatch",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "attribute.attacl IS NOT NULL",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "type_record.typacl IS NOT NULL",
    );
    expect(bundle.slice(finalGate, attestation)).toContain("acl.is_grantable");
    expect(bundle.slice(finalGate, attestation)).toContain(
      "acl.grantor<>target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "relation.relowner=target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "sequence.relowner=target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "procedure.proowner=target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "pg_catalog.pg_auth_members",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "reviewrouter_release_control",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "reviewrouter_provider_authority",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "reviewrouter_release_witness",
    );
  });

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

  it("never propagates database URLs or raw subprocess output on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-authority-gate-"));
    try {
      const credentialFile = join(directory, "database-url");
      const fakePsql = join(directory, "psql");
      writeFileSync(
        credentialFile,
        "postgresql://owner:credential-canary@authority.internal/reviewrouter",
        { mode: 0o600 },
      );
      writeFileSync(
        fakePsql,
        "#!/bin/sh\nprintf '%s\\n' 'postgresql://owner:credential-canary@authority.internal/reviewrouter' >&2\nexit 7\n",
        { mode: 0o700 },
      );
      chmodSync(fakePsql, 0o700);
      expect(() =>
        installReleaseAuthorityDatabase({
          PATH: process.env.PATH,
          REVIEW_ROUTER_PSQL_BINARY: fakePsql,
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE: "incremental-upgrade",
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE:
            credentialFile,
        }),
      ).toThrow("release_authority_migration_failed:exit=7");
      try {
        installReleaseAuthorityDatabase({
          PATH: process.env.PATH,
          REVIEW_ROUTER_PSQL_BINARY: fakePsql,
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE: "incremental-upgrade",
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE:
            credentialFile,
        });
      } catch (error) {
        expect(String(error)).not.toContain("credential-canary");
        expect(String(error)).not.toContain("postgresql://");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    expect(bundle).toContain("release_authority_verify_canonical");
    expect(bundle).toContain("release_authority_verify_legacy");
    expect(bundle).toContain("complete_catalog_v3_acl_exact");
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
  it("serializes ACL rows canonically without passing empty arrays to aclexplode", () => {
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "jsonb_agg(jsonb_build_object(",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain("'grantor'");
    expect(releaseAuthorityAclFingerprintSql).toContain("'grantee'");
    expect(releaseAuthorityAclFingerprintSql).toContain("'privilege_type'");
    expect(releaseAuthorityAclFingerprintSql).toContain("'is_grantable'");
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "WHEN acl.grantee=0 THEN 'PUBLIC'",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "acl.privilege_type,acl.is_grantable),'[]'::jsonb",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "pg_catalog.cardinality(p_acl)>0",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain("ELSE NULL::aclitem[]");
    expect(releaseAuthorityAclFingerprintSql).not.toContain(
      "jsonb_build_array",
    );
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      `\n${releaseAuthorityAclFingerprintSql}\n\nCREATE OR REPLACE FUNCTION pg_temp.release_authority_catalog_fingerprint`,
    );
    expect(releaseAuthorityCatalogFingerprintSql).not.toContain(
      "'{}'::aclitem[]",
    );
    expect(
      releaseAuthorityCatalogFingerprintSql.match(
        /pg_temp\.release_authority_acl_fingerprint\(/gu,
      ),
    ).toHaveLength(6);
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      "coalesce(nspacl,pg_catalog.acldefault('n',nspowner))",
    );
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      "coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))",
    );
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      "coalesce(type_record.typacl,pg_catalog.acldefault('T',type_record.typowner))",
    );
  });
  it("emits the complete production catalog fingerprint SQL", () => {
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    const fingerprintStart = bundle.indexOf(
      "CREATE TEMP TABLE release_authority_catalog_verification",
    );
    const fingerprintEnd = bundle.indexOf(
      "\\if :authority_schema_absent",
      fingerprintStart,
    );

    expect(fingerprintStart).toBeGreaterThan(-1);
    expect(fingerprintEnd).toBeGreaterThan(fingerprintStart);
    const fingerprint = bundle.slice(fingerprintStart, fingerprintEnd).trim();
    expect(fingerprint).toContain(
      "verifier text NOT NULL CHECK (verifier IN ('complete_catalog_v1','complete_catalog_v3_acl_exact'))",
    );
    expect(fingerprint).toContain("SELECT 'default_acl', p_schema");
    expect(fingerprint).toContain("pg_catalog.pg_default_acl default_acl");
    expect(fingerprint).toContain("default_acl.defaclobjtype=ANY");
    expect(fingerprint).toContain("SELECT 'schema', p_schema");
    expect(fingerprint).toContain("SELECT 'relation', relation.relname");
    expect(fingerprint).toContain(
      "SELECT 'function', procedure.oid::regprocedure::text",
    );
    expect(fingerprint).toContain("SELECT 'type', type_record.typname");
  });
  it("installs single-use rollout-first recovery effect permits", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
      "utf8",
    );
    expect(migration).toContain("release_recovery_effect_consume");
    expect(migration).toContain("release_recovery_effect_validate_execution");
    expect(migration).toContain("execution_receipt_sha256");
    expect(migration).toContain("state='executing'");
    expect(migration).toContain("release_recovery_effect_reconcile");
    expect(migration).toContain("release_late_job_recovery_effect_gate");
    expect(migration).toContain("release_recovery_checkpoint_permit_gate");
    expect(migration).toContain("state='forward_repair'");
  });
  it("removes implicit PUBLIC usage from the declared authority type", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000011_default_and_final_acl_exactness/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TYPE release_authority.aggregate_state FROM PUBLIC",
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
      "packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql",
      "packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql",
      "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
      "packages/platform/release-authority-db/migrations/000011_default_and_final_acl_exactness/migration.sql",
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
      "5e75a0deb033644c9a418082181dd9f21d65771cd47a7684f7497aa56e157107",
      "727a6615bb6c1af3aee4e69ed33648726b581adb4f4b2f7610be9f5518347420",
    ]);
    const bundle = releaseAuthorityMigrationBundle("fresh-install");
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
    const twelfth = bundle.indexOf(
      "REVOKE ALL ON TYPE release_authority.aggregate_state FROM PUBLIC",
      eleventh,
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
    expect(twelfth).toBeGreaterThan(eleventh);
    expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(bundle.match(/CREATE SCHEMA release_authority/gu)).toHaveLength(4);
    expect(bundle.match(/ADD COLUMN effect_state/gu)).toHaveLength(4);
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

  it("keeps clean fresh install, clean upgrade, and idempotent replay deterministic", () => {
    const fresh = releaseAuthorityMigrationBundle("fresh-install");
    const upgrade = releaseAuthorityMigrationBundle("incremental-upgrade");
    expect(releaseAuthorityMigrationBundle("fresh-install")).toBe(fresh);
    expect(releaseAuthorityMigrationBundle("incremental-upgrade")).toBe(
      upgrade,
    );
    for (const bundle of [fresh, upgrade]) {
      expect(bundle).toContain("authority_forward_11_present");
      expect(bundle).toContain("authority_forward_12_present");
      expect(bundle).toContain(
        "release authority forward migration 12 already present",
      );
      expect(bundle).toContain(
        "release authority final object ACL matrix mismatch",
      );
      expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    }
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
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    expect(bundle).toContain("authority_forward_11_present");
    expect(bundle).toContain("authority_forward_12_present");
    expect(bundle).toContain("release authority migration history mismatch");
    expect(bundle).toContain("position=1) IS DISTINCT FROM");
    expect(bundle).toContain("VALUES (11, '000010_recovery_effect_permits'");
    expect(bundle).toContain(
      "VALUES (12, '000011_default_and_final_acl_exactness'",
    );
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
