import {
  stableJson,
  type CanonicalJsonValue,
} from "./provider-invocation-manifest";
import {
  ProviderExecutionProfile,
  ReviewFindingSeverity,
  ReviewLifecycleRevalidationVerdict,
  ReviewObservationQualityFlag,
  ReviewObservationStatus,
  ReviewProviderKind,
  ReviewTaskKind,
  ReviewTrustDomain,
  assertBoundedString,
  assertEpochMilliseconds,
  assertIdentifier,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSha256,
  normalizeQualityFlags,
  normalizeReviewEvidenceScope,
  normalizeReviewRevision,
  normalizeTaskKinds,
  type ReviewEvidenceScope,
  type ReviewRevision,
} from "./review-evidence-primitives";

export const reviewEvidencePayloadVersion = 2;
export const reviewEvidenceMaxPayloadBytes = 512 * 1024;
export const reviewEvidenceMaxFindings = 200;
export const reviewEvidenceMaxEvidenceItemsPerFinding = 20;
export const reviewEvidenceMaxLifecycleRevalidations = 200;
export const reviewEvidenceMaxLifecycleEvidenceItems = 20;
export const reviewEvidenceMaxRetainMs = 90 * 24 * 60 * 60 * 1_000;

const maxPathLength = 1_024;
const maxTitleLength = 512;
const maxMessageLength = 16_384;
const maxEvidenceLength = 8_192;
const maxCategoryLength = 128;
const maxModelLength = 256;
const maxRuntimeVersionLength = 256;
const maxTokenCount = 1_000_000_000;

export type NormalizedReviewFinding = Readonly<{
  category: string;
  normalizedFailureModeHash: string;
  severity: ReviewFindingSeverity;
  title: string;
  message: string;
  evidence: readonly string[];
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  placementConfidence: number | null;
  suggestion: string | null;
}>;

export type NormalizedLifecycleEvidence = Readonly<{
  path: string;
  startLine: number | null;
  endLine: number | null;
  reason: string;
}>;

export type NormalizedLifecycleRevalidation = Readonly<{
  targetId: string;
  fingerprint: string | null;
  verdict: ReviewLifecycleRevalidationVerdict;
  confidence: number | null;
  evidence: readonly NormalizedLifecycleEvidence[];
  rationale: string | null;
}>;

export type SafeProviderUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type ReviewObservationPayload = Readonly<{
  payloadVersion: typeof reviewEvidencePayloadVersion;
  normalizedFindings: readonly NormalizedReviewFinding[];
  normalizedLifecycleRevalidations: readonly NormalizedLifecycleRevalidation[];
  safeUsage: SafeProviderUsage;
}>;

export type ReviewObservation = Readonly<{
  observationId: string;
  scope: ReviewEvidenceScope;
  manifestKey: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  manifestVersion: number;
  taskKindSet: readonly ReviewTaskKind[];
  sourceRevision: ReviewRevision;
  sourcePlanHash: string;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  sourceAuthorizationId: string;
  evidenceWriteSafetyDecisionHash: string;
  sourceRunId: string;
  sourceRunAttempt: string;
  providerKind: ReviewProviderKind;
  requestedModel: string;
  actualModel: string;
  providerRuntimeVersion: string;
  producerReleaseId: string;
  selectedProtocolVersion: string;
  trustedCapabilityProfile: string;
  executionProfile: ProviderExecutionProfile;
  attemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  status: ReviewObservationStatus.Success;
  payload: ReviewObservationPayload;
  payloadHash: string;
  byteCount: number;
  findingCount: number;
  qualityFlags: readonly ReviewObservationQualityFlag[];
  transportAttemptCount: number;
  contextDependencyAttestationId: string | null;
  contextDependencyAttestationHash: string | null;
  investigationCertificateId: string | null;
  investigationCertificateHash: string | null;
  trustDomain: ReviewTrustDomain;
  createdAtMs: number;
  reuseExpiresAtMs: number;
  retainUntilMs: number;
}>;

export type ReviewObservationCandidate = Omit<
  ReviewObservation,
  | "scope"
  | "sourceRevision"
  | "taskKindSet"
  | "payload"
  | "payloadHash"
  | "byteCount"
  | "findingCount"
  | "qualityFlags"
