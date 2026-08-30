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
  it("blocks the stale v29 review after the catalog projection changed", () => {
    const provenance = JSON.parse(
      readFileSync(
        new URL("activation-catalog-policy-provenance.json", import.meta.url),
        "utf8",
      ),
    );
    expect(canonicalActivationCatalogPolicyDigests).toEqual(
      reviewedActivationCatalogPolicyDigests,
    );
    expect(canonicalActivationCatalogPolicyTrustRootReadiness).toEqual({
      status: "blocked",
      reason: "independent-review-required-after-catalog-projection-change",
    });
    expect(provenance.invalidatedReview).toEqual({
      reviewDecisionId: "RR-V29-CODEX-GO-7459B6D4-B138EB3E-20260830",
      auditedHead: "7459b6d4fd8aab5c377547246292faf3376d98cb",
      invalidatedByCommit: "54520f050c61e88356ea0376964ac25a38700bc8",
    });
    expect(
      canonicalActivationCatalogPolicies.preactivation.policy.grants,
    ).toHaveLength(3082);
    expect(
      canonicalActivationCatalogPolicies.activated.policy.grants,
    ).toHaveLength(4072);
  });

  it("deep-freezes the source-owned artifact before exposing it", () => {
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(canonicalActivationCatalogPolicyArtifact);
  });

  it("refuses compact digest authorization while review is stale", () => {
    expect(() =>
      authorizeCanonicalActivationCatalogPolicies(
        canonicalActivationCatalogPolicyDigests,
      ),
    ).toThrow("activation_catalog_policy_trust_root_blocked");
    expect(() =>
      authorizeCanonicalActivationCatalogPolicies({
        ...reviewedActivationCatalogPolicyDigests,
        activatedCatalogPolicySha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("activation_catalog_policy_digest_mismatch");
  });
});
