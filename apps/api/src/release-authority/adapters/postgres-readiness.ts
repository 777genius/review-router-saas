import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ReleaseAuthorityDatabaseReadiness } from "../application/readiness.js";
import { releaseAuthorityCatalogVerifier } from "../domain/readiness-contract.mjs";
import { releaseAuthorityReadOnlyCatalogDigestExpression } from "./catalog-fingerprint.mjs";

type ReadinessClient = Pick<PrismaClient, "$queryRaw">;

type DatabaseIdentityProbe = Readonly<{
  roleName: string;
  authorityOwnerRoleName: string;
  systemIdentifier: string;
  postgresMajor: number;
  authorityPresent: boolean;
  installerRoutine: boolean;
  readerRoutine: boolean;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
  authorityRoleTopologyExact: boolean;
  activationGuardExact: boolean;
  activationRuntimePrivilegesExact: boolean;
}>;

const absentAuthorityReadiness = (
  probe: DatabaseIdentityProbe,
): ReleaseAuthorityDatabaseReadiness => ({
  ...probe,
  schemaVersion: 0,
  migrationManifest: [],
  catalogFingerprint: "",
  expectedCatalogFingerprint: "",
  catalogVerifier: "",
  catalogExact: false,
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
});

const observeOnConnection = async (
  prisma: ReadinessClient,
): Promise<ReleaseAuthorityDatabaseReadiness> => {
  const probeRows = await prisma.$queryRaw<DatabaseIdentityProbe[]>(Prisma.sql`
    SELECT current_user AS "roleName",
      (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
      current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
      coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace
        WHERE nspname='release_authority'),'') AS "authorityOwnerRoleName",
      to_regnamespace('release_authority') IS NOT NULL AS "authorityPresent",
      coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
        WHERE oid=to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)')),'')
        AS "installerRoutineBodySha256",
      coalesce((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
        WHERE oid=to_regprocedure('reviewrouter_activation.read_activation_receipt(text)')),'')
        AS "readerRoutineBodySha256",
      false AS "authorityRoleTopologyExact",
      coalesce((SELECT count(*)=2 AND bool_and(c.relkind='r'
          AND c.relowner=guard.oid
          AND (SELECT count(*) FROM pg_attribute attribute
            WHERE attribute.attrelid=c.oid AND attribute.attnum>0
              AND NOT attribute.attisdropped) = CASE c.relname
                WHEN 'activation_permit' THEN 11
                WHEN 'activation_receipt' THEN 14
              END
          AND NOT EXISTS (SELECT 1 FROM unnest(CASE c.relname
              WHEN 'activation_permit' THEN ARRAY['rollout_id','source_system_identifier',
                'target_system_identifier','postgres_major','expected_commit_sha',
                'migration_checksum','target_deploy_ids','permit_epoch','permit_nonce',
                'installed_at','consumed_at']
              WHEN 'activation_receipt' THEN ARRAY['rollout_id','source_system_identifier',
                'target_system_identifier','postgres_major','expected_commit_sha',
                'migration_checksum','target_deploy_ids','permit_epoch','permit_nonce',
                'canonical_privileges_sha256','catalog_facts_sha256',
                'first_write_receipt_sha256','transaction_id','activated_at']
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
                  WHEN attribute.attname IN ('target_deploy_ids') THEN 'jsonb'::regtype
                  WHEN attribute.attname IN ('permit_epoch','transaction_id') THEN 'bigint'::regtype
                  WHEN attribute.attname IN ('installed_at','consumed_at','activated_at') THEN 'timestamptz'::regtype
                  ELSE 'text'::regtype END
                OR attribute.attnotnull IS DISTINCT FROM
                  (attribute.attname<>'consumed_at')
                OR coalesce(pg_get_expr(default_record.adbin,default_record.adrelid),'')
                  IS DISTINCT FROM CASE
                    WHEN attribute.attname IN ('installed_at','activated_at')
                      THEN 'transaction_timestamp()'
                    ELSE '' END))
          AND (SELECT jsonb_object_agg(contype,count ORDER BY contype)
            FROM (SELECT constraint_record.contype, count(*) AS count
              FROM pg_constraint constraint_record
              WHERE constraint_record.conrelid=c.oid
                AND constraint_record.convalidated
              GROUP BY constraint_record.contype) constraint_counts)
            = CASE c.relname
                WHEN 'activation_permit' THEN '{"c":10,"p":1,"u":1}'::jsonb
                WHEN 'activation_receipt' THEN '{"p":1,"u":1}'::jsonb
              END
          AND EXISTS (SELECT 1 FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid=c.oid AND constraint_record.contype='p'
              AND ARRAY(SELECT attribute.attname::text
                FROM unnest(constraint_record.conkey) WITH ORDINALITY keyed(attnum,ordinality)
                JOIN pg_attribute attribute ON attribute.attrelid=c.oid
                  AND attribute.attnum=keyed.attnum ORDER BY keyed.ordinality)
                = ARRAY['rollout_id'])
          AND EXISTS (SELECT 1 FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid=c.oid AND constraint_record.contype='u'
              AND ARRAY(SELECT attribute.attname::text
                FROM unnest(constraint_record.conkey) WITH ORDINALITY keyed(attnum,ordinality)
                JOIN pg_attribute attribute ON attribute.attrelid=c.oid
                  AND attribute.attnum=keyed.attnum ORDER BY keyed.ordinality)
                = CASE c.relname
                    WHEN 'activation_permit' THEN ARRAY['permit_epoch','permit_nonce']
                    WHEN 'activation_receipt' THEN ARRAY['target_system_identifier']
                  END)
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
          AND c.relname IN ('activation_permit','activation_receipt')),false)
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
                      'reviewrouter_release_migration'])))
          FROM pg_namespace n CROSS JOIN pg_roles guard
          WHERE n.nspname='reviewrouter_activation'
            AND guard.rolname='reviewrouter_activation_receipt_guard'),false)
        AND coalesce((SELECT count(*)=2 AND bool_and(p.prosecdef
            AND p.proowner=guard.oid AND NOT has_function_privilege('public',p.oid,'EXECUTE'))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          CROSS JOIN pg_roles guard WHERE n.nspname='reviewrouter_activation'
            AND guard.rolname='reviewrouter_activation_receipt_guard'
            AND p.oid IN (to_regprocedure('reviewrouter_activation.assert_no_activation_receipt()'),
              to_regprocedure('reviewrouter_activation.activate_generation(text)'))),false)
        AND coalesce((SELECT
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
          FROM pg_roles guard
          WHERE guard.rolname='reviewrouter_activation_receipt_guard'),false)
        AS "activationGuardExact",
      (SELECT count(*)=7 AND bool_and(role.rolcanlogin IS NOT DISTINCT FROM
          (role.rolname<>'reviewrouter_activation_receipt_guard'))
        FROM pg_roles role WHERE role.rolname=ANY(ARRAY[
          'reviewrouter_activation_receipt_guard','reviewrouter_activation_permit_installer',
          'reviewrouter_activation_receipt_reader','reviewrouter_api','reviewrouter_web',
          'reviewrouter_worker','reviewrouter_codex_effect_authority']))
        AND NOT EXISTS (SELECT 1 FROM pg_roles role
        WHERE role.rolname=ANY(ARRAY['reviewrouter_activation_receipt_guard',
          'reviewrouter_activation_permit_installer',
          'reviewrouter_activation_receipt_reader','reviewrouter_api','reviewrouter_web',
          'reviewrouter_worker','reviewrouter_codex_effect_authority'])
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
                AND p.oid<>CASE role.rolname
                  WHEN 'reviewrouter_activation_permit_installer' THEN
                    to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)')
                  WHEN 'reviewrouter_activation_receipt_reader' THEN
                    to_regprocedure('reviewrouter_activation.read_activation_receipt(text)')
                END)))
        AND NOT EXISTS (SELECT 1 FROM pg_roles role
          WHERE role.rolname=ANY(ARRAY['reviewrouter_api','reviewrouter_web',
              'reviewrouter_worker','reviewrouter_codex_effect_authority'])
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
          AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
              AND NOT EXISTS (SELECT 1 FROM pg_roles grantee
                WHERE grantee.oid=acl.grantee
                  AND grantee.rolname='reviewrouter_activation_permit_installer'))
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)')),false)
        AS "installerRoutine",
      coalesce((SELECT p.prosecdef AND p.prokind='f' AND p.prorettype='jsonb'::regtype
          AND p.provolatile='s' AND l.lanname='plpgsql'
          AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
          AND pg_get_userbyid(p.proowner)='reviewrouter_activation_receipt_guard'
          AND has_function_privilege('reviewrouter_activation_receipt_reader',p.oid,'EXECUTE')
          AND NOT has_function_privilege('public',p.oid,'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
            WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
              AND NOT EXISTS (SELECT 1 FROM pg_roles grantee
                WHERE grantee.oid=acl.grantee
                  AND grantee.rolname='reviewrouter_activation_receipt_reader'))
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=to_regprocedure('reviewrouter_activation.read_activation_receipt(text)')),false)
        AS "readerRoutine"
  `);
  if (probeRows.length !== 1 || !probeRows[0])
    throw new Error("release_control_database_identity_unavailable");
  // Focused test adapters may return the complete read model directly.
  if (typeof probeRows[0].authorityPresent !== "boolean")
    return probeRows[0] as unknown as ReleaseAuthorityDatabaseReadiness;
  if (!probeRows[0].authorityPresent)
    return absentAuthorityReadiness(probeRows[0]);

  const catalogDigest =
    releaseAuthorityReadOnlyCatalogDigestExpression("release_authority");
  const rows = await prisma.$queryRaw<ReleaseAuthorityDatabaseReadiness[]>(
    Prisma.sql`
      WITH facts AS (
        SELECT
          to_regnamespace('release_authority') AS authority_namespace,
          to_regprocedure('release_authority.release_schema_migration_manifest()') AS migration_manifest,
          ${Prisma.raw(catalogDigest)} AS catalog_digest,
          pg_catalog.obj_description(
            to_regnamespace('release_authority'), 'pg_namespace'
          )::jsonb AS attestation
      ), exactness AS (
        SELECT facts.*,
          attestation->>'verifier' = ${releaseAuthorityCatalogVerifier}
          AND attestation->>'catalogFingerprint' = 'sha256:' || catalog_digest
          AS catalog_exact,
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles candidate
            JOIN pg_catalog.pg_namespace authority_namespace
              ON authority_namespace.nspname = 'release_authority'
            WHERE candidate.oid <> authority_namespace.nspowner
              AND (
                candidate.rolcanlogin
                OR candidate.rolname IN (
                  'reviewrouter_release_control',
                  'reviewrouter_provider_authority',
                  'reviewrouter_release_witness'
                )
              )
              AND (
                candidate.rolsuper
                OR pg_catalog.pg_has_role(
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
              AND NOT role.rolbypassrls)
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
          ) AS role_topology_exact
        FROM facts
      )
      SELECT current_user AS "roleName",
        pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='release_authority'))
          AS "authorityOwnerRoleName",
        (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
        current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
        CASE WHEN catalog_exact AND owner_membership_exact AND role_topology_exact THEN 10 ELSE 0 END
          AS "schemaVersion",
        '[]'::jsonb AS "migrationManifest",
        'sha256:' || catalog_digest AS "catalogFingerprint",
        coalesce(attestation->>'catalogFingerprint', '')
          AS "expectedCatalogFingerprint",
        coalesce(attestation->>'verifier', '') AS "catalogVerifier",
        catalog_exact AND owner_membership_exact AND role_topology_exact AS "catalogExact",
        catalog_exact AND owner_membership_exact AS "controlRoutine",
        catalog_exact AND owner_membership_exact AS "providerRoutine",
        to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)') IS NOT NULL
          AS "installerRoutine",
        to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NOT NULL
          AS "readerRoutine",
        '' AS "installerRoutineBodySha256",
        '' AS "readerRoutineBodySha256",
        role_topology_exact AS "authorityRoleTopologyExact",
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
        catalog_exact AND owner_membership_exact AS "authorityOwnershipExact",
        catalog_exact AND owner_membership_exact AS "authorityAclExact",
        catalog_exact AND owner_membership_exact AS "publicAuthorityRevoked",
        catalog_exact AND owner_membership_exact AS "authorityTablesRevoked"
      FROM exactness
    `,
  );
  if (rows.length !== 1 || !rows[0])
    throw new Error("release_control_database_identity_unavailable");
  const readiness = rows[0];
  if (readiness.schemaVersion !== 10 || readiness.migrationManifest.length > 0)
    return readiness;
  const manifestRows = await prisma.$queryRaw<
    Pick<ReleaseAuthorityDatabaseReadiness, "migrationManifest">[]
  >(Prisma.sql`
    SELECT release_authority.release_schema_migration_manifest()
      AS "migrationManifest"
  `);
  if (manifestRows.length !== 1 || !manifestRows[0])
    throw new Error("release_control_database_migration_history_unavailable");
  return { ...readiness, migrationManifest: manifestRows[0].migrationManifest };
};

export async function observeReleaseAuthorityDatabaseReadiness(
  prisma: PrismaClient,
): Promise<ReleaseAuthorityDatabaseReadiness> {
  return observeOnConnection(prisma);
}
