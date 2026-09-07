import {
  releaseAuthorityCatalogVerifier,
  releaseAuthorityMigrationManifestIsExact,
} from "../domain/readiness-contract.mjs";
import { releaseAuthoritySchemaVersion } from "@reviewrouter/features-release-rollout";
import {
  runtimeDatabaseIdentityEquals,
  runtimeDatabaseIdentityIsCanonical,
  type RuntimeDatabaseIdentity,
} from "../domain/database-identity.js";

export type ReleaseAuthorityDatabaseReadiness = Readonly<{
  roleName: string;
  authorityOwnerRoleName: string;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  postgresMajor: number;
  schemaVersion: number;
  migrationManifest: readonly Readonly<{
    position: number;
    migrationName: string;
    checksumSha256: string;
    byteVariant: "canonical" | "legacy_equivalent";
  }>[];
  catalogFingerprint: string;
  expectedCatalogFingerprint: string;
  catalogVerifier: string;
  catalogExact: boolean;
  defaultAclExact: boolean;
  finalAclExact: boolean;
  controlRoutine: boolean;
  providerRoutine: boolean;
  installerRoutine: boolean;
  readerRoutine: boolean;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
  applicationMigrationManifestIdentity: string;
  applicationPostCatalogDigest: string;
  activationNamespaceFingerprint: string;
  authorityRoleTopologyExact: boolean;
  preMigrationPermitBoundaryExact: boolean;
  activationGuardExact: boolean;
  activationRuntimePrivilegesExact: boolean;
  externalEffectProtocol: boolean;
  sourceFreezeProtocol: boolean;
  selectiveRecoveryProtocol: boolean;
  lateRunnerEffectProtocol: boolean;
  recoveryEffectProtocol: boolean;
  compensationCheckpointDefinition: boolean;
  runnerProviderBoundary: boolean;
  cleanupWitnessTemporalSemantics: boolean;
  requiredTriggers: boolean;
  authorityOwnershipExact: boolean;
  authorityAclExact: boolean;
  publicAuthorityRevoked: boolean;
  authorityTablesRevoked: boolean;
}>;

export enum ReleaseControlReadinessPhase {
  PreMigration = "pre_migration",
  MigrationRecovery = "migration_recovery",
  PostMigration = "post_migration",
  ControlOnly = "control_only",
}

export type ReleaseControlDatabaseSet = Readonly<{
  control: ReleaseAuthorityDatabaseReadiness;
  provider: ReleaseAuthorityDatabaseReadiness;
  installer: ReleaseAuthorityDatabaseReadiness;
  reader: ReleaseAuthorityDatabaseReadiness;
}>;

export type TrustedReleaseControlDatabaseIdentity = Readonly<{
  authorityDatabaseIdentity: RuntimeDatabaseIdentity;
  targetDatabaseIdentity: RuntimeDatabaseIdentity;
  authorityOwnerRoleName: string;
  activationGuardRoleName: string;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
  targetMigrationManifestIdentity: string;
  /** Exact additional endpoints accepted only while recovering an unknown outcome. */
  allowedTargetMigrationEndpoints?: readonly Readonly<{
    manifestIdentity: string;
    postCatalogDigest?: string;
  }>[];
  /** Required only while completing a post-migration target operation. */
  targetPostCatalogDigest?: string;
  activationNamespaceFingerprint: string;
}>;

const targetMigrationEndpointIsTrusted = (
  actualManifest: string,
  actualCatalogDigest: string,
  trusted: TrustedReleaseControlDatabaseIdentity,
): boolean =>
  (actualManifest === trusted.targetMigrationManifestIdentity &&
    (trusted.targetPostCatalogDigest === undefined ||
      actualCatalogDigest === trusted.targetPostCatalogDigest)) ||
  trusted.allowedTargetMigrationEndpoints?.some(
    (endpoint) =>
      actualManifest === endpoint.manifestIdentity &&
      (endpoint.postCatalogDigest === undefined ||
        actualCatalogDigest === endpoint.postCatalogDigest),
  ) === true;

