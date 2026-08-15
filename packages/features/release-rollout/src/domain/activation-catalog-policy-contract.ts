import { sha256Canonical } from "./release-rollout";
import generatedActivationCatalogPolicyArtifact from "./activation-catalog-policy-artifact.generated.js";
import {
  canonicalActivationPrincipalNames,
  canonicalBootstrapMembershipRoleNames,
  type ActivationCatalogPolicy,
} from "./effective-principal-inventory";
import {
  assertActivationCatalogPolicyNormalizationForProfile,
  type ActivationCatalogPolicyNormalizationProfile,
} from "./activation-catalog-policy-normalization";

export type ActivationCatalogPolicyPhase = "preactivation" | "activated";

export type PinnedActivationCatalogPolicy = Readonly<{
  policy: ActivationCatalogPolicy;
  sha256: string;
}>;

export type ActivationCatalogPolicyDigests = Readonly<{
  preactivationCatalogPolicySha256: string;
  activatedCatalogPolicySha256: string;
}>;

// The checked-in v20 artifact remains independently pinned until the rollout
// orchestrator captures and promotes the schema-owner topology. Live capture
// uses canonicalActivationPrincipalNames; this validator deliberately proves
// only the immutable artifact that is currently promoted.
const promotedArtifactPrincipalNames = canonicalActivationPrincipalNames.filter(
  (name) => name !== "reviewrouter_release_schema_owner",
);
const promotedArtifactNormalizationProfile: ActivationCatalogPolicyNormalizationProfile =
  Object.freeze({
    principalNames: promotedArtifactPrincipalNames,
    bootstrapMembershipRoleNames: canonicalBootstrapMembershipRoleNames,
    noLoginPrincipalNames: Object.freeze([
      "reviewrouter_activation_receipt_guard",
    ]),
    createRolePrincipalNames: Object.freeze(["reviewrouter_role_bootstrap"]),
  });

export const canonicalActivationCatalogPolicyTrustRootReadiness: Readonly<{
  status: "blocked" | "ready";
  reason: string;
}> = Object.freeze({
  status: "ready",
  reason:
    "reviewed-v20-production-shaped-pg17-candidate-promoted-with-pinned-phase-digests",
});

export function assertCanonicalActivationCatalogPolicyTrustRootReady(): void {
  if (canonicalActivationCatalogPolicyTrustRootReadiness.status !== "ready")
    throw new Error(
      `activation_catalog_policy_trust_root_blocked:${canonicalActivationCatalogPolicyTrustRootReadiness.reason}`,
    );
}

type ActivationCatalogPolicyArtifact = Readonly<{
  kind: "reviewrouter-activation-catalog-policy-artifact";
  version: 1;
  policies: Readonly<{
    preactivation: ActivationCatalogPolicy;
    activated: ActivationCatalogPolicy;
  }>;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneGeneratedArtifact(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function assertActivationCatalogPolicyArtifact(
  value: unknown,
): asserts value is ActivationCatalogPolicyArtifact {
  if (!isExactRecord(value, ["kind", "version", "policies"]))
    throw new Error("activation_catalog_policy_artifact_invalid");
  if (
    value.kind !== "reviewrouter-activation-catalog-policy-artifact" ||
    value.version !== 1 ||
    !isExactRecord(value.policies, ["preactivation", "activated"])
  )
    throw new Error("activation_catalog_policy_artifact_invalid");
  assertActivationCatalogPolicyNormalization(
    value.policies.preactivation,
    "preactivation",
  );
  assertActivationCatalogPolicyNormalization(
    value.policies.activated,
    "activated",
  );
}

const loadedActivationCatalogPolicyArtifact = cloneGeneratedArtifact(
  generatedActivationCatalogPolicyArtifact,
);
assertActivationCatalogPolicyArtifact(loadedActivationCatalogPolicyArtifact);
export const canonicalActivationCatalogPolicyArtifact = deepFreeze(
  loadedActivationCatalogPolicyArtifact,
);

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

export const reviewedActivationCatalogPolicyDigests = Object.freeze({
  preactivationCatalogPolicySha256:
    "sha256:c133bacb4a813540245430151ffd80f3380a4123ccc379250828d0317ac514d9",
  activatedCatalogPolicySha256:
    "sha256:7930dc496e760ae4f0577b50db1251f44c55f2db68bf97f790ce290edc8d5253",
});

if (
  !activationCatalogPolicyDigestsEqual(
    canonicalActivationCatalogPolicyDigests,
    reviewedActivationCatalogPolicyDigests,
  )
)
  throw new Error("activation_catalog_policy_reviewed_digest_drift");

const policyDigestPattern = /^sha256:[a-f0-9]{64}$/u;

/**
 * Authorizes the checked-in artifact with independently supplied compact
 * deployment configuration. There is intentionally no default argument: the
 * release artifact cannot authorize itself.
 */
export function authorizeCanonicalActivationCatalogPolicies(
  configured: ActivationCatalogPolicyDigests,
): typeof canonicalActivationCatalogPolicies {
  assertActivationCatalogPolicyNormalization(
    canonicalActivationCatalogPolicies.preactivation.policy,
    "preactivation",
  );
  assertActivationCatalogPolicyNormalization(
    canonicalActivationCatalogPolicies.activated.policy,
    "activated",
  );
  if (
    !policyDigestPattern.test(configured.preactivationCatalogPolicySha256) ||
    !policyDigestPattern.test(configured.activatedCatalogPolicySha256)
  )
    throw new Error("activation_catalog_policy_digest_invalid");
  if (!activationCatalogPolicyDigestsEqual(configured))
    throw new Error("activation_catalog_policy_digest_mismatch");
  assertCanonicalActivationCatalogPolicyTrustRootReady();
  return canonicalActivationCatalogPolicies;
}

export function assertActivationCatalogPolicyNormalization(
  value: unknown,
  phase: ActivationCatalogPolicyPhase,
): asserts value is ActivationCatalogPolicy {
  try {
    assertActivationCatalogPolicyNormalizationForProfile(
      value,
      phase,
      promotedArtifactNormalizationProfile,
    );
  } catch {
    throw new Error(`activation_catalog_policy_normalization_invalid:${phase}`);
  }
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
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
