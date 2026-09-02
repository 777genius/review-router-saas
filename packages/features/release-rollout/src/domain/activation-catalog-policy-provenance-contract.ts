import { sha256Canonical } from "./canonical-json";

export type ActivationCatalogPolicyPromotionExpectation = Readonly<{
  readinessReason: string;
  evidenceContractVersion: 2;
  promotedAt: string;
  comparisonBaseline: string;
  captureBaseCommit: string;
  auditedHead: string;
  auditedTree: string;
  captureRunId: string;
  captureRunAttempt: number;
  captureJobId: string;
  captureArtifactId: string;
  captureArtifactName: string;
  captureLabels: readonly [string, string];
  candidateEvidencePaths: readonly [string, string];
  reviewArtifactBytes: number;
  reviewArtifactSha256: string;
  reviewerEvidenceBytes: number;
  reviewerEvidenceSha256: string;
  reviewerRunId: string;
  reviewerTaskId: string;
  reviewDecisionId: string;
  reviewedAt: string;
  reviewerCompletedAt: string;
  supplementalEvidenceBytes: number;
  supplementalEvidenceSha256: string;
  supplementalReviewerRunId: string;
  supplementalReviewerTaskId: string;
  supplementalCompletedAt: string;
  candidateBytes: number;
  candidateSha256: string;
  liveCatalogDigest: string;
  liveCatalogProjectionSourceSha256: string;
  normalizationSourceSha256: string;
  sourcePg16Image: string;
  targetPg17Image: string;
  preactivationCatalogPolicySha256: string;
  activatedCatalogPolicySha256: string;
  artifactCanonicalSha256: string;
  generatedArtifactSourceBytes: number;
  generatedArtifactSourceSha256: string;
}>;

export type ActivationCatalogRawCaptureEvidence = Readonly<{
  kind: "reviewrouter-activation-catalog-raw-capture-evidence";
  version: 1;
  selectedCaptureId: string;
  captureSetSha256: string;
  captures: readonly [
    Readonly<{ label: string; bytes: number; sha256: string }>,
    Readonly<{ label: string; bytes: number; sha256: string }>,
  ];
  capture: Readonly<{
    baseCommit: string;
    auditedHead: string;
    auditedTree: string;
    workflowRunId: string;
    runAttempt: number;
    jobId: string;
    artifactId: string;
    artifactName: string;
  }>;
  postgresImages: Readonly<{ sourcePg16: string; targetPg17: string }>;
  reviewResult: "GO";
  reviewDecisionId: string;
  projectionSha256: string;
  liveCatalogDigest: string;
  postManifestIdentity: string;
  recoveryWitnessSha256: string;
  canonicalDigests: Readonly<{
    preactivation: string;
    activated: string;
    artifact: string;
  }>;
  generatedArtifactSource: Readonly<{ bytes: number; sha256: string }>;
}>;

export type ActivationCatalogPolicyTrustRootReadiness = Readonly<{
  status: "blocked" | "ready";
  reason: string;
}>;

const sha256 = /^[a-f0-9]{64}$/u;
const prefixedSha256 = /^sha256:[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const treeSha = /^[a-f0-9]{40}$/u;
const image = /^postgres:[^@\s]+@sha256:[a-f0-9]{64}$/u;
const timestamp =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const label = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const decimalId = /^[1-9][0-9]*$/u;

const exactRecord = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));

const blocked = (reason: string): ActivationCatalogPolicyTrustRootReadiness =>
  Object.freeze({ status: "blocked", reason });

const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  timestamp.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() ===
    (value.includes(".") ? value : value.replace(/Z$/u, ".000Z"));

const exactCapture = (
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): boolean =>
  exactRecord(value, [
    "baseCommit",
    "auditedHead",
    "auditedTree",
    "workflowRunId",
    "runAttempt",
    "jobId",
    "artifactId",
    "artifactName",
  ]) &&
  value.baseCommit === expected.captureBaseCommit &&
  value.auditedHead === expected.auditedHead &&
  value.auditedTree === expected.auditedTree &&
  value.workflowRunId === expected.captureRunId &&
  value.runAttempt === expected.captureRunAttempt &&
  value.jobId === expected.captureJobId &&
  value.artifactId === expected.captureArtifactId &&
  value.artifactName === expected.captureArtifactName &&
  typeof value.baseCommit === "string" &&
  commitSha.test(value.baseCommit) &&
  typeof value.auditedHead === "string" &&
  commitSha.test(value.auditedHead) &&
  typeof value.auditedTree === "string" &&
  treeSha.test(value.auditedTree) &&
  typeof value.workflowRunId === "string" &&
  decimalId.test(value.workflowRunId) &&
  typeof value.jobId === "string" &&
  decimalId.test(value.jobId) &&
  typeof value.artifactId === "string" &&
  decimalId.test(value.artifactId);

