import { describe, expect, it } from "vitest";
import { releaseAuthoritySchemaVersion } from "@reviewrouter/features-release-rollout";
import {
  releaseControlDatabaseSetIsReady,
  releaseControlMutationDatabaseIsReady,
  releaseAuthoritySchemaIsReady,
  type ReleaseAuthorityDatabaseReadiness,
} from "./readiness";
import {
  releaseAuthorityCatalogVerifier,
  releaseAuthorityMigrationContract,
} from "../domain/readiness-contract.mjs";

const canonical = (): ReleaseAuthorityDatabaseReadiness => ({
  roleName: "reviewrouter_release_control",
  authorityOwnerRoleName: "reviewrouter_release_authority_owner",
  systemIdentifier: "1",
  recoveryWitnessSha256: "",
  databaseIdentity: {
    serverIdentity: "1",
    databaseIdentity: "16384",
    databaseName: "authority",
  },
  postgresMajor: 17,
  schemaVersion: releaseAuthoritySchemaVersion,
  migrationManifest: releaseAuthorityMigrationContract.map(
    ([migrationName, checksumSha256], index) => {
      if (!migrationName || !checksumSha256)
        throw new Error("release_authority_test_contract_invalid");
      return {
        position: index + 1,
        migrationName,
        checksumSha256,
        byteVariant: "canonical" as const,
      };
    },
  ),
  catalogFingerprint: "sha256:catalog",
  expectedCatalogFingerprint: "sha256:catalog",
  catalogVerifier: releaseAuthorityCatalogVerifier,
  catalogExact: true,
  defaultAclExact: true,
  finalAclExact: true,
  controlRoutine: true,
  providerRoutine: true,
  installerRoutine: false,
  readerRoutine: false,
  installerRoutineBodySha256: "",
  readerRoutineBodySha256: "",
  applicationMigrationManifestIdentity: "",
  applicationPostCatalogDigest: "",
  activationNamespaceFingerprint: "",
  authorityRoleTopologyExact: true,
  activationGuardExact: false,
  activationRuntimePrivilegesExact: false,
  externalEffectProtocol: true,
  sourceFreezeProtocol: true,
  selectiveRecoveryProtocol: true,
  lateRunnerEffectProtocol: true,
  recoveryEffectProtocol: true,
  compensationCheckpointDefinition: true,
  runnerProviderBoundary: true,
  cleanupWitnessTemporalSemantics: true,
  requiredTriggers: true,
  authorityOwnershipExact: true,
  authorityAclExact: true,
  publicAuthorityRevoked: true,
  authorityTablesRevoked: true,
});

