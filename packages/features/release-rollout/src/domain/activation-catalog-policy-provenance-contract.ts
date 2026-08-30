export type ActivationCatalogPolicyPromotionExpectation = Readonly<{
  readinessReason: string;
  captureBaseCommit: string;
  auditedHead: string;
  captureArtifactBytes: number;
  captureArtifactSha256: string;
  capturePayloadOffsetBytes: number;
  capturePrefixSha256: string;
  reviewArtifactSha256: string;
  reviewerEvidenceSha256: string;
  reviewerRunId: string;
  reviewDecisionId: string;
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
}>;

export type ActivationCatalogPolicyTrustRootReadiness = Readonly<{
  status: "blocked" | "ready";
  reason: string;
}>;

const sha256 = /^[a-f0-9]{64}$/u;
const prefixedSha256 = /^sha256:[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const image = /^postgres:[^@\s]+@sha256:[a-f0-9]{64}$/u;
const timestamp =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const label = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;

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
  Number.isFinite(Date.parse(value));

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
      exactRecord(value.pendingReviewSourceBindings, [
        "liveCatalogProjectionSourceSha256",
        "normalizationSourceSha256",
      ]) &&
      value.pendingReviewSourceBindings.liveCatalogProjectionSourceSha256 ===
        expected.liveCatalogProjectionSourceSha256 &&
      value.pendingReviewSourceBindings.normalizationSourceSha256 ===
        expected.normalizationSourceSha256
    )
      return blocked(value.readinessReason);

    if (
      !exactRecord(value, [
        "kind",
        "version",
        "status",
        "readinessReason",
        "promotedAt",
        "captureBaseCommit",
        "candidate",
        "postgresImages",
        "canonicalDigests",
        "reviewedSources",
        "independentReview",
      ]) ||
      value.kind !==
        "reviewrouter-activation-catalog-policy-promotion-provenance" ||
      value.version !== 5 ||
      value.status !== "ready" ||
      value.readinessReason !== expected.readinessReason ||
      !validTimestamp(value.promotedAt) ||
      value.captureBaseCommit !== expected.captureBaseCommit ||
      typeof value.captureBaseCommit !== "string" ||
      !commitSha.test(value.captureBaseCommit)
    )
      return blocked("activation-catalog-policy-provenance-not-ready");

    const candidate = value.candidate;
    const images = value.postgresImages;
    const digests = value.canonicalDigests;
    const reviewedSources = value.reviewedSources;
    const review = value.independentReview;
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
      candidate.captures.length < 2 ||
      !exactRecord(images, ["sourcePg16", "targetPg17"]) ||
      images.sourcePg16 !== expected.sourcePg16Image ||
      images.targetPg17 !== expected.targetPg17Image ||
      typeof images.sourcePg16 !== "string" ||
      typeof images.targetPg17 !== "string" ||
      !image.test(images.sourcePg16) ||
      !image.test(images.targetPg17) ||
      !exactRecord(digests, [
        "preactivation",
        "activated",
        "artifact",
        "liveCatalogDigest",
      ]) ||
      digests.preactivation !== expected.preactivationCatalogPolicySha256 ||
      digests.activated !== expected.activatedCatalogPolicySha256 ||
      digests.artifact !== expected.artifactCanonicalSha256 ||
      digests.liveCatalogDigest !== candidate.liveCatalogDigest ||
      ![
        digests.preactivation,
        digests.activated,
        digests.artifact,
        digests.liveCatalogDigest,
      ].every(
        (digest) => typeof digest === "string" && prefixedSha256.test(digest),
      ) ||
      !exactRecord(reviewedSources, [
        "liveCatalogProjectionSourceSha256",
        "normalizationSourceSha256",
      ]) ||
      reviewedSources.liveCatalogProjectionSourceSha256 !==
        expected.liveCatalogProjectionSourceSha256 ||
      reviewedSources.normalizationSourceSha256 !==
        expected.normalizationSourceSha256 ||
      ![
        reviewedSources.liveCatalogProjectionSourceSha256,
        reviewedSources.normalizationSourceSha256,
      ].every((sourceHash) =>
        typeof sourceHash === "string" ? sha256.test(sourceHash) : false,
      )
    )
      return blocked("activation-catalog-policy-provenance-binding-mismatch");

    const captureLabels = new Set<string>();
    for (const capture of candidate.captures) {
      if (
        !exactRecord(capture, [
          "label",
          "artifactBytes",
          "artifactSha256",
          "payloadOffsetBytes",
          "prefixSha256",
          "payloadBytes",
          "payloadSha256",
        ]) ||
        typeof capture.label !== "string" ||
        !label.test(capture.label) ||
        capture.artifactBytes !== expected.captureArtifactBytes ||
        capture.artifactBytes !==
          expected.capturePayloadOffsetBytes + expected.candidateBytes ||
        capture.artifactSha256 !== expected.captureArtifactSha256 ||
        typeof capture.artifactSha256 !== "string" ||
        !sha256.test(capture.artifactSha256) ||
        capture.payloadOffsetBytes !== expected.capturePayloadOffsetBytes ||
        capture.prefixSha256 !== expected.capturePrefixSha256 ||
        typeof capture.prefixSha256 !== "string" ||
        !sha256.test(capture.prefixSha256) ||
        capture.payloadBytes !== candidate.bytes ||
        capture.payloadSha256 !== candidate.sha256 ||
        captureLabels.has(capture.label)
      )
        return blocked("activation-catalog-policy-capture-evidence-invalid");
      captureLabels.add(capture.label);
    }

    if (
      !exactRecord(review, [
        "result",
        "reviewerRunId",
        "reviewDecisionId",
        "reviewedAt",
        "baseCommit",
        "auditedHead",
        "reviewArtifactSha256",
        "reviewerEvidenceSha256",
        "candidateBytes",
        "candidateSha256",
        "postgresImages",
        "canonicalDigests",
        "reviewedSources",
      ]) ||
      review.result !== "GO" ||
      review.reviewerRunId !== expected.reviewerRunId ||
      review.reviewDecisionId !== expected.reviewDecisionId ||
      !validTimestamp(review.reviewedAt) ||
      Date.parse(review.reviewedAt) >= Date.parse(value.promotedAt) ||
      review.baseCommit !== value.captureBaseCommit ||
      review.auditedHead !== expected.auditedHead ||
      typeof review.auditedHead !== "string" ||
      !commitSha.test(review.auditedHead) ||
      review.reviewArtifactSha256 !== expected.reviewArtifactSha256 ||
      typeof review.reviewArtifactSha256 !== "string" ||
      !sha256.test(review.reviewArtifactSha256) ||
      review.reviewerEvidenceSha256 !== expected.reviewerEvidenceSha256 ||
      typeof review.reviewerEvidenceSha256 !== "string" ||
      !sha256.test(review.reviewerEvidenceSha256) ||
      review.candidateBytes !== candidate.bytes ||
      review.candidateSha256 !== candidate.sha256 ||
      !exactRecord(review.postgresImages, ["sourcePg16", "targetPg17"]) ||
      review.postgresImages.sourcePg16 !== images.sourcePg16 ||
      review.postgresImages.targetPg17 !== images.targetPg17 ||
      !exactRecord(review.canonicalDigests, [
        "preactivation",
        "activated",
        "artifact",
        "liveCatalogDigest",
      ]) ||
      review.canonicalDigests.preactivation !== digests.preactivation ||
      review.canonicalDigests.activated !== digests.activated ||
      review.canonicalDigests.artifact !== digests.artifact ||
      review.canonicalDigests.liveCatalogDigest !== digests.liveCatalogDigest ||
      ![
        review.canonicalDigests.preactivation,
        review.canonicalDigests.activated,
        review.canonicalDigests.artifact,
        review.canonicalDigests.liveCatalogDigest,
      ].every(
        (digest) => typeof digest === "string" && prefixedSha256.test(digest),
      ) ||
      !exactRecord(review.reviewedSources, [
        "liveCatalogProjectionSourceSha256",
        "normalizationSourceSha256",
      ]) ||
      review.reviewedSources.liveCatalogProjectionSourceSha256 !==
        reviewedSources.liveCatalogProjectionSourceSha256 ||
      review.reviewedSources.normalizationSourceSha256 !==
        reviewedSources.normalizationSourceSha256
    )
      return blocked("activation-catalog-policy-independent-review-invalid");

    return Object.freeze({
      status: "ready",
      reason: expected.readinessReason,
    });
  } catch {
    return blocked("activation-catalog-policy-provenance-invalid");
  }
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
