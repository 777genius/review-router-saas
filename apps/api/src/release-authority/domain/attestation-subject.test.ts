import { describe, expect, it } from "vitest";
import {
  attestationSubjectKey,
  createReleaseAuthorityAttestationSubject,
  ReleaseAuthorityServiceKind,
} from "./attestation-subject";

const canonical = () =>
  createReleaseAuthorityAttestationSubject({
    serviceKind: ReleaseAuthorityServiceKind.Control,
    deploymentRevision: "a".repeat(40),
    artifactDigest: `sha256:${"b".repeat(64)}`,
    catalogContractId: "catalog-v1",
    expectedDatabases: [
      {
        roleName: "role_a",
        identity: {
          serverIdentity: "1",
          databaseIdentity: "2",
          databaseName: "db",
        },
      },
    ],
    requiredRoles: ["role_a"],
    authorityOwnerRoleName: "owner_role",
    activationGuardRoleName: "guard_role",
    routineBodyRoots: {
      installerSha256: `sha256:${"c".repeat(64)}`,
      readerSha256: `sha256:${"d".repeat(64)}`,
    },
    migrationManifestIdentity: `sha256:${"e".repeat(64)}`,
    activationFingerprint: `sha256:${"f".repeat(64)}`,
    activationCatalogPolicies: {
      preactivationCatalogPolicySha256: `sha256:${"1".repeat(64)}`,
      activatedCatalogPolicySha256: `sha256:${"2".repeat(64)}`,
    },
  });

describe("exact immutable attestation subject", () => {
  it("rejects an attestation lease key produced for mismatched policy digests", () => {
    const expected = canonical();
    const substituted = createReleaseAuthorityAttestationSubject({
      ...expected,
      activationCatalogPolicies: {
        ...expected.activationCatalogPolicies,
        preactivationCatalogPolicySha256: `sha256:${"9".repeat(64)}`,
      },
    });
    expect(attestationSubjectKey(substituted)).not.toBe(
      attestationSubjectKey(expected),
    );
  });

  it("rejects runtime strings outside the strict service enum", () => {
    expect(() =>
      createReleaseAuthorityAttestationSubject({
        ...canonical(),
        serviceKind: "worker" as ReleaseAuthorityServiceKind,
      }),
    ).toThrow("release_authority_attestation_subject_invalid");
  });

  it("changes its exact key for every bound field", () => {
    const base = canonical();
    const variants = [
      { ...base, serviceKind: ReleaseAuthorityServiceKind.Witness },
      { ...base, deploymentRevision: "1".repeat(40) },
      { ...base, artifactDigest: `sha256:${"1".repeat(64)}` },
      { ...base, catalogContractId: "catalog-v2" },
      {
        ...base,
        expectedDatabases: [
          { ...base.expectedDatabases[0]!, roleName: "role_b" },
        ],
      },
      {
        ...base,
        expectedDatabases: [
          {
            roleName: "role_a",
            identity: {
              ...base.expectedDatabases[0]!.identity,
              serverIdentity: "9",
            },
          },
        ],
      },
      {
        ...base,
        expectedDatabases: [
          {
            roleName: "role_a",
            identity: {
              ...base.expectedDatabases[0]!.identity,
              databaseIdentity: "9",
            },
          },
        ],
      },
      {
        ...base,
        expectedDatabases: [
          {
            roleName: "role_a",
            identity: {
              ...base.expectedDatabases[0]!.identity,
              databaseName: "other",
            },
          },
        ],
      },
      { ...base, requiredRoles: ["role_b"] },
      { ...base, authorityOwnerRoleName: "other_owner" },
      { ...base, activationGuardRoleName: "other_guard" },
      {
        ...base,
        routineBodyRoots: {
          ...base.routineBodyRoots,
          installerSha256: `sha256:${"1".repeat(64)}`,
        },
      },
      {
        ...base,
        routineBodyRoots: {
          ...base.routineBodyRoots,
          readerSha256: `sha256:${"1".repeat(64)}`,
        },
      },
      { ...base, migrationManifestIdentity: `sha256:${"1".repeat(64)}` },
      { ...base, activationFingerprint: `sha256:${"1".repeat(64)}` },
      {
        ...base,
        activationCatalogPolicies: {
          ...base.activationCatalogPolicies,
          activatedCatalogPolicySha256: `sha256:${"3".repeat(64)}`,
        },
      },
    ];
    expect(
      variants.every(
        (variant) =>
          attestationSubjectKey(
            createReleaseAuthorityAttestationSubject(variant),
          ) !== attestationSubjectKey(base),
      ),
    ).toBe(true);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.expectedDatabases[0]!.identity)).toBe(true);
  });
});
