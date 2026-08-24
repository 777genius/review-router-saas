import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  sha256Canonical,
} from "../packages/features/release-rollout/src/domain/canonical-json.ts";
import {
  assertActivationCatalogPolicyNormalizationForProfile,
  productionActivationCatalogPolicyNormalizationProfile,
} from "../packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts";
import { assertActivationCatalogPolicyPromotionProvenance } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-provenance-contract.ts";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v24";
export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "8f4f5d60707cd57eff560218f3cdeeaf4a56f1934dab9939ba4eeb1630947630",
  bytes: 2_477_044,
  preactivationCatalogPolicySha256:
    "sha256:fe9c71391557f194d84070689100ba55e31fe9e89a768b39879ff43619726c37",
  activatedCatalogPolicySha256:
    "sha256:b5b56feebf9be6e17e6d4aaf17d7f5409b7a3df0f6fe5692ea588043d5a7e4c1",
  artifactCanonicalSha256:
    "sha256:5f4dc73eff4574cea5d6953173b0d35d4332fdc1d2e8b74190dce69569b3292d",
});

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const activationCatalogArtifactPath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js",
);
export const activationCatalogPromotionProvenancePath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/domain/activation-catalog-policy-provenance.json",
);

export const reviewedActivationCatalogPromotionExpectation = Object.freeze({
  readinessReason:
    "reviewed-v24-production-shaped-pg17-candidate-promoted-with-exact-go-evidence",
  captureBaseCommit: "012e8bec2f8ee3d7bb36a9daa394d2fe1a024b8e",
  auditedHead: "012e8bec2f8ee3d7bb36a9daa394d2fe1a024b8e",
  reviewArtifactSha256:
    "617fca74495a9d20a15de714bfd8c469209fa49a82bbd38b46bb78a9dac8e66c",
  candidateBytes: reviewedActivationCatalogCandidate.bytes,
  candidateSha256: reviewedActivationCatalogCandidate.sha256,
  sourcePg16Image:
    "postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60",
  targetPg17Image:
    "postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4",
  preactivationCatalogPolicySha256:
    reviewedActivationCatalogCandidate.preactivationCatalogPolicySha256,
  activatedCatalogPolicySha256:
    reviewedActivationCatalogCandidate.activatedCatalogPolicySha256,
  artifactCanonicalSha256:
    reviewedActivationCatalogCandidate.artifactCanonicalSha256,
});

export function assertReviewedActivationCatalogPromotionProvenance(value) {
  assertActivationCatalogPolicyPromotionProvenance(
    value,
    reviewedActivationCatalogPromotionExpectation,
  );
}

async function readPromotionProvenance() {
  try {
    return JSON.parse(
      await readFile(activationCatalogPromotionProvenancePath, "utf8"),
    );
  } catch {
    throw new Error("activation_catalog_policy_promotion_provenance_invalid");
  }
}

