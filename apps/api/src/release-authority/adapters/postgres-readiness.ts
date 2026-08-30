import { Prisma } from "@prisma/client";
import { releaseAuthoritySchemaVersion } from "@reviewrouter/features-release-rollout";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ReleaseAuthorityDatabaseReadiness } from "../application/readiness.js";
import type { RuntimeDatabaseIdentity } from "../domain/database-identity.js";
import { releaseAuthorityCatalogVerifier } from "../domain/readiness-contract.mjs";
import { releaseAuthorityReadOnlyCatalogDigestExpression } from "./catalog-fingerprint.mjs";
import {
  releaseAuthorityDefaultAclExactExpression,
  releaseAuthorityProviderTerminalTopologyExactExpression,
  releaseAuthorityRuntimeAclExactExpression,
} from "./acl-policy-postgres.mjs";
import { fencedLiveV70V73CatalogDigestSql } from "@reviewrouter/features-release-rollout/adapters/live-v70-v72-catalog-digest";

export type ReleaseAuthorityReadinessConnection = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "$executeRawUnsafe"
>;

type DatabaseIdentityProbe = Readonly<{
  roleName: string;
  authorityOwnerRoleName: string;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  postgresMajor: number;
  authorityPresent: boolean;
  installerRoutine: boolean;
  readerRoutine: boolean;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
  applicationMigrationManifestIdentity: string;
  applicationPostCatalogDigest: string;
  activationNamespaceFingerprint: string;
  authorityRoleTopologyExact: boolean;
  activationMigrationBoundaryExact: boolean;
  activationBootstrapRoutinePrivilegesExact: boolean;
  activationBootstrapRoleDemotedExact: boolean;
  activationGuardCatalogReadExact: boolean;
  activationApplicationOwnershipExact: boolean;
  activationRecoveryWitnessExact: boolean;
  activationRuntimePrivilegesExact: boolean;
}>;

type DatabaseIdentityFacts = Pick<
  DatabaseIdentityProbe,
  | "roleName"
  | "authorityOwnerRoleName"
  | "systemIdentifier"
  | "recoveryWitnessSha256"
  | "databaseIdentity"
  | "postgresMajor"
>;

type ReleaseAuthorityExactness = Omit<
  ReleaseAuthorityDatabaseReadiness,
  keyof DatabaseIdentityFacts
>;

const absentAuthorityReadiness = (
  probe: DatabaseIdentityProbe,
): ReleaseAuthorityDatabaseReadiness => {
  const {
    activationMigrationBoundaryExact,
    activationBootstrapRoutinePrivilegesExact,
    activationBootstrapRoleDemotedExact,
    activationGuardCatalogReadExact,
    activationApplicationOwnershipExact,
    activationRecoveryWitnessExact,
    ...identity
  } = probe;
  const preMigrationPermitBoundaryExact =
    activationMigrationBoundaryExact &&
    activationGuardCatalogReadExact &&
    activationRecoveryWitnessExact;
  return {
    ...identity,
    preMigrationPermitBoundaryExact,
    activationGuardExact:
      preMigrationPermitBoundaryExact &&
      activationBootstrapRoutinePrivilegesExact &&
      activationBootstrapRoleDemotedExact &&
      activationApplicationOwnershipExact,
    schemaVersion: 0,
    migrationManifest: [],
    catalogFingerprint: "",
    expectedCatalogFingerprint: "",
    catalogVerifier: "",
    catalogExact: false,
    defaultAclExact: false,
    finalAclExact: false,
    controlRoutine: false,
    providerRoutine: false,
    externalEffectProtocol: false,
    sourceFreezeProtocol: false,
    selectiveRecoveryProtocol: false,
    lateRunnerEffectProtocol: false,
    recoveryEffectProtocol: false,
    compensationCheckpointDefinition: false,
    runnerProviderBoundary: false,
    cleanupWitnessTemporalSemantics: false,
    requiredTriggers: false,
    authorityOwnershipExact: false,
    authorityAclExact: false,
    publicAuthorityRevoked: false,
    authorityTablesRevoked: false,
  };
};

