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
  it("pins the exact reviewed v26 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v26",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "f2eeaf4ed03dbb72c7b551a483201aa6086788c3ee3d3b8118ded067ae5f3d1f",
      bytes: 2_490_382,
      preactivationCatalogPolicySha256:
        "sha256:b95cc2c1fdd94b64056f6d8cd9316d361dce87a8a6a8064c8db51db65a886e68",
      activatedCatalogPolicySha256:
        "sha256:118834866426337911d13e47f2752f2f982c1393792668036e359b0062117c6f",
      artifactCanonicalSha256:
        "sha256:95a5b1adcb36e6917fa9113a17e7392772d344e4c9dfbef3d206e57e959f01d3",
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
