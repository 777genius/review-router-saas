import { canonicalJson, sha256Canonical } from "./release-rollout";

export interface ReleaseImageIdentity {
  readonly schemaVersion: "reviewrouter.hosted-runtime-image.v1";
  readonly repository: string;
  readonly commit: string;
  readonly imageUrl: string;
  readonly imageDigest: string;
}

export interface TrustedReleaseImagePolicy {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly imageRepository: string;
  readonly verificationPolicySha256: string;
}

export interface ReleaseImageProvenanceExpectation extends TrustedReleaseImagePolicy {
  readonly buildRunId?: string;
  readonly artifactId?: string;
  readonly artifactName?: string;
}

export interface VerifiedReleaseImageProvenance {
  readonly schemaVersion: "reviewrouter.release-image-provenance.v2";
  readonly identity: ReleaseImageIdentity;
  readonly claim: {
    readonly identitySha256: string;
    readonly sourceRepository: string;
    readonly sourceRevision: string;
    readonly imageRepository: string;
    readonly buildRunId: string;
    readonly artifactId: string;
    readonly artifactName: string;
  };
  readonly verification: {
    readonly policySha256: string;
    readonly verifiedAt: string;
  };
}

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9_.-]+$/u;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const imageRepository =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/u;
const exact = (value: unknown, keys: readonly string[]): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const canonicalIsoTimestamp = (value: unknown): boolean =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function releaseImageRepository(identity: ReleaseImageIdentity): string {
  const separator = identity.imageUrl.lastIndexOf("@");
  if (separator <= 0) throw new Error("release_image_identity_invalid");
  return identity.imageUrl.slice(0, separator);
}

export function assertReleaseImageIdentity(
  value: unknown,
): ReleaseImageIdentity {
  if (
    !exact(value, [
      "schemaVersion",
      "repository",
      "commit",
      "imageUrl",
      "imageDigest",
    ])
  )
    throw new Error("release_image_identity_invalid");
  const identity = value as ReleaseImageIdentity;
  const image = releaseImageRepository(identity);
  if (
    identity.schemaVersion !== "reviewrouter.hosted-runtime-image.v1" ||
    !repository.test(identity.repository) ||
    !sha.test(identity.commit) ||
    !digest.test(identity.imageDigest) ||
    !imageRepository.test(image) ||
    identity.imageUrl !== `${image}@${identity.imageDigest}`
  )
    throw new Error("release_image_identity_invalid");
  return identity;
}

export function assertVerifiedReleaseImageProvenance(
  value: unknown,
  expected: ReleaseImageProvenanceExpectation,
): VerifiedReleaseImageProvenance {
  if (!exact(value, ["schemaVersion", "identity", "claim", "verification"]))
    throw new Error("release_image_provenance_invalid");
  const provenance = value as VerifiedReleaseImageProvenance;
  let identity: ReleaseImageIdentity;
  try {
    identity = assertReleaseImageIdentity(provenance.identity);
  } catch {
    throw new Error("release_image_provenance_invalid");
  }
  const claim = provenance.claim;
  const verification = provenance.verification;
  const boundImageRepository = releaseImageRepository(identity);
  if (
    typeof expected !== "object" ||
    expected === null ||
    !repository.test(expected.sourceRepository) ||
    !sha.test(expected.sourceRevision) ||
    !imageRepository.test(expected.imageRepository) ||
    !digest.test(expected.verificationPolicySha256) ||
    !exact(claim, [
      "identitySha256",
      "sourceRepository",
      "sourceRevision",
      "imageRepository",
      "buildRunId",
      "artifactId",
      "artifactName",
    ]) ||
    !exact(verification, ["policySha256", "verifiedAt"]) ||
    provenance.schemaVersion !== "reviewrouter.release-image-provenance.v2" ||
    claim.identitySha256 !== `sha256:${sha256Canonical(identity)}` ||
    claim.sourceRepository !== identity.repository ||
    claim.sourceRevision !== identity.commit ||
    claim.imageRepository !== boundImageRepository ||
    !/^[1-9][0-9]*$/u.test(claim.buildRunId) ||
    !/^[1-9][0-9]*$/u.test(claim.artifactId) ||
    !identifier.test(claim.artifactName) ||
    !digest.test(verification.policySha256) ||
    !canonicalIsoTimestamp(verification.verifiedAt) ||
    identity.repository !== expected.sourceRepository ||
    identity.commit !== expected.sourceRevision ||
    boundImageRepository !== expected.imageRepository ||
    verification.policySha256 !== expected.verificationPolicySha256 ||
    (expected.buildRunId !== undefined &&
      claim.buildRunId !== expected.buildRunId) ||
    (expected.artifactId !== undefined &&
      claim.artifactId !== expected.artifactId) ||
    (expected.artifactName !== undefined &&
      claim.artifactName !== expected.artifactName)
  )
    throw new Error("release_image_provenance_invalid");
  return provenance;
}

export function sameReleaseImageProvenance(
  left: VerifiedReleaseImageProvenance,
  right: VerifiedReleaseImageProvenance,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
