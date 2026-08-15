import { describe, expect, it } from "vitest";
import {
  activationCatalogPolicyTrustRootReadinessFromProvenance,
  assertActivationCatalogPolicyPromotionProvenance,
  type ActivationCatalogPolicyPromotionExpectation,
} from "./activation-catalog-policy-provenance-contract";

const expected: ActivationCatalogPolicyPromotionExpectation = {
  readinessReason: "reviewed-v21",
  captureBaseCommit: "a".repeat(40),
  candidateBytes: 42,
  candidateSha256: "b".repeat(64),
  sourcePg16Image: `postgres:16.13-bookworm@sha256:${"c".repeat(64)}`,
  targetPg17Image: `postgres:17.5-bookworm@sha256:${"d".repeat(64)}`,
  preactivationCatalogPolicySha256: `sha256:${"e".repeat(64)}`,
  activatedCatalogPolicySha256: `sha256:${"f".repeat(64)}`,
  artifactCanonicalSha256: `sha256:${"1".repeat(64)}`,
};

const ready = () => ({
  kind: "reviewrouter-activation-catalog-policy-promotion-provenance",
  version: 2,
  status: "ready",
  readinessReason: expected.readinessReason,
  promotedAt: "2026-08-15T10:31:00.000Z",
  captureBaseCommit: expected.captureBaseCommit,
  candidate: {
    bytes: expected.candidateBytes,
    sha256: expected.candidateSha256,
    captures: [
      { label: "capture-a", sha256: expected.candidateSha256 },
      { label: "capture-b", sha256: expected.candidateSha256 },
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
    reviewerRunId: "rr-policy-review-v21",
    reviewedAt: "2026-08-15T10:30:00.000Z",
    baseCommit: expected.captureBaseCommit,
    candidateBytes: expected.candidateBytes,
    candidateSha256: expected.candidateSha256,
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
      "promotion timestamp without time",
      (value: ReturnType<typeof ready>) => {
        value.promotedAt = "2026-08-15";
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
