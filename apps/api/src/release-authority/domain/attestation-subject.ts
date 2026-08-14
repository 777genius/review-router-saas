import type { RuntimeDatabaseIdentity } from "./database-identity.js";

export enum ReleaseAuthorityServiceKind {
  Control = "control",
  Witness = "witness",
}

export type AttestationDatabaseSubject = Readonly<{
  roleName: string;
  identity: RuntimeDatabaseIdentity;
}>;

/** Every immutable input which gives a catalog observation its meaning. */
export type ReleaseAuthorityAttestationSubject = Readonly<{
  serviceKind: ReleaseAuthorityServiceKind;
  deploymentRevision: string;
  artifactDigest: string;
  catalogContractId: string;
  expectedDatabases: readonly AttestationDatabaseSubject[];
  requiredRoles: readonly string[];
  authorityOwnerRoleName: string;
  activationGuardRoleName: string;
  routineBodyRoots: Readonly<{
    installerSha256: string;
    readerSha256: string;
  }>;
  migrationManifestIdentity: string;
  activationFingerprint: string;
}>;

const role = /^[a-z_][a-z0-9_]{0,62}$/u;
const decimal = /^[0-9]{1,64}$/u;
const sha256 = /^sha256:[a-f0-9]{64}$/u;
const revision = /^[a-f0-9]{40}$/u;
const contract = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function createReleaseAuthorityAttestationSubject(
  input: ReleaseAuthorityAttestationSubject,
): ReleaseAuthorityAttestationSubject {
  if (
    (input.serviceKind !== ReleaseAuthorityServiceKind.Control &&
      input.serviceKind !== ReleaseAuthorityServiceKind.Witness) ||
    !revision.test(input.deploymentRevision) ||
    !sha256.test(input.artifactDigest) ||
    !contract.test(input.catalogContractId) ||
    !role.test(input.authorityOwnerRoleName) ||
    !role.test(input.activationGuardRoleName) ||
    !sha256.test(input.routineBodyRoots.installerSha256) ||
    !sha256.test(input.routineBodyRoots.readerSha256) ||
    !sha256.test(input.migrationManifestIdentity) ||
    !sha256.test(input.activationFingerprint) ||
    input.expectedDatabases.length === 0 ||
    input.requiredRoles.length === 0 ||
    new Set(input.requiredRoles).size !== input.requiredRoles.length ||
    !input.requiredRoles.every((value) => role.test(value)) ||
    !input.expectedDatabases.every(
      ({ roleName, identity }) =>
        role.test(roleName) &&
        decimal.test(identity.serverIdentity) &&
        decimal.test(identity.databaseIdentity) &&
        identity.databaseName.length > 0 &&
        identity.databaseName.length <= 63,
    )
  )
    throw new Error("release_authority_attestation_subject_invalid");

  return Object.freeze({
    ...input,
    expectedDatabases: Object.freeze(
      input.expectedDatabases.map((database) =>
        Object.freeze({
          roleName: database.roleName,
          identity: Object.freeze({ ...database.identity }),
        }),
      ),
    ),
    requiredRoles: Object.freeze([...input.requiredRoles]),
    routineBodyRoots: Object.freeze({ ...input.routineBodyRoots }),
  });
}

export const attestationSubjectKey = (
  subject: ReleaseAuthorityAttestationSubject,
): string => JSON.stringify(subject);
