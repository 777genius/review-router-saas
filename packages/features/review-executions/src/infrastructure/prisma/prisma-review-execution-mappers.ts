import {
  Prisma,
  ReviewCoverageStateV2 as PrismaCoverageState,
  ReviewExecutionStateV2 as PrismaExecutionState,
  ReviewInvocationLeasePurposeV2 as PrismaLeasePurpose,
  ReviewInvocationLeaseStateV2 as PrismaLeaseState,
  ReviewObservationAttachmentKindV2 as PrismaAttachmentKind,
  ReviewProviderKindV2 as PrismaProviderKind,
  ReviewRequestedIntentStateV2 as PrismaIntentState,
  ReviewRequestedIntentTerminalReasonV2 as PrismaIntentTerminalReason,
  ReviewRequestedTriggerKindV2 as PrismaTriggerKind,
  ReviewTaskKindV2 as PrismaTaskKind,
  ReviewWorkSlotStateV2 as PrismaWorkSlotState,
  type FinalizedReviewProjectionArtifactV2 as ArtifactRecord,
  type ReviewExecutionObservationRefV2 as ObservationRefRecord,
  type ReviewExecutionStreamV2 as StreamRecord,
  type ReviewExecutionV2 as ExecutionRecord,
  type ReviewExecutionWorkSlotV2 as WorkSlotRecord,
  type ReviewInvocationLeaseV2 as LeaseRecord,
  type ReviewRequestedIntent as IntentRecord,
} from "@prisma/client";
import {
  ReviewCoverageState,
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewObservationAttachmentKind,
  ReviewTaskKind,
  ReviewWorkSlotState,
  type FinalizedReviewProjectionArtifact,
  type ReviewExecution,
  type ReviewExecutionObservationRef,
  type ReviewExecutionScope,
  type ReviewExecutionStream,
  type ReviewInvocationLease,
  type ReviewWorkSlot,
} from "../../domain/review-execution";
import {
  ReviewRequestedIntentState,
  ReviewRequestedIntentTerminalReason,
  ReviewRequestedTriggerKind,
  type ReviewRequestedIntent,
} from "../../domain/review-requested-intent";

export function intentToDomain(record: IntentRecord): ReviewRequestedIntent {
  const claimParts = [
    record.claimId,
    record.claimOwnerIdHash,
    record.claimFencingToken,
    record.claimedAt,
    record.claimUntil,
  ];
  const hasClaim = claimParts.every((part) => part !== null);
  if (!hasClaim && claimParts.some((part) => part !== null)) {
    throw new Error("review_requested_persisted_claim_incomplete");
  }
  return {
    requestId: record.requestId,
    dispatchAttempt: record.dispatchAttempt,
    version: record.version,
    workspaceId: record.workspaceId,
    repositoryConnectionId: record.repositoryConnectionId,
    scmRepositoryIdentityId: record.scmRepositoryIdentityId,
    pullRequestNumber: record.pullRequestNumber,
    revision: revisionFromColumns(record),
    triggerKind: triggerKindFromPrisma(record.triggerKind),
    deliveryIdentityHash: record.deliveryIdentityHash,
    canonicalRequestHash: record.canonicalRequestHash,
    state: intentStateFromPrisma(record.state),
    notBefore: new Date(record.notBefore),
    claim: hasClaim
      ? {
          claimId: required(record.claimId, "claim_id"),
          ownerIdHash: required(record.claimOwnerIdHash, "claim_owner"),
          fencingToken: required(record.claimFencingToken, "claim_fence"),
          claimedAt: new Date(required(record.claimedAt, "claimed_at")),
          claimUntil: new Date(required(record.claimUntil, "claim_until")),
        }
      : null,
    submissionStartedAt:
      record.submissionStartedAt === null
        ? null
        : new Date(record.submissionStartedAt),
    nextResolutionAt:
      record.nextResolutionAt === null
        ? null
        : new Date(record.nextResolutionAt),
    resolutionDeadlineAt:
      record.resolutionDeadlineAt === null
        ? null
        : new Date(record.resolutionDeadlineAt),
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    authorizationId: record.authorizationId,
    executionId: record.executionId,
    terminalReason:
      record.terminalReason === null
        ? null
        : intentTerminalReasonFromPrisma(record.terminalReason),
    supersededByRequestId: record.supersededByRequestId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    retainUntil: new Date(record.retainUntil),
  };
}

