import { canonicalJson, sha256Canonical } from "./release-rollout";

export interface ReleaseImageIdentity {
  readonly schemaVersion: "reviewrouter.hosted-runtime-image.v1";
  readonly repository: string;
  readonly commit: string;
  readonly imageUrl: string;
  readonly imageDigest: string;
}

export interface ReleaseImageProvenancePolicy {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly imageRepository: string;
  readonly verificationPolicySha256: string;
  readonly buildRunId?: string;
  readonly artifactId?: string;
  readonly artifactName?: string;
}

export type ReleaseImageProvenanceExpectation = Readonly<
  Pick<ReleaseImageProvenancePolicy, "sourceRepository" | "sourceRevision"> &
    Partial<
      Pick<
        ReleaseImageProvenancePolicy,
        | "imageRepository"
        | "verificationPolicySha256"
        | "buildRunId"
        | "artifactId"
        | "artifactName"
      >
    >
>;

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
const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: string): boolean => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

export function releaseImageRepository(identity: ReleaseImageIdentity): string {
  const separator = identity.imageUrl.lastIndexOf("@");
  if (separator <= 0) throw new Error("release_image_identity_invalid");
  return identity.imageUrl.slice(0, separator);
}

export function assertReleaseImageIdentity(
  value: ReleaseImageIdentity,
): ReleaseImageIdentity {
  const image = releaseImageRepository(value);
  if (
    !exact(value, [
      "schemaVersion",
      "repository",
      "commit",
      "imageUrl",
      "imageDigest",
    ]) ||
    value.schemaVersion !== "reviewrouter.hosted-runtime-image.v1" ||
    !repository.test(value.repository) ||
    !sha.test(value.commit) ||
    !digest.test(value.imageDigest) ||
    !imageRepository.test(image) ||
    value.imageUrl !== `${image}@${value.imageDigest}`
  )
    throw new Error("release_image_identity_invalid");
  return value;
}

export function assertVerifiedReleaseImageProvenance(
  value: VerifiedReleaseImageProvenance,
  expected?: ReleaseImageProvenanceExpectation,
): VerifiedReleaseImageProvenance {
  const identity = assertReleaseImageIdentity(value.identity);
  const claim = value.claim;
  const verification = value.verification;
  const boundImageRepository = releaseImageRepository(identity);
  if (
    !exact(value, ["schemaVersion", "identity", "claim", "verification"]) ||
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
    value.schemaVersion !== "reviewrouter.release-image-provenance.v2" ||
    claim.identitySha256 !== `sha256:${sha256Canonical(identity)}` ||
    claim.sourceRepository !== identity.repository ||
    claim.sourceRevision !== identity.commit ||
    claim.imageRepository !== boundImageRepository ||
    !/^[1-9][0-9]*$/u.test(claim.buildRunId) ||
    !/^[1-9][0-9]*$/u.test(claim.artifactId) ||
    !identifier.test(claim.artifactName) ||
    !digest.test(verification.policySha256) ||
    !timestamp(verification.verifiedAt) ||
    (expected !== undefined &&
      (identity.repository !== expected.sourceRepository ||
        identity.commit !== expected.sourceRevision ||
        (expected.imageRepository !== undefined &&
          boundImageRepository !== expected.imageRepository) ||
        (expected.verificationPolicySha256 !== undefined &&
          verification.policySha256 !== expected.verificationPolicySha256) ||
        (expected.buildRunId !== undefined &&
          claim.buildRunId !== expected.buildRunId) ||
        (expected.artifactId !== undefined &&
          claim.artifactId !== expected.artifactId) ||
        (expected.artifactName !== undefined &&
          claim.artifactName !== expected.artifactName)))
  )
    throw new Error("release_image_provenance_invalid");
  return value;
}

export function sameReleaseImageProvenance(
  left: VerifiedReleaseImageProvenance,
  right: VerifiedReleaseImageProvenance,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