> &
  Readonly<{
    scope: ReviewEvidenceScope;
    sourceRevision: ReviewRevision;
    taskKindSet: readonly ReviewTaskKind[];
    payload: ReviewObservationPayload;
    qualityFlags: readonly ReviewObservationQualityFlag[];
    payloadHash: string;
    byteCount: number;
    findingCount: number;
  }>;

export type PreparedReviewObservationPayload = Readonly<{
  payload: ReviewObservationPayload;
  canonicalBytes: Uint8Array;
  byteCount: number;
  findingCount: number;
}>;

export function prepareReviewObservationPayload(
  candidate: ReviewObservationPayload,
): PreparedReviewObservationPayload {
  if (candidate.payloadVersion !== reviewEvidencePayloadVersion) {
    throw new Error("review_evidence_payload_version_unsupported");
  }
  if (candidate.normalizedFindings.length > reviewEvidenceMaxFindings) {
    throw new Error("review_evidence_finding_count_exceeded");
  }
  if (
    candidate.normalizedLifecycleRevalidations.length >
    reviewEvidenceMaxLifecycleRevalidations
  ) {
    throw new Error("review_evidence_lifecycle_revalidation_count_exceeded");
  }
  const normalizedFindings = candidate.normalizedFindings.map(normalizeFinding);
  const normalizedLifecycleRevalidations =
    candidate.normalizedLifecycleRevalidations.map(
      normalizeLifecycleRevalidation,
    );
  const safeUsage = normalizeUsage(candidate.safeUsage);
  const payload = Object.freeze({
    payloadVersion: reviewEvidencePayloadVersion,
    normalizedFindings: Object.freeze(normalizedFindings),
    normalizedLifecycleRevalidations: Object.freeze(
      normalizedLifecycleRevalidations,
    ),
    safeUsage,
  });
  const canonicalBytes = new TextEncoder().encode(
    stableJson(payloadToCanonicalJson(payload)),
  );
  if (canonicalBytes.byteLength > reviewEvidenceMaxPayloadBytes) {
    throw new Error("review_evidence_payload_too_large");
  }
  return Object.freeze({
    payload,
    canonicalBytes: new Uint8Array(canonicalBytes),
    byteCount: canonicalBytes.byteLength,
    findingCount: normalizedFindings.length,
  });
}

export function createReviewObservation(
  candidate: ReviewObservationCandidate,
): ReviewObservation {
  assertIdentifier(candidate.observationId, "observation_id");
  assertSha256(candidate.manifestKey, "manifest_key");
  assertSha256(candidate.providerInvocationKey, "provider_invocation_key");
  assertSha256(
    candidate.providerVoteIdentityHash,
    "provider_vote_identity_hash",
  );
  assertPositiveInteger(candidate.manifestVersion, "manifest_version");
  assertSha256(candidate.sourcePlanHash, "source_plan_hash");
  assertIdentifier(candidate.sourceExecutionId, "source_execution_id");
  assertIdentifier(candidate.sourceWorkSlotId, "source_work_slot_id");
  assertIdentifier(candidate.sourceAuthorizationId, "source_authorization_id");
  assertSha256(
    candidate.evidenceWriteSafetyDecisionHash,
    "evidence_write_safety_decision_hash",
  );
  assertIdentifier(candidate.sourceRunId, "source_run_id");
  assertIdentifier(candidate.sourceRunAttempt, "source_run_attempt");
  assertSupportedProvider(candidate.providerKind);
  assertBoundedString(
    candidate.requestedModel,
    "requested_model",
    maxModelLength,
  );
  assertBoundedString(candidate.actualModel, "actual_model", maxModelLength);
  assertBoundedString(
    candidate.providerRuntimeVersion,
    "provider_runtime_version",
    maxRuntimeVersionLength,
  );
  assertIdentifier(candidate.producerReleaseId, "producer_release_id");
  assertIdentifier(
    candidate.selectedProtocolVersion,
    "selected_protocol_version",
  );
  assertIdentifier(
    candidate.trustedCapabilityProfile,
    "trusted_capability_profile",
  );
  if (candidate.executionProfile === ProviderExecutionProfile.Unknown) {
    throw new Error("provider_execution_profile_unknown");
  }
  assertIdentifier(candidate.attemptId, "attempt_id");
  assertIdentifier(candidate.sourceLeaseId, "source_lease_id");
  assertIdentifier(candidate.sourceFencingToken, "source_fencing_token");
  if (candidate.status !== ReviewObservationStatus.Success) {
    throw new Error("review_observation_status_not_success");
  }
  assertSha256(candidate.payloadHash, "payload_hash");
  validateContextDependencyAttestationReference(candidate);
  validateInvestigationCertificateReference(candidate);
  assertNonNegativeInteger(candidate.byteCount, "byte_count");
  assertNonNegativeInteger(candidate.findingCount, "finding_count");
  if (
    candidate.transportAttemptCount < 1 ||
    candidate.transportAttemptCount > 16
  ) {
    throw new Error("transport_attempt_count_invalid");
  }
  if (candidate.trustDomain === ReviewTrustDomain.Unknown) {
    throw new Error("review_trust_domain_unknown");
  }
  assertEpochMilliseconds(candidate.createdAtMs, "created_at_ms");
  assertEpochMilliseconds(candidate.reuseExpiresAtMs, "reuse_expires_at_ms");
  assertEpochMilliseconds(candidate.retainUntilMs, "retain_until_ms");
  if (
    candidate.reuseExpiresAtMs <= candidate.createdAtMs ||
    candidate.retainUntilMs < candidate.reuseExpiresAtMs ||
    candidate.retainUntilMs - candidate.createdAtMs > reviewEvidenceMaxRetainMs
  ) {
    throw new Error("review_observation_retention_invalid");
  }
  const preparedPayload = prepareReviewObservationPayload(candidate.payload);
  if (
    preparedPayload.byteCount !== candidate.byteCount ||
    preparedPayload.findingCount !== candidate.findingCount
  ) {
    throw new Error("review_observation_payload_accounting_mismatch");
  }
  return Object.freeze({
    ...candidate,
    scope: normalizeReviewEvidenceScope(candidate.scope),
    sourceRevision: normalizeReviewRevision(candidate.sourceRevision),
    taskKindSet: normalizeTaskKinds(candidate.taskKindSet),
    payload: preparedPayload.payload,
    qualityFlags: normalizeQualityFlags(candidate.qualityFlags),
  });
}

