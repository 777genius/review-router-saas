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

const expectedMigrationIdentities = [
  [
    "000001_release_authority",
    [
      "sha256:eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
      "sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
    ],
  ],
  [
    "000002_external_effect_protocol",
    [
      "sha256:66a1cd48303f31691596ae4e64d952d0fe3543444d042b17243c1a60efb10201",
      "sha256:cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e",
    ],
  ],
  [
    "000002_transactional_service_transition",
    ["sha256:5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099"],
  ],
  [
    "000003_partial_source_freeze",
    ["sha256:02dcd03e3d86c362598537e2ac7afc1dff2d20713fa01158f65e02db621d0da5"],
  ],
  [
    "000004_selective_source_recovery",
    ["sha256:c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97"],
  ],
  [
    "000005_late_runner_effects",
    ["sha256:35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb"],
  ],
  [
    "000006_runner_provider_creation_boundary",
    ["sha256:4ee3a75a1528870df6d66a24eded9fc588aed2681b82aef57335ad7bbadf1260"],
  ],
  [
    "000007_compensation_effect_fence",
    ["sha256:99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9"],
  ],
  [
    "000008_trigger_helper_acl",
    ["sha256:550e7c1e5f11bd795a867c03873d09a6b681c559f07b2101b8e8a3dbea3408c8"],
  ],
  [
    "000009_authority_history_and_forward_repairs",
    ["sha256:bc2fb62a012ad9676ce696a5652abc8d29f2110243f0072dc75bcdcfb0ac8e25"],
  ],
  [
    "000010_recovery_effect_permits",
    ["sha256:a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd"],
  ],
] as const;

const migrationManifestIsReady = (
  manifest: ReleaseAuthorityDatabaseReadiness["migrationManifest"],
): boolean =>
  manifest.length === expectedMigrationIdentities.length &&
  expectedMigrationIdentities.every(([name, checksums], index) => {
    const applied = manifest[index];
    if (
      applied?.position !== index + 1 ||
      applied.migrationName !== name ||
      !checksums.includes(applied.checksumSha256 as never)
    )
      return false;
    const canonical = applied.checksumSha256 === checksums[0];
    return (
      applied.byteVariant === (canonical ? "canonical" : "legacy_equivalent")
    );
  });

export const releaseAuthoritySchemaIsReady = (
  readiness: ReleaseAuthorityDatabaseReadiness,
): boolean =>
  readiness.schemaVersion === 10 &&
  migrationManifestIsReady(readiness.migrationManifest) &&
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
