import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  authorizeCanonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyArtifact,
  canonicalActivationCatalogPolicyDigests,
  canonicalActivationCatalogPolicyTrustRootReadiness,
  reviewedActivationCatalogPolicyDigests,
} from "./activation-catalog-policy-contract";

describe("promoted activation catalog policy trust root", () => {
  it("pins the independently reviewed phase digests and readiness reason", () => {
    const provenance = JSON.parse(
      readFileSync(
        new URL("activation-catalog-policy-provenance.json", import.meta.url),
        "utf8",
      ),
    );
    expect(canonicalActivationCatalogPolicyDigests).toEqual(
      reviewedActivationCatalogPolicyDigests,
    );
    expect(canonicalActivationCatalogPolicyDigests).toEqual({
      preactivationCatalogPolicySha256:
        provenance.canonicalDigests.preactivation,
      activatedCatalogPolicySha256: provenance.canonicalDigests.activated,
    });
    expect(canonicalActivationCatalogPolicyTrustRootReadiness).toEqual({
      status: "ready",
      reason:
        "independently-reviewed-v19-production-shaped-pg17-candidate-promoted-with-pinned-phase-digests",
    });
    expect(
      canonicalActivationCatalogPolicies.preactivation.policy.grants,
    ).toHaveLength(2454);
    expect(
      canonicalActivationCatalogPolicies.activated.policy.grants,
    ).toHaveLength(3319);
  });

  it("deep-freezes the source-owned artifact before exposing it", () => {
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(canonicalActivationCatalogPolicyArtifact);
  });

  it("requires independent exact compact digest authorization", () => {
    expect(
      authorizeCanonicalActivationCatalogPolicies(
        reviewedActivationCatalogPolicyDigests,
      ),
    ).toBe(canonicalActivationCatalogPolicies);
    expect(() =>
      authorizeCanonicalActivationCatalogPolicies({
        ...reviewedActivationCatalogPolicyDigests,
        activatedCatalogPolicySha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("activation_catalog_policy_digest_mismatch");
  });
});