export function streamToDomain(record: StreamRecord): ReviewExecutionStream {
  const revisionColumns = [
    record.currentBaseSha,
    record.currentMergeBaseSha,
    record.currentHeadSha,
    record.currentReviewRevisionHash,
  ];
  const hasRevision = revisionColumns.every((value) => value !== null);
  if (!hasRevision && revisionColumns.some((value) => value !== null)) {
    throw new Error("review_execution_stream_revision_corrupted");
  }
  return {
    workspaceId: record.workspaceId,
    repositoryConnectionId: record.repositoryConnectionId,
    scmRepositoryIdentityId: record.scmRepositoryIdentityId,
    pullRequestNumber: record.pullRequestNumber,
    version: record.version,
    activeExecutionId: record.activeExecutionId,
    preparedExecutionId: record.preparedExecutionId,
    lastAllocatedGeneration: record.lastAllocatedGeneration,
    currentRevision: hasRevision
      ? {
          baseSha: required(record.currentBaseSha, "current_base_sha"),
          mergeBaseSha: required(
            record.currentMergeBaseSha,
            "current_merge_base_sha",
          ),
          headSha: required(record.currentHeadSha, "current_head_sha"),
          reviewRevisionHash: required(
            record.currentReviewRevisionHash,
            "current_review_revision_hash",
          ),
        }
      : null,
    updatedAt: new Date(record.updatedAt),
  };
}

export function executionToDomain(
  record: ExecutionRecord,
  workSlots: readonly WorkSlotRecord[],
): ReviewExecution {
  return {
    executionId: record.executionId,
    workspaceId: record.workspaceId,
    repositoryConnectionId: record.repositoryConnectionId,
    scmRepositoryIdentityId: record.scmRepositoryIdentityId,
    pullRequestNumber: record.pullRequestNumber,
    version: record.version,
    generation: record.generation,
    revision: revisionFromColumns(record),
    authorizationId: record.authorizationId,
    producerReleaseId: record.producerReleaseId,
    mutationEpoch: record.mutationEpoch,
    startIdentityHash: record.startIdentityHash,
    canonicalStartHash: record.canonicalStartHash,
    admissionSafetyDecisionHash: record.admissionSafetyDecisionHash,
    state: executionStateFromPrisma(record.state),
    compatibilityKey: record.compatibilityKey,
    planHash: record.planHash,
    protocolLimitsProfileId: record.protocolLimitsProfileId,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    workSlots: Object.freeze(workSlots.map(workSlotToDomain)),
    finalizedArtifactId: record.finalizedArtifactId,
    supersededByExecutionId: record.supersededByExecutionId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    admissionDeadlineAt: new Date(record.admissionDeadlineAt),
    admissionCheckedAt:
      record.admissionCheckedAt === null
        ? null
        : new Date(record.admissionCheckedAt),
    executionDeadlineAt: new Date(record.executionDeadlineAt),
    retainUntil: new Date(record.retainUntil),
  };
}

export function leaseToDomain(record: LeaseRecord): ReviewInvocationLease {
  return {
    leaseId: record.leaseId,
    workspaceId: record.workspaceId,
    repositoryConnectionId: record.repositoryConnectionId,
    scmRepositoryIdentityId: record.scmRepositoryIdentityId,
    pullRequestNumber: record.pullRequestNumber,
    executionId: record.executionId,
    executionGeneration: record.executionGeneration,
    providerInvocationKey: record.providerInvocationKey,
    preparedManifestCanonicalJson: record.preparedManifestCanonicalJson,
    preparedManifestKey: record.preparedManifestKey,
    providerVoteIdentityHash: record.providerVoteIdentityHash,
    workSlotId: record.workSlotId,
    purpose: leasePurposeFromPrisma(record.purpose),
    authorizationId: record.authorizationId,
    producerReleaseId: record.producerReleaseId,
    reviewRevisionHash: record.reviewRevisionHash,
    mutationEpoch: record.mutationEpoch,
    leaseSafetyDecisionHash: record.leaseSafetyDecisionHash,
    attemptId: record.attemptId,
    sourceObservationId: record.sourceObservationId,
    attemptOrdinal: record.attemptOrdinal,
    acquireRequestIdHash: record.acquireRequestIdHash,
    acquireRequestHash: record.acquireRequestHash,
    lastRenewRequestIdHash: record.lastRenewRequestIdHash,
    lastRenewRequestHash: record.lastRenewRequestHash,
    ownerIdHash: record.ownerIdHash,
    leaseCapabilityId: record.leaseCapabilityId,
    capabilitySigningKeyId: record.capabilitySigningKeyId,
    fencingToken: record.fencingToken,
    state: leaseStateFromPrisma(record.state),
    acquiredAt: new Date(record.acquiredAt),
    renewedAt: new Date(record.renewedAt),
    expiresAt: new Date(record.expiresAt),
    resultReportUntil: new Date(record.resultReportUntil),
    retainUntil: new Date(record.retainUntil),
  };
}

