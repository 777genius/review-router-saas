import { describe, expect, it } from "vitest";
import { sha256Canonical } from "./canonical-json";
import { activationCatalogRawPromotionTrustRoot } from "./activation-catalog-policy-raw-promotion-trust-root";
import {
  authorizeCanonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyArtifact,
  canonicalActivationCatalogPolicyDigests,
  canonicalActivationCatalogPolicyTrustRootReadiness,
  reviewedActivationCatalogPolicyDigests,
} from "./activation-catalog-policy-contract";

describe("promoted activation catalog policy trust root", () => {
  it("admits the active reviewed trust root", () => {
    if (activationCatalogRawPromotionTrustRoot.status === "ready") {
      expect(canonicalActivationCatalogPolicyDigests).toEqual(
        reviewedActivationCatalogPolicyDigests,
      );
      expect(canonicalActivationCatalogPolicyTrustRootReadiness).toEqual({
        status: "ready",
        reason: "reviewed-raw",
      });
      expect(reviewedActivationCatalogPolicyDigests).toEqual({
        preactivationCatalogPolicySha256:
          activationCatalogRawPromotionTrustRoot.evidence.canonicalDigests
            .preactivation,
        activatedCatalogPolicySha256:
          activationCatalogRawPromotionTrustRoot.evidence.canonicalDigests
            .activated,
      });
      expect(
        `sha256:${sha256Canonical(canonicalActivationCatalogPolicyArtifact)}`,
      ).toBe(
        activationCatalogRawPromotionTrustRoot.evidence.canonicalDigests
          .artifact,
      );
    } else {
      expect(canonicalActivationCatalogPolicyTrustRootReadiness).toEqual({
        status: "blocked",
        reason:
          "fresh-authenticated-raw-capture-and-independent-review-required",
      });
    }
  });

  it("deep-freezes the source-owned artifact before exposing it", () => {
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(canonicalActivationCatalogPolicyArtifact);
  });

  it("authorizes only the exact compact digests under a ready trust root", () => {
    if (activationCatalogRawPromotionTrustRoot.status === "ready") {
      expect(() =>
        authorizeCanonicalActivationCatalogPolicies(
          canonicalActivationCatalogPolicyDigests,
        ),
      ).not.toThrow();
    } else {
      expect(() =>
        authorizeCanonicalActivationCatalogPolicies(
          canonicalActivationCatalogPolicyDigests,
        ),
      ).toThrow(
        "activation_catalog_policy_trust_root_blocked:fresh-authenticated-raw-capture-and-independent-review-required",
      );
    }
    expect(() =>
      authorizeCanonicalActivationCatalogPolicies({
        ...reviewedActivationCatalogPolicyDigests,
        activatedCatalogPolicySha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("activation_catalog_policy_digest_mismatch");
  });
});
