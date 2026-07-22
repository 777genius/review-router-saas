import type {
  FinalizedReviewProjectionArtifact,
  ReviewExecutionLimits,
  ReviewExecutionScope,
  ReviewExecutionSnapshot,
  ReviewExecutionStream,
  ReviewInvocationLease,
  ReviewInvocationLeasePurpose,
  ReviewObservationAttachmentKind,
  ReviewRevision,
  ReviewWorkSlotPlan,
} from "../../domain/review-execution";

export enum ReviewExecutionPrepareStatus {
  Prepared = "prepared",
  Restored = "restored",
  IdempotencyConflict = "idempotency_conflict",
  ConcurrencyConflict = "concurrency_conflict",
}

export enum ReviewExecutionAdmissionVerdict {
  Current = "current",
  Stale = "stale",
  Unavailable = "unavailable",
}

export enum ReviewExecutionAdmissionStatus {
  Admitted = "admitted",
  Restored = "restored",
  Superseded = "superseded",
  Deferred = "deferred",
  Missing = "missing",
  ConcurrencyConflict = "concurrency_conflict",
  NotPrepared = "not_prepared",
}

export enum ReviewInvocationLeaseAcquireStatus {
  Acquired = "acquired",
  Restored = "restored",
  Busy = "busy",
  AttemptBudgetExhausted = "attempt_budget_exhausted",
  NotRunnable = "not_runnable",
  Missing = "missing",
  IdempotencyConflict = "idempotency_conflict",
}

export enum ReviewInvocationLeaseTransitionStatus {
  Applied = "applied",
  Restored = "restored",
  StaleTerm = "stale_term",
  Expired = "expired",
  Missing = "missing",
  InvalidDeadline = "invalid_deadline",
}

export enum ReviewObservationAttachmentStatus {
  Attached = "attached",
  Restored = "restored",
  Conflict = "conflict",
  Missing = "missing",
  NotRunnable = "not_runnable",
  StaleLease = "stale_lease",
  Ineligible = "ineligible",
}

export enum ReviewExecutionFinalizeStatus {
  Finalized = "finalized",
  Restored = "restored",
  Conflict = "conflict",
  Missing = "missing",
  NotRunnable = "not_runnable",
  RequiredCoverageIncomplete = "required_coverage_incomplete",
}

export enum ReviewExecutionLifecycleTransitionStatus {
  Applied = "applied",
  Restored = "restored",
  Missing = "missing",
  ConcurrencyConflict = "concurrency_conflict",
  NotEligible = "not_eligible",
}

export type PrepareReviewExecutionCommand = {
  readonly scope: ReviewExecutionScope;
  readonly expectedStreamVersion: bigint;
  readonly executionId: string;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly mutationEpoch: bigint;
  readonly revision: ReviewRevision;
  readonly startIdentityHash: string;
  readonly canonicalStartHash: string;
  readonly admissionSafetyDecisionHash: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly workSlots: readonly ReviewWorkSlotPlan[];
  readonly limits: ReviewExecutionLimits;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
  readonly admissionDeadlineAt: Date;
  readonly executionDeadlineAt: Date;
  readonly retainUntil: Date;
};

export type ConfirmReviewExecutionAdmissionCommand = {
  readonly scope: ReviewExecutionScope;
  readonly expectedStreamVersion: bigint;
  readonly executionId: string;
  readonly authorizationId: string;
  readonly mutationEpoch: bigint;
  readonly requestedRevision: ReviewRevision;
  readonly observedRevision: ReviewRevision | null;
  readonly verdict: ReviewExecutionAdmissionVerdict;
  readonly checkedAt: Date;
};

export type AcquireReviewInvocationLeaseCommand = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly workSlotId: string;
  readonly purpose: ReviewInvocationLeasePurpose;
  readonly providerInvocationKey: string;
  readonly preparedManifestCanonicalJson: string | null;
  readonly preparedManifestKey: string | null;
  readonly providerVoteIdentityHash: string;
  readonly leaseId: string;
  readonly attemptId: string | null;
  readonly sourceObservationId: string | null;
  readonly acquireRequestIdHash: string;
  readonly acquireRequestHash: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly leaseSafetyDecisionHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly resultReportUntil: Date;
  readonly retainUntil: Date;
  readonly limits: ReviewExecutionLimits;
};

export type ReviewInvocationLeaseTerm = {
  readonly leaseId: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly fencingToken: bigint;
};

export type RenewReviewInvocationLeaseCommand = ReviewInvocationLeaseTerm & {
  readonly now: Date;
  readonly expiresAt: Date;
  readonly resultReportUntil: Date;
  readonly limits: ReviewExecutionLimits;
};

export type ReleaseReviewInvocationLeaseCommand = ReviewInvocationLeaseTerm & {
  readonly now: Date;
};

export type AttachReviewObservationCommand = ReviewInvocationLeaseTerm & {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly workSlotId: string;
  readonly observationRefId: string;
  readonly observationId: string;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly eligibilityPolicyVersion: string;
  readonly now: Date;
};

export type AttachReusableReviewObservationCommand = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly workSlotId: string;
  readonly sourceExecutionId: string;
  readonly observationRefId: string;
  readonly observationId: string;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly attachmentKind:
    | ReviewObservationAttachmentKind.ExactRevisionReuse
    | ReviewObservationAttachmentKind.PromptOnlyCrossRevisionReuse
    | ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse;
  readonly eligibilityPolicyVersion: string;
  readonly reuseSafetyDecisionHash: string;
  readonly now: Date;
};

