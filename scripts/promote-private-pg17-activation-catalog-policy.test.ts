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
  it("pins the exact reviewed v24 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v24",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "8f4f5d60707cd57eff560218f3cdeeaf4a56f1934dab9939ba4eeb1630947630",
      bytes: 2_477_044,
      preactivationCatalogPolicySha256:
        "sha256:fe9c71391557f194d84070689100ba55e31fe9e89a768b39879ff43619726c37",
      activatedCatalogPolicySha256:
        "sha256:b5b56feebf9be6e17e6d4aaf17d7f5409b7a3df0f6fe5692ea588043d5a7e4c1",
      artifactCanonicalSha256:
        "sha256:5f4dc73eff4574cea5d6953173b0d35d4332fdc1d2e8b74190dce69569b3292d",
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