const exactImages = (
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): boolean =>
  exactRecord(value, ["sourcePg16", "targetPg17"]) &&
  value.sourcePg16 === expected.sourcePg16Image &&
  value.targetPg17 === expected.targetPg17Image &&
  typeof value.sourcePg16 === "string" &&
  image.test(value.sourcePg16) &&
  typeof value.targetPg17 === "string" &&
  image.test(value.targetPg17);

const exactDigests = (
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): boolean =>
  exactRecord(value, [
    "preactivation",
    "activated",
    "artifact",
    "liveCatalogDigest",
  ]) &&
  value.preactivation === expected.preactivationCatalogPolicySha256 &&
  value.activated === expected.activatedCatalogPolicySha256 &&
  value.artifact === expected.artifactCanonicalSha256 &&
  value.liveCatalogDigest === expected.liveCatalogDigest &&
  Object.values(value).every(
    (digest) => typeof digest === "string" && prefixedSha256.test(digest),
  );

const exactReviewedSources = (
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): boolean =>
  exactRecord(value, [
    "liveCatalogProjectionSourceSha256",
    "normalizationSourceSha256",
  ]) &&
  value.liveCatalogProjectionSourceSha256 ===
    expected.liveCatalogProjectionSourceSha256 &&
  value.normalizationSourceSha256 === expected.normalizationSourceSha256 &&
  Object.values(value).every(
    (sourceHash) => typeof sourceHash === "string" && sha256.test(sourceHash),
  );