export const releaseAuthoritySchemaIsReady = (
  readiness: ReleaseAuthorityDatabaseReadiness,
): boolean =>
  readiness.schemaVersion === releaseAuthoritySchemaVersion &&
  readiness.catalogExact &&
  readiness.defaultAclExact &&
  readiness.finalAclExact &&
  readiness.authorityRoleTopologyExact &&
  readiness.catalogVerifier === releaseAuthorityCatalogVerifier &&
  readiness.catalogFingerprint === readiness.expectedCatalogFingerprint &&
  releaseAuthorityMigrationManifestIsExact(readiness.migrationManifest) &&
  readiness.controlRoutine &&
  readiness.providerRoutine &&
  readiness.externalEffectProtocol &&
  readiness.sourceFreezeProtocol &&
  readiness.selectiveRecoveryProtocol &&
  readiness.lateRunnerEffectProtocol &&
  readiness.recoveryEffectProtocol &&
  readiness.compensationCheckpointDefinition &&
  readiness.runnerProviderBoundary &&
  readiness.cleanupWitnessTemporalSemantics &&
  readiness.requiredTriggers &&
  readiness.authorityOwnershipExact &&
  readiness.authorityAclExact &&
  readiness.publicAuthorityRevoked &&
  readiness.authorityTablesRevoked;

export function releaseControlDatabaseSetIsReady(
  input: ReleaseControlDatabaseSet,
  trusted: TrustedReleaseControlDatabaseIdentity,
  phase: Exclude<
    ReleaseControlReadinessPhase,
    ReleaseControlReadinessPhase.ControlOnly
  >,
): boolean {
  const { control, provider, installer, reader } = input;
  const roleName = /^[a-z_][a-z0-9_]{0,62}$/u;
  const systemIdentifier = /^[0-9]{1,64}$/u;
  const sha256 = /^[a-f0-9]{64}$/u;
  return (
    runtimeDatabaseIdentityIsCanonical(trusted.authorityDatabaseIdentity) &&
    runtimeDatabaseIdentityIsCanonical(trusted.targetDatabaseIdentity) &&
    trusted.authorityDatabaseIdentity.serverIdentity !==
      trusted.targetDatabaseIdentity.serverIdentity &&
    roleName.test(trusted.authorityOwnerRoleName) &&
    sha256.test(trusted.installerRoutineBodySha256) &&
    sha256.test(trusted.readerRoutineBodySha256) &&
    /^sha256:[a-f0-9]{64}$/u.test(trusted.targetMigrationManifestIdentity) &&
    (trusted.targetPostCatalogDigest === undefined ||
      /^sha256:[a-f0-9]{64}$/u.test(trusted.targetPostCatalogDigest)) &&
    (trusted.allowedTargetMigrationEndpoints === undefined ||
      (trusted.allowedTargetMigrationEndpoints.length > 0 &&
        trusted.allowedTargetMigrationEndpoints.every(
          (endpoint) =>
            /^sha256:[a-f0-9]{64}$/u.test(endpoint.manifestIdentity) &&
            (endpoint.postCatalogDigest === undefined ||
              /^sha256:[a-f0-9]{64}$/u.test(endpoint.postCatalogDigest)),
        ))) &&
    /^sha256:[a-f0-9]{64}$/u.test(trusted.activationNamespaceFingerprint) &&
    control.roleName === "reviewrouter_release_control" &&
    provider.roleName === "reviewrouter_provider_authority" &&
    installer.roleName === "reviewrouter_activation_permit_installer" &&
    reader.roleName === "reviewrouter_activation_receipt_reader" &&
    [control, provider, installer, reader].every(
      (readiness) =>
        systemIdentifier.test(readiness.systemIdentifier) &&
        readiness.systemIdentifier ===
          readiness.databaseIdentity.serverIdentity,
    ) &&
    control.authorityOwnerRoleName === trusted.authorityOwnerRoleName &&
    provider.authorityOwnerRoleName === trusted.authorityOwnerRoleName &&
    runtimeDatabaseIdentityEquals(
      control.databaseIdentity,
      trusted.authorityDatabaseIdentity,
    ) &&
    runtimeDatabaseIdentityEquals(
      provider.databaseIdentity,
      trusted.authorityDatabaseIdentity,
    ) &&
    runtimeDatabaseIdentityEquals(
      installer.databaseIdentity,
      trusted.targetDatabaseIdentity,
    ) &&
    runtimeDatabaseIdentityEquals(
      reader.databaseIdentity,
      trusted.targetDatabaseIdentity,
    ) &&
    !runtimeDatabaseIdentityEquals(
      trusted.authorityDatabaseIdentity,
      trusted.targetDatabaseIdentity,
    ) &&
    trusted.activationGuardRoleName ===
      "reviewrouter_activation_receipt_guard" &&
    runtimeDatabaseIdentityEquals(
      control.databaseIdentity,
      provider.databaseIdentity,
    ) &&
    !runtimeDatabaseIdentityEquals(
      control.databaseIdentity,
      installer.databaseIdentity,
    ) &&
    runtimeDatabaseIdentityEquals(
      installer.databaseIdentity,
      reader.databaseIdentity,
    ) &&
    [control, provider, installer, reader].every(
      (readiness) => readiness.postgresMajor === 17,
    ) &&
    releaseAuthoritySchemaIsReady(control) &&
    releaseAuthoritySchemaIsReady(provider) &&
    installer.installerRoutine &&
    installer.installerRoutineBodySha256 ===
      trusted.installerRoutineBodySha256 &&
    targetMigrationEndpointIsTrusted(
      installer.applicationMigrationManifestIdentity,
      installer.applicationPostCatalogDigest,
      trusted,
    ) &&
    installer.activationNamespaceFingerprint ===
      trusted.activationNamespaceFingerprint &&
    targetActivationPhaseIsReady(installer, trusted, phase) &&
    installer.activationRuntimePrivilegesExact &&
    reader.readerRoutine &&
    reader.readerRoutineBodySha256 === trusted.readerRoutineBodySha256 &&
    targetMigrationEndpointIsTrusted(
      reader.applicationMigrationManifestIdentity,
      reader.applicationPostCatalogDigest,
      trusted,
    ) &&
    reader.activationNamespaceFingerprint ===
      trusted.activationNamespaceFingerprint &&
    targetActivationPhaseIsReady(reader, trusted, phase) &&
    reader.activationRuntimePrivilegesExact
  );
}

