import {
  releaseAuthorityCatalogVerifier,
  releaseAuthorityMigrationManifestIsExact,
} from "../domain/readiness-contract.mjs";

export type ReleaseAuthorityDatabaseReadiness = Readonly<{
  roleName: string;
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
  controlRoutine: boolean;
  providerRoutine: boolean;
  installerRoutine: boolean;
  readerRoutine: boolean;
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

export const releaseAuthoritySchemaIsReady = (
  readiness: ReleaseAuthorityDatabaseReadiness,
): boolean =>
  readiness.schemaVersion === 10 &&
  readiness.catalogExact &&
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
): boolean {
  const { control, provider, installer, reader } = input;
  return (
    control.roleName === "reviewrouter_release_control" &&
    provider.roleName === "reviewrouter_provider_authority" &&
    installer.roleName === "reviewrouter_activation_permit_installer" &&
    reader.roleName === "reviewrouter_activation_receipt_reader" &&
    control.systemIdentifier === provider.systemIdentifier &&
    control.systemIdentifier !== installer.systemIdentifier &&
    installer.systemIdentifier === reader.systemIdentifier &&
    [control, provider, installer, reader].every(
      (readiness) => readiness.postgresMajor === 17,
    ) &&
    releaseAuthoritySchemaIsReady(control) &&
    releaseAuthoritySchemaIsReady(provider) &&
    installer.installerRoutine &&
    reader.readerRoutine
  );
}