export function observationRefToDomain(
  record: ObservationRefRecord,
): ReviewExecutionObservationRef {
  return {
    observationRefId: record.observationRefId,
    executionId: record.executionId,
    workSlotId: record.workSlotId,
    providerInvocationKey: record.providerInvocationKey,
    observationId: record.observationId,
    providerVoteIdentityHash: record.providerVoteIdentityHash,
    attachmentKind: attachmentKindFromPrisma(record.attachmentKind),
    eligibilityPolicyVersion: record.eligibilityPolicyVersion,
    reuseSafetyDecisionHash: record.reuseSafetyDecisionHash,
    sourceExecutionId: record.sourceExecutionId,
    sourceLeaseId: record.sourceLeaseId,
    sourceFencingToken: record.sourceFencingToken,
    payloadHash: record.payloadHash,
    byteCount: record.byteCount,
    findingCount: record.findingCount,
    attachedAt: new Date(record.attachedAt),
  };
}

export function artifactToDomain(
  record: ArtifactRecord,
  scope: ReviewExecutionScope,
): FinalizedReviewProjectionArtifact {
  const decodedEnvelope = parseJsonObject(
    record.projectionEnvelopeCanonicalJson,
  );
  if (
    canonicalJson(decodedEnvelope) !== canonicalJson(record.projectionEnvelope)
  ) {
    throw new Error("review_execution_artifact_envelope_corrupted");
  }
  if (
    new TextEncoder().encode(record.projectionEnvelopeCanonicalJson)
      .byteLength !== record.byteCount
  ) {
    throw new Error("review_execution_artifact_byte_count_corrupted");
  }
  return {
    artifactId: record.artifactId,
    executionId: record.executionId,
    generation: record.generation,
    reviewedHeadSha: record.reviewedHeadSha,
    reviewRevisionHash: record.reviewRevisionHash,
    coverageState: coverageStateFromPrisma(record.coverageState),
    projectionEnvelopeVersion: record.projectionEnvelopeVersion,
    projectionEnvelopeJson: record.projectionEnvelopeCanonicalJson,
    projectionHash: record.projectionHash,
    byteCount: record.byteCount,
    findingCount: record.findingCount,
    lifecycleStateHash: record.lifecycleStateHash,
    commandLedgerWatermark: record.commandLedgerWatermark,
    projectionPolicyVersion: record.projectionPolicyVersion,
    publicationPermit: {
      ...scope,
      executionId: record.executionId,
      generation: record.generation,
      authorizationId: record.authorizationId,
      producerReleaseId: record.producerReleaseId,
      reviewedHeadSha: record.reviewedHeadSha,
      reviewRevisionHash: record.reviewRevisionHash,
      projectionHash: record.projectionHash,
      lifecycleStateHash: record.lifecycleStateHash,
      commandLedgerWatermark: record.commandLedgerWatermark,
      permitEpoch: record.permitEpoch,
      publicationSafetyDecisionHash: record.publicationSafetyDecisionHash,
      publicationNotAfter: new Date(record.publicationNotAfter),
    },
    createdAt: new Date(record.createdAt),
    retainUntil: new Date(record.retainUntil),
  };
}

// Persistence stores use these operation-oriented names to keep mapping details
// out of transaction orchestration.
export const intentFromRecord = intentToDomain;
export const streamFromRecord = streamToDomain;
export const executionFromRecords = executionToDomain;
export const leaseFromRecord = leaseToDomain;
export const observationRefFromRecord = observationRefToDomain;