export const observeReleaseAuthorityDatabaseReadinessOnConnection = async (
  prisma: ReleaseAuthorityReadinessConnection,
  signal?: AbortSignal,
): Promise<ReleaseAuthorityDatabaseReadiness> => {
  signal?.throwIfAborted();
  // Function and operator names are resolved while PostgreSQL parses a
  // statement. Establish the trusted namespace before parsing any catalog
  // projection; a set_config CTE inside that projection is too late.
  await prisma.$executeRawUnsafe("SET LOCAL search_path = pg_catalog, pg_temp");
  signal?.throwIfAborted();
  const activationCatalogDigest =
    releaseAuthorityReadOnlyCatalogDigestExpression("reviewrouter_activation");
  const probeRows = await prisma.$queryRaw<DatabaseIdentityProbe[]>(Prisma.sql`
    SELECT current_user AS "roleName",
      (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
      coalesce(CASE
        WHEN pg_catalog.pg_input_is_valid(pg_catalog.shobj_description(
          (SELECT oid FROM pg_database WHERE datname=current_database()),
          'pg_database'
        ), 'jsonb')
        THEN pg_catalog.shobj_description(
          (SELECT oid FROM pg_database WHERE datname=current_database()),
          'pg_database'
        )::jsonb->>'recoveryWitnessSha256'
        ELSE ''
      END,'') AS "recoveryWitnessSha256",
      jsonb_build_object(
        'serverIdentity', (SELECT system_identifier::text FROM pg_control_system()),
        'databaseIdentity', (SELECT oid::text FROM pg_database
          WHERE datname=current_database()),
        'databaseName', current_database()
      ) AS "databaseIdentity",
      current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
      coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace
        WHERE nspname='release_authority'),'') AS "authorityOwnerRoleName",
      to_regnamespace('release_authority') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_class authority_root
          JOIN pg_catalog.pg_namespace authority_namespace
            ON authority_namespace.oid=authority_root.relnamespace
          WHERE authority_namespace.nspname='release_authority'
            AND authority_root.relname='rollout'
            AND authority_root.relkind IN ('r','p')
        )
        AS "authorityPresent",
      coalesce((SELECT encode(sha256(convert_to(string_agg(body_sha256, ':' ORDER BY ordinal),'UTF8')),'hex')
        FROM (VALUES
          (1,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)')),'')),
          (2,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.canonical_json(jsonb)')),'')),
          (3,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.project_effective_principal_authority(text)')),'')),
          (4,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate(text)')),'')),
          (5,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()')),'')),
          (6,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)')),'')),
          (7,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)')),'')),
          (8,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.apply_runtime_database_acl(text)')),'')),
          (9,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.activate_generation(text)')),'')),
          (10,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)')),'')),
          (11,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)')),'')),
          (12,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)')),'')),
          (13,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)')),'')),
          (14,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.read_migration_receipt(text,bigint,text)')),''))
        ) bodies(ordinal,body_sha256)),'')
        AS "installerRoutineBodySha256",
      coalesce((SELECT encode(sha256(convert_to(string_agg(body_sha256, ':' ORDER BY ordinal),'UTF8')),'hex')
        FROM (VALUES
          (1,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.canonical_json(jsonb)')),'')),
          (2,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)')),'')),
          (3,coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('reviewrouter_activation.read_activation_receipt(text)')),''))
        ) bodies(ordinal,body_sha256)),'')
        AS "readerRoutineBodySha256",
      '' AS "applicationMigrationManifestIdentity",
      '' AS "applicationPostCatalogDigest",
      CASE WHEN to_regnamespace('reviewrouter_activation') IS NULL THEN ''
        ELSE 'sha256:' || ${Prisma.raw(activationCatalogDigest)} END
        AS "activationNamespaceFingerprint",
      false AS "authorityRoleTopologyExact",
      coalesce((SELECT count(*)=4 AND bool_and(c.relkind='r'
          AND c.relowner=guard.oid
          AND (SELECT count(*) FROM pg_attribute attribute
            WHERE attribute.attrelid=c.oid AND attribute.attnum>0
              AND NOT attribute.attisdropped) = CASE c.relname
                WHEN 'activation_permit' THEN 15
                WHEN 'activation_receipt' THEN 22
                WHEN 'activation_principal_evidence' THEN 23
                WHEN 'migration_permit' THEN 19
              END
          AND NOT EXISTS (SELECT 1 FROM unnest(CASE c.relname
              WHEN 'activation_permit' THEN ARRAY['rollout_id','source_system_identifier',
                'target_system_identifier','postgres_major','expected_commit_sha',
                'migration_checksum','target_deploy_ids','permit_epoch','permit_nonce',
                'preactivation_catalog_policy','preactivation_catalog_policy_sha256',
                'activated_catalog_policy','activated_catalog_policy_sha256',
                'installed_at','consumed_at']
              WHEN 'activation_receipt' THEN ARRAY['rollout_id','source_system_identifier',
                'target_system_identifier','postgres_major','expected_commit_sha',
                'migration_checksum','target_deploy_ids','permit_epoch','permit_nonce',
                'canonical_privileges_sha256','catalog_facts_sha256',
                'preactivation_catalog_policy','preactivation_catalog_policy_sha256',
                'activated_catalog_policy','activated_catalog_policy_sha256',
                'before_principal_inventory_sha256','before_principal_policy_sha256',
                'activated_principal_inventory_sha256','activated_principal_policy_sha256',
                'first_write_receipt_sha256','transaction_id','activated_at']
              WHEN 'activation_principal_evidence' THEN ARRAY['rollout_id',
                'source_system_identifier','target_system_identifier','postgres_major',
                'expected_commit_sha','migration_checksum','target_deploy_ids',
                'permit_epoch','permit_nonce',
                'preactivation_catalog_policy','preactivation_catalog_policy_sha256',
                'activated_catalog_policy','activated_catalog_policy_sha256',
                'before_inventory','before_policy','activated_inventory','activated_policy',
                'before_principal_inventory_sha256','before_principal_policy_sha256',
                'activated_principal_inventory_sha256','activated_principal_policy_sha256',
                'transaction_id','staged_at']
              WHEN 'migration_permit' THEN ARRAY['rollout_id','source_system_identifier',
                'target_system_identifier','target_database_identity','target_database_name',
                'target_recovery_witness_sha256','transition_sha256','previous_receipt_sha256',
                'expected_post_manifest_identity','expected_post_catalog_digest',
                'source_legacy_ambiguity','eligibility_cutoff',
                'permit_epoch','permit_nonce','state','target_receipt','installed_at',
                'consumed_at','terminalized_at']
              END) expected_column
            WHERE NOT EXISTS (SELECT 1 FROM pg_attribute attribute
              WHERE attribute.attrelid=c.oid AND attribute.attnum>0
                AND NOT attribute.attisdropped
                AND attribute.attname=expected_column))
          AND NOT EXISTS (SELECT 1 FROM pg_attribute attribute
            LEFT JOIN pg_attrdef default_record
              ON default_record.adrelid=attribute.attrelid
                AND default_record.adnum=attribute.attnum
            WHERE attribute.attrelid=c.oid AND attribute.attnum>0
              AND NOT attribute.attisdropped AND (
                attribute.atttypid IS DISTINCT FROM CASE
                  WHEN attribute.attname IN ('postgres_major') THEN 'integer'::regtype
                  WHEN attribute.attname IN ('target_deploy_ids','preactivation_catalog_policy',
                    'activated_catalog_policy','before_inventory','before_policy',
                    'activated_inventory','activated_policy','target_receipt',
                    'source_legacy_ambiguity') THEN 'jsonb'::regtype
                  WHEN attribute.attname IN ('permit_epoch','transaction_id') THEN 'bigint'::regtype
                  WHEN attribute.attname IN ('installed_at','consumed_at','terminalized_at',
                    'eligibility_cutoff',
                    'activated_at','staged_at') THEN 'timestamptz'::regtype
                  ELSE 'text'::regtype END
                OR attribute.attnotnull IS DISTINCT FROM
                  (attribute.attname NOT IN ('consumed_at','terminalized_at','target_receipt'))
                OR coalesce(pg_get_expr(default_record.adbin,default_record.adrelid),'')
                  IS DISTINCT FROM CASE
                    WHEN attribute.attname IN ('installed_at','activated_at','staged_at')
                      THEN 'transaction_timestamp()'
                    WHEN attribute.attname='state' AND c.relname='migration_permit'
                      THEN '''installed''::text'
                    ELSE '' END))
          AND (SELECT jsonb_object_agg(contype,count ORDER BY contype)
            FROM (SELECT constraint_record.contype, count(*) AS count
              FROM pg_constraint constraint_record
              WHERE constraint_record.conrelid=c.oid
                AND constraint_record.convalidated
              GROUP BY constraint_record.contype) constraint_counts)
            = CASE c.relname
                WHEN 'activation_permit' THEN '{"c":12,"p":1,"u":1}'::jsonb
                WHEN 'activation_receipt' THEN '{"c":1,"p":1,"u":1}'::jsonb
                WHEN 'activation_principal_evidence' THEN '{"p":1}'::jsonb
                WHEN 'migration_permit' THEN '{"c":15,"p":1,"u":1}'::jsonb
              END
          AND EXISTS (SELECT 1 FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid=c.oid AND constraint_record.contype='p'
              AND ARRAY(SELECT attribute.attname::text
                FROM unnest(constraint_record.conkey) WITH ORDINALITY keyed(attnum,ordinality)
                JOIN pg_attribute attribute ON attribute.attrelid=c.oid
                  AND attribute.attnum=keyed.attnum ORDER BY keyed.ordinality)
                = ARRAY['rollout_id'])
          AND (c.relname='activation_principal_evidence' OR EXISTS (SELECT 1 FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid=c.oid AND constraint_record.contype='u'
              AND ARRAY(SELECT attribute.attname::text
                FROM unnest(constraint_record.conkey) WITH ORDINALITY keyed(attnum,ordinality)
                JOIN pg_attribute attribute ON attribute.attrelid=c.oid
                  AND attribute.attnum=keyed.attnum ORDER BY keyed.ordinality)
                = CASE c.relname
                    WHEN 'activation_permit' THEN ARRAY['permit_epoch','permit_nonce']
                    WHEN 'activation_receipt' THEN ARRAY['target_system_identifier']
                    WHEN 'migration_permit' THEN ARRAY['permit_epoch','permit_nonce']
                  END))
          AND NOT EXISTS (
            SELECT 1
            FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
            WHERE acl.grantee<>c.relowner
          )
          AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE',
              'DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
            WHERE has_table_privilege('public',c.oid,privilege))
          AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE',
              'DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
            WHERE has_table_privilege(installer.oid,c.oid,privilege))
          AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE',
              'DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
            WHERE has_table_privilege(reader.oid,c.oid,privilege)))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN pg_roles guard CROSS JOIN pg_roles installer
        CROSS JOIN pg_roles reader WHERE n.nspname='reviewrouter_activation'
          AND guard.rolname='reviewrouter_activation_receipt_guard'
          AND installer.rolname='reviewrouter_activation_permit_installer'
          AND reader.rolname='reviewrouter_activation_receipt_reader'
          AND c.relname IN ('activation_permit','activation_receipt',
            'activation_principal_evidence','migration_permit')),false)
        AND coalesce((SELECT n.nspowner=guard.oid AND NOT EXISTS (
            SELECT 1 FROM unnest(ARRAY['USAGE','CREATE']) privilege
            WHERE has_schema_privilege('public',n.oid,privilege))
            AND NOT EXISTS (SELECT 1
              FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
              WHERE acl.is_grantable AND acl.grantee<>n.nspowner
                OR acl.privilege_type='CREATE' AND acl.grantee<>n.nspowner
                OR acl.privilege_type='USAGE' AND acl.grantee<>n.nspowner
                  AND NOT EXISTS (SELECT 1 FROM pg_roles grantee
                    WHERE grantee.oid=acl.grantee AND grantee.rolname=ANY(ARRAY[
                      'reviewrouter_activation_permit_installer',
                      'reviewrouter_activation_receipt_reader','reviewrouter_role_bootstrap',
                      'reviewrouter_release_migration',
                      'reviewrouter_release_schema_owner'])))
          FROM pg_namespace n CROSS JOIN pg_roles guard
          WHERE n.nspname='reviewrouter_activation'
            AND guard.rolname='reviewrouter_activation_receipt_guard'),false)
        AND coalesce((SELECT count(*)=8 AND bool_and(p.prosecdef
            AND p.prokind='f' AND p.proowner=guard.oid
            AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
            AND l.lanname=CASE WHEN p.oid=to_regprocedure(
                'reviewrouter_activation.canonical_json(jsonb)')
              THEN 'sql' ELSE 'plpgsql' END
            AND p.provolatile=CASE
              WHEN p.oid=to_regprocedure('reviewrouter_activation.canonical_json(jsonb)')
                THEN 'i'::"char"
              WHEN p.oid IN (
                to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()'),
                to_regprocedure('reviewrouter_activation.project_effective_principal_authority(text)'),
                to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)'))
                THEN 's'::"char" ELSE 'v'::"char" END
            AND p.prorettype=CASE
              WHEN p.oid=to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()')
                THEN 'void'::regtype
              WHEN p.oid=to_regprocedure('reviewrouter_activation.canonical_json(jsonb)')
                THEN 'text'::regtype
              WHEN p.oid=to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)')
                THEN to_regtype('reviewrouter_activation.activation_principal_evidence')
              WHEN p.oid=to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)')
                THEN 'boolean'::regtype ELSE 'jsonb'::regtype END
            AND NOT has_function_privilege('public',p.oid,'EXECUTE')
            AND has_function_privilege('reviewrouter_release_migration',p.oid,'EXECUTE')
              IS NOT DISTINCT FROM (p.oid IN (
                to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)'),
                to_regprocedure('reviewrouter_activation.activate_generation(text)'),
                to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()')))
            AND (p.oid=to_regprocedure(
                  'reviewrouter_activation.assert_no_activation_receipt()')
                AND EXISTS (SELECT 1
                  FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                  JOIN pg_roles grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
                    AND NOT acl.is_grantable
                    AND grantee.rolname='reviewrouter_role_bootstrap')
              OR p.oid IN (
                  to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)'),
                  to_regprocedure('reviewrouter_activation.activate_generation(text)'),
                  to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()'))
                AND EXISTS (SELECT 1
                  FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                  JOIN pg_roles grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
                    AND NOT acl.is_grantable
                    AND grantee.rolname='reviewrouter_release_migration')
              OR p.oid=to_regprocedure(
                  'reviewrouter_activation.capture_catalog_policy_candidate(text)')
                AND EXISTS (SELECT 1
                  FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                  JOIN pg_roles grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
                    AND NOT acl.is_grantable
                    AND grantee.rolname='reviewrouter_release_schema_owner')
              OR p.oid NOT IN (
                  to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()'),
                  to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)'),
                  to_regprocedure('reviewrouter_activation.activate_generation(text)'),
                  to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate(text)'),
                  to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()'))
                AND NOT EXISTS (SELECT 1
                  FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                  WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner))
            AND NOT EXISTS (SELECT 1
              FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
              WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
                AND (acl.is_grantable
                  OR grantee.rolname IS DISTINCT FROM CASE
                    WHEN p.oid=to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()')
                      THEN 'reviewrouter_role_bootstrap'
                    WHEN p.oid IN (
                      to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)'),
                      to_regprocedure('reviewrouter_activation.activate_generation(text)'),
                      to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()'))
                      THEN 'reviewrouter_release_migration'
                    WHEN p.oid=to_regprocedure(
                      'reviewrouter_activation.capture_catalog_policy_candidate(text)')
                      THEN 'reviewrouter_release_schema_owner'
                    ELSE NULL END)))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_language l ON l.oid=p.prolang
          CROSS JOIN pg_roles guard WHERE n.nspname='reviewrouter_activation'
            AND guard.rolname='reviewrouter_activation_receipt_guard'
            AND p.oid IN (to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()'),
              to_regprocedure('reviewrouter_activation.canonical_json(jsonb)'),
              to_regprocedure('reviewrouter_activation.project_effective_principal_authority(text)'),
              to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate(text)'),
              to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()'),
              to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)'),
              to_regprocedure('reviewrouter_activation.activate_generation(text)'),
              to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)'))),false)
        AND coalesce((SELECT count(*)=5 AND bool_and(p.prosecdef
            AND p.prokind='f' AND p.proowner=guard.oid
            AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
            AND l.lanname='plpgsql'
            AND p.provolatile=CASE WHEN p.oid=to_regprocedure(
              'reviewrouter_activation.read_migration_receipt(text,bigint,text)')
              THEN 's'::"char" ELSE 'v'::"char" END
            AND p.prorettype=CASE
              WHEN p.oid IN (
                to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)'))
                THEN 'boolean'::regtype
              WHEN p.oid=to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)')
                THEN 'text'::regtype ELSE 'jsonb'::regtype END
            AND NOT has_function_privilege('public',p.oid,'EXECUTE')
            AND has_function_privilege('reviewrouter_activation_permit_installer',p.oid,'EXECUTE')
              IS NOT DISTINCT FROM (p.oid IN (
                to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)')))
            AND has_function_privilege('reviewrouter_release_migration',p.oid,'EXECUTE')
              IS NOT DISTINCT FROM (p.oid=to_regprocedure(
                'reviewrouter_activation.read_migration_receipt(text,bigint,text)'))
            AND has_function_privilege('reviewrouter_release_schema_owner',p.oid,'EXECUTE')
              IS NOT DISTINCT FROM (p.oid IN (
                to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                to_regprocedure('reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)')))
            AND has_function_privilege('reviewrouter_activation_receipt_reader',p.oid,'EXECUTE')
              IS NOT DISTINCT FROM (p.oid=to_regprocedure(
                'reviewrouter_activation.read_migration_receipt(text,bigint,text)'))
            AND (EXISTS (SELECT 1
              FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              JOIN pg_roles grantee ON grantee.oid=acl.grantee
              WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
                AND grantee.rolname='reviewrouter_activation_permit_installer'))
              IS NOT DISTINCT FROM (p.oid IN (
                to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)')))
            AND (EXISTS (SELECT 1
              FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              JOIN pg_roles grantee ON grantee.oid=acl.grantee
              WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
                AND grantee.rolname='reviewrouter_release_migration'))
              IS NOT DISTINCT FROM (p.oid=to_regprocedure(
                'reviewrouter_activation.read_migration_receipt(text,bigint,text)'))
            AND (EXISTS (SELECT 1
              FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              JOIN pg_roles grantee ON grantee.oid=acl.grantee
              WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
                AND grantee.rolname='reviewrouter_release_schema_owner'))
              IS NOT DISTINCT FROM (p.oid IN (
                to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                to_regprocedure('reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)')))
            AND (EXISTS (SELECT 1
              FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              JOIN pg_roles grantee ON grantee.oid=acl.grantee
              WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
                AND grantee.rolname='reviewrouter_activation_receipt_reader'))
              IS NOT DISTINCT FROM (p.oid=to_regprocedure(
                'reviewrouter_activation.read_migration_receipt(text,bigint,text)'))
            AND NOT EXISTS (SELECT 1
              FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
              WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
                AND (acl.is_grantable OR NOT (
                    grantee.rolname='reviewrouter_activation_permit_installer'
                      AND p.oid IN (
                        to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                        to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)'))
                    OR grantee.rolname='reviewrouter_release_migration'
                      AND p.oid=to_regprocedure(
                        'reviewrouter_activation.read_migration_receipt(text,bigint,text)')
                    OR grantee.rolname='reviewrouter_release_schema_owner'
                      AND p.oid IN (
                        to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                        to_regprocedure('reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)'))
                    OR grantee.rolname='reviewrouter_activation_receipt_reader'
                      AND p.oid=to_regprocedure(
                        'reviewrouter_activation.read_migration_receipt(text,bigint,text)')))))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_language l ON l.oid=p.prolang CROSS JOIN pg_roles guard
          WHERE n.nspname='reviewrouter_activation'
            AND guard.rolname='reviewrouter_activation_receipt_guard'
            AND p.oid IN (
                to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
              to_regprocedure('reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
              to_regprocedure('reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)'),
              to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)'),
              to_regprocedure('reviewrouter_activation.read_migration_receipt(text,bigint,text)'))),false)
        AS "activationMigrationBoundaryExact",
      coalesce((SELECT count(*)=8 AND bool_and(
          has_function_privilege('reviewrouter_role_bootstrap',p.oid,'EXECUTE')
            IS NOT DISTINCT FROM (p.oid=to_regprocedure(
              'reviewrouter_activation.assert_no_activation_receipt()')))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='reviewrouter_activation' AND p.oid IN (
          to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()'),
          to_regprocedure('reviewrouter_activation.canonical_json(jsonb)'),
          to_regprocedure('reviewrouter_activation.project_effective_principal_authority(text)'),
          to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate(text)'),
          to_regprocedure('reviewrouter_activation.capture_catalog_policy_candidate_pair()'),
          to_regprocedure('reviewrouter_activation.validate_principal_evidence(text,bigint)'),
          to_regprocedure('reviewrouter_activation.activate_generation(text)'),
          to_regprocedure('reviewrouter_activation.stage_principal_evidence(text)'))),false)
        AS "activationBootstrapRoutinePrivilegesExact",
      coalesce((SELECT bootstrap.rolcanlogin AND NOT bootstrap.rolsuper
          AND NOT bootstrap.rolcreatedb AND NOT bootstrap.rolcreaterole
          AND NOT bootstrap.rolreplication AND NOT bootstrap.rolbypassrls
          AND (SELECT count(*)=6
              AND count(DISTINCT granted.oid)=6
              AND count(DISTINCT grantor.oid)=1
              AND bool_and(granted.rolname=ANY(ARRAY['reviewrouter_api',
                    'reviewrouter_web','reviewrouter_worker',
                    'reviewrouter_comment_token_custody',
                    'reviewrouter_codex_effect_authority',
                    'reviewrouter_release_migration'])
                AND member.oid=bootstrap.oid
                AND grantor.oid<>bootstrap.oid
                AND grantor.rolname<>'reviewrouter_release_schema_owner'
                AND grantor.rolname<>ALL(ARRAY['reviewrouter_api',
                    'reviewrouter_web','reviewrouter_worker',
                    'reviewrouter_comment_token_custody',
                    'reviewrouter_codex_effect_authority',
                    'reviewrouter_release_migration'])
                AND edge.admin_option AND NOT edge.inherit_option
                AND NOT edge.set_option)
            FROM pg_auth_members edge
            JOIN pg_roles granted ON granted.oid=edge.roleid
            JOIN pg_roles member ON member.oid=edge.member
            JOIN pg_roles grantor ON grantor.oid=edge.grantor
            WHERE edge.roleid=bootstrap.oid OR edge.member=bootstrap.oid
              OR edge.grantor=bootstrap.oid)
        FROM pg_roles bootstrap
        WHERE bootstrap.rolname='reviewrouter_role_bootstrap'),false)
        AS "activationBootstrapRoleDemotedExact",
      coalesce((SELECT
          bool_and(
            CASE role.rolname
              WHEN 'reviewrouter_api' THEN
                has_table_privilege(role.oid,to_regclass('public."CertifiedForkReviewClaim"'),'SELECT,INSERT,UPDATE,DELETE')
              ELSE NOT has_table_privilege(role.oid,to_regclass('public."CertifiedForkReviewClaim"'),'SELECT,INSERT,UPDATE,DELETE')
            END)
          FROM pg_roles role
          WHERE role.rolname IN ('reviewrouter_api','reviewrouter_web','reviewrouter_worker')
            AND to_regclass('public."CertifiedForkReviewClaim"') IS NOT NULL),false)
        AS "certifiedForkReviewClaimRuntimeAclExact",
      coalesce((SELECT
          has_table_privilege(guard.oid,
            to_regclass('public."_prisma_migrations"'),'SELECT')
          AND NOT has_database_privilege(guard.oid,current_database(),'CREATE')
          AND NOT has_database_privilege(guard.oid,current_database(),'TEMP')
          AND NOT has_schema_privilege(guard.oid,'public','CREATE')
          AND NOT EXISTS (SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
              AND (c.relname<>'_prisma_migrations' AND EXISTS (
                  SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                    'TRUNCATE','REFERENCES','TRIGGER']) privilege
                  WHERE has_table_privilege(guard.oid,c.oid,privilege))
                OR c.relname='_prisma_migrations' AND EXISTS (
                  SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE',
                    'REFERENCES','TRIGGER']) privilege
                  WHERE has_table_privilege(guard.oid,c.oid,privilege))))
          AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n
            ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
              ('CodexOAuthLease','CodexOAuthSetupManifest',
                'CodexOAuthWritebackIntent'))=3
          AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n
            ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
              AND a.attnum>0 AND NOT a.attisdropped
            WHERE n.nspname='public' AND c.relname IN
              ('CodexOAuthLease','CodexOAuthSetupManifest',
                'CodexOAuthWritebackIntent')
              AND has_column_privilege(guard.oid,c.oid,a.attnum,'SELECT')
                IS DISTINCT FROM (a.attname='status'))
          FROM pg_roles guard
          WHERE guard.rolname='reviewrouter_activation_receipt_guard'),false)
        AS "activationGuardCatalogReadExact",
      coalesce((SELECT
          NOT owner.rolcanlogin AND NOT owner.rolsuper
          AND NOT owner.rolcreatedb AND NOT owner.rolcreaterole
          AND NOT owner.rolreplication AND NOT owner.rolbypassrls
          AND public_namespace.nspowner=owner.oid
          AND has_database_privilege(owner.oid,current_database(),'CONNECT')
          AND has_database_privilege(owner.oid,current_database(),'CREATE')
          AND has_database_privilege(owner.oid,current_database(),'TEMP')
          AND NOT has_database_privilege(migration.oid,current_database(),'CREATE')
          AND NOT has_database_privilege(migration.oid,current_database(),'TEMP')
          AND NOT has_schema_privilege(migration.oid,public_namespace.oid,'CREATE')
          AND NOT pg_has_role(migration.oid,owner.oid,'MEMBER')
          AND NOT pg_has_role(migration.oid,owner.oid,'USAGE')
          AND NOT pg_has_role(migration.oid,owner.oid,'SET')
          AND has_table_privilege(migration.oid,
            to_regclass('public._prisma_migrations'),'SELECT')
          AND NOT EXISTS (SELECT 1 FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','f')
              AND (relation.relname NOT IN ('_prisma_migrations','CodexOAuthLease',
                    'CodexOAuthSetupManifest','CodexOAuthWritebackIntent')
                  AND has_table_privilege(migration.oid,relation.oid,'SELECT')
                OR EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE',
                      'TRUNCATE','REFERENCES','TRIGGER']) privilege
                    WHERE has_table_privilege(migration.oid,relation.oid,privilege))))
          AND NOT EXISTS (SELECT 1 FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
            WHERE namespace.nspname='public'
              AND relation.relname IN ('CodexOAuthLease','CodexOAuthSetupManifest',
                'CodexOAuthWritebackIntent')
              AND has_column_privilege(migration.oid,relation.oid,
                attribute.attnum,'SELECT') IS DISTINCT FROM
                  (attribute.attname IN ('id','status')))
          AND NOT EXISTS (SELECT 1 FROM pg_class object
            JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
            WHERE namespace.nspname='public' AND object.relowner=migration.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_proc routine
            JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
            WHERE namespace.nspname='public' AND routine.proowner=migration.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_type type
            JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
            WHERE namespace.nspname='public' AND type.typowner=migration.oid)
          AND (NOT EXISTS (SELECT 1 FROM pg_auth_members edge
                WHERE edge.roleid=owner.oid OR edge.member=owner.oid
                  OR edge.grantor=owner.oid)
            OR (SELECT count(*)=1 AND bool_and(
                  edge.roleid=owner.oid AND edge.member=bootstrap.oid
                  AND edge.admin_option AND NOT edge.inherit_option
                  AND edge.set_option
                  AND grantor.rolname<>bootstrap.rolname
                  AND grantor.rolname<>owner.rolname)
                FROM pg_auth_members edge
                JOIN pg_roles grantor ON grantor.oid=edge.grantor
                WHERE edge.roleid=owner.oid OR edge.member=owner.oid
                  OR edge.grantor=owner.oid))
          AND (SELECT count(*)=2 AND bool_and(routine.prosecdef
                AND routine.prokind='p' AND routine.proowner=owner.oid
                AND routine.proconfig=CASE
                  WHEN routine.oid=to_regprocedure(
                    'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)')
                    THEN ARRAY['search_path=public, pg_temp']
                  ELSE ARRAY['search_path=pg_catalog, public, pg_temp'] END
                AND NOT has_function_privilege('public',routine.oid,'EXECUTE')
                AND has_function_privilege(migration.oid,routine.oid,'EXECUTE')
                  IS NOT DISTINCT FROM
                    (routine.oid=to_regprocedure(
                      'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)'))
                AND (EXISTS (SELECT 1
                  FROM aclexplode(coalesce(routine.proacl,
                    acldefault('f',routine.proowner))) acl
                  WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
                    AND acl.grantee=migration.oid)) IS NOT DISTINCT FROM
                    (routine.oid=to_regprocedure(
                      'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)'))
                AND NOT EXISTS (SELECT 1
                  FROM aclexplode(coalesce(routine.proacl,
                    acldefault('f',routine.proowner))) acl
                  LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
                  WHERE acl.privilege_type='EXECUTE'
                    AND acl.grantee<>routine.proowner
                    AND (acl.is_grantable OR grantee.oid IS DISTINCT FROM CASE
                      WHEN routine.oid=to_regprocedure(
                        'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)')
                        THEN migration.oid ELSE NULL END)))
            FROM pg_proc routine WHERE routine.oid IN (
              to_regprocedure(
                'public.reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean)'),
              to_regprocedure(
                'public.reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text,timestamptz)')))
          AND (SELECT count(*)=2 AND bool_and(routine.prosecdef
                AND routine.prokind='f' AND routine.proowner=owner.oid
                AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
                AND NOT has_function_privilege('public',routine.oid,'EXECUTE')
                AND has_function_privilege(
                  'reviewrouter_activation_receipt_guard',routine.oid,'EXECUTE')
                AND NOT EXISTS (SELECT 1
                  FROM aclexplode(coalesce(routine.proacl,
                    acldefault('f',routine.proowner))) acl
                  WHERE acl.privilege_type='EXECUTE'
                    AND acl.grantee<>routine.proowner
                    AND (acl.is_grantable OR acl.grantee<>
                      (SELECT oid FROM pg_roles WHERE rolname=
                        'reviewrouter_activation_receipt_guard'))))
            FROM pg_proc routine WHERE routine.oid IN (
              to_regprocedure('reviewrouter_activation.apply_runtime_acl()'),
              to_regprocedure(
                'reviewrouter_activation.capture_runtime_acl_policy_pair()')))
          AND (SELECT count(*)=1 AND bool_and(routine.prosecdef
                AND routine.prokind='f' AND routine.proowner=bootstrap.oid
                AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
                AND NOT has_function_privilege('public',routine.oid,'EXECUTE')
                AND has_function_privilege(owner.oid,routine.oid,'EXECUTE')
                AND NOT has_function_privilege(migration.oid,routine.oid,'EXECUTE')
                AND NOT has_function_privilege(
                  'reviewrouter_activation_receipt_guard',routine.oid,'EXECUTE')
                AND NOT has_function_privilege(
                  'reviewrouter_activation_permit_installer',routine.oid,'EXECUTE')
                AND NOT has_function_privilege(
                  'reviewrouter_activation_receipt_reader',routine.oid,'EXECUTE')
                AND NOT EXISTS (SELECT 1
                  FROM aclexplode(coalesce(routine.proacl,
                    acldefault('f',routine.proowner))) acl
                  WHERE acl.privilege_type='EXECUTE'
                    AND acl.grantee<>routine.proowner
                    AND (acl.is_grantable OR acl.grantee<>owner.oid)))
            FROM pg_proc routine WHERE routine.oid=to_regprocedure(
              'reviewrouter_activation.apply_runtime_database_acl(text)'))
          FROM pg_roles owner CROSS JOIN pg_roles migration
          CROSS JOIN pg_roles bootstrap
          CROSS JOIN pg_namespace public_namespace
          WHERE owner.rolname='reviewrouter_release_schema_owner'
            AND migration.rolname='reviewrouter_release_migration'
            AND bootstrap.rolname='reviewrouter_role_bootstrap'
            AND public_namespace.nspname='public'),false)
        AS "activationApplicationOwnershipExact",
      coalesce(CASE WHEN pg_catalog.pg_input_is_valid(
          pg_catalog.shobj_description((SELECT oid FROM pg_database
            WHERE datname=current_database()),'pg_database'),
          'jsonb')
          THEN pg_catalog.shobj_description((SELECT oid FROM pg_database
            WHERE datname=current_database()),'pg_database')::jsonb
              ->>'recoveryWitnessSha256' ~ '^[a-f0-9]{64}$'
          ELSE false END,false)
        AS "activationRecoveryWitnessExact",
      (SELECT count(*)=9 AND bool_and(role.rolcanlogin IS NOT DISTINCT FROM
          (role.rolname NOT IN ('reviewrouter_activation_receipt_guard',
            'reviewrouter_release_schema_owner')))
        FROM pg_roles role WHERE role.rolname=ANY(ARRAY[
          'reviewrouter_activation_receipt_guard','reviewrouter_activation_permit_installer',
          'reviewrouter_activation_receipt_reader','reviewrouter_api','reviewrouter_web',
          'reviewrouter_worker','reviewrouter_comment_token_custody',
          'reviewrouter_codex_effect_authority',
          'reviewrouter_release_schema_owner']))
        AND NOT EXISTS (SELECT 1 FROM pg_roles role
        WHERE role.rolname=ANY(ARRAY['reviewrouter_activation_receipt_guard',
          'reviewrouter_activation_permit_installer',
          'reviewrouter_activation_receipt_reader','reviewrouter_api','reviewrouter_web',
          'reviewrouter_worker','reviewrouter_comment_token_custody',
          'reviewrouter_codex_effect_authority',
          'reviewrouter_release_schema_owner'])
          AND (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
            OR role.rolreplication OR role.rolbypassrls))
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members edge
          JOIN pg_roles granted ON granted.oid=edge.roleid
          JOIN pg_roles member ON member.oid=edge.member
          WHERE granted.rolname=ANY(ARRAY['reviewrouter_activation_receipt_guard',
              'reviewrouter_activation_permit_installer','reviewrouter_activation_receipt_reader'])
             OR member.rolname=ANY(ARRAY['reviewrouter_activation_receipt_guard',
              'reviewrouter_activation_permit_installer','reviewrouter_activation_receipt_reader']))
        AND NOT EXISTS (SELECT 1 FROM pg_roles role
          WHERE role.rolname=ANY(ARRAY['reviewrouter_activation_permit_installer',
              'reviewrouter_activation_receipt_reader']) AND (
            NOT has_database_privilege(role.oid,current_database(),'CONNECT')
            OR has_database_privilege(role.oid,current_database(),'CREATE')
            OR has_database_privilege(role.oid,current_database(),'TEMP')
            OR has_schema_privilege(role.oid,'public','CREATE')
            OR NOT coalesce(has_schema_privilege(role.oid,
              to_regnamespace('reviewrouter_activation'),'USAGE'),false)
            OR coalesce(has_schema_privilege(role.oid,
              to_regnamespace('reviewrouter_activation'),'CREATE'),false)
            OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname IN ('public','reviewrouter_activation')
                AND c.relkind IN ('r','p','v','m','f')
                AND EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE',
                    'DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
                  WHERE has_table_privilege(role.oid,c.oid,privilege)))
            OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname IN ('public','reviewrouter_activation')
                AND has_function_privilege(role.oid,p.oid,'EXECUTE')
                AND NOT (
                  role.rolname='reviewrouter_activation_permit_installer' AND p.oid IN (
                    to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)'),
                to_regprocedure('reviewrouter_activation.install_migration_permit(text,text,text,text,text,text,text,text,jsonb,timestamptz,bigint,text)'),
                    to_regprocedure('reviewrouter_activation.terminalize_migration_permit(text,bigint,text,text)'),
                    to_regprocedure('reviewrouter_activation.read_activation_migration_manifest_identity()'))
                  OR role.rolname='reviewrouter_activation_receipt_reader' AND p.oid IN (
                    to_regprocedure('reviewrouter_activation.read_activation_receipt(text)'),
                    to_regprocedure('reviewrouter_activation.read_migration_receipt(text,bigint,text)'),
                    to_regprocedure('reviewrouter_activation.read_activation_migration_manifest_identity()'))
                ))))
        AND NOT EXISTS (SELECT 1 FROM pg_roles role
          WHERE role.rolname=ANY(ARRAY['reviewrouter_api','reviewrouter_web',
              'reviewrouter_worker','reviewrouter_comment_token_custody',
              'reviewrouter_codex_effect_authority'])
            AND (has_database_privilege(role.oid,current_database(),'CREATE')
              OR has_database_privilege(role.oid,current_database(),'TEMP')
              OR coalesce(has_schema_privilege(role.oid,
                to_regnamespace('reviewrouter_activation'),'USAGE'),false)
              OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='reviewrouter_activation'
                  AND EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE',
                      'DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
                    WHERE has_table_privilege(role.oid,c.oid,privilege)))
              OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='reviewrouter_activation'
                  AND has_function_privilege(role.oid,p.oid,'EXECUTE'))))
        AS "activationRuntimePrivilegesExact",
      coalesce((SELECT p.prosecdef AND p.prokind='f' AND p.prorettype='boolean'::regtype
          AND p.provolatile='v' AND l.lanname='plpgsql'
          AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
          AND pg_get_userbyid(p.proowner)='reviewrouter_activation_receipt_guard'
          AND has_function_privilege('reviewrouter_activation_permit_installer',p.oid,'EXECUTE')
          AND NOT has_function_privilege('public',p.oid,'EXECUTE')
          AND EXISTS (SELECT 1 FROM aclexplode(
              coalesce(p.proacl,acldefault('f',p.proowner))) acl
            JOIN pg_roles grantee ON grantee.oid=acl.grantee
            WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
              AND grantee.rolname='reviewrouter_activation_permit_installer')
          AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
              AND (acl.is_grantable OR NOT EXISTS (SELECT 1 FROM pg_roles grantee
                WHERE grantee.oid=acl.grantee
                  AND grantee.rolname='reviewrouter_activation_permit_installer')))
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)')),false)
        AS "installerRoutine",
      coalesce((SELECT p.prosecdef AND p.prokind='f' AND p.prorettype='jsonb'::regtype
          AND p.provolatile='s' AND l.lanname='plpgsql'
          AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
          AND pg_get_userbyid(p.proowner)='reviewrouter_activation_receipt_guard'
          AND has_function_privilege('reviewrouter_activation_receipt_reader',p.oid,'EXECUTE')
          AND NOT has_function_privilege('public',p.oid,'EXECUTE')
          AND EXISTS (SELECT 1 FROM aclexplode(
              coalesce(p.proacl,acldefault('f',p.proowner))) acl
            JOIN pg_roles grantee ON grantee.oid=acl.grantee
            WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
              AND grantee.rolname='reviewrouter_activation_receipt_reader')
          AND EXISTS (SELECT 1 FROM aclexplode(
              coalesce(p.proacl,acldefault('f',p.proowner))) acl
            JOIN pg_roles grantee ON grantee.oid=acl.grantee
            WHERE acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
              AND grantee.rolname='reviewrouter_release_migration')
          AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
              AND (acl.is_grantable OR NOT EXISTS (SELECT 1 FROM pg_roles grantee
                WHERE grantee.oid=acl.grantee
                  AND grantee.rolname IN ('reviewrouter_activation_receipt_reader','reviewrouter_release_migration'))))
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=to_regprocedure('reviewrouter_activation.read_activation_receipt(text)')),false)
        AS "readerRoutine"
  `);
  signal?.throwIfAborted();
  if (probeRows.length !== 1 || !probeRows[0])
    throw new Error("release_control_database_identity_unavailable");
  if (typeof probeRows[0].authorityPresent !== "boolean")
    throw new Error("release_control_database_identity_unavailable");
  if (!probeRows[0].authorityPresent) {
    const readiness = absentAuthorityReadiness(probeRows[0]);
    if (!probeRows[0].installerRoutine && !probeRows[0].readerRoutine)
      return readiness;
    const migrationRows = await prisma.$queryRaw<
      {
        applicationMigrationManifestIdentity: string;
        applicationPostCatalogDigest: string;
      }[]
    >(Prisma.sql`
      SELECT reviewrouter_activation.read_activation_migration_manifest_identity()
        AS "applicationMigrationManifestIdentity",
        (${Prisma.raw(fencedLiveV70V73CatalogDigestSql)})
        AS "applicationPostCatalogDigest"
    `);
    signal?.throwIfAborted();
    if (migrationRows.length !== 1 || !migrationRows[0])
      throw new Error("release_control_database_migration_history_unavailable");
    return { ...readiness, ...migrationRows[0] };
  }

  const catalogDigest =
    releaseAuthorityReadOnlyCatalogDigestExpression("release_authority");
  const defaultAclExact =
    releaseAuthorityDefaultAclExactExpression("release_authority");
  const finalAclExact =
    releaseAuthorityRuntimeAclExactExpression("release_authority");
  const providerTerminalTopologyExact =
    releaseAuthorityProviderTerminalTopologyExactExpression();
  const rows = await prisma.$queryRaw<ReleaseAuthorityExactness[]>(
    Prisma.sql`
      WITH facts AS (
        SELECT
          to_regnamespace('release_authority') AS authority_namespace,
          to_regprocedure('release_authority.release_schema_migration_manifest()') AS migration_manifest,
          ${Prisma.raw(catalogDigest)} AS catalog_digest,
          pg_catalog.obj_description(
            to_regnamespace('release_authority'), 'pg_namespace'
          )::jsonb AS attestation,
          CASE WHEN pg_catalog.pg_input_is_valid(pg_catalog.obj_description(
              to_regnamespace('reviewrouter_migration_credential'),'pg_namespace'),'jsonb')
            THEN pg_catalog.obj_description(
              to_regnamespace('reviewrouter_migration_credential'),'pg_namespace')::jsonb
                ->>'bootstrapRole'
            ELSE NULL END AS bootstrap_role,
          CASE WHEN pg_catalog.pg_input_is_valid(pg_catalog.obj_description(
              to_regnamespace('reviewrouter_migration_credential'),'pg_namespace'),'jsonb')
            THEN pg_catalog.obj_description(
              to_regnamespace('reviewrouter_migration_credential'),'pg_namespace')::jsonb
                ->>'brokerGrantorRole'
            ELSE NULL END AS broker_grantor_role,
          (SELECT root_oid FROM reviewrouter_migration_credential.provider_root_pin
            WHERE singleton) AS provider_root_oid,
          (SELECT provider_oid FROM reviewrouter_migration_credential.provider_root_pin
            WHERE singleton) AS provider_oid,
          (SELECT root_name FROM reviewrouter_migration_credential.provider_root_pin
            WHERE singleton) AS provider_root_name,
          (SELECT provider_name FROM reviewrouter_migration_credential.provider_root_pin
            WHERE singleton) AS provider_name,
          (SELECT system_identifier FROM reviewrouter_migration_credential.provider_root_pin
            WHERE singleton) AS pinned_system_identifier
      ), exactness AS (
        SELECT facts.*,
          attestation->'schemaVersion' =
            pg_catalog.to_jsonb(${releaseAuthoritySchemaVersion}::integer)
          AND attestation->>'verifier' = ${releaseAuthorityCatalogVerifier}
          AND attestation->>'catalogFingerprint' = 'sha256:' || catalog_digest
          AS catalog_exact,
          ${Prisma.raw(defaultAclExact)} AS default_acl_exact,
          ${Prisma.raw(finalAclExact)} AS final_acl_exact,
          ${Prisma.raw(providerTerminalTopologyExact)} AS provider_terminal_topology_exact,
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles candidate
            JOIN pg_catalog.pg_namespace authority_namespace
              ON authority_namespace.nspname = 'release_authority'
            WHERE candidate.oid <> authority_namespace.nspowner
              AND candidate.rolname<>'reviewrouter_bootstrap_administrator'
              AND NOT candidate.rolsuper
              AND (
                candidate.rolcanlogin
                OR candidate.rolname IN (
                  'reviewrouter_release_control',
                  'reviewrouter_provider_authority',
                  'reviewrouter_release_witness'
                )
              )
              AND (
                pg_catalog.pg_has_role(
                  candidate.oid, authority_namespace.nspowner, 'MEMBER'
                )
                OR pg_catalog.pg_has_role(
                  candidate.oid, authority_namespace.nspowner, 'USAGE'
                )
                OR pg_catalog.pg_has_role(
                  candidate.oid, authority_namespace.nspowner, 'SET'
                )
              )
          ) AS owner_membership_exact,
          (
            SELECT count(*)=3 AND bool_and(role.rolcanlogin
              AND role.oid<>authority_namespace.nspowner
              AND NOT role.rolsuper AND NOT role.rolcreatedb
              AND NOT role.rolcreaterole AND NOT role.rolreplication
              AND NOT role.rolbypassrls AND role.rolconnlimit=(-1)
              AND role.rolvaliduntil IS NULL
              AND coalesce(array_length(role.rolconfig,1),0)=0)
            FROM pg_catalog.pg_roles role
            JOIN pg_namespace authority_namespace
              ON authority_namespace.nspname='release_authority'
            WHERE role.rolname=ANY(ARRAY['reviewrouter_release_control',
              'reviewrouter_provider_authority','reviewrouter_release_witness'])
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_auth_members edge
            JOIN pg_roles granted ON granted.oid=edge.roleid
            JOIN pg_roles member ON member.oid=edge.member
            WHERE granted.rolname=ANY(ARRAY['reviewrouter_release_control',
                'reviewrouter_provider_authority','reviewrouter_release_witness'])
              OR member.rolname=ANY(ARRAY['reviewrouter_release_control',
                'reviewrouter_provider_authority','reviewrouter_release_witness'])
          ) AND (
            SELECT count(*)=3 AND bool_and(
              NOT role.rolsuper AND NOT role.rolcreatedb
              AND NOT role.rolreplication AND NOT role.rolbypassrls
              AND role.rolvaliduntil IS NULL
              AND coalesce(array_length(role.rolconfig,1),0)=0
              AND CASE role.rolname
                WHEN 'reviewrouter_authority_owner' THEN
                  NOT role.rolcanlogin AND NOT role.rolcreaterole
                    AND role.rolconnlimit=(-1)
                WHEN 'reviewrouter_migration_broker' THEN
                  NOT role.rolcanlogin AND role.rolcreaterole
                    AND role.rolconnlimit=(-1)
                WHEN 'reviewrouter_migration_issuer' THEN
                  role.rolcanlogin AND NOT role.rolcreaterole
                    AND role.rolconnlimit=(-1)
              END)
            FROM pg_catalog.pg_roles role
            WHERE role.rolname=ANY(ARRAY['reviewrouter_authority_owner',
              'reviewrouter_migration_broker','reviewrouter_migration_issuer'])
          ) AND ${Prisma.raw(providerTerminalTopologyExact)} AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_database database
            JOIN pg_catalog.pg_roles owner ON owner.oid=database.datdba
            WHERE database.datname=current_database()
              AND owner.rolname='reviewrouter_authority_owner'
          ) AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
            JOIN pg_catalog.pg_roles member ON member.oid=membership.member
            JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
            WHERE granted.rolname='reviewrouter_authority_owner'
              AND member.rolname='reviewrouter_migration_broker'
              AND grantor.rolname=facts.broker_grantor_role
              AND membership.admin_option AND NOT membership.inherit_option
              AND NOT membership.set_option
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
            JOIN pg_catalog.pg_roles member ON member.oid=membership.member
            JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
            WHERE (granted.rolname=ANY(ARRAY['reviewrouter_authority_owner',
                'reviewrouter_migration_broker','reviewrouter_migration_issuer'])
              OR member.rolname=ANY(ARRAY['reviewrouter_authority_owner',
                'reviewrouter_migration_broker','reviewrouter_migration_issuer']))
              AND NOT (granted.rolname='reviewrouter_authority_owner'
                AND member.rolname='reviewrouter_migration_broker'
                AND grantor.rolname=facts.broker_grantor_role
                AND membership.admin_option AND NOT membership.inherit_option
                AND NOT membership.set_option)
              AND NOT (granted.rolname IN ('reviewrouter_authority_owner',
                    'reviewrouter_migration_broker')
                AND member.rolname='reviewrouter_bootstrap_administrator'
                AND grantor.oid=facts.provider_root_oid
                AND membership.admin_option AND NOT membership.inherit_option
                AND NOT membership.set_option)
              AND NOT (granted.rolname~'^rr_migration_[a-f0-9]{24}$'
                AND member.rolname='reviewrouter_migration_broker'
                AND reviewrouter_migration_credential.login_role_is_inert(
                  granted.rolname))
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles role
            WHERE role.rolname=facts.bootstrap_role
          ) AND reviewrouter_migration_credential.bootstrap_is_retired()
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles role
              ON role.oid=membership.roleid OR role.oid=membership.member
            WHERE role.rolname=facts.bootstrap_role
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_shdepend dependency
            JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
            WHERE role.rolname=facts.bootstrap_role
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_stat_activity
            WHERE usename=facts.bootstrap_role
          ) AND pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NULL
          AND (
            SELECT count(*)=1 AND bool_and(role.rolcanlogin AND NOT role.rolsuper
                AND NOT role.rolcreatedb AND role.rolcreaterole
                AND NOT role.rolreplication AND NOT role.rolbypassrls
                AND role.rolconnlimit=1 AND role.rolvaliduntil IS NULL
                AND coalesce(array_length(role.rolconfig,1),0)=0)
            FROM pg_catalog.pg_roles role
            WHERE role.rolname='reviewrouter_bootstrap_administrator'
          ) AND (
            SELECT count(*)=3 AND bool_and(
              (granted.rolname='pg_signal_backend'
                AND NOT membership.admin_option
                AND membership.inherit_option AND membership.set_option)
              OR (granted.rolname IN ('reviewrouter_authority_owner',
                    'reviewrouter_migration_broker')
                AND membership.grantor=facts.provider_root_oid
                AND membership.admin_option
                AND NOT membership.inherit_option
                AND NOT membership.set_option))
            FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
            JOIN pg_catalog.pg_roles member ON member.oid=membership.member
            WHERE member.rolname='reviewrouter_bootstrap_administrator'
              AND granted.rolname IN ('reviewrouter_authority_owner',
                'reviewrouter_migration_broker','pg_signal_backend')
          ) AND facts.pinned_system_identifier=
            (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
            WHERE role.oid=facts.provider_root_oid
              AND role.rolname=facts.provider_root_name)
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
            WHERE role.oid=facts.provider_oid AND role.rolname=facts.provider_name
              AND role.rolname='reviewrouter_bootstrap_administrator')
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
            JOIN pg_catalog.pg_roles member ON member.oid=membership.member
            WHERE member.rolname='reviewrouter_bootstrap_administrator'
              AND granted.rolname NOT IN ('reviewrouter_authority_owner',
                'reviewrouter_migration_broker','pg_signal_backend')
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members membership
            JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
            WHERE granted.rolname='reviewrouter_bootstrap_administrator'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_shdepend dependency
            JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
            WHERE role.rolname IN ('reviewrouter_migration_issuer',facts.bootstrap_role,
              'reviewrouter_bootstrap_administrator')
              AND dependency.deptype='o'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_shdepend dependency
            JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
            WHERE role.rolname='reviewrouter_migration_broker'
              AND dependency.deptype='o'
              AND dependency.dbid<>(SELECT oid FROM pg_catalog.pg_database
                WHERE datname=current_database())
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_shdepend dependency
            JOIN pg_catalog.pg_roles role ON role.oid=dependency.refobjid
            WHERE role.rolname='reviewrouter_authority_owner'
              AND dependency.deptype='o'
              AND NOT (dependency.dbid=(SELECT oid FROM pg_catalog.pg_database
                    WHERE datname=current_database())
                OR (dependency.dbid=0
                  AND dependency.classid='pg_catalog.pg_database'::regclass
                  AND dependency.objid=(SELECT oid FROM pg_catalog.pg_database
                    WHERE datname=current_database())))
          ) AND NOT pg_catalog.has_database_privilege(
            (SELECT oid FROM pg_catalog.pg_roles
              WHERE rolname='reviewrouter_bootstrap_administrator'),
            current_database(),'CREATE'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles role
            WHERE role.rolname=facts.bootstrap_role
              AND pg_catalog.has_database_privilege(
                role.oid,current_database(),'CREATE')
          ) AND (
            SELECT count(*)=6 AND bool_and(
              acl.grantor=database.datdba AND NOT acl.is_grantable
              AND ((acl.grantee=database.datdba
                    AND acl.privilege_type IN ('CREATE','CONNECT','TEMPORARY'))
                OR (acl.grantee=0
                    AND acl.privilege_type IN ('CONNECT','TEMPORARY'))
                OR (acl.grantee=(SELECT oid FROM pg_catalog.pg_roles
                      WHERE rolname='reviewrouter_migration_issuer')
                    AND acl.privilege_type='CONNECT')))
            FROM pg_catalog.pg_database database
            CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
              database.datacl,pg_catalog.acldefault('d',database.datdba))) acl
            WHERE database.datname=current_database()
          ) AS role_topology_exact
        FROM facts
      )
      SELECT CASE WHEN catalog_exact AND default_acl_exact AND final_acl_exact
          AND owner_membership_exact AND role_topology_exact
          THEN (attestation->>'schemaVersion')::integer ELSE 0 END
          AS "schemaVersion",
        '[]'::jsonb AS "migrationManifest",
        'sha256:' || catalog_digest AS "catalogFingerprint",
        coalesce(attestation->>'catalogFingerprint', '')
          AS "expectedCatalogFingerprint",
        coalesce(attestation->>'verifier', '') AS "catalogVerifier",
        catalog_exact AND owner_membership_exact AND role_topology_exact AS "catalogExact",
        default_acl_exact AS "defaultAclExact",
        final_acl_exact AS "finalAclExact",
        catalog_exact AND owner_membership_exact AS "controlRoutine",
        catalog_exact AND owner_membership_exact AS "providerRoutine",
        to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text,jsonb,text,jsonb,text)') IS NOT NULL
          AS "installerRoutine",
        to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NOT NULL
          AS "readerRoutine",
        '' AS "installerRoutineBodySha256",
        '' AS "readerRoutineBodySha256",
        '' AS "applicationMigrationManifestIdentity",
        '' AS "applicationPostCatalogDigest",
        '' AS "activationNamespaceFingerprint",
        role_topology_exact AS "authorityRoleTopologyExact",
        false AS "preMigrationPermitBoundaryExact",
        false AS "activationGuardExact",
        false AS "activationRuntimePrivilegesExact",
        catalog_exact AND owner_membership_exact AS "externalEffectProtocol",
        catalog_exact AND owner_membership_exact AS "sourceFreezeProtocol",
        catalog_exact AND owner_membership_exact AS "selectiveRecoveryProtocol",
        catalog_exact AND owner_membership_exact AS "lateRunnerEffectProtocol",
        catalog_exact AND owner_membership_exact AS "recoveryEffectProtocol",
        catalog_exact AND owner_membership_exact
          AS "compensationCheckpointDefinition",
        catalog_exact AND owner_membership_exact AS "runnerProviderBoundary",
        catalog_exact AND owner_membership_exact
          AS "cleanupWitnessTemporalSemantics",
        catalog_exact AND owner_membership_exact AS "requiredTriggers",
        final_acl_exact AND owner_membership_exact AS "authorityOwnershipExact",
        final_acl_exact AND owner_membership_exact AS "authorityAclExact",
        final_acl_exact AND owner_membership_exact AS "publicAuthorityRevoked",
        final_acl_exact AND owner_membership_exact AS "authorityTablesRevoked"
      FROM exactness
    `,
  );
  signal?.throwIfAborted();
  if (rows.length !== 1 || !rows[0])
    throw new Error("release_control_database_identity_unavailable");
  const {
    roleName,
    authorityOwnerRoleName,
    systemIdentifier,
    recoveryWitnessSha256,
    databaseIdentity,
    postgresMajor,
  } = probeRows[0];
  const readiness: ReleaseAuthorityDatabaseReadiness = {
    ...rows[0],
    roleName,
    authorityOwnerRoleName,
    systemIdentifier,
    recoveryWitnessSha256,
    databaseIdentity,
    postgresMajor,
  };
  if (
    readiness.schemaVersion !== releaseAuthoritySchemaVersion ||
    readiness.migrationManifest.length > 0
  )
    return readiness;
  const manifestRows = await prisma.$queryRaw<
    Pick<ReleaseAuthorityDatabaseReadiness, "migrationManifest">[]
  >(Prisma.sql`
    SELECT release_authority.release_schema_migration_manifest()
      AS "migrationManifest"
  `);
  signal?.throwIfAborted();
  if (manifestRows.length !== 1 || !manifestRows[0])
    throw new Error("release_control_database_migration_history_unavailable");
  return { ...readiness, migrationManifest: manifestRows[0].migrationManifest };
};