export function activationCatalogPolicyTrustRootReadinessFromProvenance(
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): ActivationCatalogPolicyTrustRootReadiness {
  try {
    if (
      exactRecord(value, [
        "kind",
        "version",
        "status",
        "readinessReason",
        "invalidatedReview",
        "pendingReviewSourceBindings",
      ]) &&
      value.kind ===
        "reviewrouter-activation-catalog-policy-promotion-provenance" &&
      value.version === 5 &&
      value.status === "blocked" &&
      typeof value.readinessReason === "string" &&
      label.test(value.readinessReason) &&
      exactRecord(value.invalidatedReview, [
        "reviewDecisionId",
        "auditedHead",
        "invalidatedByCommit",
      ]) &&
      typeof value.invalidatedReview.reviewDecisionId === "string" &&
      label.test(value.invalidatedReview.reviewDecisionId) &&
      typeof value.invalidatedReview.auditedHead === "string" &&
      commitSha.test(value.invalidatedReview.auditedHead) &&
      typeof value.invalidatedReview.invalidatedByCommit === "string" &&
      commitSha.test(value.invalidatedReview.invalidatedByCommit) &&
      exactReviewedSources(value.pendingReviewSourceBindings, expected)
    )
      return blocked(value.readinessReason);

    if (
      !exactRecord(value, [
        "kind",
        "version",
        "status",
        "readinessReason",
        "evidenceContractVersion",
        "promotedAt",
        "capture",
        "candidate",
        "postgresImages",
        "canonicalDigests",
        "reviewedSources",
        "generatedArtifactSource",
        "independentReview",
        "supplementalReview",
      ]) ||
      value.kind !==
        "reviewrouter-activation-catalog-policy-promotion-provenance" ||
      value.version !== 5 ||
      value.status !== "ready" ||
      value.readinessReason !== expected.readinessReason ||
      value.evidenceContractVersion !== expected.evidenceContractVersion ||
      value.promotedAt !== expected.promotedAt ||
      !validTimestamp(value.promotedAt) ||
      !exactCapture(value.capture, expected) ||
      !exactImages(value.postgresImages, expected) ||
      !exactDigests(value.canonicalDigests, expected) ||
      !exactReviewedSources(value.reviewedSources, expected) ||
      !exactRecord(value.generatedArtifactSource, ["bytes", "sha256"]) ||
      value.generatedArtifactSource.bytes !==
        expected.generatedArtifactSourceBytes ||
      value.generatedArtifactSource.sha256 !==
        expected.generatedArtifactSourceSha256 ||
      typeof value.generatedArtifactSource.sha256 !== "string" ||
      !sha256.test(value.generatedArtifactSource.sha256)
    )
      return blocked("activation-catalog-policy-provenance-not-ready");

    const candidate = value.candidate;
    if (
      !exactRecord(candidate, [
        "bytes",
        "sha256",
        "liveCatalogDigest",
        "captures",
      ]) ||
      candidate.bytes !== expected.candidateBytes ||
      candidate.sha256 !== expected.candidateSha256 ||
      typeof candidate.sha256 !== "string" ||
      !sha256.test(candidate.sha256) ||
      candidate.liveCatalogDigest !== expected.liveCatalogDigest ||
      typeof candidate.liveCatalogDigest !== "string" ||
      !prefixedSha256.test(candidate.liveCatalogDigest) ||
      !Array.isArray(candidate.captures) ||
      candidate.captures.length !== expected.captureLabels.length
    )
      return blocked("activation-catalog-policy-provenance-binding-mismatch");

    for (let index = 0; index < candidate.captures.length; index += 1) {
      const capture = candidate.captures[index];
      if (
        !exactRecord(capture, ["label", "bytes", "sha256"]) ||
        capture.label !== expected.captureLabels[index] ||
        capture.bytes !== expected.candidateBytes ||
        capture.sha256 !== expected.candidateSha256
      )
        return blocked("activation-catalog-policy-capture-evidence-invalid");
    }

    const review = value.independentReview;
    if (
      !exactRecord(review, [
        "result",
        "reviewerRunId",
        "reviewerTaskId",
        "reviewDecisionId",
        "reviewedAt",
        "completedAt",
        "baseCommit",
        "auditedHead",
        "auditedTree",
        "reviewArtifact",
        "reviewerEvidence",
      ]) ||
      review.result !== "GO" ||
      review.reviewerRunId !== expected.reviewerRunId ||
      review.reviewerTaskId !== expected.reviewerTaskId ||
      review.reviewDecisionId !== expected.reviewDecisionId ||
      review.reviewedAt !== expected.reviewedAt ||
      review.completedAt !== expected.reviewerCompletedAt ||
      review.baseCommit !== expected.captureBaseCommit ||
      review.auditedHead !== expected.auditedHead ||
      review.auditedTree !== expected.auditedTree ||
      !exactRecord(review.reviewArtifact, ["bytes", "sha256"]) ||
      review.reviewArtifact.bytes !== expected.reviewArtifactBytes ||
      review.reviewArtifact.sha256 !== expected.reviewArtifactSha256 ||
      !exactRecord(review.reviewerEvidence, ["bytes", "sha256"]) ||
      review.reviewerEvidence.bytes !== expected.reviewerEvidenceBytes ||
      review.reviewerEvidence.sha256 !== expected.reviewerEvidenceSha256
    )
      return blocked("activation-catalog-policy-independent-review-invalid");

    const supplemental = value.supplementalReview;
    if (
      !exactRecord(supplemental, [
        "result",
        "reviewerRunId",
        "reviewerTaskId",
        "reviewDecisionId",
        "completedAt",
        "baseCommit",
        "auditedHead",
        "auditedTree",
        "reviewerEvidence",
      ]) ||
      supplemental.result !== "GO" ||
      supplemental.reviewerRunId !== expected.supplementalReviewerRunId ||
      supplemental.reviewerTaskId !== expected.supplementalReviewerTaskId ||
      supplemental.reviewDecisionId !== expected.reviewDecisionId ||
      supplemental.completedAt !== expected.supplementalCompletedAt ||
      supplemental.baseCommit !== expected.captureBaseCommit ||
      supplemental.auditedHead !== expected.auditedHead ||
      supplemental.auditedTree !== expected.auditedTree ||
      !exactRecord(supplemental.reviewerEvidence, ["bytes", "sha256"]) ||
      supplemental.reviewerEvidence.bytes !==
        expected.supplementalEvidenceBytes ||
      supplemental.reviewerEvidence.sha256 !==
        expected.supplementalEvidenceSha256
    )
      return blocked("activation-catalog-policy-supplemental-review-invalid");

    if (
      ![
        review.reviewedAt,
        review.completedAt,
        supplemental.completedAt,
        value.promotedAt,
      ].every(validTimestamp) ||
      !(
        Date.parse(review.reviewedAt as string) <
          Date.parse(review.completedAt as string) &&
        Date.parse(review.completedAt as string) <
          Date.parse(supplemental.completedAt as string) &&
        Date.parse(supplemental.completedAt as string) <
          Date.parse(value.promotedAt)
      )
    )
      return blocked("activation-catalog-policy-review-timeline-invalid");

    return Object.freeze({
      status: "ready",
      reason: expected.readinessReason,
    });
  } catch {
    return blocked("activation-catalog-policy-provenance-invalid");
  }
}

