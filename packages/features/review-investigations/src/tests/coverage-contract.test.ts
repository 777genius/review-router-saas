import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewInvestigationCoverageProfileGeneration,
  assertSupportedReviewInvestigationCoverageProfile,
  resolveReviewInvestigationCoverageProfileGeneration,
  reviewInvestigationCoverageProfileV1,
  reviewInvestigationCoverageProfileV2,
  reviewInvestigationCoverageProfileV3,
  reviewInvestigationCoverageProfileV4,
  reviewInvestigationCoverageProfileV5,
  reviewInvestigationCoverageProfileV6,
  reviewInvestigationCoverageProfileV7,
} from "../domain/coverage-contract";
import { canonicalJson } from "../domain/canonicalization";

describe("review investigation coverage profile", () => {
  it("accepts only the exact server-supported version tuple", () => {
    expect(() =>
      assertSupportedReviewInvestigationCoverageProfile({
        ...reviewInvestigationCoverageProfileV2,
        producerReleaseId: "release-legacy-v2",
      }),
    ).not.toThrow();
    expect(() =>
      assertSupportedReviewInvestigationCoverageProfile({
        ...reviewInvestigationCoverageProfileV7,
        producerReleaseId: "release-1",
      }),
    ).not.toThrow();

    for (const field of Object.keys(reviewInvestigationCoverageProfileV7)) {
      expect(() =>
        assertSupportedReviewInvestigationCoverageProfile({
          ...reviewInvestigationCoverageProfileV7,
          producerReleaseId: "release-1",
          [field]: `${field}.unsupported`,
        }),
      ).toThrow("investigation_coverage_profile_unsupported");
    }
    expect(() =>
      assertSupportedReviewInvestigationCoverageProfile({
        ...reviewInvestigationCoverageProfileV4,
        producerReleaseId: "release-1",
        unknownPolicyVersion: "unknown.v1",
      } as never),
    ).toThrow("investigation_coverage_profile_unsupported");
  });

  it("classifies the drain-compatible and current profiles explicitly", () => {
    const historicalV1 = {
      ...reviewInvestigationCoverageProfileV1,
      producerReleaseId: "release-historical-v1",
    };
    expect(
      resolveReviewInvestigationCoverageProfileGeneration(historicalV1),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V1);
    expect(() =>
      assertSupportedReviewInvestigationCoverageProfile(historicalV1),
    ).toThrow("investigation_coverage_profile_unsupported");
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV2,
        producerReleaseId: "release-legacy-v2",
      }),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V2);
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV3,
        producerReleaseId: "release-current-v3",
      }),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V3);
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV4,
        producerReleaseId: "release-current-v4",
      }),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V4);
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV5,
        producerReleaseId: "release-current-v5",
      }),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V5);
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV6,
        producerReleaseId: "release-current-v6",
      }),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V6);
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV7,
        producerReleaseId: "release-current-v7",
      }),
    ).toBe(ReviewInvestigationCoverageProfileGeneration.V7);
    expect(
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV2,
        coverageContractVersion: "legacy-coverage.v0",
        producerReleaseId: "release-legacy",
      }),
    ).toBeNull();
    for (const field of Object.keys(reviewInvestigationCoverageProfileV1)) {
      const mutated = { ...historicalV1, [field]: `${field}.unsupported` };
      if (field === "coverageContractVersion") {
        expect(
          resolveReviewInvestigationCoverageProfileGeneration(mutated),
        ).toBeNull();
      } else {
        expect(() =>
          resolveReviewInvestigationCoverageProfileGeneration(mutated),
        ).toThrow("investigation_coverage_profile_unsupported");
      }
    }
    expect(() =>
      resolveReviewInvestigationCoverageProfileGeneration({
        ...historicalV1,
        unknownPolicyVersion: "unknown.v1",
      } as never),
    ).toThrow("investigation_coverage_profile_unsupported");
    expect(() =>
      resolveReviewInvestigationCoverageProfileGeneration({
        ...reviewInvestigationCoverageProfileV4,
        expansionRulesVersion: "review-investigation-expansion.v4",
        producerReleaseId: "release-unsupported-v4",
      }),
    ).toThrow("investigation_coverage_profile_unsupported");
  });

  it("matches the current public Action capability golden vector", () => {
    expect(
      createHash("sha256")
        .update(canonicalJson(reviewInvestigationCoverageProfileV7), "utf8")
        .digest("hex"),
    ).toBe("064b245d9ac5b710a70ec2e3c1efdefa8f5b2de0efd73332a413f846c08783db");
  });
});
