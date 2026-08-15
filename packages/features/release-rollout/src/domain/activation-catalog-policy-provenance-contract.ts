export type ActivationCatalogPolicyPromotionExpectation = Readonly<{
  readinessReason: string;
  captureBaseCommit: string;
  candidateBytes: number;
  candidateSha256: string;
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

export function activationCatalogPolicyTrustRootReadinessFromProvenance(
  value: unknown,
  expected: ActivationCatalogPolicyPromotionExpectation,
): ActivationCatalogPolicyTrustRootReadiness {
  try {
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
        "independentReview",
      ]) ||
      value.kind !==
        "reviewrouter-activation-catalog-policy-promotion-provenance" ||
      value.version !== 2 ||
      value.status !== "ready" ||
      value.readinessReason !== expected.readinessReason ||
      typeof value.promotedAt !== "string" ||
      !timestamp.test(value.promotedAt) ||
      value.captureBaseCommit !== expected.captureBaseCommit ||
      typeof value.captureBaseCommit !== "string" ||
      !commitSha.test(value.captureBaseCommit)
    )
      return blocked("activation-catalog-policy-provenance-not-ready");

    const candidate = value.candidate;
    const images = value.postgresImages;
    const digests = value.canonicalDigests;
    const review = value.independentReview;
    if (
      !exactRecord(candidate, ["bytes", "sha256", "captures"]) ||
      candidate.bytes !== expected.candidateBytes ||
      candidate.sha256 !== expected.candidateSha256 ||
      typeof candidate.sha256 !== "string" ||
      !sha256.test(candidate.sha256) ||
      !Array.isArray(candidate.captures) ||
      candidate.captures.length < 2 ||
      !exactRecord(images, ["sourcePg16", "targetPg17"]) ||
      images.sourcePg16 !== expected.sourcePg16Image ||
      images.targetPg17 !== expected.targetPg17Image ||
      typeof images.sourcePg16 !== "string" ||
      typeof images.targetPg17 !== "string" ||
      !image.test(images.sourcePg16) ||
      !image.test(images.targetPg17) ||
      !exactRecord(digests, ["preactivation", "activated", "artifact"]) ||
      digests.preactivation !== expected.preactivationCatalogPolicySha256 ||
      digests.activated !== expected.activatedCatalogPolicySha256 ||
      digests.artifact !== expected.artifactCanonicalSha256 ||
      ![digests.preactivation, digests.activated, digests.artifact].every(
        (digest) => typeof digest === "string" && prefixedSha256.test(digest),
      )
    )
      return blocked("activation-catalog-policy-provenance-binding-mismatch");

    const captureLabels = new Set<string>();
    for (const capture of candidate.captures) {
      if (
        !exactRecord(capture, ["label", "sha256"]) ||
        typeof capture.label !== "string" ||
        !label.test(capture.label) ||
        capture.sha256 !== candidate.sha256 ||
        captureLabels.has(capture.label)
      )
        return blocked("activation-catalog-policy-capture-evidence-invalid");
      captureLabels.add(capture.label);
    }

    if (
      !exactRecord(review, [
        "result",
        "reviewerRunId",
        "reviewedAt",
        "baseCommit",
        "candidateBytes",
        "candidateSha256",
        "postgresImages",
        "canonicalDigests",
      ]) ||
      review.result !== "GO" ||
      typeof review.reviewerRunId !== "string" ||
      !label.test(review.reviewerRunId) ||
      typeof review.reviewedAt !== "string" ||
      !timestamp.test(review.reviewedAt) ||
      review.baseCommit !== value.captureBaseCommit ||
      review.candidateBytes !== candidate.bytes ||
      review.candidateSha256 !== candidate.sha256 ||
      !exactRecord(review.postgresImages, ["sourcePg16", "targetPg17"]) ||
      review.postgresImages.sourcePg16 !== images.sourcePg16 ||
      review.postgresImages.targetPg17 !== images.targetPg17 ||
      !exactRecord(review.canonicalDigests, [
        "preactivation",
        "activated",
        "artifact",
      ]) ||
      review.canonicalDigests.preactivation !== digests.preactivation ||
      review.canonicalDigests.activated !== digests.activated ||
      review.canonicalDigests.artifact !== digests.artifact
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