const targetActivationPhaseIsReady = (
  readiness: ReleaseAuthorityDatabaseReadiness,
  trusted: TrustedReleaseControlDatabaseIdentity,
  phase: ReleaseControlReadinessPhase,
): boolean => {
  if (
    phase === ReleaseControlReadinessPhase.ControlOnly ||
    !readiness.preMigrationPermitBoundaryExact
  )
    return false;
  const finalGuardRequired =
    phase === ReleaseControlReadinessPhase.PostMigration ||
    (phase === ReleaseControlReadinessPhase.MigrationRecovery &&
      readiness.applicationMigrationManifestIdentity !==
        trusted.targetMigrationManifestIdentity);
  return !finalGuardRequired || readiness.activationGuardExact;
};

/** Exact policy for the database connection that performs one high-risk write. */
export function releaseControlMutationDatabaseIsReady(
  readiness: ReleaseAuthorityDatabaseReadiness,
  trusted: TrustedReleaseControlDatabaseIdentity,
  phase: ReleaseControlReadinessPhase,
): boolean {
  if (
    readiness.postgresMajor !== 17 ||
    readiness.systemIdentifier !== readiness.databaseIdentity.serverIdentity
  )
    return false;
  switch (readiness.roleName) {
    case "reviewrouter_release_control":
    case "reviewrouter_provider_authority":
      return (
        runtimeDatabaseIdentityEquals(
          readiness.databaseIdentity,
          trusted.authorityDatabaseIdentity,
        ) &&
        readiness.authorityOwnerRoleName === trusted.authorityOwnerRoleName &&
        releaseAuthoritySchemaIsReady(readiness)
      );
    case "reviewrouter_activation_permit_installer":
      return (
        phase !== ReleaseControlReadinessPhase.ControlOnly &&
        runtimeDatabaseIdentityEquals(
          readiness.databaseIdentity,
          trusted.targetDatabaseIdentity,
        ) &&
        readiness.installerRoutine &&
        readiness.installerRoutineBodySha256 ===
          trusted.installerRoutineBodySha256 &&
        targetMigrationEndpointIsTrusted(
          readiness.applicationMigrationManifestIdentity,
          readiness.applicationPostCatalogDigest,
          trusted,
        ) &&
        readiness.activationNamespaceFingerprint ===
          trusted.activationNamespaceFingerprint &&
        targetActivationPhaseIsReady(readiness, trusted, phase) &&
        readiness.activationRuntimePrivilegesExact
      );
    case "reviewrouter_activation_receipt_reader":
      return (
        phase !== ReleaseControlReadinessPhase.ControlOnly &&
        runtimeDatabaseIdentityEquals(
          readiness.databaseIdentity,
          trusted.targetDatabaseIdentity,
        ) &&
        readiness.readerRoutine &&
        readiness.readerRoutineBodySha256 === trusted.readerRoutineBodySha256 &&
        targetMigrationEndpointIsTrusted(
          readiness.applicationMigrationManifestIdentity,
          readiness.applicationPostCatalogDigest,
          trusted,
        ) &&
        readiness.activationNamespaceFingerprint ===
          trusted.activationNamespaceFingerprint &&
        targetActivationPhaseIsReady(readiness, trusted, phase) &&
        readiness.activationRuntimePrivilegesExact
      );
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Typed in-place readiness
// ---------------------------------------------------------------------------
//
// `releaseControlDatabaseSetIsReady` above is the relocation contract and is
// unchanged: it still requires the authority database and the target database
// to be different resources, because relocation genuinely spans two of them.
//
// The in-place mode has the opposite topology and therefore needs its own
// readiness rather than a relaxed version of that one. Its custody lives in the
// SAME database it protects, which is the only placement the observed workspace
// allows, and it carries the execution-boundary facts that must hold before any
// DDL runs. Nothing below can make the relocation contract accept a colocated
// topology, and nothing above can make this one accept a split topology.

export type ManagedInPlaceCustodyReadiness = Readonly<{
  roleName: string;
  custodyOwnerRoleName: string;
  custodyReaderRoleName: string;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  postgresMajor: number;
  applicationMigrationManifestIdentity: string;
  /** Exact catalog attestation of the reviewed custody objects. */
  custodyAttested: boolean;
  custodyOwnerCanLogin: boolean;
  coordinatorCanAssumeCustodyOwner: boolean;
  admissionWithdrawn: boolean;
  fleetQuiesced: boolean;
  privilegedBackendPresent: boolean;
  automaticMigrationsDisabled: boolean;
  externalFenceHeld: boolean;
  runtimeGateStatus: string;
}>;

export type TrustedManagedInPlaceIdentity = Readonly<{
  operationDatabaseIdentity: RuntimeDatabaseIdentity;
  coordinatorRoleName: string;
  custodyOwnerRoleName: string;
  custodyReaderRoleName: string;
  baselineManifestIdentity: string;
  targetManifestIdentity: string;
}>;

export enum ManagedInPlaceReadinessPhase {
  BeforeExecution = "before_execution",
  AfterExecution = "after_execution",
}

/**
 * Readiness of the one qualified database for one in-place operation.
 *
 * Before execution the ledger must be at the baseline manifest; after it, at
 * the target manifest. Neither phase admits any other manifest, so a partially
 * applied state is never "ready" for anything.
 */
export function managedInPlaceDatabaseIsReady(
  readiness: ManagedInPlaceCustodyReadiness,
  trusted: TrustedManagedInPlaceIdentity,
  phase: ManagedInPlaceReadinessPhase,
): boolean {
  const roleName = /^[a-z_][a-z0-9_]{0,62}$/u;
  const manifest = /^sha256:[a-f0-9]{64}$/u;
  const expectedManifest =
    phase === ManagedInPlaceReadinessPhase.BeforeExecution
      ? trusted.baselineManifestIdentity
      : trusted.targetManifestIdentity;
  return (
    runtimeDatabaseIdentityIsCanonical(trusted.operationDatabaseIdentity) &&
    roleName.test(trusted.coordinatorRoleName) &&
    roleName.test(trusted.custodyOwnerRoleName) &&
    roleName.test(trusted.custodyReaderRoleName) &&
    new Set([
      trusted.coordinatorRoleName,
      trusted.custodyOwnerRoleName,
      trusted.custodyReaderRoleName,
    ]).size === 3 &&
    manifest.test(trusted.baselineManifestIdentity) &&
    manifest.test(trusted.targetManifestIdentity) &&
    trusted.baselineManifestIdentity !== trusted.targetManifestIdentity &&
    readiness.postgresMajor === 17 &&
    readiness.systemIdentifier === readiness.databaseIdentity.serverIdentity &&
    /^[0-9]{1,64}$/u.test(readiness.systemIdentifier) &&
    /^[a-f0-9]{64}$/u.test(readiness.recoveryWitnessSha256) &&
    readiness.roleName === trusted.coordinatorRoleName &&
    readiness.custodyOwnerRoleName === trusted.custodyOwnerRoleName &&
    readiness.custodyReaderRoleName === trusted.custodyReaderRoleName &&
    // Colocated on purpose, and required to be: this is the same database.
    runtimeDatabaseIdentityEquals(
      readiness.databaseIdentity,
      trusted.operationDatabaseIdentity,
    ) &&
    readiness.custodyAttested &&
    !readiness.custodyOwnerCanLogin &&
    !readiness.coordinatorCanAssumeCustodyOwner &&
    readiness.admissionWithdrawn &&
    readiness.fleetQuiesced &&
    !readiness.privilegedBackendPresent &&
    readiness.automaticMigrationsDisabled &&
    readiness.externalFenceHeld &&
    // The operation begins closed and ends closed in both phases.
    readiness.runtimeGateStatus === "closed" &&
    readiness.applicationMigrationManifestIdentity === expectedManifest
  );
}
