import {
  assertActivationCatalogPolicyNormalizationForProfile,
  productionActivationCatalogPolicyNormalizationProfile,
} from "../packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts";

const assertCandidate = (value, phase) => {
  try {
    assertActivationCatalogPolicyNormalizationForProfile(
      value,
      phase,
      productionActivationCatalogPolicyNormalizationProfile,
    );
    return value;
  } catch {
    throw new Error(`activation_catalog_policy_candidate_invalid:${phase}`);
  }
};

export function parsePrivatePg17ActivationCatalogPolicyCandidate(stdout) {
  if (typeof stdout !== "string")
    throw new Error("activation_catalog_policy_candidate_output_invalid");
  let observations;
  try {
    observations = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("activation_catalog_policy_candidate_output_invalid");
  }
  if (
    observations.length !== 1 ||
    observations[0] === null ||
    typeof observations[0] !== "object" ||
    Array.isArray(observations[0]) ||
    Object.keys(observations[0]).length !== 2 ||
    !Object.hasOwn(observations[0], "preactivation") ||
    !Object.hasOwn(observations[0], "activated")
  )
    throw new Error("activation_catalog_policy_candidate_envelope_invalid");
  const { preactivation, activated } = observations[0];
  return Object.freeze({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: Object.freeze({
      preactivation: assertCandidate(preactivation, "preactivation"),
      activated: assertCandidate(activated, "activated"),
    }),
  });
}
