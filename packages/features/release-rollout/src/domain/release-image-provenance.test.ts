import { describe, expect, it } from "vitest";
import { sha256Canonical } from "./release-rollout";
import {
  assertVerifiedReleaseImageProvenance,
  sameReleaseImageProvenance,
  type ReleaseImageIdentity,
  type VerifiedReleaseImageProvenance,
} from "./release-image-provenance";

const repository = "source-owner/source-repository";
const commit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageRepository = "registry.example/runtime-owner/runtime-image";
const policySha256 = `sha256:${"c".repeat(64)}`;
const identity: ReleaseImageIdentity = {
  schemaVersion: "reviewrouter.hosted-runtime-image.v1",
  repository,
  commit,
  imageUrl: `${imageRepository}@${imageDigest}`,
  imageDigest,
};
const provenance = (): VerifiedReleaseImageProvenance => ({
  schemaVersion: "reviewrouter.release-image-provenance.v2",
  identity,
  claim: {
    identitySha256: `sha256:${sha256Canonical(identity)}`,
    sourceRepository: repository,
    sourceRevision: commit,
    imageRepository,
    buildRunId: "123",
    artifactId: "456",
    artifactName: "runtime-image-v1.2.3",
  },
  verification: {
    policySha256,
    verifiedAt: "2026-08-13T00:00:00.000Z",
  },
});

describe("verified release image provenance", () => {
  it("binds source repository, exact revision, image repository and digest, run, artifact, and policy", () => {
    expect(
      assertVerifiedReleaseImageProvenance(provenance(), {
        sourceRepository: repository,
        sourceRevision: commit,
        imageRepository,
        verificationPolicySha256: policySha256,
      }),
    ).toEqual(provenance());
  });

  it.each([
    ["stale expected revision", { commit: "d".repeat(40) }],
    ["foreign source repository", { repository: "attacker/repository" }],
    [
      "foreign image repository",
      { imageRepository: "registry.example/other/image" },
    ],
    [
      "untrusted verification policy",
      { verificationPolicySha256: `sha256:${"e".repeat(64)}` },
    ],
  ] as const)("rejects %s", (_name, changed) => {
    expect(() =>
      assertVerifiedReleaseImageProvenance(provenance(), {
        sourceRepository:
          "repository" in changed ? changed.repository : repository,
        sourceRevision: "commit" in changed ? changed.commit : commit,
        imageRepository:
          "imageRepository" in changed
            ? changed.imageRepository
            : imageRepository,
        verificationPolicySha256:
          "verificationPolicySha256" in changed
            ? changed.verificationPolicySha256
            : policySha256,
      }),
    ).toThrow("release_image_provenance_invalid");
  });

  it("rejects digest substitution even when the URL is changed consistently", () => {
    const value = provenance();
    const changedDigest = `sha256:${"d".repeat(64)}`;
    expect(() =>
      assertVerifiedReleaseImageProvenance({
        ...value,
        identity: {
          ...value.identity,
          imageDigest: changedDigest,
          imageUrl: `${imageRepository}@${changedDigest}`,
        },
      }),
    ).toThrow("release_image_provenance_invalid");
  });

  it("rejects transplanted source, run, artifact, and policy claims", () => {
    const value = provenance();
    for (const changed of [
      { ...value.claim, sourceRepository: "attacker/repository" },
      { ...value.claim, sourceRevision: "f".repeat(40) },
      { ...value.claim, buildRunId: "999" },
      { ...value.claim, artifactId: "999" },
    ])
      expect(() =>
        assertVerifiedReleaseImageProvenance(
          { ...value, claim: changed },
          {
            sourceRepository: repository,
            sourceRevision: commit,
            imageRepository,
            verificationPolicySha256: policySha256,
            buildRunId: value.claim.buildRunId,
            artifactId: value.claim.artifactId,
            artifactName: value.claim.artifactName,
          },
        ),
      ).toThrow("release_image_provenance_invalid");
    expect(() =>
      assertVerifiedReleaseImageProvenance({
        ...value,
        verification: {
          ...value.verification,
          policySha256: "invalid",
        },
      }),
    ).toThrow("release_image_provenance_invalid");
  });

  it("accepts provider-neutral OCI repository identities", () => {
    const value = provenance();
    expect(
      assertVerifiedReleaseImageProvenance({
        ...value,
        identity: {
          ...value.identity,
          imageUrl: `registry.internal:5000/team/runtime@${imageDigest}`,
        },
        claim: {
          ...value.claim,
          imageRepository: "registry.internal:5000/team/runtime",
          identitySha256: `sha256:${sha256Canonical({
            ...value.identity,
            imageUrl: `registry.internal:5000/team/runtime@${imageDigest}`,
          })}`,
        },
      }).claim.imageRepository,
    ).toBe("registry.internal:5000/team/runtime");
  });

  it("detects a provenance record transplanted between rollout artifacts", () => {
    const value = provenance();
    expect(
      sameReleaseImageProvenance(value, {
        ...value,
        claim: { ...value.claim, artifactId: "999" },
      }),
    ).toBe(false);
  });

  it.each([
    ["null root", null],
    ["missing identity", { ...provenance(), identity: null }],
    [
      "invalid timestamp",
      {
        ...provenance(),
        verification: {
          ...provenance().verification,
          verifiedAt: "not-a-date",
        },
      },
    ],
  ])(
    "normalizes malformed %s to the provenance domain error",
    (_name, value) => {
      expect(() => assertVerifiedReleaseImageProvenance(value)).toThrow(
        "release_image_provenance_invalid",
      );
    },
  );
});
