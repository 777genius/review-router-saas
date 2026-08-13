import { canonicalJson, sha256Canonical } from "./release-rollout";

export interface ReleaseImageIdentity {
  readonly schemaVersion: "reviewrouter.hosted-runtime-image.v1";
  readonly repository: string;
  readonly commit: string;
  readonly imageUrl: string;
  readonly imageDigest: string;
}

export interface VerifiedReleaseImageProvenance {
  readonly schemaVersion: "reviewrouter.release-image-provenance.v1";
  readonly identity: ReleaseImageIdentity;
  readonly identitySha256: string;
  readonly releaseEvidence: {
    readonly kind: "github-artifact-attestation";
    readonly repository: string;
    readonly workflowPath: ".github/workflows/release.yml";
    readonly workflowRunId: string;
    readonly artifactId: string;
    readonly artifactName: string;
    readonly sourceRef: "refs/heads/main";
    readonly verifiedAt: string;
  };
}

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9_.-]+$/u;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function assertReleaseImageIdentity(
  value: ReleaseImageIdentity,
): ReleaseImageIdentity {
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
    value.imageUrl !==
      `ghcr.io/777genius/review-router-saas-runtime@${value.imageDigest}`
  )
    throw new Error("release_image_identity_invalid");
  return value;
}

export function assertVerifiedReleaseImageProvenance(
  value: VerifiedReleaseImageProvenance,
  expected?: Readonly<{ repository: string; commit: string }>,
): VerifiedReleaseImageProvenance {
  const identity = assertReleaseImageIdentity(value.identity);
  const evidence = value.releaseEvidence;
  if (
    !exact(value, [
      "schemaVersion",
      "identity",
      "identitySha256",
      "releaseEvidence",
    ]) ||
    !exact(evidence, [
      "kind",
      "repository",
      "workflowPath",
      "workflowRunId",
      "artifactId",
      "artifactName",
      "sourceRef",
      "verifiedAt",
    ]) ||
    value.schemaVersion !== "reviewrouter.release-image-provenance.v1" ||
    value.identitySha256 !== `sha256:${sha256Canonical(identity)}` ||
    evidence.kind !== "github-artifact-attestation" ||
    evidence.repository !== identity.repository ||
    evidence.workflowPath !== ".github/workflows/release.yml" ||
    evidence.sourceRef !== "refs/heads/main" ||
    !/^[1-9][0-9]*$/u.test(evidence.workflowRunId) ||
    !/^[1-9][0-9]*$/u.test(evidence.artifactId) ||
    !identifier.test(evidence.artifactName) ||
    !evidence.artifactName.startsWith("hosted-runtime-image-v") ||
    new Date(evidence.verifiedAt).toISOString() !== evidence.verifiedAt ||
    (expected !== undefined &&
      (identity.repository !== expected.repository ||
        identity.commit !== expected.commit))
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
