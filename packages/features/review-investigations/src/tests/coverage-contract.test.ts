import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewInvestigationCoverageProfileGeneration,
  assertSupportedReviewInvestigationCoverageProfile,
  resolveReviewInvestigationCoverageProfileGeneration,
  reviewInvestigationCoverageProfileV1,
  reviewInvestigationCoverageProfileV2,
  reviewInvestigationCoverageProfileV3,
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
        ...reviewInvestigationCoverageProfileV3,
        producerReleaseId: "release-1",
      }),
    ).not.toThrow();

    for (const field of Object.keys(reviewInvestigationCoverageProfileV3)) {
      expect(() =>
        assertSupportedReviewInvestigationCoverageProfile({
          ...reviewInvestigationCoverageProfileV3,
          producerReleaseId: "release-1",
          [field]: `${field}.unsupported`,
        }),
      ).toThrow("investigation_coverage_profile_unsupported");
    }
    expect(() =>
      assertSupportedReviewInvestigationCoverageProfile({
        ...reviewInvestigationCoverageProfileV3,
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
        ...reviewInvestigationCoverageProfileV3,
        expansionRulesVersion: "review-investigation-expansion.v4",
        producerReleaseId: "release-unsupported-v4",
      }),
    ).toThrow("investigation_coverage_profile_unsupported");
  });

  it("matches the public Action capability golden vector", () => {
    expect(
      createHash("sha256")
        .update(canonicalJson(reviewInvestigationCoverageProfileV3), "utf8")
        .digest("hex"),
    ).toBe("76226b3d40021a3bb938283f5b983df3f304b2494b8335a8f751f752fa3d0c95");
  });
});
