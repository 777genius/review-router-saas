import {
  authorizeCanonicalActivationCatalogPolicies,
  type ActivationCatalogPolicyDigests,
} from "@reviewrouter/features-release-rollout";

export const activationCatalogPolicyDigestEnvironmentNames = Object.freeze({
  preactivationCatalogPolicySha256:
    "REVIEW_ROUTER_TARGET_PREACTIVATION_CATALOG_POLICY_SHA256",
  activatedCatalogPolicySha256:
    "REVIEW_ROUTER_TARGET_ACTIVATED_CATALOG_POLICY_SHA256",
} as const);

export function configuredActivationCatalogPolicyDigests(
  env: NodeJS.ProcessEnv,
): ActivationCatalogPolicyDigests {
  const preactivationCatalogPolicySha256 =
    env[
      activationCatalogPolicyDigestEnvironmentNames
        .preactivationCatalogPolicySha256
    ];
  const activatedCatalogPolicySha256 =
    env[
      activationCatalogPolicyDigestEnvironmentNames.activatedCatalogPolicySha256
    ];
  if (!preactivationCatalogPolicySha256)
    throw new Error(
      `activation_catalog_policy_digest_env_missing:${activationCatalogPolicyDigestEnvironmentNames.preactivationCatalogPolicySha256}`,
    );
  if (!activatedCatalogPolicySha256)
    throw new Error(
      `activation_catalog_policy_digest_env_missing:${activationCatalogPolicyDigestEnvironmentNames.activatedCatalogPolicySha256}`,
    );
  return Object.freeze({
    preactivationCatalogPolicySha256,
    activatedCatalogPolicySha256,
  });
}

export function trustedActivationCatalogPoliciesFromEnvironment(
  env: NodeJS.ProcessEnv,
) {
  return authorizeCanonicalActivationCatalogPolicies(
    configuredActivationCatalogPolicyDigests(env),
  );
}
