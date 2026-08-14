import { describe, expect, it } from "vitest";
import { trustedActivationCatalogPolicy } from "./activation-catalog-policy.js";

const policy = (phase: "preactivation" | "activated") => ({
  kind: "reviewrouter-activation-catalog-policy",
  version: 1,
  phase,
  database: "review_router",
  roles: [],
  memberships: [],
  roleReachability: [],
  rowSecurity: [],
  grants: [],
  effectivePermissions: [],
});

describe("trusted activation catalog policy", () => {
  it("normalizes object keys and produces a deterministic digest", () => {
    const first = trustedActivationCatalogPolicy(
      JSON.stringify(policy("preactivation")),
      "preactivation",
    );
    const reordered = trustedActivationCatalogPolicy(
      JSON.stringify({
        ...policy("preactivation"),
        kind: "reviewrouter-activation-catalog-policy",
      }),
      "preactivation",
    );
    expect(first).toEqual(reordered);
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects legacy effective-principal and phase-swapped policies", () => {
    expect(() =>
      trustedActivationCatalogPolicy(
        JSON.stringify({ version: 1, principals: [] }),
        "activated",
      ),
    ).toThrow("activation_catalog_policy_contract_invalid:activated");
    expect(() =>
      trustedActivationCatalogPolicy(
        JSON.stringify(policy("preactivation")),
        "activated",
      ),
    ).toThrow("activation_catalog_policy_contract_invalid:activated");
  });
});