describe("release authority exact readiness contract", () => {
  it("accepts the canonical contract", () => {
    expect(releaseAuthoritySchemaIsReady(canonical())).toBe(true);
  });

  it("admits an authority mutation only from its exact role, identity, and catalog", () => {
    const readiness = canonical();
    const trusted = {
      authorityDatabaseIdentity: readiness.databaseIdentity,
      targetDatabaseIdentity: {
        serverIdentity: "2",
        databaseIdentity: "20",
        databaseName: "target",
      },
      authorityOwnerRoleName: readiness.authorityOwnerRoleName,
      activationGuardRoleName: "reviewrouter_activation_receipt_guard",
      installerRoutineBodySha256: "a".repeat(64),
      readerRoutineBodySha256: "b".repeat(64),
      targetMigrationManifestIdentity: `sha256:${"c".repeat(64)}`,
      activationNamespaceFingerprint: `sha256:${"d".repeat(64)}`,
    };
    expect(releaseControlMutationDatabaseIsReady(readiness, trusted)).toBe(
      true,
    );
    expect(
      releaseControlMutationDatabaseIsReady(
        { ...readiness, catalogExact: false },
        trusted,
      ),
    ).toBe(false);
    expect(
      releaseControlMutationDatabaseIsReady(
        {
          ...readiness,
          databaseIdentity: {
            ...readiness.databaseIdentity,
            databaseName: "rerouted",
          },
        },
        trusted,
      ),
    ).toBe(false);
  });

  it("anchors a database set to independent identities and exact activation bodies", () => {
    const control = canonical();
    const provider = {
      ...canonical(),
      roleName: "reviewrouter_provider_authority",
    };
    const activation = {
      ...canonical(),
      schemaVersion: 0,
      roleName: "reviewrouter_activation_permit_installer",
      systemIdentifier: "2",
      databaseIdentity: {
        serverIdentity: "2",
        databaseIdentity: "16385",
        databaseName: "target",
      },
      installerRoutine: true,
      readerRoutine: true,
      installerRoutineBodySha256: "a".repeat(64),
      readerRoutineBodySha256: "b".repeat(64),
      applicationMigrationManifestIdentity: `sha256:${"c".repeat(64)}`,
      activationNamespaceFingerprint: `sha256:${"d".repeat(64)}`,
      activationGuardExact: true,
      activationRuntimePrivilegesExact: true,
    };
    const reader = {
      ...activation,
      roleName: "reviewrouter_activation_receipt_reader",
    };
    const trusted = {
      authorityDatabaseIdentity: control.databaseIdentity,
      targetDatabaseIdentity: activation.databaseIdentity,
      authorityOwnerRoleName: "reviewrouter_release_authority_owner",
      activationGuardRoleName: "reviewrouter_activation_receipt_guard",
      installerRoutineBodySha256: "a".repeat(64),
      readerRoutineBodySha256: "b".repeat(64),
      targetMigrationManifestIdentity: `sha256:${"c".repeat(64)}`,
      activationNamespaceFingerprint: `sha256:${"d".repeat(64)}`,
    };
    expect(
      releaseControlDatabaseSetIsReady(
        { control, provider, installer: activation, reader },
        trusted,
      ),
    ).toBe(true);
    const guardDriftedInstaller = {
      ...activation,
      activationGuardExact: false,
    };
    expect(
      releaseControlMutationDatabaseIsReady(guardDriftedInstaller, trusted),
    ).toBe(false);
    expect(
      releaseControlDatabaseSetIsReady(
        { control, provider, installer: guardDriftedInstaller, reader },
        trusted,
      ),
    ).toBe(false);
    const postMigrationActivation = {
      ...activation,
      applicationMigrationManifestIdentity: `sha256:${"e".repeat(64)}`,
    };
    expect(
      releaseControlMutationDatabaseIsReady(postMigrationActivation, trusted),
    ).toBe(false);
    expect(
      releaseControlMutationDatabaseIsReady(postMigrationActivation, {
        ...trusted,
        allowedTargetMigrationEndpoints: [
          {
            manifestIdentity:
              postMigrationActivation.applicationMigrationManifestIdentity,
          },
        ],
      }),
    ).toBe(true);
    const exactPostCatalog = `sha256:${"f".repeat(64)}`;
    expect(
      releaseControlMutationDatabaseIsReady(
        {
          ...postMigrationActivation,
          applicationPostCatalogDigest: exactPostCatalog,
        },
        {
          ...trusted,
          allowedTargetMigrationEndpoints: [
            {
              manifestIdentity:
                postMigrationActivation.applicationMigrationManifestIdentity,
              postCatalogDigest: exactPostCatalog,
            },
          ],
        },
      ),
    ).toBe(true);
    expect(
      releaseControlMutationDatabaseIsReady(
        {
          ...postMigrationActivation,
          applicationPostCatalogDigest: `sha256:${"0".repeat(64)}`,
        },
        {
          ...trusted,
          allowedTargetMigrationEndpoints: [
            {
              manifestIdentity:
                postMigrationActivation.applicationMigrationManifestIdentity,
              postCatalogDigest: exactPostCatalog,
            },
          ],
        },
      ),
    ).toBe(false);
    const postInstaller = {
      ...postMigrationActivation,
      applicationPostCatalogDigest: exactPostCatalog,
    };
    const postReader = {
      ...postInstaller,
      roleName: "reviewrouter_activation_receipt_reader",
    };
    const postPolicy = {
      ...trusted,
      targetMigrationManifestIdentity:
        postMigrationActivation.applicationMigrationManifestIdentity,
      targetPostCatalogDigest: exactPostCatalog,
    };
    expect(
      releaseControlDatabaseSetIsReady(
        { control, provider, installer: postInstaller, reader: postReader },
        postPolicy,
      ),
    ).toBe(true);
    expect(
      releaseControlDatabaseSetIsReady(
        {
          control,
          provider,
          installer: {
            ...postInstaller,
            applicationPostCatalogDigest: `sha256:${"0".repeat(64)}`,
          },
          reader: postReader,
        },
        postPolicy,
      ),
    ).toBe(false);
    expect(
      releaseControlDatabaseSetIsReady(
        { control, provider, installer: postInstaller, reader: postReader },
        {
          ...postPolicy,
          targetMigrationManifestIdentity: `sha256:${"1".repeat(64)}`,
        },
      ),
    ).toBe(false);
    expect(
      releaseControlDatabaseSetIsReady(
        {
          control: {
            ...control,
            databaseIdentity: {
              ...control.databaseIdentity,
              databaseIdentity: "99999",
              databaseName: "same_cluster_wrong_database",
            },
          },
          provider,
          installer: activation,
          reader,
        },
        trusted,
      ),
    ).toBe(false);
    expect(
      releaseControlDatabaseSetIsReady(
        { control, provider, installer: activation, reader },
        {
          ...trusted,
          targetMigrationManifestIdentity: undefined as unknown as string,
        },
      ),
    ).toBe(false);
    expect(
      releaseControlDatabaseSetIsReady(
        {
          control,
          provider,
          installer: {
            ...activation,
            applicationMigrationManifestIdentity: `sha256:${"e".repeat(64)}`,
          },
          reader,
        },
        trusted,
      ),
    ).toBe(false);
    expect(
      releaseControlDatabaseSetIsReady(
        {
          control,
          provider,
          installer: {
            ...activation,
            installerRoutineBodySha256: "mutated",
          },
          reader,
        },
        trusted,
      ),
    ).toBe(false);
  });

  it.each([
    "catalogExact",
    "defaultAclExact",
    "finalAclExact",
    "authorityOwnershipExact",
    "authorityAclExact",
    "requiredTriggers",
  ] as const)("fails closed when %s is false", (field) => {
    expect(
      releaseAuthoritySchemaIsReady({ ...canonical(), [field]: false }),
    ).toBe(false);
  });

  it("rejects fingerprint and verifier mismatch", () => {
    expect(
      releaseAuthoritySchemaIsReady({
        ...canonical(),
        expectedCatalogFingerprint: "sha256:other",
      }),
    ).toBe(false);
    expect(
      releaseAuthoritySchemaIsReady({
        ...canonical(),
        catalogVerifier: "important_objects_v0",
      }),
    ).toBe(false);
  });

  it("accepts only the complete canonical or documented paired legacy history", () => {
    const legacy = canonical().migrationManifest.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            checksumSha256:
              "sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
            byteVariant: "legacy_equivalent" as const,
          }
        : index === 1
          ? {
              ...entry,
              checksumSha256:
                "sha256:cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e",
              byteVariant: "legacy_equivalent" as const,
            }
          : entry,
    );
    expect(
      releaseAuthoritySchemaIsReady({
        ...canonical(),
        migrationManifest: legacy,
      }),
    ).toBe(true);
    expect(
      releaseAuthoritySchemaIsReady({
        ...canonical(),
        migrationManifest: legacy.slice(0, -1),
      }),
    ).toBe(false);
    expect(
      releaseAuthoritySchemaIsReady({
        ...canonical(),
        migrationManifest: legacy.map((entry, index) =>
          index === 1 ? { ...entry, byteVariant: "canonical" as const } : entry,
        ),
      }),
    ).toBe(false);
    expect(
      releaseAuthoritySchemaIsReady({
        ...canonical(),
        migrationManifest: canonical().migrationManifest.map((entry, index) =>
          index === 2
            ? {
                ...entry,
                checksumSha256: undefined as unknown as string,
                byteVariant: "legacy_equivalent" as const,
              }
            : entry,
        ),
      }),
    ).toBe(false);
  });
});