async function writeArtifactAtomically(generated) {
  const temporaryPath = `${activationCatalogArtifactPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, generated, { flag: "wx" });
    await rename(temporaryPath, activationCatalogArtifactPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArguments(argv) {
  let candidatePath;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate" && candidatePath === undefined) {
      candidatePath = argv[index + 1];
      index += 1;
    } else if (argument === "--write" && !write) {
      write = true;
    } else {
      throw new Error("activation_catalog_policy_promotion_arguments_invalid");
    }
  }
  if (!candidatePath)
    throw new Error("activation_catalog_policy_promotion_candidate_required");
  return { candidatePath: resolve(candidatePath), write };
}

function assertArtifactCandidate(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "kind,policies,version" ||
    value.kind !==
      "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    value.version !== 1 ||
    value.policies === null ||
    typeof value.policies !== "object" ||
    Array.isArray(value.policies) ||
    Object.keys(value.policies).sort().join(",") !== "activated,preactivation"
  )
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  assertNormalizedCandidatePolicy(
    value.policies.preactivation,
    "preactivation",
  );
  assertNormalizedCandidatePolicy(value.policies.activated, "activated");
}

function assertNormalizedCandidatePolicy(value, phase) {
  try {
    assertActivationCatalogPolicyNormalizationForProfile(
      value,
      phase,
      productionActivationCatalogPolicyNormalizationProfile,
    );
  } catch {
    throw new Error(
      `activation_catalog_policy_promotion_normalization_invalid:${phase}`,
    );
  }
}

export function canonicalActivationCatalogArtifactSource(candidateBytes) {
  if (!Buffer.isBuffer(candidateBytes))
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  if (candidateBytes.byteLength !== reviewedActivationCatalogCandidate.bytes)
    throw new Error("activation_catalog_policy_promotion_candidate_size_drift");
  if (sha256(candidateBytes) !== reviewedActivationCatalogCandidate.sha256)
    throw new Error("activation_catalog_policy_promotion_candidate_hash_drift");
  let candidate;
  try {
    candidate = JSON.parse(candidateBytes.toString("utf8"));
  } catch {
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  }
  assertArtifactCandidate(candidate);
  const artifact = {
    kind: "reviewrouter-activation-catalog-policy-artifact",
    version: 1,
    policies: candidate.policies,
  };
  const phaseDigests = {
    preactivationCatalogPolicySha256: `sha256:${sha256Canonical(
      artifact.policies.preactivation,
    )}`,
    activatedCatalogPolicySha256: `sha256:${sha256Canonical(
      artifact.policies.activated,
    )}`,
  };
  if (
    phaseDigests.preactivationCatalogPolicySha256 !==
      reviewedActivationCatalogCandidate.preactivationCatalogPolicySha256 ||
    phaseDigests.activatedCatalogPolicySha256 !==
      reviewedActivationCatalogCandidate.activatedCatalogPolicySha256
  )
    throw new Error("activation_catalog_policy_promotion_phase_digest_drift");
  const canonicalArtifact = canonicalJson(artifact);
  if (
    `sha256:${sha256(canonicalArtifact)}` !==
    reviewedActivationCatalogCandidate.artifactCanonicalSha256
  )
    throw new Error("activation_catalog_policy_promotion_artifact_drift");
  return Buffer.from(
    `// Generated by scripts/promote-private-pg17-activation-catalog-policy.mjs. Do not edit.\n` +
      `/** @type {unknown} */\n` +
      `const canonicalActivationCatalogPolicyArtifact = ${canonicalArtifact};\n` +
      `export default canonicalActivationCatalogPolicyArtifact;\n`,
    "utf8",
  );
}

export async function promotePrivatePg17ActivationCatalogPolicy({
  env = process.env,
  argv = process.argv.slice(2),
} = {}) {
  if (
    env.REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION !==
    activationCatalogPromotionOptIn
  )
    throw new Error("activation_catalog_policy_promotion_opt_in_required");
  const { candidatePath, write } = parseArguments(argv);
  const generated = canonicalActivationCatalogArtifactSource(
    await readFile(candidatePath),
  );
  assertReviewedActivationCatalogPromotionProvenance(
    await readPromotionProvenance(),
  );
  if (write) await writeArtifactAtomically(generated);
  else {
    let existing;
    try {
      existing = await readFile(activationCatalogArtifactPath);
    } catch {
      throw new Error("activation_catalog_policy_promotion_artifact_missing");
    }
    if (!existing.equals(generated))
      throw new Error("activation_catalog_policy_promotion_artifact_drift");
  }
  return Object.freeze({
    candidatePath,
    candidateSha256: reviewedActivationCatalogCandidate.sha256,
    artifactPath: activationCatalogArtifactPath,
    artifactSourceSha256: sha256(generated),
    artifactCanonicalSha256:
      reviewedActivationCatalogCandidate.artifactCanonicalSha256,
    ...reviewedActivationCatalogCandidate,
    mode: write ? "promoted" : "verified",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await promotePrivatePg17ActivationCatalogPolicy())}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