export function artifactFromRecord(
  record: ArtifactRecord,
  execution: ReviewExecutionScope & {
    readonly authorizationId: string;
    readonly producerReleaseId: string;
  },
): FinalizedReviewProjectionArtifact {
  if (
    record.authorizationId !== execution.authorizationId ||
    record.producerReleaseId !== execution.producerReleaseId
  ) {
    throw new Error("review_execution_artifact_binding_corrupted");
  }
  return artifactToDomain(record, execution);
}

export function streamUpdateData(
  stream: ReviewExecutionStream,
): Prisma.ReviewExecutionStreamV2UpdateManyMutationInput {
  return {
    version: stream.version,
    activeExecutionId: stream.activeExecutionId,
    preparedExecutionId: stream.preparedExecutionId,
    lastAllocatedGeneration: stream.lastAllocatedGeneration,
    currentBaseSha: stream.currentRevision?.baseSha ?? null,
    currentMergeBaseSha: stream.currentRevision?.mergeBaseSha ?? null,
    currentHeadSha: stream.currentRevision?.headSha ?? null,
    currentReviewRevisionHash:
      stream.currentRevision?.reviewRevisionHash ?? null,
    updatedAt: stream.updatedAt,
  };
}

export function executionUpdateData(
  execution: ReviewExecution,
): Prisma.ReviewExecutionV2UpdateManyMutationInput {
  return {
    version: execution.version,
    state: executionStateToPrisma(execution.state),
    supersededByExecutionId: execution.supersededByExecutionId,
    finalizedArtifactId: execution.finalizedArtifactId,
    updatedAt: execution.updatedAt,
    admissionCheckedAt: execution.admissionCheckedAt,
  };
}

export function workSlotUpdateData(
  slot: ReviewWorkSlot,
): Prisma.ReviewExecutionWorkSlotV2UpdateManyMutationInput {
  return {
    state: workSlotStateToPrisma(slot.state),
    nextAttemptOrdinal: slot.nextAttemptOrdinal,
    activeLeaseId: slot.activeLeaseId,
    acceptedObservationRefId: slot.acceptedObservationRefId,
  };
}

export function leaseUpdateData(
  lease: ReviewInvocationLease,
): Prisma.ReviewInvocationLeaseV2UpdateManyMutationInput {
  return {
    state: leaseStateToPrisma(lease.state),
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    resultReportUntil: lease.resultReportUntil,
  };
}

export function jsonObjectFromString(value: string): Prisma.InputJsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("review_execution_projection_envelope_not_object");
  }
  return parsed as Prisma.InputJsonObject;
}

export function triggerKindToPrisma(
  value: ReviewRequestedTriggerKind,
): PrismaTriggerKind {
  switch (value) {
    case ReviewRequestedTriggerKind.PullRequestSynchronized:
      return PrismaTriggerKind.pull_request_synchronized;
    case ReviewRequestedTriggerKind.PullRequestReadyForReview:
      return PrismaTriggerKind.pull_request_ready_for_review;
    case ReviewRequestedTriggerKind.ManualCommand:
      return PrismaTriggerKind.manual_command;
    case ReviewRequestedTriggerKind.LifecycleChanged:
      return PrismaTriggerKind.lifecycle_changed;
  }
}

export function intentStateToPrisma(
  value: ReviewRequestedIntentState,
): PrismaIntentState {
  switch (value) {
    case ReviewRequestedIntentState.PendingDispatch:
      return PrismaIntentState.pending_dispatch;
    case ReviewRequestedIntentState.Dispatching:
      return PrismaIntentState.dispatching;
    case ReviewRequestedIntentState.ReconcilingDispatch:
      return PrismaIntentState.reconciling_dispatch;
    case ReviewRequestedIntentState.AwaitingAuthorization:
      return PrismaIntentState.awaiting_authorization;
    case ReviewRequestedIntentState.Dispatched:
      return PrismaIntentState.dispatched;
    case ReviewRequestedIntentState.Terminal:
      return PrismaIntentState.terminal;
    case ReviewRequestedIntentState.Superseded:
      return PrismaIntentState.superseded;
  }
}