export function cloneReviewObservation(
  observation: ReviewObservation,
): ReviewObservation {
  return createReviewObservation({
    ...observation,
    scope: { ...observation.scope },
    sourceRevision: { ...observation.sourceRevision },
    taskKindSet: [...observation.taskKindSet],
    payload: {
      payloadVersion: observation.payload.payloadVersion,
      normalizedFindings: observation.payload.normalizedFindings.map(
        (finding) => ({
          ...finding,
          evidence: [...finding.evidence],
        }),
      ),
      normalizedLifecycleRevalidations:
        observation.payload.normalizedLifecycleRevalidations.map(
          (revalidation) => ({
            ...revalidation,
            evidence: revalidation.evidence.map((item) => ({ ...item })),
          }),
        ),
      safeUsage: { ...observation.payload.safeUsage },
    },
    qualityFlags: [...observation.qualityFlags],
  });
}

export function reviewObservationAttemptIdentity(
  observation: ReviewObservation,
): string {
  return [
    observation.sourceExecutionId,
    observation.providerVoteIdentityHash,
    observation.attemptId,
  ].join("\0");
}

export function sameReviewObservationAcceptance(
  left: ReviewObservation,
  right: ReviewObservation,
): boolean {
  return (
    JSON.stringify([
      reviewObservationAttemptIdentity(left),
      left.manifestKey,
      left.providerInvocationKey,
      left.sourceWorkSlotId,
      left.sourceAuthorizationId,
      left.evidenceWriteSafetyDecisionHash,
      left.sourceLeaseId,
      left.sourceFencingToken,
      left.actualModel,
      left.payloadHash,
      left.byteCount,
      left.findingCount,
      left.qualityFlags,
      left.transportAttemptCount,
      left.contextDependencyAttestationId,
      left.contextDependencyAttestationHash,
      left.investigationCertificateId,
      left.investigationCertificateHash,
    ]) ===
    JSON.stringify([
      reviewObservationAttemptIdentity(right),
      right.manifestKey,
      right.providerInvocationKey,
      right.sourceWorkSlotId,
      right.sourceAuthorizationId,
      right.evidenceWriteSafetyDecisionHash,
      right.sourceLeaseId,
      right.sourceFencingToken,
      right.actualModel,
      right.payloadHash,
      right.byteCount,
      right.findingCount,
      right.qualityFlags,
      right.transportAttemptCount,
      right.contextDependencyAttestationId,
      right.contextDependencyAttestationHash,
      right.investigationCertificateId,
      right.investigationCertificateHash,
    ])
  );
}

