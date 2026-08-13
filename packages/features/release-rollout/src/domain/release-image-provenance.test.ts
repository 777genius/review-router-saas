import { describe, expect, it } from "vitest";
import { sha256Canonical } from "./release-rollout";
import {
  assertVerifiedReleaseImageProvenance,
  sameReleaseImageProvenance,
  type ReleaseImageIdentity,
  type VerifiedReleaseImageProvenance,
} from "./release-image-provenance";

const repository = "777genius/review-router-saas";
const commit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const identity: ReleaseImageIdentity = {
  schemaVersion: "reviewrouter.hosted-runtime-image.v1",
  repository,
  commit,
  imageUrl: `ghcr.io/777genius/review-router-saas-runtime@${imageDigest}`,
  imageDigest,
};
const provenance = (): VerifiedReleaseImageProvenance => ({
  schemaVersion: "reviewrouter.release-image-provenance.v1",
  identity,
  identitySha256: `sha256:${sha256Canonical(identity)}`,
  releaseEvidence: {
    kind: "github-artifact-attestation",
    repository,
    workflowPath: ".github/workflows/release.yml",
    workflowRunId: "123",
    artifactId: "456",
    artifactName: "hosted-runtime-image-v1.2.3",
    sourceRef: "refs/heads/main",
    verifiedAt: "2026-08-13T00:00:00.000Z",
  },
});

describe("verified release image provenance", () => {
  it("binds repository, exact commit, digest, immutable image URL, and release evidence", () => {
    expect(
      assertVerifiedReleaseImageProvenance(provenance(), {
        repository,
        commit,
      }),
    ).toEqual(provenance());
  });

  it.each([
    ["stale expected commit", { commit: "c".repeat(40) }],
    ["foreign repository", { repository: "attacker/repository" }],
  ] as const)("rejects %s", (_name, changed) => {
    expect(() =>
      assertVerifiedReleaseImageProvenance(provenance(), {
        repository: "repository" in changed ? changed.repository : repository,
        commit: "commit" in changed ? changed.commit : commit,
      }),
    ).toThrow("release_image_provenance_invalid");
  });

  it("rejects a digest variable substituted after attestation", () => {
    const value = provenance();
    const changedDigest = `sha256:${"d".repeat(64)}`;
    expect(() =>
      assertVerifiedReleaseImageProvenance({
        ...value,
        identity: {
          ...value.identity,
          imageDigest: changedDigest,
          imageUrl: `ghcr.io/777genius/review-router-saas-runtime@${changedDigest}`,
        },
      }),
    ).toThrow("release_image_provenance_invalid");
  });

  it("rejects transplanted release evidence", () => {
    const value = provenance();
    expect(() =>
      assertVerifiedReleaseImageProvenance({
        ...value,
        releaseEvidence: {
          ...value.releaseEvidence,
          repository: "attacker/repository",
        },
      }),
    ).toThrow("release_image_provenance_invalid");
  });

  it("detects a provenance record transplanted between rollout artifacts", () => {
    const value = provenance();
    expect(
      sameReleaseImageProvenance(value, {
        ...value,
        releaseEvidence: { ...value.releaseEvidence, artifactId: "999" },
      }),
    ).toBe(false);
  });
});
