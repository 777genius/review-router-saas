import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sha256Canonical } from "./canonical-json";
import { activationCatalogRawPromotionTrustRoot } from "./activation-catalog-policy-raw-promotion-trust-root";
import {
  authorizeCanonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyArtifact,
  canonicalActivationCatalogPolicyDigests,
  canonicalActivationCatalogPolicyTrustRootReadiness,
  reviewedActivationCatalogPolicyDigests,
} from "./activation-catalog-policy-contract";

describe("promoted activation catalog policy trust root", () => {
  it("admits the active reviewed trust root", () => {
    const provenance = JSON.parse(
      readFileSync(
        new URL("activation-catalog-policy-provenance.json", import.meta.url),
        "utf8",
      ),
    );
    expect(canonicalActivationCatalogPolicyDigests).toEqual(
      reviewedActivationCatalogPolicyDigests,
    );
    if (activationCatalogRawPromotionTrustRoot.status === "ready") {
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
        status: "ready",
        reason:
          "reviewed-v29-schema-v5-pr245-promoted-with-evidence-contract-v2",
      });
      expect(provenance).toMatchObject({
        version: 5,
        status: "ready",
        evidenceContractVersion: 2,
        capture: {
          baseCommit: "79c8496d64b63c129e19331ee328666f714d82b1",
          auditedTree: "1cdb05db1f73eb2bf294d774d517fff533ca24bc",
        },
      });
      expect(
        canonicalActivationCatalogPolicies.preactivation.policy.grants,
      ).toHaveLength(3082);
      expect(
        canonicalActivationCatalogPolicies.activated.policy.grants,
      ).toHaveLength(4072);
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

  it("authorizes only the exact compact digests under the ready trust root", () => {
    expect(() =>
      authorizeCanonicalActivationCatalogPolicies(
        canonicalActivationCatalogPolicyDigests,
      ),
    ).not.toThrow();
    expect(() =>
      authorizeCanonicalActivationCatalogPolicies({
        ...reviewedActivationCatalogPolicyDigests,
        activatedCatalogPolicySha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("activation_catalog_policy_digest_mismatch");
  });
});
