import { canonicalJson, sha256Canonical } from "./release-rollout";
import type { ActivationCatalogPolicy } from "./effective-principal-inventory";

export type ActivationCatalogPolicyPhase = "preactivation" | "activated";

export type PinnedActivationCatalogPolicy = Readonly<{
  policy: ActivationCatalogPolicy;
  sha256: string;
}>;

export type ActivationCatalogPolicyDigests = Readonly<{
  preactivationCatalogPolicySha256: string;
  activatedCatalogPolicySha256: string;
}>;

/**
 * Release-owned activation policy trust root. Updating this artifact is a
 * versioned release change; deployment configuration is only checked input.
 */
export const canonicalActivationCatalogPolicyArtifact = Object.freeze({
  kind: "reviewrouter-activation-catalog-policy-artifact" as const,
  version: 1 as const,
  policies: Object.freeze({
    preactivation: Object.freeze({
      kind: "reviewrouter-activation-catalog-policy" as const,
      version: 1 as const,
      phase: "preactivation" as const,
      database: "review_router",
      roles: Object.freeze([]),
      memberships: Object.freeze([]),
      roleReachability: Object.freeze([]),
      rowSecurity: Object.freeze([]),
      grants: Object.freeze([]),
      effectivePermissions: Object.freeze([]),
    }),
    activated: Object.freeze({
      kind: "reviewrouter-activation-catalog-policy" as const,
      version: 1 as const,
      phase: "activated" as const,
      database: "review_router",
      roles: Object.freeze([]),
      memberships: Object.freeze([]),
      roleReachability: Object.freeze([]),
      rowSecurity: Object.freeze([]),
      grants: Object.freeze([]),
      effectivePermissions: Object.freeze([]),
    }),
  }),
});

const pin = (policy: ActivationCatalogPolicy): PinnedActivationCatalogPolicy =>
  Object.freeze({
    policy,
    sha256: `sha256:${sha256Canonical(policy)}`,
  });

export const canonicalActivationCatalogPolicies = Object.freeze({
  preactivation: pin(
    canonicalActivationCatalogPolicyArtifact.policies.preactivation,
  ),
  activated: pin(canonicalActivationCatalogPolicyArtifact.policies.activated),
});

export const canonicalActivationCatalogPolicyDigests = Object.freeze({
  preactivationCatalogPolicySha256:
    canonicalActivationCatalogPolicies.preactivation.sha256,
  activatedCatalogPolicySha256:
    canonicalActivationCatalogPolicies.activated.sha256,
});

const expectedFields = new Set([
  "kind",
  "version",
  "phase",
  "database",
  "roles",
  "memberships",
  "roleReachability",
  "rowSecurity",
  "grants",
  "effectivePermissions",
]);

export function assertCanonicalActivationCatalogPolicyInput(
  serialized: string,
  phase: ActivationCatalogPolicyPhase,
): PinnedActivationCatalogPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`activation_catalog_policy_json_invalid:${phase}`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== expectedFields.size ||
    !Object.keys(parsed).every((field) => expectedFields.has(field)) ||
    (parsed as Record<string, unknown>).kind !==
      "reviewrouter-activation-catalog-policy" ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).phase !== phase ||
    typeof (parsed as Record<string, unknown>).database !== "string" ||
    ![
      "roles",
      "memberships",
      "roleReachability",
      "rowSecurity",
      "grants",
      "effectivePermissions",
    ].every((field) =>
      Array.isArray((parsed as Record<string, unknown>)[field]),
    )
  )
    throw new Error(`activation_catalog_policy_contract_invalid:${phase}`);
  const expected = canonicalActivationCatalogPolicies[phase];
  if (canonicalJson(parsed) !== canonicalJson(expected.policy))
    throw new Error(
      `activation_catalog_policy_deployment_input_mismatch:${phase}`,
    );
  return expected;
}

export function activationCatalogPolicyDigestsEqual(
  value: ActivationCatalogPolicyDigests,
  expected: ActivationCatalogPolicyDigests = canonicalActivationCatalogPolicyDigests,
): boolean {
  return (
    value.preactivationCatalogPolicySha256 ===
      expected.preactivationCatalogPolicySha256 &&
    value.activatedCatalogPolicySha256 === expected.activatedCatalogPolicySha256
  );
}
