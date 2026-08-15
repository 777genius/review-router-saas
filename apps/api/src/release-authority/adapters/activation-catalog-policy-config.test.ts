import { describe, expect, it } from "vitest";
import {
  canonicalActivationCatalogPolicyDigests,
  canonicalActivationCatalogPolicyTrustRootReadiness,
} from "@reviewrouter/features-release-rollout";
import {
  configuredActivationCatalogPolicyDigests,
  trustedActivationCatalogPoliciesFromEnvironment,
} from "./activation-catalog-policy-config.js";

const configured = {
  REVIEW_ROUTER_TARGET_PREACTIVATION_CATALOG_POLICY_SHA256:
    canonicalActivationCatalogPolicyDigests.preactivationCatalogPolicySha256,
  REVIEW_ROUTER_TARGET_ACTIVATED_CATALOG_POLICY_SHA256:
    canonicalActivationCatalogPolicyDigests.activatedCatalogPolicySha256,
};

describe("activation catalog policy deployment authorization", () => {
  it("requires both independently configured compact digests", () => {
    expect(() => configuredActivationCatalogPolicyDigests({})).toThrow(
      "activation_catalog_policy_digest_env_missing:REVIEW_ROUTER_TARGET_PREACTIVATION_CATALOG_POLICY_SHA256",
    );
    expect(() =>
      configuredActivationCatalogPolicyDigests({
        REVIEW_ROUTER_TARGET_PREACTIVATION_CATALOG_POLICY_SHA256:
          configured.REVIEW_ROUTER_TARGET_PREACTIVATION_CATALOG_POLICY_SHA256,
      }),
    ).toThrow(
      "activation_catalog_policy_digest_env_missing:REVIEW_ROUTER_TARGET_ACTIVATED_CATALOG_POLICY_SHA256",
    );
  });

  it.each(["", "abc", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`])(
    "rejects malformed digest %j",
    (digest) => {
      expect(() =>
        trustedActivationCatalogPoliciesFromEnvironment({
          ...configured,
          REVIEW_ROUTER_TARGET_ACTIVATED_CATALOG_POLICY_SHA256: digest,
        }),
      ).toThrow(
        digest === ""
          ? "activation_catalog_policy_digest_env_missing"
          : "activation_catalog_policy_digest_invalid",
      );
    },
  );

  it("rejects a well-formed digest that does not authorize the artifact", () => {
    expect(() =>
      trustedActivationCatalogPoliciesFromEnvironment({
        ...configured,
        REVIEW_ROUTER_TARGET_ACTIVATED_CATALOG_POLICY_SHA256: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow("activation_catalog_policy_digest_mismatch");
  });

  it("blocks the changed artifact until PG17 policy recapture is reviewed", () => {
    expect(canonicalActivationCatalogPolicyTrustRootReadiness).toEqual({
      status: "blocked",
      reason:
        "pg17-recapture-required-after-migration-permit-contract-change",
    });
    expect(() => trustedActivationCatalogPoliciesFromEnvironment(configured))
      .toThrow("activation_catalog_policy_trust_root_blocked");
  });
});
