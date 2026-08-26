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
  it("pins the exact reviewed v29 candidate and operator opt-in", () => {
    expect(activationCatalogPromotionOptIn).toBe(
      "promote-reviewed-activation-catalog-v29",
    );
    expect(reviewedActivationCatalogCandidate).toEqual({
      sha256:
        "bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62",
      bytes: 2_627_574,
      preactivationCatalogPolicySha256:
        "sha256:7d511ef69e73cb040ce164de5914f8129f956ff9a351840391b0c1937958c787",
      activatedCatalogPolicySha256:
        "sha256:c2981e22c9095572a396c81acbab316ae643a5d4305a113cfeff2327f7e57c47",
      artifactCanonicalSha256:
        "sha256:ac627f7d9bb37e15ba790082586ce3b84e8c4d19361f517ba59e0d46441d3b0c",
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
