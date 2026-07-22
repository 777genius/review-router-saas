export const reviewExecutionAbsoluteMaxWorkSlots = 256;
export const reviewExecutionAbsoluteMaxAttemptBudget = 32;
export const reviewExecutionAbsoluteMaxProjectionBytes = 2 * 1024 * 1024;
export const reviewExecutionAbsoluteMaxFindingCount = 2_000;

export enum ReviewExecutionProviderKind {
  Codex = "codex",
  ClaudeCode = "claude_code",
  OpenRouter = "openrouter",
}

export enum ReviewTaskKind {
  FindingDiscovery = "finding_discovery",
  LifecycleRevalidation = "lifecycle_revalidation",
}

export enum ReviewExecutionState {
  Planned = "planned",
  Running = "running",
  Superseded = "superseded",
  Completed = "completed",
  Partial = "partial",
  Failed = "failed",
}

export enum ReviewWorkSlotState {
  Pending = "pending",
  Leased = "leased",
  Satisfied = "satisfied",
  Exhausted = "exhausted",
  Cancelled = "cancelled",
}

export enum ReviewInvocationLeasePurpose {
  ProviderExecution = "provider_execution",
  ObservationAdoption = "observation_adoption",
}

export enum ReviewInvocationLeaseState {
  Active = "active",
  Released = "released",
  Expired = "expired",
  Revoked = "revoked",
}

export enum ReviewObservationAttachmentKind {
  FreshLease = "fresh_lease",
  ObservationAdoption = "observation_adoption",
  ExactRevisionReuse = "exact_revision_reuse",
  PromptOnlyCrossRevisionReuse = "prompt_only_cross_revision_reuse",
  ContextGatewayCrossRevisionReuse = "context_gateway_cross_revision_reuse",
}

export enum ReviewCoverageState {
  Completed = "completed",
  Partial = "partial",
}

export enum PublicationPermitValidationStatus {
  Current = "current",
  Expired = "expired",
  Superseded = "superseded",
  RevisionChanged = "revision_changed",
  ProjectionChanged = "projection_changed",
  LifecycleChanged = "lifecycle_changed",
  CommandWatermarkChanged = "command_watermark_changed",
  AuthorizationOrReleaseRevoked = "authorization_or_release_revoked",
}

export type ReviewExecutionScope = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
};

export type ReviewRevision = {
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
};

export type ReviewExecutionLimits = {
  readonly profileId: string;
  readonly maxWorkSlots: number;
  readonly maxAttemptBudget: number;
  readonly maxProjectionBytes: number;
  readonly maxFindingCount: number;
  readonly maxLeaseDurationMs: number;
  readonly maxResultReportDurationMs: number;
};

export type ReviewWorkSlotPlan = {
  readonly workSlotId: string;
  readonly taskKind: ReviewTaskKind;
  readonly providerKind: ReviewExecutionProviderKind;
  readonly providerVoteIdentityHash: string;
  readonly shardKey: string;
  readonly required: boolean;
  readonly attemptBudget: number;
  readonly retryPolicyVersion: string;
};

export type ReviewWorkSlot = ReviewWorkSlotPlan & {
  readonly state: ReviewWorkSlotState;
  readonly activeLeaseId: string | null;
  readonly acceptedObservationRefId: string | null;
  readonly nextAttemptOrdinal: number;
};

export type ReviewExecutionStream = ReviewExecutionScope & {
  readonly version: bigint;
  readonly activeExecutionId: string | null;
  readonly preparedExecutionId: string | null;
  readonly lastAllocatedGeneration: bigint;
  readonly currentRevision: ReviewRevision | null;
  readonly updatedAt: Date;
};

export type ReviewExecution = ReviewExecutionScope & {
  readonly executionId: string;
  readonly version: bigint;
  readonly generation: bigint;
  readonly revision: ReviewRevision;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly mutationEpoch: bigint;
  readonly startIdentityHash: string;
  readonly canonicalStartHash: string;
  readonly admissionSafetyDecisionHash: string;
  readonly state: ReviewExecutionState;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly protocolLimitsProfileId: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly workSlots: readonly ReviewWorkSlot[];
  readonly finalizedArtifactId: string | null;
  readonly supersededByExecutionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly admissionDeadlineAt: Date;
  readonly admissionCheckedAt: Date | null;
  readonly executionDeadlineAt: Date;
  readonly retainUntil: Date;
};

