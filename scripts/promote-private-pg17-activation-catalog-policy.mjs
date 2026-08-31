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
import {
  activationCatalogRawPromotionTrustRoot,
  activationCatalogPromotionOptIn,
  reviewedActivationCatalogCandidate,
  reviewedActivationCatalogPromotionExpectation,
} from "../packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation.ts";
import { assertActivationCatalogPolicyPromotionProvenance } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-provenance-contract.ts";
import { assertActivationCatalogPolicyReviewEvidence } from "../packages/features/release-rollout/src/adapters/activation-catalog-policy-review-evidence.ts";
import {
  reviewedActivationCatalogCandidatePath,
  reviewedActivationCatalogCandidateRepositoryPath,
} from "./lib/reviewed-activation-catalog-candidate.mjs";

export {
  activationCatalogRawPromotionTrustRoot,
  activationCatalogPromotionOptIn,
  reviewedActivationCatalogCandidate,
  reviewedActivationCatalogPromotionExpectation,
  reviewedActivationCatalogCandidatePath,
  reviewedActivationCatalogCandidateRepositoryPath,
};

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const activationCatalogArtifactPath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js",
);
export const activationCatalogPromotionProvenancePath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/domain/activation-catalog-policy-provenance.json",
);
export const activationCatalogIndependentReviewPath = resolve(
  repositoryRoot,
  "docs/release-evidence/activation-catalog-policy-v29-schema-v5-independent-review.md",
);
export const activationCatalogReviewerEvidencePath = resolve(
  repositoryRoot,
  "docs/release-evidence/activation-catalog-policy-v29-schema-v5-reviewer-runtime.json",
);
export const activationCatalogSupplementalReviewerEvidencePath = resolve(
  repositoryRoot,
  "docs/release-evidence/activation-catalog-policy-v29-schema-v5-security-reviewer-runtime.json",
);
export const activationCatalogLiveProjectionSourcePath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
);
export const activationCatalogNormalizationSourcePath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts",
);

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

export async function assertActivationCatalogPolicyIndependentReviewEvidence() {
  const [reviewArtifact, reviewerRuntime, supplementalRuntime] =
    await Promise.all([
      readFile(activationCatalogIndependentReviewPath),
      readFile(activationCatalogReviewerEvidencePath),
      readFile(activationCatalogSupplementalReviewerEvidencePath),
    ]);
  assertActivationCatalogPolicyReviewEvidence(
    { reviewArtifact, reviewerRuntime, supplementalRuntime },
    reviewedActivationCatalogPromotionExpectation,
  );
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

export async function assertActivationCatalogPolicyReviewedSourceBindings() {
  const expectation = reviewedActivationCatalogPromotionExpectation;
  const [projectionSource, normalizationSource] = await Promise.all([
    readFile(activationCatalogLiveProjectionSourcePath),
    readFile(activationCatalogNormalizationSourcePath),
  ]);
  if (
    sha256(projectionSource) !==
      expectation.liveCatalogProjectionSourceSha256 ||
    sha256(normalizationSource) !== expectation.normalizationSourceSha256
  )
    throw new Error("activation_catalog_policy_reviewed_source_drift");
}

function parseArguments(argv) {
  const paths = {};
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = {
      "--candidate": "candidatePath",
      "--capture-1": "capture1Path",
      "--capture-2": "capture2Path",
    }[argument];
    if (key && paths[key] === undefined && argv[index + 1]) {
      paths[key] = resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--write" && !write) {
      write = true;
    } else {
      throw new Error("activation_catalog_policy_promotion_arguments_invalid");
    }
  }
  if (paths.candidatePath && Object.keys(paths).length === 1)
    return { mode: "legacy", candidatePath: paths.candidatePath, write };
  if (
    !paths.candidatePath &&
    paths.capture1Path &&
    paths.capture2Path &&
    Object.keys(paths).length === 2
  )
    return {
      mode: "raw",
      capturePaths: [paths.capture1Path, paths.capture2Path],
      write,
    };
  if (Object.keys(paths).length === 0)
    throw new Error("activation_catalog_policy_promotion_candidate_required");
  throw new Error("activation_catalog_policy_promotion_arguments_invalid");
}

