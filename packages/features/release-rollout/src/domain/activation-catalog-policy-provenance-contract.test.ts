import { describe, expect, it } from "vitest";
import {
  activationCatalogPolicyTrustRootReadinessFromProvenance,
  assertActivationCatalogPolicyPromotionProvenance,
  type ActivationCatalogPolicyPromotionExpectation,
} from "./activation-catalog-policy-provenance-contract";

const expected: ActivationCatalogPolicyPromotionExpectation = {
  readinessReason: "reviewed-v21",
  captureBaseCommit: "a".repeat(40),
  auditedHead: "2".repeat(40),
  captureArtifactBytes: 47,
  captureArtifactSha256: "4".repeat(64),
  capturePayloadOffsetBytes: 5,
  capturePrefixSha256: "5".repeat(64),
  reviewArtifactSha256: "3".repeat(64),
  reviewerEvidenceSha256: "6".repeat(64),
  reviewerRunId: "rr-policy-review-v21",
  reviewDecisionId: "rr-policy-review-v21:go",
  candidateBytes: 42,
  candidateSha256: "b".repeat(64),
  liveCatalogDigest: `sha256:${"7".repeat(64)}`,
  sourcePg16Image: `postgres:16.13-bookworm@sha256:${"c".repeat(64)}`,
  targetPg17Image: `postgres:17.5-bookworm@sha256:${"d".repeat(64)}`,
  preactivationCatalogPolicySha256: `sha256:${"e".repeat(64)}`,
  activatedCatalogPolicySha256: `sha256:${"f".repeat(64)}`,
  artifactCanonicalSha256: `sha256:${"1".repeat(64)}`,
};

const ready = () => ({
  kind: "reviewrouter-activation-catalog-policy-promotion-provenance",
  version: 3,
  status: "ready",
  readinessReason: expected.readinessReason,
  promotedAt: "2026-08-15T10:31:00.000Z",
  captureBaseCommit: expected.captureBaseCommit,
  candidate: {
    bytes: expected.candidateBytes,
    sha256: expected.candidateSha256,
    liveCatalogDigest: expected.liveCatalogDigest,
    captures: [
      {
        label: "capture-a",
        artifactBytes: expected.captureArtifactBytes,
        artifactSha256: expected.captureArtifactSha256,
        payloadOffsetBytes: expected.capturePayloadOffsetBytes,
        prefixSha256: expected.capturePrefixSha256,
        payloadBytes: expected.candidateBytes,
        payloadSha256: expected.candidateSha256,
      },
      {
        label: "capture-b",
        artifactBytes: expected.captureArtifactBytes,
        artifactSha256: expected.captureArtifactSha256,
        payloadOffsetBytes: expected.capturePayloadOffsetBytes,
        prefixSha256: expected.capturePrefixSha256,
        payloadBytes: expected.candidateBytes,
        payloadSha256: expected.candidateSha256,
      },
    ],
  },
  postgresImages: {
    sourcePg16: expected.sourcePg16Image,
    targetPg17: expected.targetPg17Image,
  },
  canonicalDigests: {
    preactivation: expected.preactivationCatalogPolicySha256,
    activated: expected.activatedCatalogPolicySha256,
    artifact: expected.artifactCanonicalSha256,
  },
  independentReview: {
    result: "GO",
    reviewerRunId: expected.reviewerRunId,
    reviewDecisionId: expected.reviewDecisionId,
    reviewedAt: "2026-08-15T10:30:00.000Z",
    baseCommit: expected.captureBaseCommit,
    auditedHead: expected.auditedHead,
    reviewArtifactSha256: expected.reviewArtifactSha256,
    reviewerEvidenceSha256: expected.reviewerEvidenceSha256,
    candidateBytes: expected.candidateBytes,
    candidateSha256: expected.candidateSha256,
    liveCatalogDigest: expected.liveCatalogDigest,
    postgresImages: {
      sourcePg16: expected.sourcePg16Image,
      targetPg17: expected.targetPg17Image,
    },
    canonicalDigests: {
      preactivation: expected.preactivationCatalogPolicySha256,
      activated: expected.activatedCatalogPolicySha256,
      artifact: expected.artifactCanonicalSha256,
    },
  },
});

describe("activation catalog policy promotion provenance", () => {
  it("accepts two byte-identical captures and an exact independent GO", () => {
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(
        ready(),
        expected,
      ),
    ).toEqual({ status: "ready", reason: "reviewed-v21" });
    expect(() =>
      assertActivationCatalogPolicyPromotionProvenance(ready(), expected),
    ).not.toThrow();
  });

  it.each([
    [
      "audited head drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.auditedHead = "0".repeat(40);
      },
    ],
    [
      "review artifact digest drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.reviewArtifactSha256 = "0".repeat(64);
      },
    ],
    [
      "reviewer runtime evidence digest drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.reviewerEvidenceSha256 = "0".repeat(64);
      },
    ],
    [
      "review decision identity drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.reviewDecisionId = "rr-policy-review-v21:no-go";
      },
    ],
    [
      "NO-GO review",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.result = "NO-GO";
      },
    ],
    [
      "candidate drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.candidateSha256 = "0".repeat(64);
      },
    ],
    [
      "live catalog digest drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.liveCatalogDigest = `sha256:${"0".repeat(64)}`;
      },
    ],
    [
      "image drift",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.postgresImages.targetPg17 = `postgres:17.5-bookworm@sha256:${"0".repeat(64)}`;
      },
    ],
    [
      "duplicate capture",
      (value: ReturnType<typeof ready>) => {
        value.candidate.captures[1]!.label = value.candidate.captures[0]!.label;
      },
    ],
    [
      "raw capture artifact digest drift",
      (value: ReturnType<typeof ready>) => {
        value.candidate.captures[0]!.artifactSha256 = "0".repeat(64);
      },
    ],
    [
      "capture payload boundary drift",
      (value: ReturnType<typeof ready>) => {
        value.candidate.captures[0]!.payloadOffsetBytes += 1;
      },
    ],
    [
      "review after promotion",
      (value: ReturnType<typeof ready>) => {
        value.independentReview.reviewedAt = "2026-08-15T10:32:00.000Z";
      },
    ],
    [
      "promotion timestamp without time",
      (value: ReturnType<typeof ready>) => {
        value.promotedAt = "2026-08-15";
      },
    ],
    [
      "invalid calendar timestamp",
      (value: ReturnType<typeof ready>) => {
        value.promotedAt = "2026-99-99T10:31:00.000Z";
      },
    ],
  ])("blocks %s", (_name, mutate) => {
    const value = ready();
    mutate(value);
    expect(
      activationCatalogPolicyTrustRootReadinessFromProvenance(value, expected)
        .status,
    ).toBe("blocked");
    expect(() =>
      assertActivationCatalogPolicyPromotionProvenance(value, expected),
    ).toThrow("activation_catalog_policy_promotion_provenance_invalid");
  });
});