export async function observeReleaseAuthorityDatabaseReadiness(
  prisma: PrismaClient,
  options: Readonly<{
    signal?: AbortSignal;
    poolWaitMilliseconds?: number;
    lockTimeoutMilliseconds?: number;
    statementTimeoutMilliseconds?: number;
    transactionTimeoutMilliseconds?: number;
  }> = {},
): Promise<ReleaseAuthorityDatabaseReadiness> {
  const poolWaitMilliseconds = options.poolWaitMilliseconds ?? 2_000;
  const lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? 2_000;
  const statementTimeoutMilliseconds =
    options.statementTimeoutMilliseconds ?? 15_000;
  const transactionTimeoutMilliseconds =
    options.transactionTimeoutMilliseconds ?? 17_000;
  if (
    ![
      poolWaitMilliseconds,
      lockTimeoutMilliseconds,
      statementTimeoutMilliseconds,
      transactionTimeoutMilliseconds,
    ].every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 60_000,
    ) ||
    transactionTimeoutMilliseconds <= statementTimeoutMilliseconds
  )
    throw new Error("release_control_readiness_timeout_invalid");
  options.signal?.throwIfAborted();

  return prisma.$transaction(
    async (connection) => {
      options.signal?.throwIfAborted();
      await connection.$executeRawUnsafe(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
      await connection.$queryRaw(Prisma.sql`
        SELECT
          set_config('statement_timeout', ${`${statementTimeoutMilliseconds}ms`}, true),
          set_config('lock_timeout', ${`${lockTimeoutMilliseconds}ms`}, true)
      `);
      return observeReleaseAuthorityDatabaseReadinessOnConnection(
        connection,
        options.signal,
      );
    },
    {
      maxWait: poolWaitMilliseconds,
      timeout: transactionTimeoutMilliseconds,
    },
  );
}