function validateContextDependencyAttestationReference(
  candidate: ReviewObservationCandidate,
): void {
  const hasAttestationId = candidate.contextDependencyAttestationId !== null;
  const hasAttestationHash =
    candidate.contextDependencyAttestationHash !== null;
  if (hasAttestationId !== hasAttestationHash) {
    throw new Error("context_dependency_attestation_reference_incomplete");
  }
  if (candidate.contextDependencyAttestationId !== null) {
    assertIdentifier(
      candidate.contextDependencyAttestationId,
      "context_dependency_attestation_id",
    );
  }
  if (candidate.contextDependencyAttestationHash !== null) {
    assertSha256(
      candidate.contextDependencyAttestationHash,
      "context_dependency_attestation_hash",
    );
  }
  if (
    candidate.executionProfile !== ProviderExecutionProfile.ContextGatewayV1 &&
    hasAttestationId
  ) {
    throw new Error("context_dependency_attestation_profile_invalid");
  }
}

function validateInvestigationCertificateReference(
  candidate: ReviewObservationCandidate,
): void {
  const hasId = candidate.investigationCertificateId !== null;
  const hasHash = candidate.investigationCertificateHash !== null;
  if (hasId !== hasHash) {
    throw new Error("investigation_certificate_reference_incomplete");
  }
  if (candidate.investigationCertificateId !== null) {
    assertIdentifier(
      candidate.investigationCertificateId,
      "investigation_certificate_id",
    );
  }
  if (candidate.investigationCertificateHash !== null) {
    assertSha256(
      candidate.investigationCertificateHash,
      "investigation_certificate_hash",
    );
  }
  if (
    candidate.executionProfile ===
    ProviderExecutionProfile.InvestigationGatewayV1
      ? !hasId
      : hasId
  ) {
    throw new Error("investigation_certificate_profile_invalid");
  }
}

function normalizeFinding(
  candidate: NormalizedReviewFinding,
): NormalizedReviewFinding {
  assertBoundedString(
    candidate.category,
    "finding_category",
    maxCategoryLength,
  );
  assertSha256(
    candidate.normalizedFailureModeHash,
    "normalized_failure_mode_hash",
  );
  if (candidate.severity === ReviewFindingSeverity.Unknown) {
    throw new Error("finding_severity_unknown");
  }
  const title = redactSensitiveText(candidate.title);
  const message = redactSensitiveText(candidate.message);
  const suggestion =
    candidate.suggestion === null
      ? null
      : redactSensitiveText(candidate.suggestion);
  assertBoundedString(title, "finding_title", maxTitleLength);
  assertBoundedString(message, "finding_message", maxMessageLength);
  if (suggestion !== null) {
    assertBoundedString(suggestion, "finding_suggestion", maxMessageLength);
  }
  if (candidate.evidence.length > reviewEvidenceMaxEvidenceItemsPerFinding) {
    throw new Error("finding_evidence_count_exceeded");
  }
  const evidence = candidate.evidence.map((item) => {
    const redacted = redactSensitiveText(item);
    assertBoundedString(redacted, "finding_evidence", maxEvidenceLength);
    return redacted;
  });
  if (candidate.path !== null) {
    assertBoundedString(candidate.path, "finding_path", maxPathLength);
    if (candidate.path.startsWith("/") || candidate.path.includes("..")) {
      throw new Error("finding_path_invalid");
    }
  }
  normalizeLineRange(candidate.startLine, candidate.endLine);
  if (
    candidate.placementConfidence !== null &&
    (!Number.isFinite(candidate.placementConfidence) ||
      candidate.placementConfidence < 0 ||
      candidate.placementConfidence > 1)
  ) {
    throw new Error("finding_placement_confidence_invalid");
  }
  return Object.freeze({
    ...candidate,
    title,
    message,
    suggestion,
    evidence: Object.freeze(evidence),
  });
}