export type ReviewInvocationLease = ReviewExecutionScope & {
  readonly providerInvocationKey: string;
  readonly preparedManifestCanonicalJson: string | null;
  readonly preparedManifestKey: string | null;
  readonly providerVoteIdentityHash: string;
  readonly workSlotId: string;
  readonly leaseId: string;
  readonly purpose: ReviewInvocationLeasePurpose;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly reviewRevisionHash: string;
  readonly mutationEpoch: bigint;
  readonly leaseSafetyDecisionHash: string;
  readonly attemptId: string | null;
  readonly sourceObservationId: string | null;
  readonly attemptOrdinal: number;
  readonly acquireRequestIdHash: string;
  readonly acquireRequestHash: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly fencingToken: bigint;
  readonly executionId: string;
  readonly executionGeneration: bigint;
  readonly state: ReviewInvocationLeaseState;
  readonly acquiredAt: Date;
  readonly renewedAt: Date;
  readonly expiresAt: Date;
  readonly resultReportUntil: Date;
  readonly retainUntil: Date;
};

export type ReviewExecutionObservationRef = {
  readonly observationRefId: string;
  readonly executionId: string;
  readonly workSlotId: string;
  readonly providerInvocationKey: string;
  readonly observationId: string;
  readonly providerVoteIdentityHash: string;
  readonly attachmentKind: ReviewObservationAttachmentKind;
  readonly eligibilityPolicyVersion: string;
  readonly reuseSafetyDecisionHash: string | null;
  readonly sourceExecutionId: string;
  readonly sourceLeaseId: string | null;
  readonly sourceFencingToken: bigint | null;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly attachedAt: Date;
};

export type PublicationPermit = ReviewExecutionScope & {
  readonly executionId: string;
  readonly generation: bigint;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly reviewedHeadSha: string;
  readonly reviewRevisionHash: string;
  readonly projectionHash: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly permitEpoch: bigint;
  readonly publicationSafetyDecisionHash: string;
  readonly publicationNotAfter: Date;
};