export function assertArtifactCandidate(
  value,
  reviewedCandidate = reviewedActivationCatalogCandidate,
) {
  const reviewedLiveCatalogDigest = Reflect.get(
    reviewedCandidate,
    "liveCatalogDigest",
  );
  const capturesLiveCatalogDigest =
    typeof reviewedLiveCatalogDigest === "string";
  const expectedFields = capturesLiveCatalogDigest
    ? "kind,liveCatalogDigest,policies,version"
    : "kind,policies,version";
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== expectedFields ||
    value.kind !==
      "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    value.version !== (capturesLiveCatalogDigest ? 2 : 1) ||
    (capturesLiveCatalogDigest &&
      value.liveCatalogDigest !== reviewedLiveCatalogDigest) ||
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
  const generated = Buffer.from(
    `// Generated by scripts/promote-private-pg17-activation-catalog-policy.mjs. Do not edit.\n` +
      `/** @type {unknown} */\n` +
      `const canonicalActivationCatalogPolicyArtifact = ${canonicalArtifact};\n` +
      `export default canonicalActivationCatalogPolicyArtifact;\n`,
    "utf8",
  );
  if (
    generated.byteLength !==
      reviewedActivationCatalogPromotionExpectation.generatedArtifactSourceBytes ||
    sha256(generated) !==
      reviewedActivationCatalogPromotionExpectation.generatedArtifactSourceSha256
  )
    throw new Error("activation_catalog_policy_generated_source_drift");
  return generated;
}

export function canonicalActivationCatalogArtifactSourceFromRawCapture(
  rawCapture,
  evidence,
) {
  assertNormalizedCandidatePolicy(
    rawCapture.policies.preactivation,
    "preactivation",
  );
  assertNormalizedCandidatePolicy(rawCapture.policies.activated, "activated");
  const artifact = {
    kind: "reviewrouter-activation-catalog-policy-artifact",
    version: 1,
    policies: rawCapture.policies,
  };
  if (
    `sha256:${sha256Canonical(artifact.policies.preactivation)}` !==
      evidence.canonicalDigests.preactivation ||
    `sha256:${sha256Canonical(artifact.policies.activated)}` !==
      evidence.canonicalDigests.activated
  )
    throw new Error("activation_catalog_policy_promotion_phase_digest_drift");
  const canonicalArtifact = canonicalJson(artifact);
  if (
    `sha256:${sha256(canonicalArtifact)}` !== evidence.canonicalDigests.artifact
  )
    throw new Error("activation_catalog_policy_promotion_artifact_drift");
  const generated = Buffer.from(
    `// Generated by scripts/promote-private-pg17-activation-catalog-policy.mjs. Do not edit.\n` +
      `/** @type {unknown} */\n` +
      `const canonicalActivationCatalogPolicyArtifact = ${canonicalArtifact};\n` +
      `export default canonicalActivationCatalogPolicyArtifact;\n`,
    "utf8",
  );
  if (
    generated.byteLength !== evidence.generatedArtifactSource.bytes ||
    sha256(generated) !== evidence.generatedArtifactSource.sha256
  )
    throw new Error("activation_catalog_policy_generated_source_drift");
  return generated;
}

export async function promotePrivatePg17ActivationCatalogPolicy({
  env = process.env,
  argv = process.argv.slice(2),
} = {}) {
  const argumentsValue = parseArguments(argv);
  if (argumentsValue.mode === "raw")
    throw new Error(
      `activation_catalog_policy_raw_trust_root_${activationCatalogRawPromotionTrustRoot.status}`,
    );

  const optIn = env.REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION;
  if (optIn !== activationCatalogPromotionOptIn)
    throw new Error("activation_catalog_policy_promotion_opt_in_required");

  const generated = canonicalActivationCatalogArtifactSource(
    await readFile(argumentsValue.candidatePath),
  );
  await assertActivationCatalogPolicyReviewedSourceBindings();
  const provenance = await readPromotionProvenance();
  assertReviewedActivationCatalogPromotionProvenance(provenance);
  await assertActivationCatalogPolicyIndependentReviewEvidence();
  const result = {
    candidatePath: argumentsValue.candidatePath,
    candidateSha256: reviewedActivationCatalogCandidate.sha256,
    ...reviewedActivationCatalogCandidate,
  };

  if (argumentsValue.write) await writeArtifactAtomically(generated);
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
    ...result,
    artifactPath: activationCatalogArtifactPath,
    artifactSourceSha256: sha256(generated),
    mode: argumentsValue.write ? "promoted" : "verified",
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
