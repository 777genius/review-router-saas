import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ReleaseAuthorityDatabaseReadiness } from "../application/readiness.js";
import { releaseAuthorityCatalogVerifier } from "../domain/readiness-contract.mjs";
import { releaseAuthorityReadOnlyCatalogDigestExpression } from "./catalog-fingerprint.mjs";

type ReadinessClient = Pick<PrismaClient, "$queryRaw">;

type DatabaseIdentityProbe = Readonly<{
  roleName: string;
  systemIdentifier: string;
  postgresMajor: number;
  authorityPresent: boolean;
  installerRoutine: boolean;
  readerRoutine: boolean;
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
      to_regnamespace('release_authority') IS NOT NULL AS "authorityPresent",
      to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)') IS NOT NULL
        AS "installerRoutine",
      to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NOT NULL
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
          ) AS owner_membership_exact
        FROM facts
      )
      SELECT current_user AS "roleName",
        (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
        current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
        CASE WHEN catalog_exact AND owner_membership_exact THEN 10 ELSE 0 END
          AS "schemaVersion",
        '[]'::jsonb AS "migrationManifest",
        'sha256:' || catalog_digest AS "catalogFingerprint",
        coalesce(attestation->>'catalogFingerprint', '')
          AS "expectedCatalogFingerprint",
        coalesce(attestation->>'verifier', '') AS "catalogVerifier",
        catalog_exact AND owner_membership_exact AS "catalogExact",
        catalog_exact AND owner_membership_exact AS "controlRoutine",
        catalog_exact AND owner_membership_exact AS "providerRoutine",
        to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)') IS NOT NULL
          AS "installerRoutine",
        to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NOT NULL
          AS "readerRoutine",
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
