import { describe, expect, it } from "vitest";
import {
  activationCatalogPromotionOptIn,
  assertReviewedActivationCatalogPromotionProvenance,
  promotePrivatePg17ActivationCatalogPolicy,
} from "./promote-private-pg17-activation-catalog-policy.mjs";

describe("activation catalog policy promotion", () => {
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
});