export function executionStateToPrisma(
  value: ReviewExecutionState,
): PrismaExecutionState {
  switch (value) {
    case ReviewExecutionState.Planned:
      return PrismaExecutionState.planned;
    case ReviewExecutionState.Running:
      return PrismaExecutionState.running;
    case ReviewExecutionState.Superseded:
      return PrismaExecutionState.superseded;
    case ReviewExecutionState.Completed:
      return PrismaExecutionState.completed;
    case ReviewExecutionState.Partial:
      return PrismaExecutionState.partial;
    case ReviewExecutionState.Failed:
      return PrismaExecutionState.failed;
  }
}

export function workSlotStateToPrisma(
  value: ReviewWorkSlotState,
): PrismaWorkSlotState {
  switch (value) {
    case ReviewWorkSlotState.Pending:
      return PrismaWorkSlotState.pending;
    case ReviewWorkSlotState.Leased:
      return PrismaWorkSlotState.leased;
    case ReviewWorkSlotState.Satisfied:
      return PrismaWorkSlotState.satisfied;
    case ReviewWorkSlotState.Exhausted:
      return PrismaWorkSlotState.exhausted;
    case ReviewWorkSlotState.Cancelled:
      return PrismaWorkSlotState.cancelled;
  }
}

export function providerKindToPrisma(
  value: ReviewExecutionProviderKind,
): PrismaProviderKind {
  switch (value) {
    case ReviewExecutionProviderKind.Codex:
      return PrismaProviderKind.codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return PrismaProviderKind.claude_code;
    case ReviewExecutionProviderKind.OpenRouter:
      return PrismaProviderKind.openrouter;
  }
}

export function taskKindToPrisma(value: ReviewTaskKind): PrismaTaskKind {
  switch (value) {
    case ReviewTaskKind.FindingDiscovery:
      return PrismaTaskKind.finding_discovery;
    case ReviewTaskKind.LifecycleRevalidation:
      return PrismaTaskKind.lifecycle_revalidation;
  }
}

export function leasePurposeToPrisma(
  value: ReviewInvocationLeasePurpose,
): PrismaLeasePurpose {
  switch (value) {
    case ReviewInvocationLeasePurpose.ProviderExecution:
      return PrismaLeasePurpose.provider_execution;
    case ReviewInvocationLeasePurpose.ObservationAdoption:
      return PrismaLeasePurpose.observation_adoption;
  }
}

export function leaseStateToPrisma(
  value: ReviewInvocationLeaseState,
): PrismaLeaseState {
  switch (value) {
    case ReviewInvocationLeaseState.Active:
      return PrismaLeaseState.active;
    case ReviewInvocationLeaseState.Released:
      return PrismaLeaseState.released;
    case ReviewInvocationLeaseState.Expired:
      return PrismaLeaseState.expired;
    case ReviewInvocationLeaseState.Revoked:
      return PrismaLeaseState.revoked;
  }
}

export function attachmentKindToPrisma(
  value: ReviewObservationAttachmentKind,
): PrismaAttachmentKind {
  switch (value) {
    case ReviewObservationAttachmentKind.FreshLease:
      return PrismaAttachmentKind.fresh_lease;
    case ReviewObservationAttachmentKind.ObservationAdoption:
      return PrismaAttachmentKind.observation_adoption;
    case ReviewObservationAttachmentKind.ExactRevisionReuse:
      return PrismaAttachmentKind.exact_revision_reuse;
    case ReviewObservationAttachmentKind.PromptOnlyCrossRevisionReuse:
      return PrismaAttachmentKind.prompt_only_cross_revision_reuse;
    case ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse:
      return PrismaAttachmentKind.context_gateway_cross_revision_reuse;
  }
}

export function coverageStateToPrisma(
  value: ReviewCoverageState,
): PrismaCoverageState {
  switch (value) {
    case ReviewCoverageState.Completed:
      return PrismaCoverageState.completed;
    case ReviewCoverageState.Partial:
      return PrismaCoverageState.partial;
  }
}

