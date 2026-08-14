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
  activationNamespaceFingerprint: string;
  authorityRoleTopologyExact: boolean;
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
  activationNamespaceFingerprint: string;
}>;

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
    installer.applicationMigrationManifestIdentity ===
      trusted.targetMigrationManifestIdentity &&
    installer.activationNamespaceFingerprint ===
      trusted.activationNamespaceFingerprint &&
    installer.activationGuardExact &&
    installer.activationRuntimePrivilegesExact &&
    reader.readerRoutine &&
    reader.readerRoutineBodySha256 === trusted.readerRoutineBodySha256 &&
    reader.applicationMigrationManifestIdentity ===
      trusted.targetMigrationManifestIdentity &&
    reader.activationNamespaceFingerprint ===
      trusted.activationNamespaceFingerprint &&
    reader.activationGuardExact &&
    reader.activationRuntimePrivilegesExact
  );
}