export function assertActivationCatalogRawCaptureEvidence(
  value: unknown,
): asserts value is ActivationCatalogRawCaptureEvidence {
  if (
    !exactRecord(value, [
      "kind",
      "version",
      "selectedCaptureId",
      "captureSetSha256",
      "captures",
      "capture",
      "postgresImages",
      "reviewResult",
      "reviewDecisionId",
      "projectionSha256",
      "liveCatalogDigest",
      "postManifestIdentity",
      "recoveryWitnessSha256",
      "canonicalDigests",
      "generatedArtifactSource",
    ]) ||
    value.kind !== "reviewrouter-activation-catalog-raw-capture-evidence" ||
    value.version !== 1 ||
    !Array.isArray(value.captures) ||
    value.captures.length !== 2
  )
    throw new Error("activation_catalog_policy_raw_capture_evidence_invalid");

  const captures = value.captures;
  const captureSetMaterial = { ...value };
  delete captureSetMaterial.kind;
  delete captureSetMaterial.version;
  delete captureSetMaterial.captureSetSha256;
  if (
    captures.some(
      (capture) =>
        !exactRecord(capture, ["label", "bytes", "sha256"]) ||
        typeof capture.label !== "string" ||
        !label.test(capture.label) ||
        typeof capture.bytes !== "number" ||
        !Number.isSafeInteger(capture.bytes) ||
        capture.bytes < 1 ||
        capture.bytes > 16 * 1024 * 1024 ||
        typeof capture.sha256 !== "string" ||
        !sha256.test(capture.sha256),
    ) ||
    captures[0].label === captures[1].label ||
    value.selectedCaptureId !== captures[0].label ||
    value.captureSetSha256 !== `sha256:${sha256Canonical(captureSetMaterial)}`
  )
    throw new Error("activation_catalog_policy_raw_capture_evidence_invalid");

  const capture = value.capture;
  if (
    !exactRecord(capture, [
      "baseCommit",
      "auditedHead",
      "auditedTree",
      "workflowRunId",
      "runAttempt",
      "jobId",
      "artifactId",
      "artifactName",
    ]) ||
    typeof capture.baseCommit !== "string" ||
    !commitSha.test(capture.baseCommit) ||
    typeof capture.auditedHead !== "string" ||
    !commitSha.test(capture.auditedHead) ||
    capture.baseCommit === capture.auditedHead ||
    typeof capture.auditedTree !== "string" ||
    !treeSha.test(capture.auditedTree) ||
    typeof capture.workflowRunId !== "string" ||
    !decimalId.test(capture.workflowRunId) ||
    typeof capture.runAttempt !== "number" ||
    !Number.isSafeInteger(capture.runAttempt) ||
    capture.runAttempt < 1 ||
    typeof capture.jobId !== "string" ||
    !decimalId.test(capture.jobId) ||
    typeof capture.artifactId !== "string" ||
    !decimalId.test(capture.artifactId) ||
    typeof capture.artifactName !== "string" ||
    !label.test(capture.artifactName) ||
    !exactRecord(value.postgresImages, ["sourcePg16", "targetPg17"]) ||
    typeof value.postgresImages.sourcePg16 !== "string" ||
    !image.test(value.postgresImages.sourcePg16) ||
    typeof value.postgresImages.targetPg17 !== "string" ||
    !image.test(value.postgresImages.targetPg17) ||
    value.reviewResult !== "GO" ||
    typeof value.reviewDecisionId !== "string" ||
    !label.test(value.reviewDecisionId)
  )
    throw new Error("activation_catalog_policy_raw_capture_evidence_invalid");

  if (
    ![
      value.projectionSha256,
      value.liveCatalogDigest,
      value.postManifestIdentity,
    ].every(
      (entry) => typeof entry === "string" && prefixedSha256.test(entry),
    ) ||
    typeof value.recoveryWitnessSha256 !== "string" ||
    !sha256.test(value.recoveryWitnessSha256) ||
    !exactRecord(value.canonicalDigests, [
      "preactivation",
      "activated",
      "artifact",
    ]) ||
    !Object.values(value.canonicalDigests).every(
      (entry) => typeof entry === "string" && prefixedSha256.test(entry),
    ) ||
    !exactRecord(value.generatedArtifactSource, ["bytes", "sha256"]) ||
    typeof value.generatedArtifactSource.bytes !== "number" ||
    !Number.isSafeInteger(value.generatedArtifactSource.bytes) ||
    value.generatedArtifactSource.bytes < 1 ||
    typeof value.generatedArtifactSource.sha256 !== "string" ||
    !sha256.test(value.generatedArtifactSource.sha256)
  )
    throw new Error("activation_catalog_policy_raw_capture_evidence_invalid");
}

export function assertActivationCatalogPolicyPromotionProvenance(
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): void {
  const readiness = activationCatalogPolicyTrustRootReadinessFromProvenance(
    value,
    expected,
  );
  if (readiness.status !== "ready")
    throw new Error(
      `activation_catalog_policy_promotion_provenance_invalid:${readiness.reason}`,
    );
}
