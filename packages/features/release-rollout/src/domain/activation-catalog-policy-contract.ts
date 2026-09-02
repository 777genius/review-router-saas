import { sha256Canonical } from "./canonical-json";
import generatedActivationCatalogPolicyArtifact from "./activation-catalog-policy-artifact.generated.js";
import { type ActivationCatalogPolicy } from "./effective-principal-inventory";
import {
  assertActivationCatalogPolicyNormalizationForProfile,
  productionActivationCatalogPolicyNormalizationProfile,
} from "./activation-catalog-policy-normalization";
import { activationCatalogRawPromotionTrustRoot } from "./activation-catalog-policy-raw-promotion-trust-root";

export type ActivationCatalogPolicyPhase = "preactivation" | "activated";

export type PinnedActivationCatalogPolicy = Readonly<{
  policy: ActivationCatalogPolicy;
  sha256: string;
}>;

export type ActivationCatalogPolicyDigests = Readonly<{
  preactivationCatalogPolicySha256: string;
  activatedCatalogPolicySha256: string;
}>;

export const canonicalActivationCatalogPolicyTrustRootReadiness: Readonly<{
  status: "blocked" | "ready";
  reason: string;
}> =
  activationCatalogRawPromotionTrustRoot.status === "ready"
    ? Object.freeze({ status: "ready", reason: "reviewed-raw" })
    : Object.freeze({
        status: "blocked",
        reason: activationCatalogRawPromotionTrustRoot.reason,
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
    activationCatalogRawPromotionTrustRoot.status === "ready"
      ? activationCatalogRawPromotionTrustRoot.evidence.canonicalDigests
          .preactivation
      : "sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b",
  activatedCatalogPolicySha256:
    activationCatalogRawPromotionTrustRoot.status === "ready"
      ? activationCatalogRawPromotionTrustRoot.evidence.canonicalDigests
          .activated
      : "sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b",
});

if (
  canonicalActivationCatalogPolicyTrustRootReadiness.status === "ready" &&
  (!activationCatalogPolicyDigestsEqual(
    canonicalActivationCatalogPolicyDigests,
    reviewedActivationCatalogPolicyDigests,
  ) ||
    (activationCatalogRawPromotionTrustRoot.status === "ready" &&
      `sha256:${sha256Canonical(canonicalActivationCatalogPolicyArtifact)}` !==
        activationCatalogRawPromotionTrustRoot.evidence.canonicalDigests
          .artifact))
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
      productionActivationCatalogPolicyNormalizationProfile,
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
