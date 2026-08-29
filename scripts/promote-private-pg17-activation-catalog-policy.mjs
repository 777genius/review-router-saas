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
  activationCatalogPromotionOptIn,
  reviewedActivationCatalogCandidate,
  reviewedActivationCatalogPromotionExpectation,
} from "../packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation.ts";
import { assertActivationCatalogPolicyPromotionProvenance } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-provenance-contract.ts";
import { fencedLiveV70V73CatalogDigestSql } from "../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";

export {
  activationCatalogPromotionOptIn,
  reviewedActivationCatalogCandidate,
  reviewedActivationCatalogPromotionExpectation,
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
  "docs/release-evidence/activation-catalog-policy-v25-independent-review.json",
);
export const activationCatalogReviewerEvidencePath = resolve(
  repositoryRoot,
  "docs/release-evidence/activation-catalog-policy-v25-reviewer-runtime.json",
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

async function readJsonEvidence(path, hash, errorCode) {
  try {
    const bytes = await readFile(path);
    if (sha256(bytes) !== hash) throw new Error(errorCode);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(errorCode);
  }
}

export async function assertActivationCatalogPolicyIndependentReviewEvidence(
  provenance,
) {
  const expectation = reviewedActivationCatalogPromotionExpectation;
  const report = await readJsonEvidence(
    activationCatalogIndependentReviewPath,
    expectation.reviewArtifactSha256,
    "activation_catalog_policy_independent_review_artifact_invalid",
  );
  const reviewer = await readJsonEvidence(
    activationCatalogReviewerEvidencePath,
    expectation.reviewerEvidenceSha256,
    "activation_catalog_policy_reviewer_runtime_evidence_invalid",
  );
  const outputSummary = Array.isArray(reviewer.evidence)
    ? reviewer.evidence.find(
        (entry) =>
          typeof entry === "string" && entry.startsWith("output_summary:"),
      )
    : undefined;
  if (
    report?.verdict !== "GO" ||
    report?.exactHead !== expectation.auditedHead ||
    report?.sourceProductCommit !== expectation.captureBaseCommit ||
    report?.reviewerRunId !== expectation.reviewerRunId ||
    report?.reviewDecisionId !== expectation.reviewDecisionId ||
    report?.reviewerEvidenceSha256 !== expectation.reviewerEvidenceSha256 ||
    report?.candidateBytes !== expectation.candidateBytes ||
    report?.candidateSha256 !== expectation.candidateSha256 ||
    canonicalJson(report?.candidateCaptures) !==
      canonicalJson(provenance?.candidate?.captures) ||
    reviewer?.status !== "done" ||
    reviewer?.provider !== "codex" ||
    reviewer?.runId !== expectation.reviewerRunId ||
    reviewer?.taskId !== expectation.reviewerRunId ||
    reviewer?.updatedAt !== report.reviewedAt ||
    !Array.isArray(reviewer.blockers) ||
    reviewer.blockers.length !== 0 ||
    !Array.isArray(reviewer.changedFiles) ||
    reviewer.changedFiles.length !== 0 ||
    !reviewer.evidence.includes("safe_execution_status:completed") ||
    typeof outputSummary !== "string" ||
    (!outputSummary.includes("# Verdict: GO") &&
      !outputSummary.includes("**Verdict: GO**")) ||
    !outputSummary.includes(expectation.reviewDecisionId) ||
    !outputSummary.includes(expectation.candidateSha256) ||
    !outputSummary.includes(expectation.captureBaseCommit)
  )
    throw new Error(
      "activation_catalog_policy_independent_review_evidence_invalid",
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
  const v1Fields = "kind,policies,version";
  const v2Fields = "capture,kind,policies,version";
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![v1Fields, v2Fields].includes(Object.keys(value).sort().join(",")) ||
    value.kind !==
      "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    ![1, 2].includes(value.version) ||
    value.policies === null ||
    typeof value.policies !== "object" ||
    Array.isArray(value.policies) ||
    Object.keys(value.policies).sort().join(",") !== "activated,preactivation"
  )
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  if (value.version === 1 && Object.hasOwn(value, "capture"))
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  if (value.version === 2) assertCaptureBinding(value.capture, value.policies);
  assertNormalizedCandidatePolicy(
    value.policies.preactivation,
    "preactivation",
  );
  assertNormalizedCandidatePolicy(value.policies.activated, "activated");
}

export function assertActivationCatalogPolicyCandidateSchema(value) {
  assertArtifactCandidate(value);
}

function assertCaptureBinding(value, policies) {
  const database = value?.database;
  const projection = value?.projection;
  const custody = value?.custody;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "commitSha,custody,database,postManifestIdentity,projection" ||
    !/^[a-f0-9]{40}$/u.test(value.commitSha ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.postManifestIdentity ?? "") ||
    database === null ||
    typeof database !== "object" ||
    Array.isArray(database) ||
    Object.keys(database).sort().join(",") !==
      "configuredIdentity,disposableIdentity,recoveryWitnessSha256,systemIdentifier" ||
    !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
      database.disposableIdentity ?? "",
    ) ||
    !/^[a-z0-9.-]+:[0-9]{1,5}\/[A-Za-z0-9_.-]+$/u.test(
      database.configuredIdentity ?? "",
    ) ||
    !/^[1-9][0-9]{0,19}$/u.test(database.systemIdentifier ?? "") ||
    !/^[a-f0-9]{64}$/u.test(database.recoveryWitnessSha256 ?? "") ||
    projection === null ||
    typeof projection !== "object" ||
    Array.isArray(projection) ||
    Object.keys(projection).sort().join(",") !== "observedDigest,sha256" ||
    !/^sha256:[a-f0-9]{64}$/u.test(projection.sha256 ?? "") ||
    projection.sha256 !==
      `sha256:${sha256(fencedLiveV70V73CatalogDigestSql)}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(projection.observedDigest ?? "") ||
    projection.observedDigest ===
      reviewedActivationCatalogPromotionExpectation.activeProductionCatalogDigest ||
    custody === null ||
    typeof custody !== "object" ||
    Array.isArray(custody) ||
    Object.keys(custody).sort().join(",") !==
      "auditedHead,captureBaseCommit,evidenceSha256" ||
    !/^[a-f0-9]{40}$/u.test(custody.captureBaseCommit ?? "") ||
    !/^[a-f0-9]{40}$/u.test(custody.auditedHead ?? "") ||
    custody.auditedHead !== value.commitSha ||
    !/^sha256:[a-f0-9]{64}$/u.test(custody.evidenceSha256 ?? "") ||
    custody.evidenceSha256 !==
      `sha256:${sha256(
        canonicalJson({
          auditedHead: custody.auditedHead,
          captureBaseCommit: custody.captureBaseCommit,
          commitSha: value.commitSha,
          database,
          policies,
          postManifestIdentity: value.postManifestIdentity,
          projection,
        }),
      )}`
  )
    throw new Error(
      "activation_catalog_policy_promotion_capture_binding_invalid",
    );
}

export function assertActivationCatalogPolicyCaptureBinding(value, policies) {
  assertCaptureBinding(value, policies);
}

function assertCaptureReviewedForCurrentTrustRoot(capture) {
  const expectation = reviewedActivationCatalogPromotionExpectation;
  if (
    capture.custody.captureBaseCommit !== expectation.captureBaseCommit ||
    capture.custody.auditedHead !== expectation.auditedHead ||
    capture.commitSha !== expectation.auditedHead ||
    capture.postManifestIdentity !== expectation.postManifestIdentity
  )
    throw new Error(
      "activation_catalog_policy_promotion_new_candidate_review_required",
    );
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
  let candidate;
  try {
    candidate = JSON.parse(candidateBytes.toString("utf8"));
  } catch {
    if (candidateBytes.byteLength !== reviewedActivationCatalogCandidate.bytes)
      throw new Error(
        "activation_catalog_policy_promotion_candidate_size_drift",
      );
    if (sha256(candidateBytes) !== reviewedActivationCatalogCandidate.sha256)
      throw new Error(
        "activation_catalog_policy_promotion_candidate_hash_drift",
      );
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  }
  assertArtifactCandidate(candidate);
  if (candidate.version === 2)
    assertCaptureReviewedForCurrentTrustRoot(candidate.capture);
  const reviewedPayloadBytes =
    candidate.version === 2
      ? Buffer.from(
          canonicalJson({
            kind: candidate.kind,
            policies: candidate.policies,
            version: 1,
          }),
          "utf8",
        )
      : candidateBytes;
  if (candidate.version === 2) {
    if (
      sha256(reviewedPayloadBytes) !==
      reviewedActivationCatalogCandidate.canonicalSha256
    )
      throw new Error(
        "activation_catalog_policy_promotion_candidate_canonical_hash_drift",
      );
  } else {
    if (
      reviewedPayloadBytes.byteLength !==
      reviewedActivationCatalogCandidate.bytes
    )
      throw new Error(
        "activation_catalog_policy_promotion_candidate_size_drift",
      );
    if (
      sha256(reviewedPayloadBytes) !== reviewedActivationCatalogCandidate.sha256
    )
      throw new Error(
        "activation_catalog_policy_promotion_candidate_hash_drift",
      );
  }
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
  const provenance = await readPromotionProvenance();
  assertReviewedActivationCatalogPromotionProvenance(provenance);
  await assertActivationCatalogPolicyIndependentReviewEvidence(provenance);
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