export type FinalizedReviewProjectionArtifact = {
  readonly artifactId: string;
  readonly executionId: string;
  readonly generation: bigint;
  readonly reviewedHeadSha: string;
  readonly reviewRevisionHash: string;
  readonly coverageState: ReviewCoverageState;
  readonly projectionEnvelopeVersion: number;
  readonly projectionEnvelopeJson: string;
  readonly projectionHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly projectionPolicyVersion: string;
  readonly publicationPermit: PublicationPermit;
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

export type ReviewExecutionSnapshot = {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly observationRefs: readonly ReviewExecutionObservationRef[];
  readonly activeLeases: readonly ReviewInvocationLease[];
  readonly artifact: FinalizedReviewProjectionArtifact | null;
};

export function createEmptyReviewExecutionStream(
  scope: ReviewExecutionScope,
  now: Date,
): ReviewExecutionStream {
  assertReviewExecutionScope(scope);
  assertDate(now, "now");
  return {
    ...scope,
    version: 0n,
    activeExecutionId: null,
    preparedExecutionId: null,
    lastAllocatedGeneration: 0n,
    currentRevision: null,
    updatedAt: new Date(now),
  };
}

export function prepareWorkSlots(
  plans: readonly ReviewWorkSlotPlan[],
  limits: ReviewExecutionLimits,
): readonly ReviewWorkSlot[] {
  assertReviewExecutionLimits(limits);
  if (plans.length === 0 || plans.length > limits.maxWorkSlots) {
    throw new Error("review_execution_work_slot_count_out_of_bounds");
  }
  const ids = new Set<string>();
  const semanticKeys = new Set<string>();
  return plans.map((plan) => {
    assertIdentifier(plan.workSlotId, "work_slot_id");
    assertEnumValue(ReviewTaskKind, plan.taskKind, "task_kind");
    assertEnumValue(
      ReviewExecutionProviderKind,
      plan.providerKind,
      "provider_kind",
    );
    assertSha256(plan.providerVoteIdentityHash, "provider_vote_identity_hash");
    assertIdentifier(plan.shardKey, "shard_key");
    assertPositiveInteger(plan.attemptBudget, "attempt_budget");
    if (plan.attemptBudget > limits.maxAttemptBudget) {
      throw new Error("review_execution_attempt_budget_out_of_bounds");
    }
    assertIdentifier(plan.retryPolicyVersion, "retry_policy_version");
    if (ids.has(plan.workSlotId)) {
      throw new Error("review_execution_duplicate_work_slot_id");
    }
    ids.add(plan.workSlotId);
    const semanticKey = [
      plan.taskKind,
      plan.providerVoteIdentityHash,
      plan.shardKey,
    ].join("\0");
    if (semanticKeys.has(semanticKey)) {
      throw new Error("review_execution_duplicate_work_slot_semantics");
    }
    semanticKeys.add(semanticKey);
    return {
      ...plan,
      state: ReviewWorkSlotState.Pending,
      activeLeaseId: null,
      acceptedObservationRefId: null,
      nextAttemptOrdinal: 1,
    };
  });
}

export function canonicalReviewExecutionPlanPreimage(
  plans: readonly ReviewWorkSlotPlan[],
): string {
  return JSON.stringify(
    plans.map((plan) => ({
      workSlotId: plan.workSlotId,
      taskKind: plan.taskKind,
      providerKind: plan.providerKind,
      providerVoteIdentityHash: plan.providerVoteIdentityHash,
      shardKey: plan.shardKey,
      required: plan.required,
      attemptBudget: plan.attemptBudget,
      retryPolicyVersion: plan.retryPolicyVersion,
    })),
  );
}

export function canonicalReviewExecutionStartPreimage(input: {
  readonly authorizationId: string;
  readonly revision: ReviewRevision;
  readonly planHash: string;
  readonly canonicalPlan: string;
}): string {
  return [
    "rr.review-execution-start.v1",
    input.authorizationId,
    input.revision.baseSha,
    input.revision.mergeBaseSha,
    input.revision.headSha,
    input.revision.reviewRevisionHash,
    input.planHash,
    input.canonicalPlan,
  ].join("\0");
}

export function reviewRevisionsEqual(
  left: ReviewRevision,
  right: ReviewRevision,
): boolean {
  return (
    left.baseSha === right.baseSha &&
    left.mergeBaseSha === right.mergeBaseSha &&
    left.headSha === right.headSha &&
    left.reviewRevisionHash === right.reviewRevisionHash
  );
}

export function reviewExecutionIsTerminal(
  state: ReviewExecutionState,
): boolean {
  return (
    state === ReviewExecutionState.Superseded ||
    state === ReviewExecutionState.Completed ||
    state === ReviewExecutionState.Partial ||
    state === ReviewExecutionState.Failed
  );
}

export function deriveCoverageState(
  slots: readonly ReviewWorkSlot[],
): ReviewCoverageState {
  return slots.every(
    (slot) => !slot.required || slot.state === ReviewWorkSlotState.Satisfied,
  )
    ? ReviewCoverageState.Completed
    : ReviewCoverageState.Partial;
}

export function validatePublicationPermit(input: {
  readonly permit: PublicationPermit;
  readonly stream: ReviewExecutionStream;
  readonly projectionHash: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly authorizationActive: boolean;
  readonly producerReleaseActive: boolean;
  readonly now: Date;
}): PublicationPermitValidationStatus {
  assertDate(input.now, "publication_permit_check_time");
  if (!input.authorizationActive || !input.producerReleaseActive) {
    return PublicationPermitValidationStatus.AuthorizationOrReleaseRevoked;
  }
  if (input.permit.publicationNotAfter <= input.now) {
    return PublicationPermitValidationStatus.Expired;
  }
  if (
    input.stream.activeExecutionId !== input.permit.executionId ||
    input.stream.lastAllocatedGeneration !== input.permit.generation
  ) {
    return PublicationPermitValidationStatus.Superseded;
  }
  if (
    input.stream.currentRevision === null ||
    input.stream.currentRevision.headSha !== input.permit.reviewedHeadSha ||
    input.stream.currentRevision.reviewRevisionHash !==
      input.permit.reviewRevisionHash
  ) {
    return PublicationPermitValidationStatus.RevisionChanged;
  }
  if (input.projectionHash !== input.permit.projectionHash) {
    return PublicationPermitValidationStatus.ProjectionChanged;
  }
  if (input.lifecycleStateHash !== input.permit.lifecycleStateHash) {
    return PublicationPermitValidationStatus.LifecycleChanged;
  }
  if (input.commandLedgerWatermark !== input.permit.commandLedgerWatermark) {
    return PublicationPermitValidationStatus.CommandWatermarkChanged;
  }
  return PublicationPermitValidationStatus.Current;
}

export function assertFinalizationEnvelope(input: {
  readonly projectionEnvelopeVersion: number;
  readonly projectionEnvelopeJson: string;
  readonly projectionHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly limits: ReviewExecutionLimits;
}): void {
  assertPositiveInteger(
    input.projectionEnvelopeVersion,
    "projection_envelope_version",
  );
  assertSha256(input.projectionHash, "projection_hash");
  assertNonNegativeInteger(input.byteCount, "projection_byte_count");
  assertNonNegativeInteger(input.findingCount, "projection_finding_count");
  if (
    new TextEncoder().encode(input.projectionEnvelopeJson).byteLength !==
    input.byteCount
  ) {
    throw new Error("review_execution_projection_byte_count_mismatch");
  }
  if (input.byteCount > input.limits.maxProjectionBytes) {
    throw new Error("review_execution_projection_too_large");
  }
  if (input.findingCount > input.limits.maxFindingCount) {
    throw new Error("review_execution_finding_count_out_of_bounds");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(input.projectionEnvelopeJson) as unknown;
  } catch {
    throw new Error("review_execution_projection_envelope_invalid_json");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new Error("review_execution_projection_envelope_not_object");
  }
}

export function assertReviewExecutionScope(scope: ReviewExecutionScope): void {
  assertIdentifier(scope.workspaceId, "workspace_id");
  assertIdentifier(scope.repositoryConnectionId, "repository_connection_id");
  assertIdentifier(scope.scmRepositoryIdentityId, "scm_repository_identity_id");
  assertPositiveInteger(scope.pullRequestNumber, "pull_request_number");
}

export function assertReviewRevision(revision: ReviewRevision): void {
  assertCommitSha(revision.baseSha, "base_sha");
  assertCommitSha(revision.mergeBaseSha, "merge_base_sha");
  assertCommitSha(revision.headSha, "head_sha");
  assertSha256(revision.reviewRevisionHash, "review_revision_hash");
}

export function assertReviewExecutionLimits(
  limits: ReviewExecutionLimits,
): void {
  assertIdentifier(limits.profileId, "protocol_limits_profile_id");
  assertBoundedPositiveInteger(
    limits.maxWorkSlots,
    reviewExecutionAbsoluteMaxWorkSlots,
    "max_work_slots",
  );
  assertBoundedPositiveInteger(
    limits.maxAttemptBudget,
    reviewExecutionAbsoluteMaxAttemptBudget,
    "max_attempt_budget",
  );
  assertBoundedPositiveInteger(
    limits.maxProjectionBytes,
    reviewExecutionAbsoluteMaxProjectionBytes,
    "max_projection_bytes",
  );
  assertBoundedPositiveInteger(
    limits.maxFindingCount,
    reviewExecutionAbsoluteMaxFindingCount,
    "max_finding_count",
  );
  assertPositiveInteger(limits.maxLeaseDurationMs, "max_lease_duration_ms");
  assertPositiveInteger(
    limits.maxResultReportDurationMs,
    "max_result_report_duration_ms",
  );
  if (limits.maxResultReportDurationMs < limits.maxLeaseDurationMs) {
    throw new Error("review_execution_result_window_shorter_than_lease");
  }
}

export function assertIdentifier(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}

export function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}

export function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}

export function scopeKey(scope: ReviewExecutionScope): string {
  assertReviewExecutionScope(scope);
  return [
    scope.workspaceId,
    scope.repositoryConnectionId,
    scope.scmRepositoryIdentityId,
    String(scope.pullRequestNumber),
  ].join("\0");
}

function assertCommitSha(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}

function assertBoundedPositiveInteger(
  value: number,
  maximum: number,
  field: string,
): void {
  assertPositiveInteger(value, field);
  if (value > maximum) {
    throw new Error(`review_execution_${field}_above_absolute_maximum`);
  }
}

function assertEnumValue<T extends Record<string, string>>(
  values: T,
  value: T[keyof T],
  field: string,
): void {
  if (!Object.values(values).includes(value)) {
    throw new Error(`review_execution_invalid_${field}`);
  }
}
