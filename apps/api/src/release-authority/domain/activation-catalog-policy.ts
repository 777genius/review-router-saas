import {
  assertCanonicalActivationCatalogPolicyInput,
  type ActivationCatalogPolicyPhase,
  type PinnedActivationCatalogPolicy,
} from "@reviewrouter/features-release-rollout";

export type TrustedActivationCatalogPolicy = PinnedActivationCatalogPolicy;

export function trustedActivationCatalogPolicy(
  serialized: string,
  phase: ActivationCatalogPolicyPhase,
): TrustedActivationCatalogPolicy {
  return assertCanonicalActivationCatalogPolicyInput(serialized, phase);
}
