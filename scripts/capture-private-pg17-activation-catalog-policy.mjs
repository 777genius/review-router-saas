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

const parseCandidateArtifact = (parsed) => {
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !==
      JSON.stringify(["kind", "policies", "version"]) ||
    parsed.kind !==
      "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    parsed.version !== 1 ||
    parsed.policies === null ||
    typeof parsed.policies !== "object" ||
    Array.isArray(parsed.policies) ||
    JSON.stringify(Object.keys(parsed.policies).sort()) !==
      JSON.stringify(["activated", "preactivation"])
  )
    throw new Error("activation_catalog_policy_candidate_envelope_invalid");
  return Object.freeze({
    kind: parsed.kind,
    version: parsed.version,
    policies: Object.freeze({
      preactivation: assertCandidate(
        parsed.policies.preactivation,
        "preactivation",
      ),
      activated: assertCandidate(parsed.policies.activated, "activated"),
    }),
  });
};

export function parsePrivatePg17ActivationCatalogPolicyArtifactBytes(bytes) {
  let parsed;
  try {
    const value = Buffer.from(bytes);
    if (value.length === 0 || value.length > 4 * 1024 * 1024)
      throw new Error("size");
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error("activation_catalog_policy_candidate_output_invalid");
  }
  return parseCandidateArtifact(parsed);
}

export function normalizePrivatePg17ActivationCatalogPolicyArtifactCandidate(
  value,
) {
  return parseCandidateArtifact(value);
}

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
  return parseCandidateArtifact({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: { preactivation, activated },
  });
}