function workSlotToDomain(record: WorkSlotRecord): ReviewWorkSlot {
  return {
    workSlotId: record.workSlotId,
    taskKind: taskKindFromPrisma(record.taskKind),
    providerKind: providerKindFromPrisma(record.providerKind),
    providerVoteIdentityHash: record.providerVoteIdentityHash,
    shardKey: record.shardKey,
    required: record.required,
    attemptBudget: record.attemptBudget,
    retryPolicyVersion: record.retryPolicyVersion,
    state: workSlotStateFromPrisma(record.state),
    nextAttemptOrdinal: record.nextAttemptOrdinal,
    activeLeaseId: record.activeLeaseId,
    acceptedObservationRefId: record.acceptedObservationRefId,
  };
}

function revisionFromColumns(record: {
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
}) {
  return {
    baseSha: record.baseSha,
    mergeBaseSha: record.mergeBaseSha,
    headSha: record.headSha,
    reviewRevisionHash: record.reviewRevisionHash,
  };
}

function triggerKindFromPrisma(
  value: PrismaTriggerKind,
): ReviewRequestedTriggerKind {
  switch (value) {
    case PrismaTriggerKind.pull_request_synchronized:
      return ReviewRequestedTriggerKind.PullRequestSynchronized;
    case PrismaTriggerKind.pull_request_ready_for_review:
      return ReviewRequestedTriggerKind.PullRequestReadyForReview;
    case PrismaTriggerKind.manual_command:
      return ReviewRequestedTriggerKind.ManualCommand;
    case PrismaTriggerKind.lifecycle_changed:
      return ReviewRequestedTriggerKind.LifecycleChanged;
  }
}

function intentStateFromPrisma(
  value: PrismaIntentState,
): ReviewRequestedIntentState {
  switch (value) {
    case PrismaIntentState.pending_dispatch:
      return ReviewRequestedIntentState.PendingDispatch;
    case PrismaIntentState.dispatching:
      return ReviewRequestedIntentState.Dispatching;
    case PrismaIntentState.reconciling_dispatch:
      return ReviewRequestedIntentState.ReconcilingDispatch;
    case PrismaIntentState.awaiting_authorization:
      return ReviewRequestedIntentState.AwaitingAuthorization;
    case PrismaIntentState.dispatched:
      return ReviewRequestedIntentState.Dispatched;
    case PrismaIntentState.terminal:
      return ReviewRequestedIntentState.Terminal;
    case PrismaIntentState.superseded:
      return ReviewRequestedIntentState.Superseded;
  }
}

export function intentTerminalReasonToPrisma(
  value: ReviewRequestedIntentTerminalReason,
): PrismaIntentTerminalReason {
  switch (value) {
    case ReviewRequestedIntentTerminalReason.DispatchFailedNoEffect:
      return PrismaIntentTerminalReason.dispatch_failed_no_effect;
    case ReviewRequestedIntentTerminalReason.DispatchOutcomeUnknown:
      return PrismaIntentTerminalReason.dispatch_outcome_unknown;
    case ReviewRequestedIntentTerminalReason.AuthorizationDeadlineExceeded:
      return PrismaIntentTerminalReason.authorization_deadline_exceeded;
    case ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted:
      return PrismaIntentTerminalReason.dispatch_attempts_exhausted;
  }
}

function intentTerminalReasonFromPrisma(
  value: PrismaIntentTerminalReason,
): ReviewRequestedIntentTerminalReason {
  switch (value) {
    case PrismaIntentTerminalReason.dispatch_failed_no_effect:
      return ReviewRequestedIntentTerminalReason.DispatchFailedNoEffect;
    case PrismaIntentTerminalReason.dispatch_outcome_unknown:
      return ReviewRequestedIntentTerminalReason.DispatchOutcomeUnknown;
    case PrismaIntentTerminalReason.authorization_deadline_exceeded:
      return ReviewRequestedIntentTerminalReason.AuthorizationDeadlineExceeded;
    case PrismaIntentTerminalReason.dispatch_attempts_exhausted:
      return ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted;
  }
}

function executionStateFromPrisma(
  value: PrismaExecutionState,
): ReviewExecutionState {
  switch (value) {
    case PrismaExecutionState.planned:
      return ReviewExecutionState.Planned;
    case PrismaExecutionState.running:
      return ReviewExecutionState.Running;
    case PrismaExecutionState.superseded:
      return ReviewExecutionState.Superseded;
    case PrismaExecutionState.completed:
      return ReviewExecutionState.Completed;
    case PrismaExecutionState.partial:
      return ReviewExecutionState.Partial;
    case PrismaExecutionState.failed:
      return ReviewExecutionState.Failed;
  }
}

