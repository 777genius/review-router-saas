import {
  stableJson,
  type CanonicalJsonValue,
} from "./provider-invocation-manifest";
import {
  ProviderExecutionProfile,
  ReviewFindingSeverity,
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

export const reviewEvidencePayloadVersion = 1;
export const reviewEvidenceMaxPayloadBytes = 512 * 1024;
export const reviewEvidenceMaxFindings = 200;
export const reviewEvidenceMaxEvidenceItemsPerFinding = 20;
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
}>;

export type SafeProviderUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type ReviewObservationPayload = Readonly<{
  payloadVersion: typeof reviewEvidencePayloadVersion;
  normalizedFindings: readonly NormalizedReviewFinding[];
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
  const normalizedFindings = candidate.normalizedFindings.map(normalizeFinding);
  const safeUsage = normalizeUsage(candidate.safeUsage);
  const payload = Object.freeze({
    payloadVersion: reviewEvidencePayloadVersion,
    normalizedFindings: Object.freeze(normalizedFindings),
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
    ])
  );
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
  assertBoundedString(title, "finding_title", maxTitleLength);
  assertBoundedString(message, "finding_message", maxMessageLength);
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
    evidence: Object.freeze(evidence),
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
  return [
    payload.payloadVersion,
    payload.normalizedFindings.map((finding) => [
      finding.category,
      finding.normalizedFailureModeHash,
      finding.severity,
      finding.title,
      finding.message,
      finding.evidence,
      finding.path,
      finding.startLine,
      finding.endLine,
      finding.placementConfidence,
    ]),
    [
      payload.safeUsage.inputTokens,
      payload.safeUsage.outputTokens,
      payload.safeUsage.totalTokens,
    ],
  ];
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
