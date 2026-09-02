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
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z-]+$/u.test(error.message)
        ? error.message
        : "unknown";
    throw new Error(
      `activation_catalog_policy_candidate_invalid:${phase}:${reason}`,
      { cause: error },
    );
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
    Object.keys(observations[0]).length !== 3 ||
    !Object.hasOwn(observations[0], "preactivation") ||
    !Object.hasOwn(observations[0], "activated") ||
    !Object.hasOwn(observations[0], "liveCatalogDigest")
  )
    throw new Error("activation_catalog_policy_candidate_envelope_invalid");
  const { preactivation, activated, liveCatalogDigest } = observations[0];
  if (!/^sha256:[a-f0-9]{64}$/u.test(liveCatalogDigest))
    throw new Error(
      "activation_catalog_policy_candidate_catalog_digest_invalid",
    );
  return Object.freeze({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    liveCatalogDigest,
    policies: Object.freeze({
      preactivation: assertCandidate(preactivation, "preactivation"),
      activated: assertCandidate(activated, "activated"),
    }),
  });
}