function normalizeLifecycleRevalidation(
  candidate: NormalizedLifecycleRevalidation,
): NormalizedLifecycleRevalidation {
  assertIdentifier(candidate.targetId, "lifecycle_target_id");
  if (candidate.fingerprint !== null) {
    assertBoundedString(
      candidate.fingerprint,
      "lifecycle_fingerprint",
      maxModelLength,
    );
  }
  if (
    candidate.verdict === ReviewLifecycleRevalidationVerdict.Unknown ||
    !Object.values(ReviewLifecycleRevalidationVerdict).includes(
      candidate.verdict,
    )
  ) {
    throw new Error("lifecycle_revalidation_verdict_invalid");
  }
  if (
    candidate.confidence !== null &&
    (!Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1)
  ) {
    throw new Error("lifecycle_revalidation_confidence_invalid");
  }
  if (candidate.evidence.length > reviewEvidenceMaxLifecycleEvidenceItems) {
    throw new Error("lifecycle_revalidation_evidence_count_exceeded");
  }
  const evidence = candidate.evidence.map((item) => {
    assertBoundedString(item.path, "lifecycle_evidence_path", maxPathLength);
    if (item.path.startsWith("/") || item.path.includes("..")) {
      throw new Error("lifecycle_evidence_path_invalid");
    }
    normalizeLineRange(item.startLine, item.endLine);
    const reason = redactSensitiveText(item.reason);
    assertBoundedString(reason, "lifecycle_evidence_reason", maxEvidenceLength);
    return Object.freeze({ ...item, reason });
  });
  const rationale =
    candidate.rationale === null
      ? null
      : redactSensitiveText(candidate.rationale);
  if (rationale !== null) {
    assertBoundedString(
      rationale,
      "lifecycle_revalidation_rationale",
      maxMessageLength,
    );
  }
  return Object.freeze({
    ...candidate,
    evidence: Object.freeze(evidence),
    rationale,
  });
}

function normalizeUsage(candidate: SafeProviderUsage): SafeProviderUsage {
  for (const [field, value] of Object.entries(candidate)) {
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || value < 0 || value > maxTokenCount)
    ) {
      throw new Error(`safe_usage_${field}_invalid`);
    }
  }
  if (
    candidate.totalTokens !== null &&
    candidate.inputTokens !== null &&
    candidate.outputTokens !== null &&
    candidate.totalTokens !== candidate.inputTokens + candidate.outputTokens
  ) {
    throw new Error("safe_usage_total_mismatch");
  }
  return Object.freeze({ ...candidate });
}

function normalizeLineRange(
  startLine: number | null,
  endLine: number | null,
): void {
  if (startLine === null && endLine === null) return;
  if (startLine === null || endLine === null) {
    throw new Error("finding_line_range_incomplete");
  }
  assertPositiveInteger(startLine, "finding_start_line");
  assertPositiveInteger(endLine, "finding_end_line");
  if (endLine < startLine) throw new Error("finding_line_range_invalid");
}

function assertSupportedProvider(providerKind: ReviewProviderKind): void {
  if (providerKind === ReviewProviderKind.Unknown) {
    throw new Error("provider_kind_unknown");
  }
}

function payloadToCanonicalJson(
  payload: ReviewObservationPayload,
): CanonicalJsonValue {
  return {
    normalizedFindings: payload.normalizedFindings.map((finding) => ({
      category: finding.category,
      endLine: finding.endLine,
      evidence: finding.evidence,
      message: finding.message,
      normalizedFailureModeHash: finding.normalizedFailureModeHash,
      path: finding.path,
      placementConfidence: finding.placementConfidence,
      severity: finding.severity,
      startLine: finding.startLine,
      suggestion: finding.suggestion,
      title: finding.title,
    })),
    normalizedLifecycleRevalidations:
      payload.normalizedLifecycleRevalidations.map((revalidation) => ({
        confidence: revalidation.confidence,
        evidence: revalidation.evidence.map((item) => ({
          endLine: item.endLine,
          path: item.path,
          reason: item.reason,
          startLine: item.startLine,
        })),
        fingerprint: revalidation.fingerprint,
        rationale: revalidation.rationale,
        targetId: revalidation.targetId,
        verdict: revalidation.verdict,
      })),
    payloadVersion: payload.payloadVersion,
    safeUsage: {
      inputTokens: payload.safeUsage.inputTokens,
      outputTokens: payload.safeUsage.outputTokens,
      totalTokens: payload.safeUsage.totalTokens,
    },
  };
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [REDACTED]")
    .replace(
      /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]{4,}/giu,
      (match) =>
        `${match.slice(0, Math.max(0, match.search(/[:=]/u) + 1))}[REDACTED]`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[REDACTED_JWT]",
    );
}
