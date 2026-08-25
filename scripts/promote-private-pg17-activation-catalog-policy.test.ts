import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  activationCatalogPromotionOptIn,
  activationCatalogPromotionProvenancePath,
  assertActivationCatalogPolicyIndependentReviewEvidence,
  assertReviewedActivationCatalogPromotionProvenance,
  promotePrivatePg17ActivationCatalogPolicy,
  reviewedActivationCatalogCandidate,
} from "./promote-private-pg17-activation-catalog-policy.mjs";

describe("activation catalog policy promotion", () => {
  it("pins the exact reviewed v28 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v28",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9",
      bytes: 2_506_590,
      preactivationCatalogPolicySha256:
        "sha256:95591a9df4dd88afe9a9a10118bf11b7e5ec4694748f8262de124d5f7ba7fd59",
      activatedCatalogPolicySha256:
        "sha256:6c8f40abc68b063b835289d3d42f7ee07d9769baf269c5b05fb85db72c8cb3a0",
      artifactCanonicalSha256:
        "sha256:bb528f22b531f212641ecebdb5ea8d0b851f0291a8c830d5bb41c88b348ccb57",
    });
  });

  it("requires the exact operator promotion opt-in before reading input", async () => {
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {},
        argv: ["--candidate", "/does/not/exist"],
      }),
    ).rejects.toThrow("activation_catalog_policy_promotion_opt_in_required");
  });

  it("requires an explicit candidate path under the exact opt-in", async () => {
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {
          REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
            activationCatalogPromotionOptIn,
        },
        argv: [],
      }),
    ).rejects.toThrow("activation_catalog_policy_promotion_candidate_required");
  });

  it("refuses unreviewed candidate bytes", async () => {
    await expect(
      promotePrivatePg17ActivationCatalogPolicy({
        env: {
          REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION:
            activationCatalogPromotionOptIn,
        },
        argv: ["--candidate", import.meta.filename],
      }),
    ).rejects.toThrow(
      /activation_catalog_policy_promotion_candidate_(?:size|hash)_drift/u,
    );
  });

  it("refuses promotion without exact independent GO evidence", () => {
    expect(() =>
      assertReviewedActivationCatalogPromotionProvenance({
        status: "ready",
        independentReview: { result: "NO-GO" },
      }),
    ).toThrow("activation_catalog_policy_promotion_provenance_invalid");
  });

  it("verifies the immutable independent review and runtime evidence", async () => {
    const provenance = JSON.parse(
      await readFile(activationCatalogPromotionProvenancePath, "utf8"),
    );
    await expect(
      assertActivationCatalogPolicyIndependentReviewEvidence(provenance),
    ).resolves.toBeUndefined();
  });
});
