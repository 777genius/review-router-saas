import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  releaseAuthorityAclFingerprintSql,
  releaseAuthorityCatalogFingerprintSql,
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
      `\n${releaseAuthorityAclFingerprintSql}\n\nCREATE FUNCTION pg_temp.release_authority_catalog_fingerprint`,
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
    const bundle = releaseAuthorityMigrationBundle();
    const fingerprintStart = bundle.indexOf(
      "CREATE TEMP TABLE release_authority_catalog_verification",
    );
    const fingerprintEnd = bundle.indexOf(
      "\\if :authority_schema_absent",
      fingerprintStart,
    );

    expect(fingerprintStart).toBeGreaterThan(-1);
    expect(fingerprintEnd).toBeGreaterThan(fingerprintStart);
    expect(bundle.slice(fingerprintStart, fingerprintEnd).trim())
      .toMatchInlineSnapshot(`
      "CREATE TEMP TABLE release_authority_catalog_verification (
        catalog_fingerprint text NOT NULL,
        byte_variant text NOT NULL CHECK (byte_variant IN ('canonical','legacy_equivalent')),
        verifier text NOT NULL CHECK (verifier = 'complete_catalog_v1')
      ) ON COMMIT DROP;

      CREATE FUNCTION pg_temp.release_authority_acl_fingerprint(p_acl aclitem[])
      RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $acl$
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'grantor',CASE WHEN acl.grantor=0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
          'grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
          'privilege_type',acl.privilege_type,
          'is_grantable',acl.is_grantable
        ) ORDER BY
          CASE WHEN acl.grantor=0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantor) END,
          CASE WHEN acl.grantee=0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
          acl.privilege_type,acl.is_grantable),'[]'::jsonb)
        FROM pg_catalog.aclexplode(CASE
          WHEN pg_catalog.cardinality(p_acl)>0 THEN p_acl
          ELSE NULL::aclitem[]
        END) acl
      $acl$;

      CREATE FUNCTION pg_temp.release_authority_catalog_fingerprint(p_schema text)
      RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $fingerprint$
        WITH target AS (
          SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname=p_schema
        ), records(kind, identity, definition) AS (
          SELECT 'schema', p_schema,
            jsonb_build_object(
              'owner', pg_catalog.pg_get_userbyid(nspowner),
              'acl',pg_temp.release_authority_acl_fingerprint(
                coalesce(nspacl,pg_catalog.acldefault('n',nspowner))))
          FROM target
          UNION ALL
          SELECT 'relation', relation.relname,
            jsonb_build_object(
              'kind',relation.relkind,'persistence',relation.relpersistence,
              'owner',pg_catalog.pg_get_userbyid(relation.relowner),
              'replicaIdentity',relation.relreplident,'rowSecurity',relation.relrowsecurity,
              'forceRowSecurity',relation.relforcerowsecurity,
              'options',coalesce(to_jsonb(relation.reloptions),'[]'::jsonb),
              'accessMethod',coalesce(access_method.amname,''),
              'tablespace',CASE WHEN relation.reltablespace=0 THEN ''
                ELSE pg_catalog.pg_tablespace_location(relation.reltablespace) END,
              'acl',pg_temp.release_authority_acl_fingerprint(
                coalesce(relation.relacl,pg_catalog.acldefault(
                  CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,
                  relation.relowner))),
              'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object(
                'position',attribute.attnum,'name',attribute.attname,
                'type',replace(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),p_schema,'release_authority'),
                'notNull',attribute.attnotnull,'identity',attribute.attidentity,
                'generated',attribute.attgenerated,'compression',attribute.attcompression,
                'collation',CASE WHEN attribute.attcollation=0 THEN ''
                  ELSE attribute.attcollation::regcollation::text END,
                'storage',attribute.attstorage,'statistics',attribute.attstattarget,
                'default',replace(coalesce(pg_catalog.pg_get_expr(default_record.adbin,default_record.adrelid),''),p_schema,'release_authority')
                ,'acl',pg_temp.release_authority_acl_fingerprint(attribute.attacl)
              ) ORDER BY attribute.attnum),'[]'::jsonb)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_record
                  ON default_record.adrelid=attribute.attrelid AND default_record.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
              'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(constraint_record.conname,
                constraint_record.contype,constraint_record.condeferrable,constraint_record.condeferred,
                constraint_record.convalidated,replace(pg_catalog.pg_get_constraintdef(constraint_record.oid,true),p_schema,'release_authority'))
                ORDER BY constraint_record.conname),'[]'::jsonb)
                FROM pg_catalog.pg_constraint constraint_record WHERE constraint_record.conrelid=relation.oid),
              'indexes',(SELECT coalesce(jsonb_agg(replace(pg_catalog.pg_get_indexdef(index_record.indexrelid),p_schema,'release_authority')
                ORDER BY index_record.indexrelid::regclass::text),'[]'::jsonb)
                FROM pg_catalog.pg_index index_record WHERE index_record.indrelid=relation.oid),
              'sequence',(SELECT jsonb_build_array(sequence_record.seqtypid::regtype::text,
                sequence_record.seqstart,sequence_record.seqincrement,sequence_record.seqmax,
                sequence_record.seqmin,sequence_record.seqcache,sequence_record.seqcycle)
                FROM pg_catalog.pg_sequence sequence_record WHERE sequence_record.seqrelid=relation.oid)
            )
          FROM pg_catalog.pg_class relation JOIN target ON target.oid=relation.relnamespace
          LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid=relation.relam
          UNION ALL
          SELECT 'function', procedure.oid::regprocedure::text,
            jsonb_build_object(
              'identityArgs',replace(pg_catalog.pg_get_function_identity_arguments(procedure.oid),p_schema,'release_authority'),
              'arguments',replace(pg_catalog.pg_get_function_arguments(procedure.oid),p_schema,'release_authority'),
              'result',replace(pg_catalog.pg_get_function_result(procedure.oid),p_schema,'release_authority'),
              'kind',procedure.prokind,'language',language.lanname,'volatility',procedure.provolatile,
              'strict',procedure.proisstrict,'securityDefiner',procedure.prosecdef,
              'leakproof',procedure.proleakproof,'parallel',procedure.proparallel,
              'cost',procedure.procost,'rows',procedure.prorows,
              'config',coalesce(to_jsonb(procedure.proconfig),'[]'::jsonb),
              'owner',pg_catalog.pg_get_userbyid(procedure.proowner),
              'source',replace(procedure.prosrc,p_schema,'release_authority'),
              'acl',pg_temp.release_authority_acl_fingerprint(
                coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)))
            )
          FROM pg_catalog.pg_proc procedure
          JOIN target ON target.oid=procedure.pronamespace
          JOIN pg_catalog.pg_language language ON language.oid=procedure.prolang
          UNION ALL
          SELECT 'trigger', relation.relname||'.'||trigger.tgname,
            jsonb_build_object('enabled',trigger.tgenabled,
              'definition',replace(pg_catalog.pg_get_triggerdef(trigger.oid,true),p_schema,'release_authority'))
          FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
          JOIN target ON target.oid=relation.relnamespace WHERE NOT trigger.tgisinternal
          UNION ALL
          SELECT 'type', type_record.typname,
            jsonb_build_object(
              'kind',type_record.typtype,'category',type_record.typcategory,
              'owner',pg_catalog.pg_get_userbyid(type_record.typowner),
              'notNull',type_record.typnotnull,'byValue',type_record.typbyval,
              'alignment',type_record.typalign,'storage',type_record.typstorage,
              'base',replace(CASE WHEN type_record.typbasetype=0 THEN '' ELSE type_record.typbasetype::regtype::text END,p_schema,'release_authority'),
              'element',replace(CASE WHEN type_record.typelem=0 THEN '' ELSE type_record.typelem::regtype::text END,p_schema,'release_authority'),
              'default',coalesce(type_record.typdefault,''),
              'acl',pg_temp.release_authority_acl_fingerprint(
                coalesce(type_record.typacl,pg_catalog.acldefault('T',type_record.typowner))),
              'enum',(SELECT coalesce(jsonb_agg(enum_record.enumlabel ORDER BY enum_record.enumsortorder),'[]'::jsonb)
                FROM pg_catalog.pg_enum enum_record WHERE enum_record.enumtypid=type_record.oid)
            )
          FROM pg_catalog.pg_type type_record JOIN target ON target.oid=type_record.typnamespace
        )
        SELECT coalesce(jsonb_agg(jsonb_build_array(kind,
          replace(identity,p_schema,'release_authority'),definition)
          ORDER BY kind,replace(identity,p_schema,'release_authority')),'[]'::jsonb)::text
        FROM records
      $fingerprint$;"
    `);
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
      "5e75a0deb033644c9a418082181dd9f21d65771cd47a7684f7497aa56e157107",
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
