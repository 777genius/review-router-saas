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
  it("pins the exact reviewed v25 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v25",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "3f20cac0f84591e99f2f4f4a555faac4e2900fc5e6271238d20c71b67a6538bb",
      bytes: 2_489_008,
      preactivationCatalogPolicySha256:
        "sha256:36e6e4875c530beba1cb6bfc580a358d031895334e6af6a6bad193148e1beebe",
      activatedCatalogPolicySha256:
        "sha256:d0ccc9a760f69c467d3c9df56502704abb1f03116a2be156eb206100b35f5866",
      artifactCanonicalSha256:
        "sha256:539eead0f59e75f283d217be840280c61a3813d928e24a48ed9b34687ef5111d",
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