function workSlotStateFromPrisma(
  value: PrismaWorkSlotState,
): ReviewWorkSlotState {
  switch (value) {
    case PrismaWorkSlotState.pending:
      return ReviewWorkSlotState.Pending;
    case PrismaWorkSlotState.leased:
      return ReviewWorkSlotState.Leased;
    case PrismaWorkSlotState.satisfied:
      return ReviewWorkSlotState.Satisfied;
    case PrismaWorkSlotState.exhausted:
      return ReviewWorkSlotState.Exhausted;
    case PrismaWorkSlotState.cancelled:
      return ReviewWorkSlotState.Cancelled;
  }
}

function providerKindFromPrisma(
  value: PrismaProviderKind,
): ReviewExecutionProviderKind {
  switch (value) {
    case PrismaProviderKind.codex:
      return ReviewExecutionProviderKind.Codex;
    case PrismaProviderKind.claude_code:
      return ReviewExecutionProviderKind.ClaudeCode;
    case PrismaProviderKind.openrouter:
      return ReviewExecutionProviderKind.OpenRouter;
  }
}

function taskKindFromPrisma(value: PrismaTaskKind): ReviewTaskKind {
  switch (value) {
    case PrismaTaskKind.finding_discovery:
      return ReviewTaskKind.FindingDiscovery;
    case PrismaTaskKind.lifecycle_revalidation:
      return ReviewTaskKind.LifecycleRevalidation;
    case PrismaTaskKind.code_review:
    case PrismaTaskKind.finding_revalidation:
    case PrismaTaskKind.conflict_review:
      throw new Error("review_execution_task_kind_not_supported");
  }
}

function leasePurposeFromPrisma(
  value: PrismaLeasePurpose,
): ReviewInvocationLeasePurpose {
  switch (value) {
    case PrismaLeasePurpose.provider_execution:
      return ReviewInvocationLeasePurpose.ProviderExecution;
    case PrismaLeasePurpose.observation_adoption:
      return ReviewInvocationLeasePurpose.ObservationAdoption;
  }
}

function leaseStateFromPrisma(
  value: PrismaLeaseState,
): ReviewInvocationLeaseState {
  switch (value) {
    case PrismaLeaseState.active:
      return ReviewInvocationLeaseState.Active;
    case PrismaLeaseState.released:
      return ReviewInvocationLeaseState.Released;
    case PrismaLeaseState.expired:
      return ReviewInvocationLeaseState.Expired;
    case PrismaLeaseState.revoked:
      return ReviewInvocationLeaseState.Revoked;
  }
}

function attachmentKindFromPrisma(
  value: PrismaAttachmentKind,
): ReviewObservationAttachmentKind {
  switch (value) {
    case PrismaAttachmentKind.fresh_lease:
      return ReviewObservationAttachmentKind.FreshLease;
    case PrismaAttachmentKind.observation_adoption:
      return ReviewObservationAttachmentKind.ObservationAdoption;
    case PrismaAttachmentKind.exact_revision_reuse:
      return ReviewObservationAttachmentKind.ExactRevisionReuse;
    case PrismaAttachmentKind.prompt_only_cross_revision_reuse:
      return ReviewObservationAttachmentKind.PromptOnlyCrossRevisionReuse;
    case PrismaAttachmentKind.context_gateway_cross_revision_reuse:
      return ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse;
  }
}

function coverageStateFromPrisma(
  value: PrismaCoverageState,
): ReviewCoverageState {
  switch (value) {
    case PrismaCoverageState.completed:
      return ReviewCoverageState.Completed;
    case PrismaCoverageState.partial:
      return ReviewCoverageState.Partial;
  }
}

function required<T>(value: T | null, field: string): T {
  if (value === null) {
    throw new Error(`review_execution_prisma_${field}_corrupted`);
  }
  return value;
}

function parseJsonObject(value: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("review_execution_artifact_envelope_corrupted");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error("review_execution_artifact_envelope_corrupted");
  }
  return decoded as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