export type AdoptAcceptedReviewObservationCommand = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly workSlotId: string;
  readonly sourceLeaseId: string;
  readonly sourceFencingToken: bigint;
  readonly sourceObservationId: string;
  readonly observationRefId: string;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly eligibilityPolicyVersion: string;
  readonly adoptionLeaseId: string;
  readonly adoptionAcquireRequestIdHash: string;
  readonly adoptionAcquireRequestHash: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly leaseSafetyDecisionHash: string;
  readonly now: Date;
  readonly retainUntil: Date;
};

export type FinalizeReviewExecutionCommand = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly expectedStreamVersion: bigint;
  readonly expectedExecutionVersion: bigint;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly projectionEnvelopeVersion: number;
  readonly projectionEnvelopeJson: string;
  readonly projectionHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly projectionPolicyVersion: string;
  readonly publicationSafetyDecisionHash: string;
  readonly publicationNotAfter: Date;
  readonly permitEpoch: bigint;
  readonly allowPartial: boolean;
  readonly limits: ReviewExecutionLimits;
  readonly now: Date;
  readonly retainUntil: Date;
};

export type SupersedeReviewExecutionCommand = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly expectedStreamVersion: bigint;
  readonly observedCurrentRevision: ReviewRevision;
  readonly now: Date;
};

export type FailAbandonedPreparedExecutionCommand = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly expectedStreamVersion: bigint;
  readonly now: Date;
};

export type ReviewExecutionPrepareResult = {
  readonly status: ReviewExecutionPrepareStatus;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export type ReviewExecutionAdmissionResult = {
  readonly status: ReviewExecutionAdmissionStatus;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export type ReviewInvocationLeaseAcquireResult = {
  readonly status: ReviewInvocationLeaseAcquireStatus;
  readonly lease?: ReviewInvocationLease | undefined;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export type ReviewInvocationLeaseTransitionResult = {
  readonly status: ReviewInvocationLeaseTransitionStatus;
  readonly lease?: ReviewInvocationLease | undefined;
};

export type ReviewObservationAttachmentResult = {
  readonly status: ReviewObservationAttachmentStatus;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export type ReviewExecutionFinalizeResult = {
  readonly status: ReviewExecutionFinalizeStatus;
  readonly artifact?: FinalizedReviewProjectionArtifact | undefined;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export type ReviewExecutionLifecycleTransitionResult = {
  readonly status: ReviewExecutionLifecycleTransitionStatus;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export interface ReviewExecutionQueryPort {
  findStream(
    scope: ReviewExecutionScope,
  ): Promise<ReviewExecutionStream | null>;
  findExecution(executionId: string): Promise<ReviewExecutionSnapshot | null>;
  findByStartIdentity(input: {
    readonly scope: ReviewExecutionScope;
    readonly authorizationId: string;
    readonly startIdentityHash: string;
  }): Promise<ReviewExecutionSnapshot | null>;
  findLease(leaseId: string): Promise<ReviewInvocationLease | null>;
  findProviderExecutionLeaseByAttemptId(
    attemptId: string,
  ): Promise<ReviewInvocationLease | null>;
}

export interface ReviewExecutionCommandPort {
  prepareExecution(
    command: PrepareReviewExecutionCommand,
  ): Promise<ReviewExecutionPrepareResult>;
  confirmAdmission(
    command: ConfirmReviewExecutionAdmissionCommand,
  ): Promise<ReviewExecutionAdmissionResult>;
  acquireLease(
    command: AcquireReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseAcquireResult>;
  renewLease(
    command: RenewReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseTransitionResult>;
  releaseLease(
    command: ReleaseReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseTransitionResult>;
  attachObservation(
    command: AttachReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult>;
  attachReusableObservation(
    command: AttachReusableReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult>;
  adoptObservation(
    command: AdoptAcceptedReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult>;
  finalizeExecution(
    command: FinalizeReviewExecutionCommand,
  ): Promise<ReviewExecutionFinalizeResult>;
  supersedeExecution(
    command: SupersedeReviewExecutionCommand,
  ): Promise<ReviewExecutionLifecycleTransitionResult>;
  failAbandonedPreparedExecution(
    command: FailAbandonedPreparedExecutionCommand,
  ): Promise<ReviewExecutionLifecycleTransitionResult>;
}

export type ReviewExecutionPruneResult = Readonly<{
  compactedLeases: number;
  deletedObservationRefs: number;
  deletedArtifacts: number;
  deletedWorkSlots: number;
  deletedExecutions: number;
}>;

export interface ReviewExecutionPrunerPort {
  pruneRetainedHistory(input: {
    readonly limit: number;
  }): Promise<ReviewExecutionPruneResult>;
}

export interface ReviewExecutionFencingTokenSourcePort {
  next(): bigint;
}

export enum CurrentReviewRevisionStatus {
  Found = "found",
  Unavailable = "unavailable",
}

export interface CurrentReviewRevisionPort {
  resolve(scope: ReviewExecutionScope): Promise<
    | {
        readonly status: CurrentReviewRevisionStatus.Found;
        readonly revision: ReviewRevision;
      }
    | { readonly status: CurrentReviewRevisionStatus.Unavailable }
  >;
}

export interface Sha256DigestPort {
  digestUtf8(value: string): Promise<string>;
}

export interface ClockPort {
  now(): Date;
}

export type ReviewExecutionAuthorizationFacts = {
  readonly authorizationId: string;
  readonly scope: ReviewExecutionScope;
  readonly revision: ReviewRevision;
  readonly producerReleaseId: string;
  readonly mutationEpoch: bigint;
  readonly admissionSafetyDecisionHash: string;
  readonly limits: ReviewExecutionLimits;
  readonly expiresAt: Date;
  readonly active: boolean;
};

export interface ReviewExecutionAuthorizationFactsPort {
  find(
    authorizationId: string,
  ): Promise<ReviewExecutionAuthorizationFacts | null>;
}
