import {
  releaseAuthorityCatalogVerifier,
  releaseAuthorityMigrationManifestIsExact,
} from "../domain/readiness-contract.mjs";

export type ReleaseAuthorityDatabaseReadiness = Readonly<{
  roleName: string;
  authorityOwnerRoleName: string;
  systemIdentifier: string;
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
  authoritySystemIdentifier: string;
  targetSystemIdentifier: string;
  authorityOwnerRoleName: string;
  activationGuardRoleName: string;
  installerRoutineBodySha256: string;
  readerRoutineBodySha256: string;
}>;

export const releaseAuthoritySchemaIsReady = (
  readiness: ReleaseAuthorityDatabaseReadiness,
): boolean =>
  readiness.schemaVersion === 11 &&
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
  const systemIdentifier = /^[0-9]{1,64}$/u;
  const roleName = /^[a-z_][a-z0-9_]{0,62}$/u;
  const sha256 = /^[a-f0-9]{64}$/u;
  return (
    systemIdentifier.test(trusted.authoritySystemIdentifier) &&
    systemIdentifier.test(trusted.targetSystemIdentifier) &&
    roleName.test(trusted.authorityOwnerRoleName) &&
    sha256.test(trusted.installerRoutineBodySha256) &&
    sha256.test(trusted.readerRoutineBodySha256) &&
    control.roleName === "reviewrouter_release_control" &&
    provider.roleName === "reviewrouter_provider_authority" &&
    installer.roleName === "reviewrouter_activation_permit_installer" &&
    reader.roleName === "reviewrouter_activation_receipt_reader" &&
    control.authorityOwnerRoleName === trusted.authorityOwnerRoleName &&
    provider.authorityOwnerRoleName === trusted.authorityOwnerRoleName &&
    control.systemIdentifier === trusted.authoritySystemIdentifier &&
    provider.systemIdentifier === trusted.authoritySystemIdentifier &&
    installer.systemIdentifier === trusted.targetSystemIdentifier &&
    reader.systemIdentifier === trusted.targetSystemIdentifier &&
    trusted.authoritySystemIdentifier !== trusted.targetSystemIdentifier &&
    trusted.activationGuardRoleName ===
      "reviewrouter_activation_receipt_guard" &&
    control.systemIdentifier === provider.systemIdentifier &&
    control.systemIdentifier !== installer.systemIdentifier &&
    installer.systemIdentifier === reader.systemIdentifier &&
    [control, provider, installer, reader].every(
      (readiness) => readiness.postgresMajor === 17,
    ) &&
    releaseAuthoritySchemaIsReady(control) &&
    releaseAuthoritySchemaIsReady(provider) &&
    installer.installerRoutine &&
    installer.installerRoutineBodySha256 ===
      trusted.installerRoutineBodySha256 &&
    installer.activationGuardExact &&
    installer.activationRuntimePrivilegesExact &&
    reader.readerRoutine &&
    reader.readerRoutineBodySha256 === trusted.readerRoutineBodySha256 &&
    reader.activationGuardExact &&
    reader.activationRuntimePrivilegesExact
  );
}
